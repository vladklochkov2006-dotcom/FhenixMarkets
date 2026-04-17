// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================================
// FHENIX GOVERNANCE — DAO Governance + Resolver Registry + Slashing
// ============================================================================
// Full governance system: proposals, voting, resolver management,
// multi-resolver panels, slashing, delegation, and reward distribution.
// Uses native ETH for staking and voting (no governance token).
//
// FHE integration: vote amounts are encrypted so nobody can see
// how much weight a voter put behind their vote until finalization.
//
// Uses @fhenixprotocol/cofhe-contracts (CoFHE coprocessor on Sepolia).
// ============================================================================

import {FHE, euint128, ebool} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {ITaskManager} from "@fhenixprotocol/cofhe-contracts/ICofhe.sol";

interface IFhenixMarkets {
    function markets(bytes32 marketId) external view returns (
        bytes32 id, address creator, address resolver, bytes32 questionHash,
        uint8 category, uint8 numOutcomes, uint64 deadline, uint64 resolutionDeadline,
        uint8 status, uint64 createdAt
    );
}

contract FhenixGovernance {

    // ========================================================================
    // CONSTANTS
    // ========================================================================

    uint128 public constant MIN_PROPOSAL_STAKE = 0.01 ether;   // stake to create proposal
    uint128 public constant MIN_VOTE_AMOUNT    = 0.001 ether;  // min vote weight

    uint64 public constant VOTING_PERIOD    = 7 days;
    uint64 public constant TIMELOCK_STANDARD = 2 days;
    uint64 public constant TIMELOCK_LONG     = 3 days;

    // Proposal types
    uint8 public constant PROPOSAL_RESOLVE_DISPUTE  = 1;
    uint8 public constant PROPOSAL_FEE_CHANGE       = 2;
    uint8 public constant PROPOSAL_TREASURY          = 3;
    uint8 public constant PROPOSAL_PARAMETER         = 4;
    uint8 public constant PROPOSAL_EMERGENCY_PAUSE   = 5;
    uint8 public constant PROPOSAL_RESOLVER_ELECTION = 6;

    // Proposal statuses
    uint8 public constant STATUS_ACTIVE   = 0;
    uint8 public constant STATUS_PASSED   = 1;
    uint8 public constant STATUS_REJECTED = 2;
    uint8 public constant STATUS_EXECUTED = 3;
    uint8 public constant STATUS_VETOED   = 4;

    // Quorum requirements (ETH)
    uint128 public constant QUORUM_RESOLVE   = 0.1 ether;
    uint128 public constant QUORUM_FEE       = 0.5 ether;
    uint128 public constant QUORUM_TREASURY  = 1 ether;
    uint128 public constant QUORUM_PARAMETER = 0.25 ether;
    uint128 public constant QUORUM_EMERGENCY = 0.05 ether;
    uint128 public constant QUORUM_RESOLVER  = 0.5 ether;

    // Resolver tiers
    uint8 public constant TIER_BRONZE    = 1;
    uint8 public constant TIER_SILVER    = 2;
    uint8 public constant TIER_GOLD      = 3;
    uint8 public constant TIER_COMMITTEE = 4;

    uint128 public constant RESOLVER_STAKE_BRONZE = 0.05 ether;

    // Slashing
    uint128 public constant SLASH_PERCENT_MINOR = 10;  // 10%
    uint128 public constant SLASH_PERCENT_MAJOR = 25;  // 25%
    uint8   public constant MAX_STRIKES = 3;

    // Tier upgrade thresholds
    uint64  public constant SILVER_MARKETS_REQUIRED   = 10;
    uint128 public constant SILVER_REPUTATION_MIN     = 12000;
    uint64  public constant GOLD_MARKETS_REQUIRED     = 50;
    uint128 public constant GOLD_REPUTATION_MIN       = 15000;

    // Panel
    uint8 public constant PANEL_SIZE     = 3;
    uint8 public constant PANEL_MAJORITY = 2;

    // ========================================================================
    // STRUCTS
    // ========================================================================

    struct Proposal {
        bytes32 id;
        address proposer;
        uint8   proposalType;
        bytes32 target;          // market ID or parameter key
        uint128 payload1;        // value (e.g. new fee amount)
        bytes32 payload2;        // secondary data
        uint128 votesFor;        // decrypted aggregate (updated on finalize)
        uint128 votesAgainst;    // decrypted aggregate (updated on finalize)
        uint128 quorumRequired;
        uint64  createdAt;
        uint64  votingDeadline;
        uint64  timelockUntil;
        uint8   status;
    }

    struct ResolverProfile {
        address resolver;
        uint128 stakeAmount;
        uint8   tier;
        uint64  marketsResolved;
        uint64  disputesReceived;
        uint64  disputesLost;
        uint8   strikes;
        uint128 reputationScore;
        uint64  registeredAt;
        uint64  lastActiveAt;
        bool    isActive;
    }

    struct MultiResolverPanel {
        bytes32 marketId;
        address resolver1;
        address resolver2;
        address resolver3;
        uint8   votesSubmitted;
        uint8[5] outcomeVotes;  // index 1-4 for outcomes
        bool    finalized;
        uint8   winningOutcome;
        uint64  assignedAt;
    }

    struct GuardianConfig {
        address guardian1;
        address guardian2;
        address guardian3;
        uint8   threshold;
    }

    struct RewardEpoch {
        uint64  epochId;
        uint128 totalLPReward;
        uint128 totalTraderReward;
        uint128 totalLPContributions;
        uint128 totalTradeVolume;
        uint64  startedAt;
        bool    distributed;
    }

    // ========================================================================
    // STATE
    // ========================================================================

    address public deployer;
    bool    public initialized;

    IFhenixMarkets public marketsContract;

    // Governance proposals
    mapping(bytes32 => Proposal) public proposals;
    uint256 public proposalCount;

    // Vote tracking: keccak256(proposalId, voter) => voted
    mapping(bytes32 => bool) private hasVoted;

    // ---- FHE: Encrypted vote weights ----
    // keccak256(proposalId, voter) => encrypted vote amount
    mapping(bytes32 => euint128) private encVoteWeights;
    // Encrypted aggregate tallies: proposalId => encrypted sum
    mapping(bytes32 => euint128) private encVotesFor;
    mapping(bytes32 => euint128) private encVotesAgainst;

    // Vote lock tracking: voter => total locked ETH
    mapping(address => uint128) private voteLocks;
    // Per-proposal locks: keccak256(proposalId, voter) => locked amount (plaintext for unlock)
    mapping(bytes32 => uint128) private proposalLocks;


    // Guardian config
    GuardianConfig public guardians;

    // Delegation: keccak256(delegator, delegate) => amount
    mapping(bytes32 => uint128) private delegationAmounts;
    // Total delegated power to an address
    mapping(address => uint128) private delegatedPower;

    // Resolver registry
    mapping(address => ResolverProfile) public resolverRegistry;
    mapping(address => bool)   public blacklistedResolvers;

    // Committee (up to 5 members)
    address[5] public committeeMembers;
    uint8      public committeeSize;

    // Committee votes: keccak256(marketId, voter) => voted
    mapping(bytes32 => bool) public committeeVoted;
    // Committee outcome tally: keccak256(marketId, outcome) => vote count
    mapping(bytes32 => uint8) public committeeOutcomeVotes;
    // Committee decision: marketId => (outcome, finalized)
    mapping(bytes32 => uint8) public committeeDecision;
    mapping(bytes32 => bool)  public committeeFinalized;

    // Multi-resolver panels
    mapping(bytes32 => MultiResolverPanel) public resolverPanels;
    // Panel votes: keccak256(marketId, resolver) => voted
    mapping(bytes32 => bool) public panelVoted;

    // Governance-resolved outcomes: marketId => outcome
    mapping(bytes32 => uint8) public governanceResolvedOutcomes;

    // Governance execution flags
    mapping(bytes32 => bool)   public approvedResolvers;    // hash(address) => approved
    mapping(bytes32 => uint128) public governanceParams;     // paramKey => value
    bool public governancePaused;

    // Reward epochs
    mapping(uint64 => RewardEpoch) public rewardEpochs;
    uint64 public currentEpochId;
    // User contributions: keccak256(user, epochId) => (lpContribution, tradeVolume)
    mapping(bytes32 => uint128) private userLPContributions;
    mapping(bytes32 => uint128) private userTradeVolume;
    mapping(bytes32 => bool)    private rewardClaimed;

    // Protocol treasury held by governance
    uint128 public treasuryBalance;

    // ========================================================================
    // EVENTS
    // ========================================================================

    event GovernanceInitialized(address guardian1, address guardian2, address guardian3);
    event ProposalCreated(bytes32 indexed proposalId, address proposer, uint8 proposalType);
    event VoteCast(bytes32 indexed proposalId, address indexed voter);
    event VoteFinalized(bytes32 indexed proposalId, uint8 status);
    event ProposalExecuted(bytes32 indexed proposalId);
    event ProposalVetoed(bytes32 indexed proposalId);

    event ResolverRegistered(address indexed resolver);
    event ResolverUnstaked(address indexed resolver);
    event ResolverSlashed(address indexed resolver);
    event ResolverBlacklisted(address indexed resolver);
    event ResolverTierUpgraded(address indexed resolver, uint8 newTier);

    event PanelAssigned(bytes32 indexed marketId);
    event PanelVoteSubmitted(bytes32 indexed marketId, address indexed resolver);
    event PanelFinalized(bytes32 indexed marketId);

    event DelegationCreated(address indexed delegator, address indexed delegate);
    event DelegationRemoved(address indexed delegator, address indexed delegate);

    event RewardEpochFunded(uint64 epochId);
    event RewardClaimed(address indexed user);

    // ========================================================================
    // MODIFIERS
    // ========================================================================

    modifier onlyDeployer() {
        require(msg.sender == deployer, "Only deployer");
        _;
    }

    modifier onlyGuardian() {
        require(
            msg.sender == guardians.guardian1 ||
            msg.sender == guardians.guardian2 ||
            msg.sender == guardians.guardian3,
            "Not guardian"
        );
        _;
    }

    modifier whenInitialized() {
        require(initialized, "Not initialized");
        _;
    }

    modifier whenNotPaused() {
        require(!governancePaused, "Paused");
        _;
    }

    // ========================================================================
    // CONSTRUCTOR
    // ========================================================================

    constructor() {
        deployer = msg.sender;
    }

    // ========================================================================
    // INITIALIZATION
    // ========================================================================

    function initGovernance(
        address guardian1,
        address guardian2,
        address guardian3,
        address _marketsContract
    ) external onlyDeployer {
        require(!initialized, "Already initialized");
        require(guardian1 != address(0) && guardian2 != address(0) && guardian3 != address(0), "Zero guardian");

        guardians = GuardianConfig({
            guardian1: guardian1,
            guardian2: guardian2,
            guardian3: guardian3,
            threshold: 2
        });

        marketsContract = IFhenixMarkets(_marketsContract);
        initialized = true;

        emit GovernanceInitialized(guardian1, guardian2, guardian3);
    }

    // ########################################################################
    //                    GOVERNANCE PROPOSALS (T1–T8)
    // ########################################################################

    // ========================================================================
    // T1. CREATE PROPOSAL — Stake ETH to create
    // ========================================================================

    function createProposal(
        uint8   proposalType,
        bytes32 target,
        uint128 payload1,
        bytes32 payload2
    ) external payable whenInitialized whenNotPaused returns (bytes32) {
        require(proposalType >= 1 && proposalType <= 6, "Invalid type");
        require(msg.value >= MIN_PROPOSAL_STAKE, "Min stake");

        bytes32 proposalId = keccak256(abi.encodePacked(
            msg.sender, proposalType, target, payload1, block.timestamp
        ));

        require(proposals[proposalId].proposer == address(0), "Exists");

        uint128 quorum = _getQuorum(proposalType);

        proposals[proposalId] = Proposal({
            id: proposalId,
            proposer: msg.sender,
            proposalType: proposalType,
            target: target,
            payload1: payload1,
            payload2: payload2,
            votesFor: 0,
            votesAgainst: 0,
            quorumRequired: quorum,
            createdAt: uint64(block.timestamp),
            votingDeadline: uint64(block.timestamp) + VOTING_PERIOD,
            timelockUntil: 0,
            status: STATUS_ACTIVE
        });

        // Initialize encrypted tallies
        euint128 zeroEnc = FHE.asEuint128(uint256(0));
        FHE.allowThis(zeroEnc);
        encVotesFor[proposalId] = zeroEnc;

        euint128 zeroEnc2 = FHE.asEuint128(uint256(0));
        FHE.allowThis(zeroEnc2);
        encVotesAgainst[proposalId] = zeroEnc2;

        // Lock proposer's stake
        voteLocks[msg.sender] += uint128(msg.value);
        bytes32 lockKey = keccak256(abi.encodePacked(proposalId, msg.sender));
        proposalLocks[lockKey] = uint128(msg.value);

        proposalCount++;

        emit ProposalCreated(proposalId, msg.sender, proposalType);
        return proposalId;
    }

    // ========================================================================
    // T2. VOTE FOR — Encrypted vote weight
    // ========================================================================

    function voteFor(bytes32 proposalId) external payable whenInitialized whenNotPaused {
        _castVote(proposalId, true);
    }

    // ========================================================================
    // T3. VOTE AGAINST — Encrypted vote weight
    // ========================================================================

    function voteAgainst(bytes32 proposalId) external payable whenInitialized whenNotPaused {
        _castVote(proposalId, false);
    }

    function _castVote(bytes32 proposalId, bool support) internal {
        Proposal storage prop = proposals[proposalId];
        require(prop.proposer != address(0), "Not found");
        require(prop.status == STATUS_ACTIVE, "Not active");
        require(block.timestamp <= prop.votingDeadline, "Voting closed");
        require(msg.value >= MIN_VOTE_AMOUNT, "Min vote");

        bytes32 voteKey = keccak256(abi.encodePacked(proposalId, msg.sender));
        require(!hasVoted[voteKey], "Already voted");

        hasVoted[voteKey] = true;
        uint128 amount = uint128(msg.value);

        // Lock voter's stake
        voteLocks[msg.sender] += amount;
        proposalLocks[voteKey] = amount;

        // ---- FHE: Encrypt vote weight (PRIVATE) ----
        euint128 encAmount = FHE.asEuint128(uint256(amount));
        FHE.allowThis(encAmount);
        FHE.allowSender(encAmount);
        encVoteWeights[voteKey] = encAmount;

        // Add to encrypted tally — nobody sees individual weights
        if (support) {
            euint128 newTally = FHE.add(encVotesFor[proposalId], encAmount);
            FHE.allowThis(newTally);
            encVotesFor[proposalId] = newTally;
        } else {
            euint128 newTally = FHE.add(encVotesAgainst[proposalId], encAmount);
            FHE.allowThis(newTally);
            encVotesAgainst[proposalId] = newTally;
        }

        emit VoteCast(proposalId, msg.sender);
    }

    // ========================================================================
    // T4. UNLOCK AFTER VOTE — Return staked ETH
    // ========================================================================

    function unlockAfterVote(bytes32 proposalId) external {
        Proposal storage prop = proposals[proposalId];
        require(
            prop.status != STATUS_ACTIVE || block.timestamp > prop.votingDeadline,
            "Still active"
        );

        bytes32 lockKey = keccak256(abi.encodePacked(proposalId, msg.sender));
        uint128 locked = proposalLocks[lockKey];
        require(locked > 0, "Nothing locked");

        proposalLocks[lockKey] = 0;
        voteLocks[msg.sender] -= locked;

        (bool sent, ) = payable(msg.sender).call{value: locked}("");
        require(sent, "Transfer failed");
    }

    // ========================================================================
    // T4b. REQUEST VOTE DECRYPTION
    // ========================================================================

    mapping(bytes32 => bool) public decryptionRequested;

    function requestVoteDecryption(bytes32 proposalId) external whenInitialized {
        Proposal storage prop = proposals[proposalId];
        require(prop.status == STATUS_ACTIVE, "Not active");
        require(block.timestamp > prop.votingDeadline, "Voting open");
        require(!decryptionRequested[proposalId], "Already requested");

        decryptionRequested[proposalId] = true;

        ITaskManager(0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9).createDecryptTask(uint256(euint128.unwrap(encVotesFor[proposalId])), msg.sender);
        ITaskManager(0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9).createDecryptTask(uint256(euint128.unwrap(encVotesAgainst[proposalId])), msg.sender);
    }

    // ========================================================================
    // T5. FINALIZE VOTE — Decrypt tallies and determine outcome
    // ========================================================================

    // Finalize vote — uses getDecryptResultSafe to handle async CoFHE decryption
    function finalizeVote(bytes32 proposalId) external whenInitialized {
        Proposal storage prop = proposals[proposalId];
        require(prop.status == STATUS_ACTIVE, "Not active");
        require(block.timestamp > prop.votingDeadline, "Voting open");
        require(decryptionRequested[proposalId], "Decryption not requested");

        // ---- FHE: Read decrypted tallies from CoFHE (safe version) ----
        (uint128 totalFor, bool forDecrypted) = FHE.getDecryptResultSafe(encVotesFor[proposalId]);
        (uint128 totalAgainst, bool againstDecrypted) = FHE.getDecryptResultSafe(encVotesAgainst[proposalId]);
        require(forDecrypted && againstDecrypted, "Decryption pending, try again later");

        prop.votesFor     = totalFor;
        prop.votesAgainst = totalAgainst;

        uint128 totalVotes = totalFor + totalAgainst;

        if (totalVotes >= prop.quorumRequired && totalFor > totalAgainst) {
            prop.status = STATUS_PASSED;
            // Set timelock
            if (prop.proposalType == PROPOSAL_EMERGENCY_PAUSE) {
                prop.timelockUntil = uint64(block.timestamp); // immediate
            } else if (prop.proposalType == PROPOSAL_TREASURY) {
                prop.timelockUntil = uint64(block.timestamp) + TIMELOCK_LONG;
            } else {
                prop.timelockUntil = uint64(block.timestamp) + TIMELOCK_STANDARD;
            }
        } else {
            prop.status = STATUS_REJECTED;
        }

        emit VoteFinalized(proposalId, prop.status);
    }

    // ========================================================================
    // T6. EXECUTE GOVERNANCE — Execute a passed proposal after timelock
    // ========================================================================

    function executeGovernance(bytes32 proposalId) external whenInitialized {
        Proposal storage prop = proposals[proposalId];
        require(prop.status == STATUS_PASSED, "Not passed");
        require(block.timestamp >= prop.timelockUntil, "Timelocked");

        prop.status = STATUS_EXECUTED;

        // Execute based on type
        if (prop.proposalType == PROPOSAL_FEE_CHANGE) {
            governanceParams[prop.target] = prop.payload1;
        } else if (prop.proposalType == PROPOSAL_PARAMETER) {
            governanceParams[prop.target] = prop.payload1;
        } else if (prop.proposalType == PROPOSAL_EMERGENCY_PAUSE) {
            governancePaused = prop.payload1 > 0;
        } else if (prop.proposalType == PROPOSAL_RESOLVER_ELECTION) {
            approvedResolvers[prop.target] = true;
        } else if (prop.proposalType == PROPOSAL_RESOLVE_DISPUTE) {
            governanceResolvedOutcomes[prop.target] = uint8(prop.payload1);
        } else if (prop.proposalType == PROPOSAL_TREASURY) {
            _executeTreasuryProposal(prop.payload1, prop.payload2);
        }

        emit ProposalExecuted(proposalId);
    }

    // ========================================================================
    // T7. VETO PROPOSAL — Guardian can veto
    // ========================================================================

    function vetoProposal(bytes32 proposalId) external onlyGuardian {
        Proposal storage prop = proposals[proposalId];
        require(
            prop.status == STATUS_ACTIVE || prop.status == STATUS_PASSED,
            "Cannot veto"
        );

        prop.status = STATUS_VETOED;
        emit ProposalVetoed(proposalId);
    }

    // ########################################################################
    //                        DELEGATION (T8–T9)
    // ########################################################################

    // ========================================================================
    // T8. DELEGATE VOTES
    // ========================================================================

    function delegateVotes(address delegate) external payable whenInitialized {
        require(delegate != address(0) && delegate != msg.sender, "Invalid delegate");
        require(msg.value > 0, "No value");

        uint128 amount = uint128(msg.value);
        bytes32 delKey = keccak256(abi.encodePacked(msg.sender, delegate));

        delegationAmounts[delKey] += amount;
        delegatedPower[delegate]  += amount;

        emit DelegationCreated(msg.sender, delegate);
    }

    // ========================================================================
    // T9. UNDELEGATE VOTES
    // ========================================================================

    function undelegateVotes(address delegate) external {
        bytes32 delKey = keccak256(abi.encodePacked(msg.sender, delegate));
        uint128 amount = delegationAmounts[delKey];
        require(amount > 0, "No delegation");

        delegationAmounts[delKey] = 0;
        delegatedPower[delegate] -= amount;

        (bool sent, ) = payable(msg.sender).call{value: amount}("");
        require(sent, "Transfer failed");

        emit DelegationRemoved(msg.sender, delegate);
    }

    // ########################################################################
    //                    RESOLVER REGISTRY (T10–T16)
    // ########################################################################

    // ========================================================================
    // T10. REGISTER RESOLVER — Stake ETH to become resolver
    // ========================================================================

    function registerResolver() external payable whenInitialized {
        require(msg.value >= RESOLVER_STAKE_BRONZE, "Min stake");
        require(!blacklistedResolvers[msg.sender], "Blacklisted");
        require(!resolverRegistry[msg.sender].isActive, "Already registered");

        resolverRegistry[msg.sender] = ResolverProfile({
            resolver: msg.sender,
            stakeAmount: uint128(msg.value),
            tier: TIER_BRONZE,
            marketsResolved: 0,
            disputesReceived: 0,
            disputesLost: 0,
            strikes: 0,
            reputationScore: 10000, // start at 100.00
            registeredAt: uint64(block.timestamp),
            lastActiveAt: uint64(block.timestamp),
            isActive: true
        });

        emit ResolverRegistered(msg.sender);
    }

    // ========================================================================
    // T11. UNSTAKE RESOLVER
    // ========================================================================

    function unstakeResolver() external {
        ResolverProfile storage profile = resolverRegistry[msg.sender];
        require(profile.isActive, "Not active");

        uint128 stake = profile.stakeAmount;
        profile.isActive = false;
        profile.stakeAmount = 0;

        (bool sent, ) = payable(msg.sender).call{value: stake}("");
        require(sent, "Transfer failed");

        emit ResolverUnstaked(msg.sender);
    }

    // ========================================================================
    // T12. SLASH RESOLVER — Deployer/guardian punishes bad resolver
    // ========================================================================

    function slashResolver(address resolver) external {
        require(msg.sender == deployer || _isGuardian(msg.sender), "Not authorized");

        ResolverProfile storage profile = resolverRegistry[resolver];
        require(profile.isActive, "Not active");

        profile.strikes++;

        uint128 slashPercent = profile.strikes >= 2 ? SLASH_PERCENT_MAJOR : SLASH_PERCENT_MINOR;
        uint128 slashAmount = (profile.stakeAmount * slashPercent) / 100;

        profile.stakeAmount -= slashAmount;
        profile.reputationScore = profile.reputationScore > 1000
            ? profile.reputationScore - 1000
            : 0;

        // Auto-blacklist after MAX_STRIKES
        if (profile.strikes >= MAX_STRIKES) {
            profile.isActive = false;
            blacklistedResolvers[resolver] = true;
            emit ResolverBlacklisted(resolver);
        }

        // Slashed ETH goes to treasury
        treasuryBalance += slashAmount;

        emit ResolverSlashed(resolver);
    }

    // ========================================================================
    // T13. UPGRADE RESOLVER TIER
    // ========================================================================

    function upgradeResolverTier(address resolver) external whenInitialized {
        ResolverProfile storage profile = resolverRegistry[resolver];
        require(profile.isActive, "Not active");

        if (profile.tier == TIER_BRONZE) {
            require(
                profile.marketsResolved >= SILVER_MARKETS_REQUIRED &&
                profile.reputationScore >= SILVER_REPUTATION_MIN,
                "Not eligible for Silver"
            );
            profile.tier = TIER_SILVER;
        } else if (profile.tier == TIER_SILVER) {
            require(
                profile.marketsResolved >= GOLD_MARKETS_REQUIRED &&
                profile.reputationScore >= GOLD_REPUTATION_MIN,
                "Not eligible for Gold"
            );
            profile.tier = TIER_GOLD;
        } else {
            revert("Max tier");
        }

        emit ResolverTierUpgraded(resolver, profile.tier);
    }

    // ========================================================================
    // T14. BLACKLIST RESOLVER
    // ========================================================================

    function blacklistResolver(address resolver) external {
        require(msg.sender == deployer || _isGuardian(msg.sender), "Not authorized");

        resolverRegistry[resolver].isActive = false;
        blacklistedResolvers[resolver] = true;

        emit ResolverBlacklisted(resolver);
    }

    // ========================================================================
    // T15. UPDATE RESOLVER STATS
    // ========================================================================

    function updateResolverStats(
        address resolver,
        bool    resolved,
        bool    disputed,
        bool    disputeLost
    ) external onlyDeployer {
        ResolverProfile storage profile = resolverRegistry[resolver];
        require(profile.isActive, "Not active");

        if (resolved) {
            profile.marketsResolved++;
            profile.reputationScore += 100; // +1.00
        }
        if (disputed) {
            profile.disputesReceived++;
            profile.reputationScore = profile.reputationScore > 200
                ? profile.reputationScore - 200
                : 0;
        }
        if (disputeLost) {
            profile.disputesLost++;
        }
        profile.lastActiveAt = uint64(block.timestamp);
    }

    // ========================================================================
    // T16. SET COMMITTEE MEMBERS
    // ========================================================================

    function setCommitteeMembers(address[5] calldata members, uint8 size) external onlyDeployer {
        require(size <= 5, "Max 5");
        committeeMembers = members;
        committeeSize = size;
    }

    // ########################################################################
    //                    MULTI-RESOLVER PANELS (T17–T19)
    // ########################################################################

    // ========================================================================
    // T17. ASSIGN RESOLVER PANEL — Deployer assigns 3 resolvers to a market
    // ========================================================================

    function assignResolverPanel(
        bytes32 marketId,
        address r1,
        address r2,
        address r3
    ) external onlyDeployer {
        require(resolverRegistry[r1].isActive, "R1 not active");
        require(resolverRegistry[r2].isActive, "R2 not active");
        require(resolverRegistry[r3].isActive, "R3 not active");

        resolverPanels[marketId] = MultiResolverPanel({
            marketId: marketId,
            resolver1: r1,
            resolver2: r2,
            resolver3: r3,
            votesSubmitted: 0,
            outcomeVotes: [0, 0, 0, 0, 0],
            finalized: false,
            winningOutcome: 0,
            assignedAt: uint64(block.timestamp)
        });

        emit PanelAssigned(marketId);
    }

    // ========================================================================
    // T18. PANEL VOTE — Resolver submits their outcome vote
    // ========================================================================

    function panelVote(bytes32 marketId, uint8 outcome) external {
        MultiResolverPanel storage panel = resolverPanels[marketId];
        require(!panel.finalized, "Already finalized");
        require(
            msg.sender == panel.resolver1 ||
            msg.sender == panel.resolver2 ||
            msg.sender == panel.resolver3,
            "Not on panel"
        );
        require(outcome >= 1 && outcome <= 4, "Invalid outcome");

        bytes32 pvKey = keccak256(abi.encodePacked(marketId, msg.sender));
        require(!panelVoted[pvKey], "Already voted");

        panelVoted[pvKey] = true;
        panel.votesSubmitted++;
        panel.outcomeVotes[outcome]++;

        emit PanelVoteSubmitted(marketId, msg.sender);

        // Auto-finalize when majority reached
        if (panel.outcomeVotes[outcome] >= PANEL_MAJORITY) {
            panel.finalized = true;
            panel.winningOutcome = outcome;
            emit PanelFinalized(marketId);
        }
    }

    // ########################################################################
    //                    COMMITTEE VOTING (T19–T20)
    // ########################################################################

    // ========================================================================
    // T19. COMMITTEE VOTE — Committee member votes on outcome
    // ========================================================================

    function committeeVoteResolve(bytes32 marketId, uint8 outcome) external {
        require(_isCommitteeMember(msg.sender), "Not committee");
        require(outcome >= 1 && outcome <= 4, "Invalid");
        require(!committeeFinalized[marketId], "Already finalized");

        bytes32 cvKey = keccak256(abi.encodePacked(marketId, msg.sender));
        require(!committeeVoted[cvKey], "Already voted");

        committeeVoted[cvKey] = true;

        bytes32 coKey = keccak256(abi.encodePacked(marketId, outcome));
        committeeOutcomeVotes[coKey]++;

        // Auto-finalize on majority
        if (committeeOutcomeVotes[coKey] >= (committeeSize + 1) / 2) {
            committeeFinalized[marketId] = true;
            committeeDecision[marketId] = outcome;
        }
    }

    // ========================================================================
    // T20. FINALIZE COMMITTEE VOTE — explicit finalization of committee decision
    // ========================================================================

    function finalizeCommitteeVote(bytes32 marketId) external {
        require(!committeeFinalized[marketId], "Already finalized");

        // Find outcome with most votes
        uint8 bestOutcome = 0;
        uint8 bestVotes = 0;
        for (uint8 o = 1; o <= 4; o++) {
            bytes32 coKey = keccak256(abi.encodePacked(marketId, o));
            uint8 votes = committeeOutcomeVotes[coKey];
            if (votes > bestVotes) {
                bestVotes = votes;
                bestOutcome = o;
            }
        }

        require(bestVotes >= (committeeSize + 1) / 2, "No majority");

        committeeFinalized[marketId] = true;
        committeeDecision[marketId] = bestOutcome;
    }

    // ========================================================================
    // T21. GOVERNANCE RESOLVE — Direct resolution via governance vote
    // ========================================================================

    function governanceResolve(bytes32 marketId, uint8 winningOutcome) external onlyDeployer {
        require(winningOutcome >= 1 && winningOutcome <= 4, "Invalid");
        governanceResolvedOutcomes[marketId] = winningOutcome;
    }

    // ########################################################################
    //                    ESCALATION (T21–T22)
    // ########################################################################

    // Escalation statuses
    uint8 public constant ESCALATION_NONE       = 0;
    uint8 public constant ESCALATION_INITIATED  = 1;
    uint8 public constant ESCALATION_COMMUNITY  = 2;
    uint8 public constant ESCALATION_RESOLVED   = 3;

    uint64  public constant ESCALATION_WINDOW   = 3 days;
    uint128 public constant ESCALATION_BOND     = 0.01 ether;

    struct Escalation {
        bytes32 marketId;
        address initiator;
        uint8   proposedOutcome;
        uint8   status;
        uint64  initiatedAt;
        uint128 bondAmount;
        // Community vote tallies
        uint128 votesFor;
        uint128 votesAgainst;
        uint64  communityDeadline;
    }

    mapping(bytes32 => Escalation) public escalations;
    // keccak256(marketId, voter) => voted in community escalation
    mapping(bytes32 => bool) private escalationVoted;
    // keccak256(marketId, voter) => bond deposited
    mapping(bytes32 => uint128) private escalationBonds;

    event EscalationInitiated(bytes32 indexed marketId, address indexed initiator);
    event EscalatedToCommunity(bytes32 indexed marketId);
    event EscalationVoteCast(bytes32 indexed marketId, address indexed voter);
    event EscalationResolved(bytes32 indexed marketId);

    /// @notice Initiate escalation for a disputed market to governance resolution
    function initiateEscalation(
        bytes32 marketId,
        uint8   proposedOutcome
    ) external payable whenInitialized {
        require(msg.value >= ESCALATION_BOND, "Min bond");
        require(proposedOutcome >= 1 && proposedOutcome <= 4, "Invalid outcome");
        require(escalations[marketId].status == ESCALATION_NONE, "Already escalated");

        escalations[marketId] = Escalation({
            marketId: marketId,
            initiator: msg.sender,
            proposedOutcome: proposedOutcome,
            status: ESCALATION_INITIATED,
            initiatedAt: uint64(block.timestamp),
            bondAmount: uint128(msg.value),
            votesFor: 0,
            votesAgainst: 0,
            communityDeadline: 0
        });

        emit EscalationInitiated(marketId, msg.sender);
    }

    /// @notice Escalate to community voting — opens a community vote window
    function escalateToCommunity(bytes32 marketId) external whenInitialized {
        Escalation storage esc = escalations[marketId];
        require(esc.status == ESCALATION_INITIATED, "Not initiated");
        // Only deployer, guardian, or the initiator can escalate to community
        require(
            msg.sender == deployer ||
            _isGuardian(msg.sender) ||
            msg.sender == esc.initiator,
            "Not authorized"
        );

        esc.status = ESCALATION_COMMUNITY;
        esc.communityDeadline = uint64(block.timestamp) + ESCALATION_WINDOW;

        emit EscalatedToCommunity(marketId);
    }

    /// @notice Vote in community escalation (ETH-weighted)
    function voteEscalation(bytes32 marketId, bool support) external payable whenInitialized {
        Escalation storage esc = escalations[marketId];
        require(esc.status == ESCALATION_COMMUNITY, "Not in community vote");
        require(block.timestamp <= esc.communityDeadline, "Voting closed");
        require(msg.value > 0, "No value");

        bytes32 voteKey = keccak256(abi.encodePacked(marketId, msg.sender));
        require(!escalationVoted[voteKey], "Already voted");

        escalationVoted[voteKey] = true;
        uint128 amount = uint128(msg.value);
        escalationBonds[voteKey] = amount;

        if (support) {
            esc.votesFor += amount;
        } else {
            esc.votesAgainst += amount;
        }

        emit EscalationVoteCast(marketId, msg.sender);
    }

    /// @notice Finalize community escalation and resolve the outcome
    function finalizeEscalation(bytes32 marketId) external whenInitialized {
        Escalation storage esc = escalations[marketId];
        require(esc.status == ESCALATION_COMMUNITY, "Not in community vote");
        require(block.timestamp > esc.communityDeadline, "Still voting");

        esc.status = ESCALATION_RESOLVED;

        if (esc.votesFor > esc.votesAgainst) {
            // Community approved the escalation — apply proposed outcome
            governanceResolvedOutcomes[esc.marketId] = esc.proposedOutcome;
            emit EscalationResolved(marketId);
        } else {
            // Community rejected — outcome stays as-is
            emit EscalationResolved(marketId);
        }
    }

    /// @notice Withdraw escalation bond after resolution
    function withdrawEscalationBond(bytes32 marketId) external {
        bytes32 voteKey = keccak256(abi.encodePacked(marketId, msg.sender));
        uint128 bond = escalationBonds[voteKey];

        // Also allow initiator to claim their bond
        Escalation storage esc = escalations[marketId];
        if (msg.sender == esc.initiator && esc.bondAmount > 0) {
            require(esc.status == ESCALATION_RESOLVED, "Not resolved");
            bond += esc.bondAmount;
            esc.bondAmount = 0;
        }

        require(bond > 0, "No bond");
        escalationBonds[voteKey] = 0;

        (bool sent, ) = payable(msg.sender).call{value: bond}("");
        require(sent, "Transfer failed");
    }

    // ########################################################################
    //                        REWARDS (T23–T25)
    // ########################################################################

    // ========================================================================
    // T21. FUND REWARD EPOCH
    // ========================================================================

    function fundRewardEpoch(
        uint128 lpReward,
        uint128 traderReward
    ) external payable onlyDeployer {
        require(msg.value >= lpReward + traderReward, "Insufficient");

        currentEpochId++;

        rewardEpochs[currentEpochId] = RewardEpoch({
            epochId: currentEpochId,
            totalLPReward: lpReward,
            totalTraderReward: traderReward,
            totalLPContributions: 0,
            totalTradeVolume: 0,
            startedAt: uint64(block.timestamp),
            distributed: false
        });

        emit RewardEpochFunded(currentEpochId);
    }

    // ========================================================================
    // T22. RECORD CONTRIBUTION — Track user activity for rewards
    // ========================================================================

    function recordContribution(
        address user,
        uint64  epochId,
        uint128 lpContribution,
        uint128 tradeVolume
    ) external onlyDeployer {
        bytes32 key = keccak256(abi.encodePacked(user, epochId));

        userLPContributions[key] += lpContribution;
        userTradeVolume[key]     += tradeVolume;

        RewardEpoch storage epoch = rewardEpochs[epochId];
        epoch.totalLPContributions += lpContribution;
        epoch.totalTradeVolume     += tradeVolume;
    }

    // ========================================================================
    // T23. CLAIM REWARD
    // ========================================================================

    function claimReward(uint64 epochId) external {
        bytes32 key = keccak256(abi.encodePacked(msg.sender, epochId));
        require(!rewardClaimed[key], "Already claimed");

        RewardEpoch storage epoch = rewardEpochs[epochId];
        require(epoch.epochId > 0, "No epoch");

        uint128 lpContrib    = userLPContributions[key];
        uint128 tradeVol     = userTradeVolume[key];

        uint128 lpReward = 0;
        if (epoch.totalLPContributions > 0 && lpContrib > 0) {
            lpReward = (lpContrib * epoch.totalLPReward) / epoch.totalLPContributions;
        }

        uint128 traderReward = 0;
        if (epoch.totalTradeVolume > 0 && tradeVol > 0) {
            traderReward = (tradeVol * epoch.totalTraderReward) / epoch.totalTradeVolume;
        }

        uint128 totalReward = lpReward + traderReward;
        require(totalReward > 0, "No reward");

        rewardClaimed[key] = true;

        (bool sent, ) = payable(msg.sender).call{value: totalReward}("");
        require(sent, "Transfer failed");

        emit RewardClaimed(msg.sender);
    }

    // ########################################################################
    //                          TREASURY
    // ########################################################################

    function depositProtocolFees() external payable {
        treasuryBalance += uint128(msg.value);
    }

    function withdrawTreasury(uint128 amount, address recipient) external onlyDeployer {
        require(amount <= treasuryBalance, "Exceeds balance");
        treasuryBalance -= amount;

        (bool sent, ) = payable(recipient).call{value: amount}("");
        require(sent, "Transfer failed");
    }

    // ########################################################################
    //                         VIEW FUNCTIONS
    // ########################################################################

    function getProposal(bytes32 proposalId) external view returns (Proposal memory) {
        return proposals[proposalId];
    }

    function getResolverProfile(address resolver) external view returns (ResolverProfile memory) {
        return resolverRegistry[resolver];
    }

    function getPanel(bytes32 marketId) external view returns (MultiResolverPanel memory) {
        return resolverPanels[marketId];
    }

    // ########################################################################
    //                         INTERNAL HELPERS
    // ########################################################################

    function _getQuorum(uint8 proposalType) internal pure returns (uint128) {
        if (proposalType == PROPOSAL_RESOLVE_DISPUTE)  return QUORUM_RESOLVE;
        if (proposalType == PROPOSAL_FEE_CHANGE)       return QUORUM_FEE;
        if (proposalType == PROPOSAL_TREASURY)          return QUORUM_TREASURY;
        if (proposalType == PROPOSAL_PARAMETER)         return QUORUM_PARAMETER;
        if (proposalType == PROPOSAL_EMERGENCY_PAUSE)   return QUORUM_EMERGENCY;
        if (proposalType == PROPOSAL_RESOLVER_ELECTION) return QUORUM_RESOLVER;
        return QUORUM_TREASURY; // default highest
    }

    function _isGuardian(address addr) internal view returns (bool) {
        return addr == guardians.guardian1 ||
               addr == guardians.guardian2 ||
               addr == guardians.guardian3;
    }

    function _isCommitteeMember(address addr) internal view returns (bool) {
        for (uint8 i = 0; i < committeeSize; i++) {
            if (committeeMembers[i] == addr) return true;
        }
        return false;
    }

    function _executeTreasuryProposal(uint128 amount, bytes32 recipientHash) internal {
        require(amount <= treasuryBalance, "Exceeds treasury");
        treasuryBalance -= amount;

        // recipientHash = bytes32(uint256(uint160(recipient)))
        address recipient = address(uint160(uint256(recipientHash)));
        require(recipient != address(0), "Zero address");

        (bool sent, ) = payable(recipient).call{value: amount}("");
        require(sent, "Transfer failed");
    }

    // ========================================================================
    // RECEIVE
    // ========================================================================

    receive() external payable {}
}
