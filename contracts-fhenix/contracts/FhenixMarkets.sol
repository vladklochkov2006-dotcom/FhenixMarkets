// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================================
// FHENIX MARKETS — Privacy-Preserving Prediction Market Protocol
// ============================================================================
// FPMM (Fixed Product Market Maker) with FHE-encrypted bet positions.
// Share balances and LP positions are encrypted — nobody can see your bets.
// AMM reserves are public for price discovery.
//
// Supports up to 4 outcomes per market, native ETH liquidity,
// multi-voter quorum resolution, and dispute mechanism.
//
// Uses @fhenixprotocol/cofhe-contracts (CoFHE coprocessor on Sepolia).
// ============================================================================

import {FHE, euint8, euint128, ebool} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {ITaskManager, InEuint8} from "@fhenixprotocol/cofhe-contracts/ICofhe.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract FhenixMarkets is ReentrancyGuard {

    // ========================================================================
    // CONSTANTS
    // ========================================================================

    uint8 public constant MARKET_STATUS_ACTIVE = 1;
    uint8 public constant MARKET_STATUS_CLOSED = 2;
    uint8 public constant MARKET_STATUS_RESOLVED = 3;
    uint8 public constant MARKET_STATUS_CANCELLED = 4;
    uint8 public constant STATUS_PENDING_RESOLUTION = 5;
    uint8 public constant STATUS_PENDING_FINALIZATION = 6;
    uint8 public constant STATUS_DISPUTED = 7;

    // Fee configuration (basis points: 100 = 1%)
    uint128 public constant PROTOCOL_FEE_BPS = 50;   // 0.5%
    uint128 public constant CREATOR_FEE_BPS = 50;     // 0.5%
    uint128 public constant LP_FEE_BPS = 100;          // 1.0%
    uint128 public constant FEE_DENOMINATOR = 10000;

    // Voter reward: 20% of protocol fees split among winning voters
    uint128 public constant VOTER_REWARD_PERCENT = 20;

    uint128 public constant MIN_TRADE_AMOUNT = 1000;       // 1000 wei
    uint128 public constant MIN_LIQUIDITY = 10000;          // 10000 wei

    // Multi-Voter Quorum + Dispute resolution
    uint128 public constant MIN_VOTE_BOND = 0.001 ether;   // per vote
    uint8   public constant MIN_VOTERS = 3;
    uint64  public constant VOTE_WINDOW = 12 hours;
    uint64  public constant DISPUTE_WINDOW = 12 hours;
    uint64  public constant WINNER_CLAIM_PRIORITY = 12 hours;
    uint128 public constant DISPUTE_BOND_MULTIPLIER = 3;    // 3x total voter bonds

    // ========================================================================
    // STRUCTS
    // ========================================================================

    struct Market {
        bytes32 id;
        address creator;
        address resolver;          // advisory — anyone can vote via quorum
        bytes32 questionHash;
        uint8   category;
        uint8   numOutcomes;       // 2–4
        uint64  deadline;          // betting closes
        uint64  resolutionDeadline;
        uint8   status;
        uint64  createdAt;
    }

    struct AMMPool {
        uint128 reserve1;
        uint128 reserve2;
        uint128 reserve3;          // 0 if numOutcomes < 3
        uint128 reserve4;          // 0 if numOutcomes < 4
        uint128 totalLiquidity;
        uint128 totalLPShares;
        uint128 totalVolume;
    }

    struct MarketFees {
        uint128 protocolFees;
        uint128 creatorFees;
    }



    struct VoterInfo {
        euint8  encVotedOutcome;  // Optional FHE-encrypted vote choice
        uint128 bondAmount;
        bool    claimed;
    }

    struct VoteTally {
        euint128 encOutcome1Bonds;
        euint128 encOutcome2Bonds;
        euint128 encOutcome3Bonds;
        euint128 encOutcome4Bonds;
        uint128 totalVoters;
        uint128 totalBonded;
        uint64  votingDeadline;
        uint64  disputeDeadline;
        bool    finalized;
        uint8   winningOutcome;
        bool    decryptionRequested;
    }

    // ========================================================================
    // STATE — Public (on-chain readable)
    // ========================================================================

    address public deployer;
    uint256 public marketCount;

    mapping(bytes32 => Market)     public markets;
    mapping(bytes32 => AMMPool)    public ammPools;
    mapping(bytes32 => MarketFees) public marketFees;
    mapping(bytes32 => VoteTally)  public voteTallies;
    mapping(bytes32 => uint128)    public marketCredits;   // ETH held per market

    // Voter tracking: keccak256(marketId, voter) => VoterInfo
    // PRIVATE: hides which outcome each voter chose and their bond
    mapping(bytes32 => VoterInfo) private voters;

    // Dispute bonds: marketId => bond amount deposited
    mapping(bytes32 => uint128) private disputeBonds;
    // Dispute info: marketId => disputer address
    mapping(bytes32 => address) private disputers;
    // Dispute proposed outcome
    mapping(bytes32 => uint8) private disputeOutcomes;

    // Share redemption tracking: keccak256(marketId, user, outcome) => redeemed
    mapping(bytes32 => bool) private shareRedeemed;
    // Creator fee claimed: marketId => claimed
    mapping(bytes32 => bool) private creatorFeesClaimed;
    // LP refund claimed: keccak256(marketId, user) => claimed
    mapping(bytes32 => bool) private lpRefundClaimed;

    // Protocol treasury (private — no need to expose fee accumulation)
    uint128 private protocolTreasury;

    // Voter rewards pool: address => accumulated rewards
    // PRIVATE: hides how much each voter earned
    mapping(address => uint128) private voterRewards;

    // ========================================================================
    // STATE — Encrypted (FHE private)
    // ========================================================================
    // Nobody can read these except the owner (via CoFHE permit)

    // Encrypted share balances: keccak256(marketId, user, outcome) => euint128
    mapping(bytes32 => euint128) private encShareBalances;

    // Encrypted LP balances: keccak256(marketId, user) => euint128
    mapping(bytes32 => euint128) private encLPBalances;

    // Total encrypted shares issued per outcome (for proportional LP withdrawal)
    // These are public counters used in AMM math
    mapping(bytes32 => uint128) private totalSharesIssued; // keccak256(marketId, outcome)

    // ========================================================================
    // STATE — Public Plaintext Balances & Unshielding
    // ========================================================================

    mapping(bytes32 => uint128) public publicShareBalances; // keccak256(marketId, user, outcome)
    mapping(bytes32 => uint128) public publicLPBalances;    // keccak256(marketId, user)

    struct UnshieldRequest {
        bytes32 marketId;
        address user;
        uint8   outcome;     // 0 = LP shares, 1-4 = outcome shares
        uint128 amount;
        bool    executed;
    }

    uint256 public nextUnshieldId;
    mapping(uint256 => UnshieldRequest) public unshieldRequests;
    mapping(uint256 => ebool) private encUnshieldStatus;

    // ========================================================================
    // EVENTS
    // ========================================================================

    event MarketCreated(
        bytes32 indexed marketId,
        address indexed creator,
        bytes32 questionHash,
        uint8   numOutcomes,
        uint64  deadline
    );

    event UnshieldRequested(uint256 indexed requestId, address indexed user, bytes32 marketId, uint8 outcome, uint128 amount);
    event UnshieldExecuted(uint256 indexed requestId, bool successful);

    // Privacy-preserving events: no outcome, amount, or share counts leaked.
    // Only marketId + address are emitted so the frontend can index activity.

    event SharesBought(
        bytes32 indexed marketId,
        address indexed buyer
    );

    event SharesSold(
        bytes32 indexed marketId,
        address indexed seller
    );

    event LiquidityAdded(
        bytes32 indexed marketId,
        address indexed provider
    );

    event LiquidityWithdrawn(
        bytes32 indexed marketId,
        address indexed provider
    );

    event MarketClosed(bytes32 indexed marketId);
    event MarketCancelled(bytes32 indexed marketId);

    event VoteSubmitted(bytes32 indexed marketId, address indexed voter);
    event VotesFinalized(bytes32 indexed marketId, uint8 winningOutcome);
    event ResolutionConfirmed(bytes32 indexed marketId, uint8 winningOutcome);
    event ResolutionDisputed(bytes32 indexed marketId, address disputer, uint8 proposedOutcome);
    event SharesRedeemed(bytes32 indexed marketId, address indexed redeemer);
    event RefundClaimed(bytes32 indexed marketId, address indexed claimer);



    // ========================================================================
    // MODIFIERS
    // ========================================================================

    modifier onlyDeployer() {
        require(msg.sender == deployer);
        _;
    }

    modifier marketExists(bytes32 marketId) {
        require(markets[marketId].creator != address(0));
        _;
    }

    // ========================================================================
    // CONSTRUCTOR
    // ========================================================================

    constructor() {
        deployer = msg.sender;
    }

    // ========================================================================
    // KEY HELPERS
    // ========================================================================

    function _shareKey(bytes32 marketId, address user, uint8 outcome) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(marketId, user, outcome));
    }

    function _lpKey(bytes32 marketId, address user) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(marketId, user));
    }

    function _voterKey(bytes32 marketId, address voter) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(marketId, voter));
    }

    function _outcomeShareKey(bytes32 marketId, uint8 outcome) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(marketId, outcome));
    }

    // ========================================================================
    // FHE HELPERS — safe add/sub with initialization check
    // ========================================================================

    function _fheAdd(euint128 current, uint128 amount) internal returns (euint128) {
        euint128 enc = FHE.asEuint128(uint256(amount));
        if (FHE.isInitialized(current)) {
            euint128 result = FHE.add(current, enc);
            FHE.allowThis(result);
            FHE.allowSender(result);
            return result;
        } else {
            FHE.allowThis(enc);
            FHE.allowSender(enc);
            return enc;
        }
    }

    // ========================================================================
    // 1. CREATE MARKET
    // ========================================================================

    function createMarket(
        bytes32 questionHash,
        uint8   category,
        uint8   numOutcomes,
        uint64  deadline,
        uint64  resolutionDeadline,
        address resolver
    ) external payable returns (bytes32) {
        require(numOutcomes >= 2 && numOutcomes <= 4);
        require(msg.value >= MIN_LIQUIDITY);
        require(deadline > block.timestamp);
        require(resolutionDeadline > deadline);

        uint128 initialLiquidity = uint128(msg.value);

        // Generate unique market ID
        bytes32 marketId = keccak256(abi.encodePacked(
            msg.sender,
            questionHash,
            deadline,
            resolutionDeadline,
            block.timestamp
        ));

        require(markets[marketId].creator == address(0));

        // Store market metadata (public)
        markets[marketId] = Market({
            id: marketId,
            creator: msg.sender,
            resolver: resolver,
            questionHash: questionHash,
            category: category,
            numOutcomes: numOutcomes,
            deadline: deadline,
            resolutionDeadline: resolutionDeadline,
            status: MARKET_STATUS_ACTIVE,
            createdAt: uint64(block.timestamp)
        });

        // Initialize AMM pool with equal reserves (public)
        uint128 perOutcome = initialLiquidity / uint128(numOutcomes);

        ammPools[marketId] = AMMPool({
            reserve1: perOutcome,
            reserve2: perOutcome,
            reserve3: numOutcomes >= 3 ? perOutcome : 0,
            reserve4: numOutcomes >= 4 ? perOutcome : 0,
            totalLiquidity: initialLiquidity,
            totalLPShares: initialLiquidity,
            totalVolume: 0
        });

        marketFees[marketId] = MarketFees({
            protocolFees: 0,
            creatorFees: 0
        });

        marketCredits[marketId] = initialLiquidity;

        // Encrypt LP position for creator (private)
        bytes32 lpKey = _lpKey(marketId, msg.sender);
        encLPBalances[lpKey] = _fheAdd(encLPBalances[lpKey], initialLiquidity);
        marketCount++;

        emit MarketCreated(
            marketId, msg.sender, questionHash,
            numOutcomes, deadline
        );

        return marketId;
    }

    // ========================================================================
    // UNSHIELDING MECHANISM (Required before selling/withdrawing/redeeming)
    // ========================================================================

    function requestUnshieldShares(bytes32 marketId, uint8 outcome, uint128 amount) external marketExists(marketId) returns (uint256) {
        require(outcome >= 1 && outcome <= markets[marketId].numOutcomes);
        require(amount > 0);

        bytes32 key = _shareKey(marketId, msg.sender, outcome);
        euint128 encAmount = FHE.asEuint128(uint256(amount));
        
        ebool isSufficient = FHE.gte(encShareBalances[key], encAmount);
        euint128 actualSub = FHE.select(isSufficient, encAmount, FHE.asEuint128(0));
        encShareBalances[key] = FHE.sub(encShareBalances[key], actualSub);
        FHE.allowThis(encShareBalances[key]);
        FHE.allowSender(encShareBalances[key]);

        uint256 reqId = ++nextUnshieldId;
        unshieldRequests[reqId] = UnshieldRequest({
            marketId: marketId,
            user: msg.sender,
            outcome: outcome,
            amount: amount,
            executed: false
        });

        FHE.allowThis(isSufficient);
        encUnshieldStatus[reqId] = isSufficient;
        ITaskManager(0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9).createDecryptTask(uint256(ebool.unwrap(isSufficient)), msg.sender);

        emit UnshieldRequested(reqId, msg.sender, marketId, outcome, amount);
        return reqId;
    }

    function requestUnshieldLP(bytes32 marketId, uint128 amount) external marketExists(marketId) returns (uint256) {
        require(amount > 0);

        bytes32 key = _lpKey(marketId, msg.sender);
        euint128 encAmount = FHE.asEuint128(uint256(amount));
        
        ebool isSufficient = FHE.gte(encLPBalances[key], encAmount);
        euint128 actualSub = FHE.select(isSufficient, encAmount, FHE.asEuint128(0));
        encLPBalances[key] = FHE.sub(encLPBalances[key], actualSub);
        FHE.allowThis(encLPBalances[key]);
        FHE.allowSender(encLPBalances[key]);

        uint256 reqId = ++nextUnshieldId;
        unshieldRequests[reqId] = UnshieldRequest({
            marketId: marketId,
            user: msg.sender,
            outcome: 0,
            amount: amount,
            executed: false
        });

        FHE.allowThis(isSufficient);
        encUnshieldStatus[reqId] = isSufficient;
        ITaskManager(0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9).createDecryptTask(uint256(ebool.unwrap(isSufficient)), msg.sender);

        emit UnshieldRequested(reqId, msg.sender, marketId, 0, amount);
        return reqId;
    }

    function executeUnshield(uint256 reqId) external {
        UnshieldRequest storage req = unshieldRequests[reqId];
        require(req.user != address(0));
        require(!req.executed);

        ebool isSufficient = encUnshieldStatus[reqId];
        (bool success, bool decrypted) = FHE.getDecryptResultSafe(isSufficient);
        require(decrypted);

        req.executed = true;

        if (success) {
            if (req.outcome == 0) {
                publicLPBalances[_lpKey(req.marketId, req.user)] += req.amount;
            } else {
                publicShareBalances[_shareKey(req.marketId, req.user, req.outcome)] += req.amount;
            }
        }

        emit UnshieldExecuted(reqId, success);
    }

    // ========================================================================
    // 2. BUY SHARES — FPMM complete-set minting
    // ========================================================================
    //
    //   shares_out = (r_i + a) - r_i * ∏(r_k / (r_k + a)) for k ≠ i
    //
    // Amount goes in publicly (ETH), shares are added to encrypted balance.

    function buyShares(
        bytes32 marketId,
        uint8   outcome,
        InEuint8 calldata encOutcome,
        uint128 minSharesOut
    ) external payable nonReentrant marketExists(marketId) {
        Market storage market = markets[marketId];
        require(market.status == MARKET_STATUS_ACTIVE);
        require(block.timestamp <= market.deadline);
        uint8 n = market.numOutcomes;
        require(outcome >= 1 && outcome <= n);

        uint128 amountIn = uint128(msg.value);
        require(amountIn >= MIN_TRADE_AMOUNT);

        // Calculate fees
        uint128 protocolFee = (amountIn * PROTOCOL_FEE_BPS) / FEE_DENOMINATOR;
        uint128 creatorFee  = (amountIn * CREATOR_FEE_BPS) / FEE_DENOMINATOR;
        uint128 amountToPool = amountIn - protocolFee - creatorFee;

        // Accumulate fees (public)
        MarketFees storage fees = marketFees[marketId];
        fees.protocolFees += protocolFee;
        fees.creatorFees  += creatorFee;
        protocolTreasury  += protocolFee;

        // FPMM calculation — compute shares for all possible outcomes (public math)
        AMMPool storage pool = ammPools[marketId];
        uint128 sharesOut = _calculateSharesOut(pool, outcome, n, amountToPool);

        require(sharesOut >= minSharesOut);
        require(sharesOut > 0);

        // Update reserves (public)
        _updateReservesAfterBuy(pool, outcome, n, amountToPool, sharesOut);
        pool.totalLiquidity += amountToPool;
        pool.totalVolume    += amountIn;

        // Track ETH held
        marketCredits[marketId] += amountIn;

        // Track total shares issued (public counter)
        bytes32 oKey = _outcomeShareKey(marketId, outcome);
        totalSharesIssued[oKey] += sharesOut;

        // ---- FHE: Credit shares using encrypted outcome (PRIVATE balance assignment) ----
        euint8 eOutcome = FHE.asEuint8(encOutcome);
        FHE.allowThis(eOutcome);

        euint128 eShares = FHE.asEuint128(uint256(sharesOut));
        FHE.allowThis(eShares);

        _creditSecretShares(marketId, msg.sender, eOutcome, eShares, n);

        emit SharesBought(marketId, msg.sender);
    }

    // ========================================================================
    // 3. SELL SHARES — FPMM complete-set burning
    // ========================================================================
    //
    //   r_i_new = r_i * ∏(r_k / (r_k - poolOut)) for k ≠ i
    //   shares_needed = r_i_new - r_i + poolOut
    //
    // User specifies sharesToSell (public). FHE.sub will revert on underflow
    // if the user doesn't have enough shares.

    function sellShares(
        bytes32 marketId,
        uint8   outcome,
        uint128 sharesToSell,
        uint128 minTokensOut
    ) external nonReentrant marketExists(marketId) {
        Market storage market = markets[marketId];
        require(market.status == MARKET_STATUS_ACTIVE);
        require(block.timestamp <= market.deadline);
        require(outcome >= 1 && outcome <= market.numOutcomes);
        require(sharesToSell > 0);

        // FPMM reverse calculation: how many tokens for sharesToSell
        AMMPool storage pool = ammPools[marketId];
        uint8 n = market.numOutcomes;
        uint128 tokensGross = _calculateTokensOut(pool, outcome, n, sharesToSell);

        // Fees on gross tokens
        uint128 protocolFee = (tokensGross * PROTOCOL_FEE_BPS) / FEE_DENOMINATOR;
        uint128 creatorFee  = (tokensGross * CREATOR_FEE_BPS) / FEE_DENOMINATOR;
        uint128 lpFee       = (tokensGross * LP_FEE_BPS) / FEE_DENOMINATOR;
        uint128 netTokens   = tokensGross - protocolFee - creatorFee - lpFee;

        require(netTokens >= minTokensOut);

        // Accumulate fees
        MarketFees storage fees = marketFees[marketId];
        fees.protocolFees += protocolFee;
        fees.creatorFees  += creatorFee;
        protocolTreasury  += protocolFee;

        // Update reserves (public)
        _updateReservesAfterSell(pool, outcome, n, tokensGross, sharesToSell);
        pool.totalLiquidity -= tokensGross;
        pool.totalVolume    += tokensGross;

        // Update counters
        marketCredits[marketId] -= (netTokens + protocolFee + creatorFee);
        bytes32 oKey = _outcomeShareKey(marketId, outcome);
        totalSharesIssued[oKey] -= sharesToSell;

        // ---- Update public unshielded balances ----
        bytes32 key = _shareKey(marketId, msg.sender, outcome);
        require(publicShareBalances[key] >= sharesToSell);
        publicShareBalances[key] -= sharesToSell;

        // Transfer ETH to seller
        (bool sent, ) = payable(msg.sender).call{value: netTokens}("");
        require(sent);

        emit SharesSold(marketId, msg.sender);
    }

    // ========================================================================
    // 4. ADD LIQUIDITY
    // ========================================================================

    function addLiquidity(bytes32 marketId) external payable marketExists(marketId) {
        Market storage market = markets[marketId];
        require(market.status == MARKET_STATUS_ACTIVE);
        require(block.timestamp <= market.deadline);

        uint128 amount = uint128(msg.value);
        require(amount >= MIN_LIQUIDITY);

        AMMPool storage pool = ammPools[marketId];

        // LP shares proportional to existing pool
        uint128 lpShares;
        if (pool.totalLPShares == 0) {
            lpShares = amount;
        } else {
            lpShares = (amount * pool.totalLPShares) / pool.totalLiquidity;
        }

        require(lpShares > 0);

        // Update reserves proportionally
        uint8 n = market.numOutcomes;
        uint128 r1Add = (amount * pool.reserve1) / pool.totalLiquidity;
        uint128 r2Add = (amount * pool.reserve2) / pool.totalLiquidity;
        pool.reserve1 += r1Add;
        pool.reserve2 += r2Add;
        if (n >= 3) {
            uint128 r3Add = (amount * pool.reserve3) / pool.totalLiquidity;
            pool.reserve3 += r3Add;
        }
        if (n >= 4) {
            uint128 r4Add = (amount * pool.reserve4) / pool.totalLiquidity;
            pool.reserve4 += r4Add;
        }
        pool.totalLiquidity += amount;
        pool.totalLPShares  += lpShares;

        marketCredits[marketId] += amount;

        // ---- FHE: Add LP shares to encrypted balance (PRIVATE) ----
        bytes32 key = _lpKey(marketId, msg.sender);
        encLPBalances[key] = _fheAdd(encLPBalances[key], lpShares);

        emit LiquidityAdded(marketId, msg.sender);
    }

    // ========================================================================
    // 5. WITHDRAW LIQUIDITY (resolved market)
    // ========================================================================

    function withdrawLiquidity(
        bytes32 marketId,
        uint128 lpSharesToWithdraw
    ) external nonReentrant marketExists(marketId) {
        Market storage market = markets[marketId];
        require(
            market.status == MARKET_STATUS_RESOLVED,
            "Not resolved"
        );

        VoteTally storage tally = voteTallies[marketId];
        // Wait for winner claim priority window
        require(
            block.timestamp > tally.disputeDeadline + WINNER_CLAIM_PRIORITY,
            "Priority window"
        );

        require(lpSharesToWithdraw > 0);

        // Calculate proportional payout
        AMMPool storage pool = ammPools[marketId];
        uint128 tokensOut = (lpSharesToWithdraw * pool.totalLiquidity) / pool.totalLPShares;

        require(tokensOut > 0);
        require(tokensOut <= marketCredits[marketId]);

        // Update pool
        pool.totalLPShares  -= lpSharesToWithdraw;
        pool.totalLiquidity -= tokensOut;
        marketCredits[marketId] -= tokensOut;

        // ---- Update public unshielded balances ----
        bytes32 key = _lpKey(marketId, msg.sender);
        require(publicLPBalances[key] >= lpSharesToWithdraw);
        publicLPBalances[key] -= lpSharesToWithdraw;

        (bool sent, ) = payable(msg.sender).call{value: tokensOut}("");
        require(sent);

        emit LiquidityWithdrawn(marketId, msg.sender);
    }

    // ########################################################################
    //                          MARKET LIFECYCLE
    // ########################################################################

    // ========================================================================
    // 6. CLOSE MARKET (after deadline, opens voting)
    // ========================================================================

    function closeMarket(bytes32 marketId) external marketExists(marketId) {
        Market storage market = markets[marketId];
        require(market.status == MARKET_STATUS_ACTIVE);
        require(block.timestamp > market.deadline);

        market.status = STATUS_PENDING_RESOLUTION;

        voteTallies[marketId] = VoteTally({
            encOutcome1Bonds: FHE.asEuint128(0),
            encOutcome2Bonds: FHE.asEuint128(0),
            encOutcome3Bonds: FHE.asEuint128(0),
            encOutcome4Bonds: FHE.asEuint128(0),
            totalVoters: 0,
            totalBonded: 0,
            votingDeadline: uint64(block.timestamp) + VOTE_WINDOW,
            disputeDeadline: 0,
            finalized: false,
            winningOutcome: 0,
            decryptionRequested: false
        });

        emit MarketClosed(marketId);
    }

    // ========================================================================
    // 7. CANCEL MARKET (creator or deployer, only if active)
    // ========================================================================

    function cancelMarket(bytes32 marketId) external marketExists(marketId) {
        Market storage market = markets[marketId];
        require(
            msg.sender == market.creator || msg.sender == deployer,
            "Not authorized"
        );
        require(
            market.status == MARKET_STATUS_ACTIVE ||
            market.status == STATUS_PENDING_RESOLUTION,
            "Cannot cancel"
        );

        market.status = MARKET_STATUS_CANCELLED;
        emit MarketCancelled(marketId);
    }

    // ########################################################################
    //                    MULTI-VOTER QUORUM RESOLUTION
    // ########################################################################

    // ========================================================================
    // 8. VOTE OUTCOME (with bond)
    // ========================================================================

    function voteOutcome(
        bytes32 marketId,
        InEuint8 calldata encOutcome
    ) external payable marketExists(marketId) {
        Market storage market = markets[marketId];
        require(
            market.status == STATUS_PENDING_RESOLUTION ||
            market.status == STATUS_DISPUTED,
            "Not in voting"
        );

        VoteTally storage tally = voteTallies[marketId];
        require(block.timestamp <= tally.votingDeadline);

        uint128 bondAmount = uint128(msg.value);
        require(bondAmount >= MIN_VOTE_BOND);

        // Check not already voted
        bytes32 vKey = _voterKey(marketId, msg.sender);
        require(voters[vKey].bondAmount == 0);

        euint8 eOutcome = FHE.asEuint8(encOutcome);
        FHE.allowThis(eOutcome);

        // Record vote
        voters[vKey] = VoterInfo({
            encVotedOutcome: eOutcome,
            bondAmount: bondAmount,
            claimed: false
        });

        euint128 eBond = FHE.asEuint128(uint256(bondAmount));
        FHE.allowThis(eBond);
        
        _addSecretVoteTallies(tally, eOutcome, eBond, market.numOutcomes);

        tally.totalVoters++;
        tally.totalBonded += bondAmount;

        emit VoteSubmitted(marketId, msg.sender);
    }

    // ========================================================================
    // 9a. REQUEST VOTE DECRYPTION — trigger async FHE decrypt of tallies
    // ========================================================================

    function requestVoteDecryption(bytes32 marketId) external marketExists(marketId) {
        Market storage market = markets[marketId];
        require(
            market.status == STATUS_PENDING_RESOLUTION ||
            market.status == STATUS_DISPUTED,
            "Not in voting"
        );
        VoteTally storage tally = voteTallies[marketId];
        require(block.timestamp > tally.votingDeadline);
        require(!tally.finalized);
        require(!tally.decryptionRequested);

        tally.decryptionRequested = true;

        address TM = 0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9;
        if (FHE.isInitialized(tally.encOutcome1Bonds)) ITaskManager(TM).createDecryptTask(uint256(euint128.unwrap(tally.encOutcome1Bonds)), msg.sender);
        if (FHE.isInitialized(tally.encOutcome2Bonds)) ITaskManager(TM).createDecryptTask(uint256(euint128.unwrap(tally.encOutcome2Bonds)), msg.sender);
        if (market.numOutcomes >= 3 && FHE.isInitialized(tally.encOutcome3Bonds)) ITaskManager(TM).createDecryptTask(uint256(euint128.unwrap(tally.encOutcome3Bonds)), msg.sender);
        if (market.numOutcomes >= 4 && FHE.isInitialized(tally.encOutcome4Bonds)) ITaskManager(TM).createDecryptTask(uint256(euint128.unwrap(tally.encOutcome4Bonds)), msg.sender);
    }

    // ========================================================================
    // 9b. FINALIZE VOTES — read decrypted tallies, pick winner
    // ========================================================================

    function finalizeVotes(bytes32 marketId) external marketExists(marketId) {
        Market storage market = markets[marketId];
        require(
            market.status == STATUS_PENDING_RESOLUTION ||
            market.status == STATUS_DISPUTED,
            "Not in voting"
        );

        VoteTally storage tally = voteTallies[marketId];
        require(block.timestamp > tally.votingDeadline);
        require(!tally.finalized);
        require(tally.decryptionRequested);
        require(tally.totalVoters >= MIN_VOTERS);

        (uint256 raw1, bool ready1) = FHE.getDecryptResultSafe(tally.encOutcome1Bonds);
        (uint256 raw2, bool ready2) = FHE.getDecryptResultSafe(tally.encOutcome2Bonds);
        uint128 bonds1 = ready1 ? uint128(raw1) : 0;
        uint128 bonds2 = ready2 ? uint128(raw2) : 0;

        uint128 bonds3 = 0;
        uint128 bonds4 = 0;
        if (market.numOutcomes >= 3) {
            (uint256 raw3, bool ready3) = FHE.getDecryptResultSafe(tally.encOutcome3Bonds);
            if (ready3) bonds3 = uint128(raw3);
        }
        if (market.numOutcomes >= 4) {
            (uint256 raw4, bool ready4) = FHE.getDecryptResultSafe(tally.encOutcome4Bonds);
            if (ready4) bonds4 = uint128(raw4);
        }

        require(bonds1 + bonds2 + bonds3 + bonds4 > 0);

        uint128 maxBonds = bonds1;
        uint8 winner = 1;

        if (bonds2 > maxBonds) {
            maxBonds = bonds2;
            winner = 2;
        }
        if (market.numOutcomes >= 3 && bonds3 > maxBonds) {
            maxBonds = bonds3;
            winner = 3;
        }
        if (market.numOutcomes >= 4 && bonds4 > maxBonds) {
            maxBonds = bonds4;
            winner = 4;
        }

        tally.winningOutcome = winner;
        tally.finalized = true;
        tally.disputeDeadline = uint64(block.timestamp) + DISPUTE_WINDOW;

        market.status = STATUS_PENDING_FINALIZATION;

        emit VotesFinalized(marketId, winner);
    }

    // ========================================================================
    // 10. CONFIRM RESOLUTION — after dispute window, make it official
    // ========================================================================

    function confirmResolution(bytes32 marketId) external marketExists(marketId) {
        Market storage market = markets[marketId];
        require(market.status == STATUS_PENDING_FINALIZATION);

        VoteTally storage tally = voteTallies[marketId];
        require(block.timestamp > tally.disputeDeadline);

        market.status = MARKET_STATUS_RESOLVED;

        emit ResolutionConfirmed(marketId, tally.winningOutcome);
    }

    // ========================================================================
    // 11. DISPUTE RESOLUTION — challenge with 3x bond
    // ========================================================================

    function disputeResolution(
        bytes32 marketId,
        uint8   proposedOutcome
    ) external payable marketExists(marketId) {
        Market storage market = markets[marketId];
        require(market.status == STATUS_PENDING_FINALIZATION);

        VoteTally storage tally = voteTallies[marketId];
        require(block.timestamp <= tally.disputeDeadline);
        require(proposedOutcome >= 1 && proposedOutcome <= market.numOutcomes);
        require(proposedOutcome != tally.winningOutcome);

        uint128 requiredBond = tally.totalBonded * DISPUTE_BOND_MULTIPLIER;
        uint128 bondAmount = uint128(msg.value);
        require(bondAmount >= requiredBond);

        // Store dispute info
        disputeBonds[marketId] = bondAmount;
        disputers[marketId] = msg.sender;
        disputeOutcomes[marketId] = proposedOutcome;

        // Reset to disputed — re-opens voting with new window
        market.status = STATUS_DISPUTED;
        tally.finalized = false;
        tally.votingDeadline = uint64(block.timestamp) + VOTE_WINDOW;
        tally.winningOutcome = 0;

        // Reset tallies for fresh vote
        tally.encOutcome1Bonds = FHE.asEuint128(0);
        tally.encOutcome2Bonds = FHE.asEuint128(0);
        tally.encOutcome3Bonds = FHE.asEuint128(0);
        tally.encOutcome4Bonds = FHE.asEuint128(0);
        tally.totalVoters = 0;
        tally.totalBonded = 0;
        tally.decryptionRequested = false;

        emit ResolutionDisputed(marketId, msg.sender, proposedOutcome);
    }

    // ########################################################################
    //                              CLAIMS
    // ########################################################################

    // ========================================================================
    // 12. REDEEM SHARES (winner takes payout)
    // ========================================================================

    function redeemShares(
        bytes32 marketId,
        uint128 sharesToRedeem
    ) external nonReentrant marketExists(marketId) {
        Market storage market = markets[marketId];
        require(market.status == MARKET_STATUS_RESOLVED);

        VoteTally storage tally = voteTallies[marketId];
        uint8 winningOutcome = tally.winningOutcome;
        require(winningOutcome >= 1);

        require(sharesToRedeem > 0);

        // Payout: each winning share is worth proportional to the pool
        AMMPool storage pool = ammPools[marketId];
        bytes32 oKey = _outcomeShareKey(marketId, winningOutcome);
        uint128 totalWinning = totalSharesIssued[oKey];
        require(totalWinning > 0);

        uint128 payout = (sharesToRedeem * pool.totalLiquidity) / totalWinning;
        require(payout > 0);
        require(payout <= marketCredits[marketId]);

        // Update state
        marketCredits[marketId] -= payout;
        totalSharesIssued[oKey] -= sharesToRedeem;

        // ---- Update public unshielded balances ----
        bytes32 key = _shareKey(marketId, msg.sender, winningOutcome);
        require(publicShareBalances[key] >= sharesToRedeem);
        publicShareBalances[key] -= sharesToRedeem;

        (bool sent, ) = payable(msg.sender).call{value: payout}("");
        require(sent);

        emit SharesRedeemed(marketId, msg.sender);
    }

    // ========================================================================
    // 13. CLAIM REFUND (cancelled market — get back bet value)
    // ========================================================================

    function claimRefund(
        bytes32 marketId,
        uint8   outcome,
        uint128 sharesToRefund
    ) external nonReentrant marketExists(marketId) {
        Market storage market = markets[marketId];
        require(market.status == MARKET_STATUS_CANCELLED);
        require(outcome >= 1 && outcome <= market.numOutcomes);
        require(sharesToRefund > 0);

        // Refund proportional to pool
        AMMPool storage pool = ammPools[marketId];
        bytes32 oKey = _outcomeShareKey(marketId, outcome);
        uint128 totalOutcome = totalSharesIssued[oKey];
        require(totalOutcome > 0);

        // Proportional refund from pool
        uint128 refundAmount = (sharesToRefund * pool.totalLiquidity) / totalOutcome;
        require(refundAmount <= marketCredits[marketId]);

        marketCredits[marketId] -= refundAmount;
        totalSharesIssued[oKey] -= sharesToRefund;

        // ---- Update public unshielded balances ----
        bytes32 key = _shareKey(marketId, msg.sender, outcome);
        require(publicShareBalances[key] >= sharesToRefund);
        publicShareBalances[key] -= sharesToRefund;

        (bool sent, ) = payable(msg.sender).call{value: refundAmount}("");
        require(sent);

        emit RefundClaimed(marketId, msg.sender);
    }

    // ========================================================================
    // 14. CLAIM LP REFUND (cancelled market)
    // ========================================================================

    function claimLPRefund(
        bytes32 marketId,
        uint128 lpSharesToRefund
    ) external nonReentrant marketExists(marketId) {
        Market storage market = markets[marketId];
        require(market.status == MARKET_STATUS_CANCELLED);
        require(lpSharesToRefund > 0);

        bytes32 key = _lpKey(marketId, msg.sender);
        require(!lpRefundClaimed[key]);

        AMMPool storage pool = ammPools[marketId];
        uint128 refund = (lpSharesToRefund * pool.totalLiquidity) / pool.totalLPShares;
        require(refund <= marketCredits[marketId]);

        pool.totalLPShares  -= lpSharesToRefund;
        pool.totalLiquidity -= refund;
        marketCredits[marketId] -= refund;

        // ---- Update public unshielded balances ----
        require(publicLPBalances[key] >= lpSharesToRefund);
        publicLPBalances[key] -= lpSharesToRefund;

        (bool sent, ) = payable(msg.sender).call{value: refund}("");
        require(sent);

        emit RefundClaimed(marketId, msg.sender);
    }

    // ========================================================================
    // 15. WITHDRAW CREATOR FEES
    // ========================================================================

    function withdrawCreatorFees(bytes32 marketId) external marketExists(marketId) {
        Market storage market = markets[marketId];
        require(msg.sender == market.creator);
        require(
            market.status == MARKET_STATUS_RESOLVED ||
            market.status == MARKET_STATUS_CANCELLED,
            "Not finalized"
        );
        require(!creatorFeesClaimed[marketId]);

        uint128 amount = marketFees[marketId].creatorFees;
        require(amount > 0);

        creatorFeesClaimed[marketId] = true;

        (bool sent, ) = payable(msg.sender).call{value: amount}("");
        require(sent);
    }

    // ========================================================================
    // 16. CLAIM VOTER BOND (after resolution confirmed)
    // ========================================================================

    function requestVoterDecryption(bytes32 marketId) external marketExists(marketId) {
        bytes32 vKey = _voterKey(marketId, msg.sender);
        VoterInfo storage info = voters[vKey];
        require(info.bondAmount > 0);
        require(!info.claimed);
        require(FHE.isInitialized(info.encVotedOutcome));
        ITaskManager(0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9).createDecryptTask(uint256(euint8.unwrap(info.encVotedOutcome)), msg.sender);
    }

    function claimVoterBond(bytes32 marketId) external marketExists(marketId) {
        Market storage market = markets[marketId];
        require(
            market.status == MARKET_STATUS_RESOLVED ||
            market.status == MARKET_STATUS_CANCELLED,
            "Not finalized"
        );

        bytes32 vKey = _voterKey(marketId, msg.sender);
        VoterInfo storage info = voters[vKey];
        require(info.bondAmount > 0);
        require(!info.claimed);

        VoteTally storage tally = voteTallies[marketId];
        uint128 payout = info.bondAmount;

        if (FHE.isInitialized(info.encVotedOutcome) && tally.winningOutcome > 0) {
            (uint256 rawVote, bool voteReady) = FHE.getDecryptResultSafe(info.encVotedOutcome);
            if (voteReady) {
                uint8 votedFor = uint8(rawVote);
                if (votedFor == tally.winningOutcome) {
                    MarketFees storage fees = marketFees[marketId];
                    uint128 voterPool = (fees.protocolFees * VOTER_REWARD_PERCENT) / 100;
                    uint128 totalWinnerBonds = tally.totalBonded;
                    if (totalWinnerBonds > 0) {
                        uint128 reward = (voterPool * info.bondAmount) / totalWinnerBonds;
                        payout += reward;
                        voterRewards[msg.sender] += reward;
                    }
                }
            }
        }

        info.claimed = true;

        (bool sent, ) = payable(msg.sender).call{value: payout}("");
        require(sent);
    }

    // ========================================================================
    // 17. CLAIM DISPUTE BOND
    // ========================================================================

    function claimDisputeBond(bytes32 marketId) external marketExists(marketId) {
        require(msg.sender == disputers[marketId]);
        require(
            markets[marketId].status == MARKET_STATUS_RESOLVED ||
            markets[marketId].status == MARKET_STATUS_CANCELLED,
            "Not finalized"
        );

        uint128 bond = disputeBonds[marketId];
        require(bond > 0);

        disputeBonds[marketId] = 0;

        (bool sent, ) = payable(msg.sender).call{value: bond}("");
        require(sent);
    }

    // ========================================================================
    // 18. CLAIM VOTER REWARD — withdraw accumulated voter rewards
    // ========================================================================

    function claimVoterReward() external {
        uint128 reward = voterRewards[msg.sender];
        require(reward > 0);

        voterRewards[msg.sender] = 0;

        (bool sent, ) = payable(msg.sender).call{value: reward}("");
        require(sent);
    }

    // ========================================================================
    // 19. WITHDRAW PROTOCOL FEES (deployer only)
    // ========================================================================

    function withdrawProtocolFees(uint128 amount) external onlyDeployer {
        require(amount <= protocolTreasury);
        protocolTreasury -= amount;

        (bool sent, ) = payable(deployer).call{value: amount}("");
        require(sent);
    }



    // ########################################################################
    //                     VIEW FUNCTIONS
    // ########################################################################

    /// @notice Get current prices for all outcomes (derived from AMM reserves)
    function getPrices(bytes32 marketId)
        external view
        returns (uint128 price1, uint128 price2, uint128 price3, uint128 price4)
    {
        AMMPool storage pool = ammPools[marketId];
        Market  storage market = markets[marketId];

        // Price of outcome i = (1/r_i) / sum(1/r_k)
        // Use uint256 and high precision to avoid integer division truncation
        uint256 invR1 = pool.reserve1 > 0 ? (1e36 / uint256(pool.reserve1)) : 0;
        uint256 invR2 = pool.reserve2 > 0 ? (1e36 / uint256(pool.reserve2)) : 0;
        uint256 invR3 = (market.numOutcomes >= 3 && pool.reserve3 > 0)
            ? (1e36 / uint256(pool.reserve3)) : 0;
        uint256 invR4 = (market.numOutcomes >= 4 && pool.reserve4 > 0)
            ? (1e36 / uint256(pool.reserve4)) : 0;

        uint256 totalInv = invR1 + invR2 + invR3 + invR4;

        if (totalInv > 0) {
            price1 = uint128((invR1 * 1e18) / totalInv);
            price2 = uint128((invR2 * 1e18) / totalInv);
            price3 = market.numOutcomes >= 3 ? uint128((invR3 * 1e18) / totalInv) : 0;
            price4 = market.numOutcomes >= 4 ? uint128((invR4 * 1e18) / totalInv) : 0;
        }
    }



    // ########################################################################
    //                          INTERNAL — AMM MATH
    // ########################################################################

    /// @dev FPMM: Calculate shares out for a buy order
    ///      shares_out = (r_i + a) - r_i * ∏(r_k / (r_k + a)) for k ≠ i
    function _calculateSharesOut(
        AMMPool storage pool,
        uint8   outcome,
        uint8   n,
        uint128 amountToPool
    ) internal view returns (uint128) {
        uint256 a = uint256(amountToPool);

        uint256[4] memory r;
        r[0] = uint256(pool.reserve1);
        r[1] = uint256(pool.reserve2);
        r[2] = n >= 3 ? uint256(pool.reserve3) : 0;
        r[3] = n >= 4 ? uint256(pool.reserve4) : 0;

        uint256 rI = r[outcome - 1];

        // Step-wise product: rI * ∏(r_k / (r_k + a)) for active k ≠ i
        // Using fixed-point with 1e18 precision to avoid rounding to zero
        uint256 product = rI * 1e18;

        for (uint8 k = 0; k < n; k++) {
            if (k != outcome - 1) {
                product = (product * r[k]) / (r[k] + a);
            }
        }

        uint256 rINew = product / 1e18;
        uint256 sharesOut = (rI + a) - rINew;

        return uint128(sharesOut);
    }

    /// @dev Update reserves after a buy:
    ///      non-target reserves += amount, target reserve = rI_new
    function _updateReservesAfterBuy(
        AMMPool storage pool,
        uint8   outcome,
        uint8   n,
        uint128 amountToPool,
        uint128 sharesOut
    ) internal {
        uint256 a = uint256(amountToPool);

        // For the target outcome, new reserve = rI + a - sharesOut
        // For non-target outcomes, new reserve = rK + a
        if (outcome == 1) {
            unchecked {
                pool.reserve1 = uint128(uint256(pool.reserve1) + a - uint256(sharesOut));
                pool.reserve2 += amountToPool;
                if (n >= 3) pool.reserve3 += amountToPool;
                if (n >= 4) pool.reserve4 += amountToPool;
            }
        } else if (outcome == 2) {
            unchecked {
                pool.reserve1 += amountToPool;
                pool.reserve2 = uint128(uint256(pool.reserve2) + a - uint256(sharesOut));
                if (n >= 3) pool.reserve3 += amountToPool;
                if (n >= 4) pool.reserve4 += amountToPool;
            }
        } else if (outcome == 3) {
            unchecked {
                pool.reserve1 += amountToPool;
                pool.reserve2 += amountToPool;
                pool.reserve3 = uint128(uint256(pool.reserve3) + a - uint256(sharesOut));
                if (n >= 4) pool.reserve4 += amountToPool;
            }
        } else {
            unchecked {
                pool.reserve1 += amountToPool;
                pool.reserve2 += amountToPool;
                if (n >= 3) pool.reserve3 += amountToPool;
                pool.reserve4 = uint128(uint256(pool.reserve4) + a - uint256(sharesOut));
            }
        }
    }

    /// @dev FPMM reverse: calculate tokens out for selling shares
    ///      r_i_new = r_i * ∏(r_k / (r_k - tokensOut)) for k ≠ i
    ///      We solve for tokensOut given sharesToSell
    function _calculateTokensOut(
        AMMPool storage pool,
        uint8   outcome,
        uint8   n,
        uint128 sharesToSell
    ) internal view returns (uint128) {
        uint256[4] memory r;
        r[0] = uint256(pool.reserve1);
        r[1] = uint256(pool.reserve2);
        r[2] = n >= 3 ? uint256(pool.reserve3) : 0;
        r[3] = n >= 4 ? uint256(pool.reserve4) : 0;

        uint256 rI = r[outcome - 1];
        uint256 s = uint256(sharesToSell);

        // Binary search for tokensOut
        uint256 lo = 0;
        uint256 hi = rI;
        if (hi > pool.totalLiquidity) hi = uint256(pool.totalLiquidity);

        for (uint256 iter = 0; iter < 128; iter++) {
            uint256 mid = (lo + hi + 1) / 2;

            uint256 product = rI * 1e18;
            for (uint8 k = 0; k < n; k++) {
                if (k != outcome - 1) {
                    if (r[k] <= mid) {
                        product = type(uint256).max;
                        break;
                    }
                    product = (product * r[k]) / (r[k] - mid);
                }
            }

            uint256 rINew;
            if (product == type(uint256).max) {
                rINew = type(uint256).max;
            } else {
                rINew = product / 1e18;
            }

            uint256 sharesNeeded;
            if (rINew == type(uint256).max || rINew < rI) {
                sharesNeeded = type(uint256).max;
            } else {
                sharesNeeded = rINew - rI + mid;
            }

            if (sharesNeeded <= s) {
                lo = mid;
            } else {
                hi = mid - 1;
            }

            if (lo == hi) break;
        }

        return uint128(lo);
    }

    /// @dev Update reserves after a sell:
    ///      non-target reserves -= tokensOut, target reserve += sharesToSell - tokensOut
    function _updateReservesAfterSell(
        AMMPool storage pool,
        uint8   outcome,
        uint8   n,
        uint128 tokensGross,
        uint128 sharesToSell
    ) internal {
        if (outcome == 1) {
            pool.reserve1 += sharesToSell;
            pool.reserve1 -= tokensGross;
            pool.reserve2 -= tokensGross;
            if (n >= 3) pool.reserve3 -= tokensGross;
            if (n >= 4) pool.reserve4 -= tokensGross;
        } else if (outcome == 2) {
            pool.reserve1 -= tokensGross;
            pool.reserve2 += sharesToSell;
            pool.reserve2 -= tokensGross;
            if (n >= 3) pool.reserve3 -= tokensGross;
            if (n >= 4) pool.reserve4 -= tokensGross;
        } else if (outcome == 3) {
            pool.reserve1 -= tokensGross;
            pool.reserve2 -= tokensGross;
            pool.reserve3 += sharesToSell;
            pool.reserve3 -= tokensGross;
            if (n >= 4) pool.reserve4 -= tokensGross;
        } else {
            pool.reserve1 -= tokensGross;
            pool.reserve2 -= tokensGross;
            if (n >= 3) pool.reserve3 -= tokensGross;
            pool.reserve4 += sharesToSell;
            pool.reserve4 -= tokensGross;
        }
    }



    // ========================================================================
    // VIEW: Encrypted balance getters (for cofhejs permit/sealOutput)
    // ========================================================================

    /// @notice Returns encrypted share balance handle for the caller
    function getEncShareBalance(bytes32 marketId, uint8 outcome) external view returns (euint128) {
        return encShareBalances[_shareKey(marketId, msg.sender, outcome)];
    }

    /// @notice Returns encrypted LP balance handle for the caller
    function getEncLPBalance(bytes32 marketId) external view returns (euint128) {
        return encLPBalances[_lpKey(marketId, msg.sender)];
    }

    // ========================================================================
    // FHE HELPER — optimized balance selection
    // ========================================================================

    function _fheAddEnc(euint128 current, euint128 amount) internal returns (euint128) {
        if (FHE.isInitialized(current)) {
            euint128 result = FHE.add(current, amount);
            FHE.allowThis(result);
            FHE.allowSender(result);
            return result;
        } else {
            FHE.allowThis(amount);
            FHE.allowSender(amount);
            return amount;
        }
    }

    function _creditSecretShares(bytes32 marketId, address user, euint8 eOutcome, euint128 eShares, uint8 n) internal {
        euint128 zero = FHE.asEuint128(0);
        FHE.allowThis(zero);
        for (uint8 i = 1; i <= n; i++) {
            bytes32 key = _shareKey(marketId, user, i);
            ebool isThis = FHE.eq(eOutcome, FHE.asEuint8(i));
            euint128 delta = FHE.select(isThis, eShares, zero);
            FHE.allowThis(delta);
            encShareBalances[key] = _fheAddEnc(encShareBalances[key], delta);
        }
    }

    function _addSecretVoteTallies(VoteTally storage tally, euint8 eOutcome, euint128 eBond, uint8 n) internal {
        euint128 zero = FHE.asEuint128(0);
        FHE.allowThis(zero);

        ebool is1 = FHE.eq(eOutcome, FHE.asEuint8(1));
        euint128 delta1 = FHE.select(is1, eBond, zero);
        FHE.allowThis(delta1);
        tally.encOutcome1Bonds = _fheAddEnc(tally.encOutcome1Bonds, delta1);

        ebool is2 = FHE.eq(eOutcome, FHE.asEuint8(2));
        euint128 delta2 = FHE.select(is2, eBond, zero);
        FHE.allowThis(delta2);
        tally.encOutcome2Bonds = _fheAddEnc(tally.encOutcome2Bonds, delta2);

        if (n >= 3) {
            ebool is3 = FHE.eq(eOutcome, FHE.asEuint8(3));
            euint128 delta3 = FHE.select(is3, eBond, zero);
            FHE.allowThis(delta3);
            tally.encOutcome3Bonds = _fheAddEnc(tally.encOutcome3Bonds, delta3);
        }
        if (n >= 4) {
            ebool is4 = FHE.eq(eOutcome, FHE.asEuint8(4));
            euint128 delta4 = FHE.select(is4, eBond, zero);
            FHE.allowThis(delta4);
            tally.encOutcome4Bonds = _fheAddEnc(tally.encOutcome4Bonds, delta4);
        }
    }

    // ========================================================================
    // RECEIVE — allow contract to hold ETH
    // ========================================================================

    receive() external payable {}
}
