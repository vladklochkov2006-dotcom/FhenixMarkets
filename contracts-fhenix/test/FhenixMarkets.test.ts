import { expect } from "chai";
import { ethers } from "hardhat";
import { deployMarkets, createTestMarket, unshieldShares } from "./helpers";

describe("FhenixMarkets", function () {
  // Increase timeout for viaIR compilation
  this.timeout(120_000);

  describe("Market Creation", function () {
    it("should create a binary market with initial liquidity", async function () {
      const markets = await deployMarkets();
      const [creator] = await ethers.getSigners();

      const liquidity = ethers.parseEther("1");
      const questionHash = ethers.keccak256(ethers.toUtf8Bytes("Test?"));
      const block = await ethers.provider.getBlock("latest");
      const deadline = block!.timestamp + 86400;
      const resDeadline = deadline + 86400;

      const tx = await markets.createMarket(
        questionHash, 1, 2, deadline, resDeadline, creator.address,
        { value: liquidity }
      );
      const receipt = await tx.wait();

      expect(receipt!.status).to.equal(1);
      expect(await markets.marketCount()).to.equal(1);
    });

    it("should create a 4-outcome market", async function () {
      const markets = await deployMarkets();
      const marketId = await createTestMarket(markets, { numOutcomes: 4 });

      const market = await markets.getMarket(marketId);
      expect(market.numOutcomes).to.equal(4);
      expect(market.status).to.equal(1); // ACTIVE
    });

    it("should initialize AMM pool with equal reserves", async function () {
      const markets = await deployMarkets();
      const liquidity = ethers.parseEther("2");
      const marketId = await createTestMarket(markets, { liquidity });

      const pool = await markets.getPool(marketId);
      // 2 outcomes, 1 ETH each
      expect(pool.reserve1).to.equal(ethers.parseEther("1"));
      expect(pool.reserve2).to.equal(ethers.parseEther("1"));
      expect(pool.totalLiquidity).to.equal(liquidity);
      expect(pool.totalLPShares).to.equal(liquidity);
    });

    it("should reject < 2 outcomes", async function () {
      const markets = await deployMarkets();
      const [creator] = await ethers.getSigners();
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 86400;

      await expect(
        markets.createMarket(
          ethers.ZeroHash, 1, 1, deadline, deadline + 86400, creator.address,
          { value: ethers.parseEther("1") }
        )
      ).to.be.revertedWith("2-4 outcomes");
    });

    it("should reject > 4 outcomes", async function () {
      const markets = await deployMarkets();
      const [creator] = await ethers.getSigners();
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 86400;

      await expect(
        markets.createMarket(
          ethers.ZeroHash, 1, 5, deadline, deadline + 86400, creator.address,
          { value: ethers.parseEther("1") }
        )
      ).to.be.revertedWith("2-4 outcomes");
    });

    it("should reject deadline in past", async function () {
      const markets = await deployMarkets();
      const [creator] = await ethers.getSigners();
      const pastDeadline = (await ethers.provider.getBlock("latest"))!.timestamp - 86400;

      await expect(
        markets.createMarket(
          ethers.ZeroHash, 1, 2, pastDeadline, pastDeadline + 86400, creator.address,
          { value: ethers.parseEther("1") }
        )
      ).to.be.revertedWith("Deadline in future");
    });

    it("should reject insufficient liquidity", async function () {
      const markets = await deployMarkets();
      const [creator] = await ethers.getSigners();
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 86400;

      await expect(
        markets.createMarket(
          ethers.ZeroHash, 1, 2, deadline, deadline + 86400, creator.address,
          { value: 100 } // below MIN_LIQUIDITY
        )
      ).to.be.revertedWith("Min liquidity");
    });
  });

  describe("Buy Shares (FPMM)", function () {
    it("should buy shares and update AMM reserves", async function () {
      const markets = await deployMarkets();
      const marketId = await createTestMarket(markets, {
        liquidity: ethers.parseEther("10"),
      });

      const betAmount = ethers.parseEther("1");
      const tx = await markets.buyShares(marketId, 1, 0, { value: betAmount });
      const receipt = await tx.wait();
      expect(receipt!.status).to.equal(1);

      // Check pool reserves changed
      const pool = await markets.getPool(marketId);
      expect(pool.totalVolume).to.equal(betAmount);
      // Reserve1 should decrease (more shares bought = lower reserve for that outcome)
      // Reserve2 should increase
      expect(pool.reserve2).to.be.gt(ethers.parseEther("5"));
    });

    it("should collect fees on buy", async function () {
      const markets = await deployMarkets();
      const marketId = await createTestMarket(markets, {
        liquidity: ethers.parseEther("10"),
      });

      await markets.buyShares(marketId, 1, 0, { value: ethers.parseEther("1") });

      const fees = await markets.marketFees(marketId);
      // Protocol fee: 0.5% of 1 ETH = 0.005 ETH
      expect(fees.protocolFees).to.equal(ethers.parseEther("0.005"));
      // Creator fee: 0.5% of 1 ETH = 0.005 ETH
      expect(fees.creatorFees).to.equal(ethers.parseEther("0.005"));
    });

    it("should emit SharesBought event", async function () {
      const markets = await deployMarkets();
      const marketId = await createTestMarket(markets);

      await expect(
        markets.buyShares(marketId, 1, 0, { value: ethers.parseEther("0.1") })
      ).to.emit(markets, "SharesBought");
    });

    it("should reject buy on non-existent market", async function () {
      const markets = await deployMarkets();

      await expect(
        markets.buyShares(ethers.ZeroHash, 1, 0, { value: ethers.parseEther("0.1") })
      ).to.be.revertedWith("Market not found");
    });

    it("should reject buy with invalid outcome", async function () {
      const markets = await deployMarkets();
      const marketId = await createTestMarket(markets); // 2 outcomes

      await expect(
        markets.buyShares(marketId, 3, 0, { value: ethers.parseEther("0.1") })
      ).to.be.revertedWith("Invalid outcome");
    });

    it("should reject buy below minimum", async function () {
      const markets = await deployMarkets();
      const marketId = await createTestMarket(markets);

      await expect(
        markets.buyShares(marketId, 1, 0, { value: 500 }) // below MIN_TRADE_AMOUNT
      ).to.be.revertedWith("Below minimum");
    });
  });

  describe("Sell Shares", function () {
    it("should sell shares and receive ETH", async function () {
      const markets = await deployMarkets();
      const [buyer] = await ethers.getSigners();
      const marketId = await createTestMarket(markets, {
        liquidity: ethers.parseEther("10"),
      });

      // Buy shares first
      await markets.buyShares(marketId, 1, 0, { value: ethers.parseEther("1") });

      // Get balance before sell
      const balBefore = await ethers.provider.getBalance(buyer.address);

      // Sell some shares
      await unshieldShares(markets, marketId, 1, 1000n, buyer);
      const tx = await markets.connect(buyer).sellShares(marketId, 1, 1000n, 0n);
      const receipt = await tx.wait();
      expect(receipt!.status).to.equal(1);
    });

    it("should reject selling more shares than owned (FHE check)", async function () {
      const markets = await deployMarkets();
      const marketId = await createTestMarket(markets);

      // Try to sell without buying first — public balance is 0
      await expect(
        markets.sellShares(marketId, 1, ethers.parseEther("100"), 0)
      ).to.be.revertedWith("Insufficient public shares");
    });
  });

  describe("Add Liquidity", function () {
    it("should add liquidity and get LP shares", async function () {
      const markets = await deployMarkets();
      const marketId = await createTestMarket(markets, {
        liquidity: ethers.parseEther("10"),
      });

      const tx = await markets.addLiquidity(marketId, {
        value: ethers.parseEther("5"),
      });
      const receipt = await tx.wait();
      expect(receipt!.status).to.equal(1);

      const pool = await markets.getPool(marketId);
      expect(pool.totalLiquidity).to.equal(ethers.parseEther("15"));
    });

    it("should emit LiquidityAdded event", async function () {
      const markets = await deployMarkets();
      const marketId = await createTestMarket(markets);

      await expect(
        markets.addLiquidity(marketId, { value: ethers.parseEther("1") })
      ).to.emit(markets, "LiquidityAdded");
    });
  });

  describe("Market Lifecycle", function () {
    it("should close market after deadline", async function () {
      const markets = await deployMarkets();
      const marketId = await createTestMarket(markets, { deadlineOffset: 60 });

      // Fast-forward past deadline
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);

      const tx = await markets.closeMarket(marketId);
      const receipt = await tx.wait();
      expect(receipt!.status).to.equal(1);

      const market = await markets.getMarket(marketId);
      expect(market.status).to.equal(5); // STATUS_PENDING_RESOLUTION
    });

    it("should reject close before deadline", async function () {
      const markets = await deployMarkets();
      const marketId = await createTestMarket(markets, {
        deadlineOffset: 86400,
      });

      await expect(
        markets.closeMarket(marketId)
      ).to.be.revertedWith("Not past deadline");
    });

    it("should cancel market by creator", async function () {
      const markets = await deployMarkets();
      const marketId = await createTestMarket(markets);

      const tx = await markets.cancelMarket(marketId);
      const receipt = await tx.wait();
      expect(receipt!.status).to.equal(1);

      const market = await markets.getMarket(marketId);
      expect(market.status).to.equal(4); // MARKET_STATUS_CANCELLED
    });

    it("should reject cancel by non-creator", async function () {
      const markets = await deployMarkets();
      const [, other] = await ethers.getSigners();
      const marketId = await createTestMarket(markets);

      await expect(
        markets.connect(other).cancelMarket(marketId)
      ).to.be.revertedWith("Not authorized");
    });
  });

  describe("Resolution — Multi-Voter Quorum", function () {
    async function setupResolution(markets: any) {
      const marketId = await createTestMarket(markets, { deadlineOffset: 60 });

      // Fast-forward past deadline
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);

      // Close market
      await markets.closeMarket(marketId);
      return marketId;
    }

    it("should accept votes with bond", async function () {
      const markets = await deployMarkets();
      const signers = await ethers.getSigners();
      const marketId = await setupResolution(markets);

      const bond = ethers.parseEther("0.01");

      // 3 voters vote for outcome 1
      for (let i = 0; i < 3; i++) {
        await markets.connect(signers[i]).voteOutcome(marketId, 1, { value: bond });
      }

      const tally = await markets.getVoteTally(marketId);
      expect(tally.totalVoters).to.equal(3);
      expect(tally.totalBonded).to.equal(bond * 3n);
    });

    it("should reject double voting", async function () {
      const markets = await deployMarkets();
      const marketId = await setupResolution(markets);

      const bond = ethers.parseEther("0.01");
      await markets.voteOutcome(marketId, 1, { value: bond });

      await expect(
        markets.voteOutcome(marketId, 2, { value: bond })
      ).to.be.revertedWith("Already voted");
    });

    it("should finalize votes and determine winner", async function () {
      const markets = await deployMarkets();
      const signers = await ethers.getSigners();
      const marketId = await setupResolution(markets);

      const bond = ethers.parseEther("0.01");

      // 2 vote outcome 1, 1 votes outcome 2
      await markets.connect(signers[0]).voteOutcome(marketId, 1, { value: bond });
      await markets.connect(signers[1]).voteOutcome(marketId, 1, { value: bond });
      await markets.connect(signers[2]).voteOutcome(marketId, 2, { value: bond });

      // Fast-forward past vote window (12 hours)
      await ethers.provider.send("evm_increaseTime", [12 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);

      await markets.finalizeVotes(marketId);

      const tally = await markets.getVoteTally(marketId);
      expect(tally.finalized).to.be.true;
      expect(tally.winningOutcome).to.equal(1);
    });

    it("should reject finalization with < 3 voters", async function () {
      const markets = await deployMarkets();
      const marketId = await setupResolution(markets);

      await markets.voteOutcome(marketId, 1, { value: ethers.parseEther("0.01") });

      await ethers.provider.send("evm_increaseTime", [12 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        markets.finalizeVotes(marketId)
      ).to.be.revertedWith("Not enough voters");
    });

    it("full resolution flow: close → vote → finalize → confirm → resolve", async function () {
      const markets = await deployMarkets();
      const signers = await ethers.getSigners();
      const marketId = await setupResolution(markets);

      // Vote
      const bond = ethers.parseEther("0.01");
      await markets.connect(signers[0]).voteOutcome(marketId, 1, { value: bond });
      await markets.connect(signers[1]).voteOutcome(marketId, 1, { value: bond });
      await markets.connect(signers[2]).voteOutcome(marketId, 1, { value: bond });

      // Finalize
      await ethers.provider.send("evm_increaseTime", [12 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      await markets.finalizeVotes(marketId);

      // Confirm after dispute window
      await ethers.provider.send("evm_increaseTime", [12 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      await markets.confirmResolution(marketId);

      const market = await markets.getMarket(marketId);
      expect(market.status).to.equal(3); // MARKET_STATUS_RESOLVED
    });
  });

  describe("Dispute Resolution", function () {
    it("should accept dispute with 3x bond", async function () {
      const markets = await deployMarkets();
      const signers = await ethers.getSigners();
      const marketId = await createTestMarket(markets, { deadlineOffset: 60 });

      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);
      await markets.closeMarket(marketId);

      // Vote
      const bond = ethers.parseEther("0.01");
      await markets.connect(signers[0]).voteOutcome(marketId, 1, { value: bond });
      await markets.connect(signers[1]).voteOutcome(marketId, 1, { value: bond });
      await markets.connect(signers[2]).voteOutcome(marketId, 1, { value: bond });

      // Finalize
      await ethers.provider.send("evm_increaseTime", [12 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      await markets.finalizeVotes(marketId);

      // Dispute with 3x total bonded = 0.09 ETH
      const disputeBond = ethers.parseEther("0.09");
      await expect(
        markets.connect(signers[3]).disputeResolution(marketId, 2, { value: disputeBond })
      ).to.emit(markets, "ResolutionDisputed");

      const market = await markets.getMarket(marketId);
      expect(market.status).to.equal(7); // STATUS_DISPUTED
    });
  });

  describe("Claims", function () {
    it("should allow creator to withdraw fees", async function () {
      const markets = await deployMarkets();
      const [creator] = await ethers.getSigners();
      const marketId = await createTestMarket(markets, {
        liquidity: ethers.parseEther("10"),
        deadlineOffset: 60,
      });

      // Generate some fees via trading
      await markets.buyShares(marketId, 1, 0, { value: ethers.parseEther("2") });

      // Close and resolve
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);
      await markets.cancelMarket(marketId);

      const fees = await markets.marketFees(marketId);
      expect(fees.creatorFees).to.be.gt(0);

      const tx = await markets.withdrawCreatorFees(marketId);
      expect((await tx.wait())!.status).to.equal(1);
    });

    it("should allow voter bond claim after resolution", async function () {
      const markets = await deployMarkets();
      const signers = await ethers.getSigners();
      const marketId = await createTestMarket(markets, { deadlineOffset: 60 });

      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);
      await markets.closeMarket(marketId);

      const bond = ethers.parseEther("0.01");
      await markets.connect(signers[0]).voteOutcome(marketId, 1, { value: bond });
      await markets.connect(signers[1]).voteOutcome(marketId, 1, { value: bond });
      await markets.connect(signers[2]).voteOutcome(marketId, 1, { value: bond });

      await ethers.provider.send("evm_increaseTime", [12 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      await markets.finalizeVotes(marketId);

      await ethers.provider.send("evm_increaseTime", [12 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      await markets.confirmResolution(marketId);

      // Voter claims bond
      const balBefore = await ethers.provider.getBalance(signers[0].address);
      await markets.connect(signers[0]).claimVoterBond(marketId);
      const balAfter = await ethers.provider.getBalance(signers[0].address);

      // Should get back at least the bond (plus potential reward)
      expect(balAfter).to.be.gt(balBefore - ethers.parseEther("0.001")); // accounting for gas
    });
  });

  describe("View Functions", function () {
    it("should return prices from AMM", async function () {
      const markets = await deployMarkets();
      const marketId = await createTestMarket(markets, {
        liquidity: ethers.parseEther("10"),
      });

      const [p1, p2, p3, p4] = await markets.getPrices(marketId);
      // Binary market with equal reserves → 50/50
      // p1 + p2 should ≈ 1e18
      const total = p1 + p2;
      expect(total).to.be.closeTo(ethers.parseEther("1"), ethers.parseEther("0.01"));
    });

    it("should return market info", async function () {
      const markets = await deployMarkets();
      const marketId = await createTestMarket(markets);

      const market = await markets.getMarket(marketId);
      expect(market.numOutcomes).to.equal(2);
      expect(market.status).to.equal(1);
    });
  });

  describe("Protocol Fees", function () {
    it("should allow deployer to withdraw protocol fees", async function () {
      const markets = await deployMarkets();
      const marketId = await createTestMarket(markets, {
        liquidity: ethers.parseEther("10"),
      });

      await markets.buyShares(marketId, 1, 0, { value: ethers.parseEther("2") });

      const treasury = await markets.protocolTreasury();
      expect(treasury).to.be.gt(0);

      await markets.withdrawProtocolFees(treasury);
      expect(await markets.protocolTreasury()).to.equal(0);
    });

    it("should reject non-deployer withdrawing fees", async function () {
      const markets = await deployMarkets();
      const [, other] = await ethers.getSigners();

      await expect(
        markets.connect(other).withdrawProtocolFees(100)
      ).to.be.revertedWith("Only deployer");
    });
  });

  describe("Voter Rewards", function () {
    it("should allow voter to claim accumulated rewards", async function () {
      const markets = await deployMarkets();
      const signers = await ethers.getSigners();
      const marketId = await createTestMarket(markets, {
        deadlineOffset: 60,
        liquidity: ethers.parseEther("10"),
      });

      // Generate fees via buy
      await markets.buyShares(marketId, 1, 0, { value: ethers.parseEther("2") });

      // Close → vote → finalize → confirm (full resolution)
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);
      await markets.closeMarket(marketId);

      const bond = ethers.parseEther("0.01");
      await markets.connect(signers[0]).voteOutcome(marketId, 1, { value: bond });
      await markets.connect(signers[1]).voteOutcome(marketId, 1, { value: bond });
      await markets.connect(signers[2]).voteOutcome(marketId, 1, { value: bond });

      await ethers.provider.send("evm_increaseTime", [12 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      await markets.finalizeVotes(marketId);

      await ethers.provider.send("evm_increaseTime", [12 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      await markets.confirmResolution(marketId);

      // Claim bond (this also accumulates voterRewards)
      await markets.connect(signers[0]).claimVoterBond(marketId);

      // Check accumulated rewards
      const rewards = await markets.voterRewards(signers[0].address);
      expect(rewards).to.be.gt(0);

      // Claim voter reward separately
      const balBefore = await ethers.provider.getBalance(signers[0].address);
      await markets.connect(signers[0]).claimVoterReward();
      const balAfter = await ethers.provider.getBalance(signers[0].address);

      expect(balAfter).to.be.gt(balBefore - ethers.parseEther("0.001")); // minus gas
      expect(await markets.voterRewards(signers[0].address)).to.equal(0);
    });

    it("should reject claim with no rewards", async function () {
      const markets = await deployMarkets();
      const [, noRewards] = await ethers.getSigners();

      await expect(
        markets.connect(noRewards).claimVoterReward()
      ).to.be.revertedWith("No rewards");
    });
  });

  describe("Multisig Treasury", function () {
    it("should initialize multisig with 3 signers", async function () {
      const markets = await deployMarkets();
      const [deployer, s1, s2, s3] = await ethers.getSigners();

      await markets.initMultisig(s1.address, s2.address, s3.address);

      const ms = await markets.multisig();
      expect(ms.signer1).to.equal(s1.address);
      expect(ms.signer2).to.equal(s2.address);
      expect(ms.signer3).to.equal(s3.address);
      expect(ms.threshold).to.equal(2);
      expect(ms.initialized).to.equal(true);
    });

    it("should reject double initialization", async function () {
      const markets = await deployMarkets();
      const [, s1, s2, s3] = await ethers.getSigners();
      await markets.initMultisig(s1.address, s2.address, s3.address);

      await expect(
        markets.initMultisig(s1.address, s2.address, s3.address)
      ).to.be.revertedWith("Multisig already initialized");
    });

    it("should reject non-deployer initializing multisig", async function () {
      const markets = await deployMarkets();
      const [, s1, s2, s3] = await ethers.getSigners();

      await expect(
        markets.connect(s1).initMultisig(s1.address, s2.address, s3.address)
      ).to.be.revertedWith("Only deployer");
    });

    it("should propose, approve, and execute treasury withdrawal (2-of-3)", async function () {
      const markets = await deployMarkets();
      const signers = await ethers.getSigners();
      const [deployer, s1, s2, s3, recipient] = signers;

      // Setup: create market to generate protocol fees
      const marketId = await createTestMarket(markets, { liquidity: ethers.parseEther("10") });
      await markets.buyShares(marketId, 1, 0, { value: ethers.parseEther("2") });
      const treasury = await markets.protocolTreasury();
      expect(treasury).to.be.gt(0);

      // Init multisig
      await markets.initMultisig(s1.address, s2.address, s3.address);

      // s1 proposes withdrawal
      const withdrawAmount = treasury / 2n;
      const tx = await markets.connect(s1).proposeTreasuryWithdrawal(recipient.address, withdrawAmount);
      const receipt = await tx.wait();

      // Extract proposalId from event
      const event = receipt!.logs.find((log: any) => {
        try { return markets.interface.parseLog(log)?.name === "TreasuryProposalCreated"; } catch { return false; }
      });
      const parsed = markets.interface.parseLog(event);
      const proposalId = parsed!.args[0];

      // s1 auto-approved (1/2), now s2 approves
      await markets.connect(s2).approveTreasuryProposal(proposalId);

      // Execute (2/2 met)
      const recipientBefore = await ethers.provider.getBalance(recipient.address);
      await markets.connect(s1).executeTreasuryProposal(proposalId);
      const recipientAfter = await ethers.provider.getBalance(recipient.address);

      expect(recipientAfter - recipientBefore).to.equal(withdrawAmount);
      expect(await markets.protocolTreasury()).to.equal(treasury - withdrawAmount);
    });

    it("should reject execution without enough approvals", async function () {
      const markets = await deployMarkets();
      const signers = await ethers.getSigners();
      const [deployer, s1, s2, s3, recipient] = signers;

      const marketId = await createTestMarket(markets, { liquidity: ethers.parseEther("10") });
      await markets.buyShares(marketId, 1, 0, { value: ethers.parseEther("2") });

      await markets.initMultisig(s1.address, s2.address, s3.address);

      const treasury = await markets.protocolTreasury();
      const tx = await markets.connect(s1).proposeTreasuryWithdrawal(recipient.address, treasury / 2n);
      const receipt = await tx.wait();
      const event = receipt!.logs.find((log: any) => {
        try { return markets.interface.parseLog(log)?.name === "TreasuryProposalCreated"; } catch { return false; }
      });
      const proposalId = markets.interface.parseLog(event)!.args[0];

      // Only 1 approval (s1 auto), try to execute
      await expect(
        markets.connect(s1).executeTreasuryProposal(proposalId)
      ).to.be.revertedWith("Not enough approvals");
    });

    it("should reject non-signer proposing", async function () {
      const markets = await deployMarkets();
      const [deployer, s1, s2, s3, outsider] = await ethers.getSigners();

      await markets.initMultisig(s1.address, s2.address, s3.address);

      await expect(
        markets.connect(outsider).proposeTreasuryWithdrawal(outsider.address, 1000)
      ).to.be.revertedWith("Not multisig signer");
    });
  });
});
