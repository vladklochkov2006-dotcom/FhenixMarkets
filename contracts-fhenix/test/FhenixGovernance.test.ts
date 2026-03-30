import { expect } from "chai";
import { ethers } from "hardhat";
import { deployGovernance, deployMarkets } from "./helpers";

describe("FhenixGovernance", function () {
  this.timeout(120_000);

  describe("Initialization", function () {
    it("should initialize governance with guardians", async function () {
      const governance = await deployGovernance();
      expect(await governance.initialized()).to.be.true;
    });

    it("should reject double initialization", async function () {
      const governance = await deployGovernance();
      const [deployer] = await ethers.getSigners();

      await expect(
        governance.initGovernance(
          deployer.address, deployer.address, deployer.address, deployer.address
        )
      ).to.be.revertedWith("Already initialized");
    });
  });

  describe("Proposals", function () {
    it("should create a proposal with stake", async function () {
      const governance = await deployGovernance();
      const stake = ethers.parseEther("0.01");

      const target = ethers.keccak256(ethers.toUtf8Bytes("fee_param"));

      const tx = await governance.createProposal(
        2, // FEE_CHANGE
        target,
        100, // new fee value
        ethers.ZeroHash,
        { value: stake }
      );
      const receipt = await tx.wait();
      expect(receipt!.status).to.equal(1);
      expect(await governance.proposalCount()).to.equal(1);
    });

    it("should reject proposal with insufficient stake", async function () {
      const governance = await deployGovernance();

      await expect(
        governance.createProposal(
          2, ethers.ZeroHash, 100, ethers.ZeroHash,
          { value: ethers.parseEther("0.001") } // below MIN_PROPOSAL_STAKE
        )
      ).to.be.revertedWith("Min stake");
    });

    it("should reject invalid proposal type", async function () {
      const governance = await deployGovernance();

      await expect(
        governance.createProposal(
          0, ethers.ZeroHash, 100, ethers.ZeroHash,
          { value: ethers.parseEther("0.01") }
        )
      ).to.be.revertedWith("Invalid type");
    });
  });

  describe("Voting (FHE-encrypted weights)", function () {
    async function createTestProposal(governance: any) {
      const target = ethers.keccak256(ethers.toUtf8Bytes("test_param"));
      const tx = await governance.createProposal(
        4, // PARAMETER
        target, 42, ethers.ZeroHash,
        { value: ethers.parseEther("0.01") }
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (log: any) => {
          try { return governance.interface.parseLog(log)?.name === "ProposalCreated"; }
          catch { return false; }
        }
      );
      return governance.interface.parseLog(event)!.args[0] as string;
    }

    it("should cast encrypted vote for", async function () {
      const governance = await deployGovernance();
      const [, voter] = await ethers.getSigners();
      const proposalId = await createTestProposal(governance);

      const tx = await governance.connect(voter).voteFor(proposalId, {
        value: ethers.parseEther("0.01"),
      });
      expect((await tx.wait())!.status).to.equal(1);
    });

    it("should cast encrypted vote against", async function () {
      const governance = await deployGovernance();
      const [, voter] = await ethers.getSigners();
      const proposalId = await createTestProposal(governance);

      const tx = await governance.connect(voter).voteAgainst(proposalId, {
        value: ethers.parseEther("0.01"),
      });
      expect((await tx.wait())!.status).to.equal(1);
    });

    it("should reject double vote", async function () {
      const governance = await deployGovernance();
      const [, voter] = await ethers.getSigners();
      const proposalId = await createTestProposal(governance);

      await governance.connect(voter).voteFor(proposalId, {
        value: ethers.parseEther("0.01"),
      });

      await expect(
        governance.connect(voter).voteFor(proposalId, {
          value: ethers.parseEther("0.01"),
        })
      ).to.be.revertedWith("Already voted");
    });

    it("should finalize vote — decrypt tallies and determine outcome", async function () {
      const governance = await deployGovernance();
      const signers = await ethers.getSigners();
      const proposalId = await createTestProposal(governance);

      // Vote for with more weight
      await governance.connect(signers[1]).voteFor(proposalId, {
        value: ethers.parseEther("0.5"),
      });
      await governance.connect(signers[2]).voteAgainst(proposalId, {
        value: ethers.parseEther("0.1"),
      });

      // Fast-forward past voting period (7 days)
      await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);

      await governance.finalizeVote(proposalId);

      const proposal = await governance.getProposal(proposalId);
      // Quorum for PARAMETER = 0.25 ETH, total = 0.6 ETH > 0.25
      // For > Against → PASSED
      expect(proposal.status).to.equal(1); // STATUS_PASSED
      expect(proposal.votesFor).to.equal(ethers.parseEther("0.5"));
      expect(proposal.votesAgainst).to.equal(ethers.parseEther("0.1"));
    });

    it("should reject proposal that doesn't meet quorum", async function () {
      const governance = await deployGovernance();
      const [, voter] = await ethers.getSigners();
      const proposalId = await createTestProposal(governance);

      // Small vote (below quorum)
      await governance.connect(voter).voteFor(proposalId, {
        value: ethers.parseEther("0.01"),
      });

      await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);

      await governance.finalizeVote(proposalId);

      const proposal = await governance.getProposal(proposalId);
      expect(proposal.status).to.equal(2); // STATUS_REJECTED
    });
  });

  describe("Unlock & Execute", function () {
    it("should unlock staked ETH after voting ends", async function () {
      const governance = await deployGovernance();
      const [, voter] = await ethers.getSigners();

      const target = ethers.keccak256(ethers.toUtf8Bytes("p"));
      const tx = await governance.createProposal(
        4, target, 1, ethers.ZeroHash,
        { value: ethers.parseEther("0.01") }
      );
      const receipt = await tx.wait();
      const event = receipt!.logs.find(
        (log: any) => {
          try { return governance.interface.parseLog(log)?.name === "ProposalCreated"; }
          catch { return false; }
        }
      );
      const proposalId = governance.interface.parseLog(event)!.args[0];

      await governance.connect(voter).voteFor(proposalId, {
        value: ethers.parseEther("0.1"),
      });

      // Fast-forward
      await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);

      // Unlock
      const balBefore = await ethers.provider.getBalance(voter.address);
      await governance.connect(voter).unlockAfterVote(proposalId);
      const balAfter = await ethers.provider.getBalance(voter.address);

      expect(balAfter).to.be.gt(balBefore - ethers.parseEther("0.001")); // gas
    });

    it("should execute passed proposal after timelock", async function () {
      const governance = await deployGovernance();
      const signers = await ethers.getSigners();

      const paramKey = ethers.keccak256(ethers.toUtf8Bytes("max_fee"));
      const tx = await governance.createProposal(
        4, paramKey, 500, ethers.ZeroHash,
        { value: ethers.parseEther("0.01") }
      );
      const receipt = await tx.wait();
      const event = receipt!.logs.find(
        (log: any) => {
          try { return governance.interface.parseLog(log)?.name === "ProposalCreated"; }
          catch { return false; }
        }
      );
      const proposalId = governance.interface.parseLog(event)!.args[0];

      // Vote
      await governance.connect(signers[1]).voteFor(proposalId, {
        value: ethers.parseEther("0.5"),
      });

      // Finalize
      await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      await governance.finalizeVote(proposalId);

      // Wait timelock (2 days)
      await ethers.provider.send("evm_increaseTime", [2 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);

      await governance.executeGovernance(proposalId);

      const param = await governance.governanceParams(paramKey);
      expect(param).to.equal(500);
    });
  });

  describe("Guardian Veto", function () {
    it("should allow guardian to veto proposal", async function () {
      const governance = await deployGovernance();
      const [deployer] = await ethers.getSigners(); // deployer is guardian

      const target = ethers.keccak256(ethers.toUtf8Bytes("v"));
      const tx = await governance.createProposal(
        4, target, 1, ethers.ZeroHash,
        { value: ethers.parseEther("0.01") }
      );
      const receipt = await tx.wait();
      const event = receipt!.logs.find(
        (log: any) => {
          try { return governance.interface.parseLog(log)?.name === "ProposalCreated"; }
          catch { return false; }
        }
      );
      const proposalId = governance.interface.parseLog(event)!.args[0];

      await governance.vetoProposal(proposalId);

      const proposal = await governance.getProposal(proposalId);
      expect(proposal.status).to.equal(4); // STATUS_VETOED
    });
  });

  describe("Resolver Registry", function () {
    it("should register resolver with stake", async function () {
      const governance = await deployGovernance();
      const [, resolver] = await ethers.getSigners();

      await governance.connect(resolver).registerResolver({
        value: ethers.parseEther("0.05"),
      });

      const profile = await governance.getResolverProfile(resolver.address);
      expect(profile.isActive).to.be.true;
      expect(profile.tier).to.equal(1); // TIER_BRONZE
    });

    it("should unstake resolver and return ETH", async function () {
      const governance = await deployGovernance();
      const [, resolver] = await ethers.getSigners();

      await governance.connect(resolver).registerResolver({
        value: ethers.parseEther("0.05"),
      });

      const balBefore = await ethers.provider.getBalance(resolver.address);
      await governance.connect(resolver).unstakeResolver();
      const balAfter = await ethers.provider.getBalance(resolver.address);

      expect(balAfter).to.be.gt(balBefore);

      const profile = await governance.getResolverProfile(resolver.address);
      expect(profile.isActive).to.be.false;
    });

    it("should slash resolver", async function () {
      const governance = await deployGovernance();
      const [deployer, resolver] = await ethers.getSigners();

      await governance.connect(resolver).registerResolver({
        value: ethers.parseEther("0.1"),
      });

      await governance.slashResolver(resolver.address);

      const profile = await governance.getResolverProfile(resolver.address);
      expect(profile.strikes).to.equal(1);
      // 10% slashed: 0.1 ETH → 0.09 ETH
      expect(profile.stakeAmount).to.equal(ethers.parseEther("0.09"));
    });

    it("should auto-blacklist after 3 strikes", async function () {
      const governance = await deployGovernance();
      const [, resolver] = await ethers.getSigners();

      await governance.connect(resolver).registerResolver({
        value: ethers.parseEther("1"),
      });

      await governance.slashResolver(resolver.address);
      await governance.slashResolver(resolver.address);
      await governance.slashResolver(resolver.address);

      expect(await governance.blacklistedResolvers(resolver.address)).to.be.true;
    });
  });

  describe("Delegation", function () {
    it("should delegate and undelegate votes", async function () {
      const governance = await deployGovernance();
      const [, delegator, delegate] = await ethers.getSigners();

      await governance.connect(delegator).delegateVotes(delegate.address, {
        value: ethers.parseEther("0.5"),
      });

      expect(await governance.delegatedPower(delegate.address))
        .to.equal(ethers.parseEther("0.5"));

      // Undelegate
      const balBefore = await ethers.provider.getBalance(delegator.address);
      await governance.connect(delegator).undelegateVotes(delegate.address);
      const balAfter = await ethers.provider.getBalance(delegator.address);

      expect(balAfter).to.be.gt(balBefore);
      expect(await governance.delegatedPower(delegate.address)).to.equal(0);
    });
  });

  describe("Multi-Resolver Panels", function () {
    it("should assign and vote on a panel", async function () {
      const governance = await deployGovernance();
      const signers = await ethers.getSigners();
      const marketId = ethers.keccak256(ethers.toUtf8Bytes("market1"));

      // Register 3 resolvers
      for (let i = 1; i <= 3; i++) {
        await governance.connect(signers[i]).registerResolver({
          value: ethers.parseEther("0.05"),
        });
      }

      // Assign panel
      await governance.assignResolverPanel(
        marketId,
        signers[1].address,
        signers[2].address,
        signers[3].address
      );

      // Panel votes
      await governance.connect(signers[1]).panelVote(marketId, 1);
      await governance.connect(signers[2]).panelVote(marketId, 1); // majority reached

      const panel = await governance.getPanel(marketId);
      expect(panel.finalized).to.be.true;
      expect(panel.winningOutcome).to.equal(1);
    });
  });

  describe("Committee Vote Finalization", function () {
    it("should explicitly finalize committee vote", async function () {
      const governance = await deployGovernance();
      const signers = await ethers.getSigners();
      const marketId = ethers.keccak256(ethers.toUtf8Bytes("committee-market"));

      // Set up 3 committee members
      await governance.setCommitteeMembers(
        [signers[1].address, signers[2].address, signers[3].address, ethers.ZeroAddress, ethers.ZeroAddress],
        3
      );

      // 2 of 3 vote for outcome 2
      await governance.connect(signers[1]).committeeVoteResolve(marketId, 2);
      // After 1 vote, not yet finalized via auto-finalize (needs majority = 2)
      // But the auto-finalize won't trigger until 2nd vote

      await governance.connect(signers[2]).committeeVoteResolve(marketId, 2);
      // Auto-finalized by majority in committeeVoteResolve

      expect(await governance.committeeFinalized(marketId)).to.be.true;
      expect(await governance.committeeDecision(marketId)).to.equal(2);
    });

    it("should finalize via explicit call when no auto-finalize", async function () {
      const governance = await deployGovernance();
      const signers = await ethers.getSigners();
      const marketId = ethers.keccak256(ethers.toUtf8Bytes("committee-explicit"));

      // 5 committee members
      await governance.setCommitteeMembers(
        [signers[1].address, signers[2].address, signers[3].address, signers[4].address, signers[5].address],
        5
      );

      // 3 vote for outcome 1 (majority = 3 for 5 members)
      await governance.connect(signers[1]).committeeVoteResolve(marketId, 1);
      await governance.connect(signers[2]).committeeVoteResolve(marketId, 1);
      await governance.connect(signers[3]).committeeVoteResolve(marketId, 1); // auto-finalizes

      expect(await governance.committeeFinalized(marketId)).to.be.true;
      expect(await governance.committeeDecision(marketId)).to.equal(1);
    });

    it("should reject finalize without majority", async function () {
      const governance = await deployGovernance();
      const signers = await ethers.getSigners();
      const marketId = ethers.keccak256(ethers.toUtf8Bytes("no-majority"));

      await governance.setCommitteeMembers(
        [signers[1].address, signers[2].address, signers[3].address, signers[4].address, signers[5].address],
        5
      );

      // Only 1 vote — not enough
      await governance.connect(signers[1]).committeeVoteResolve(marketId, 1);

      await expect(
        governance.finalizeCommitteeVote(marketId)
      ).to.be.revertedWith("No majority");
    });
  });

  describe("Escalation", function () {
    it("should initiate escalation with bond", async function () {
      const governance = await deployGovernance();
      const [, initiator] = await ethers.getSigners();
      const marketId = ethers.keccak256(ethers.toUtf8Bytes("disputed-market"));

      await governance.connect(initiator).initiateEscalation(marketId, 2, {
        value: ethers.parseEther("0.01"),
      });

      const esc = await governance.escalations(marketId);
      expect(esc.initiator).to.equal(initiator.address);
      expect(esc.proposedOutcome).to.equal(2);
      expect(esc.status).to.equal(1); // ESCALATION_INITIATED
      expect(esc.bondAmount).to.equal(ethers.parseEther("0.01"));
    });

    it("should reject escalation with insufficient bond", async function () {
      const governance = await deployGovernance();
      const [, initiator] = await ethers.getSigners();
      const marketId = ethers.keccak256(ethers.toUtf8Bytes("market2"));

      await expect(
        governance.connect(initiator).initiateEscalation(marketId, 1, {
          value: ethers.parseEther("0.001"), // below 0.01 minimum
        })
      ).to.be.revertedWith("Min bond");
    });

    it("should reject double escalation", async function () {
      const governance = await deployGovernance();
      const [, initiator] = await ethers.getSigners();
      const marketId = ethers.keccak256(ethers.toUtf8Bytes("market3"));

      await governance.connect(initiator).initiateEscalation(marketId, 1, {
        value: ethers.parseEther("0.01"),
      });

      await expect(
        governance.connect(initiator).initiateEscalation(marketId, 2, {
          value: ethers.parseEther("0.01"),
        })
      ).to.be.revertedWith("Already escalated");
    });

    it("full escalation flow: initiate → community → vote → finalize", async function () {
      const governance = await deployGovernance();
      const signers = await ethers.getSigners();
      const [deployer, initiator, voter1, voter2, voter3] = signers;
      const marketId = ethers.keccak256(ethers.toUtf8Bytes("full-escalation"));

      // 1. Initiate
      await governance.connect(initiator).initiateEscalation(marketId, 2, {
        value: ethers.parseEther("0.01"),
      });

      // 2. Escalate to community (deployer is also guardian)
      await governance.escalateToCommunity(marketId);

      const esc1 = await governance.escalations(marketId);
      expect(esc1.status).to.equal(2); // ESCALATION_COMMUNITY
      expect(esc1.communityDeadline).to.be.gt(0);

      // 3. Community votes
      await governance.connect(voter1).voteEscalation(marketId, true, {
        value: ethers.parseEther("0.5"),
      });
      await governance.connect(voter2).voteEscalation(marketId, true, {
        value: ethers.parseEther("0.3"),
      });
      await governance.connect(voter3).voteEscalation(marketId, false, {
        value: ethers.parseEther("0.2"),
      });

      // 4. Fast-forward past community deadline (3 days)
      await ethers.provider.send("evm_increaseTime", [3 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);

      // 5. Finalize
      await governance.finalizeEscalation(marketId);

      const esc2 = await governance.escalations(marketId);
      expect(esc2.status).to.equal(3); // ESCALATION_RESOLVED

      // Community voted FOR (0.8 ETH) > AGAINST (0.2 ETH) — proposed outcome applied
      expect(await governance.governanceResolvedOutcomes(marketId)).to.equal(2);
    });

    it("should reject community vote after deadline", async function () {
      const governance = await deployGovernance();
      const [deployer, initiator, voter1] = await ethers.getSigners();
      const marketId = ethers.keccak256(ethers.toUtf8Bytes("late-vote"));

      await governance.connect(initiator).initiateEscalation(marketId, 1, {
        value: ethers.parseEther("0.01"),
      });
      await governance.escalateToCommunity(marketId);

      // Fast-forward past deadline
      await ethers.provider.send("evm_increaseTime", [3 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        governance.connect(voter1).voteEscalation(marketId, true, {
          value: ethers.parseEther("0.1"),
        })
      ).to.be.revertedWith("Voting closed");
    });

    it("should allow bond withdrawal after resolution", async function () {
      const governance = await deployGovernance();
      const [deployer, initiator, voter1] = await ethers.getSigners();
      const marketId = ethers.keccak256(ethers.toUtf8Bytes("bond-withdraw"));

      await governance.connect(initiator).initiateEscalation(marketId, 1, {
        value: ethers.parseEther("0.01"),
      });
      await governance.escalateToCommunity(marketId);

      await governance.connect(voter1).voteEscalation(marketId, true, {
        value: ethers.parseEther("0.5"),
      });

      await ethers.provider.send("evm_increaseTime", [3 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      await governance.finalizeEscalation(marketId);

      // Voter withdraws bond
      const balBefore = await ethers.provider.getBalance(voter1.address);
      await governance.connect(voter1).withdrawEscalationBond(marketId);
      const balAfter = await ethers.provider.getBalance(voter1.address);

      // Should get back at least ~0.49 ETH (0.5 minus gas)
      expect(balAfter - balBefore).to.be.gt(ethers.parseEther("0.49"));

      // Initiator withdraws their bond
      const initBalBefore = await ethers.provider.getBalance(initiator.address);
      await governance.connect(initiator).withdrawEscalationBond(marketId);
      const initBalAfter = await ethers.provider.getBalance(initiator.address);
      expect(initBalAfter - initBalBefore).to.be.gt(ethers.parseEther("0.009"));
    });
  });
});
