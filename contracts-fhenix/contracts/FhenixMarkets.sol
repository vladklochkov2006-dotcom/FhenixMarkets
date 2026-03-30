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

import {FHE, euint128, ebool} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

contract FhenixMarkets {

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

    struct VoteTally {
        uint128 outcome1Bonds;
        uint128 outcome2Bonds;
        uint128 outcome3Bonds;
        uint128 outcome4Bonds;
        uint8   totalVoters;
        uint128 totalBonded;
        uint64  votingDeadline;
        uint64  disputeDeadline;
        bool    finalized;
        uint8   winningOutcome;
    }

    struct VoterInfo {
        uint8   votedOutcome;
        uint128 bondAmount;
        bool    claimed;
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
    mapping(bytes32 => VoterInfo) public voters;

    // Dispute bonds: marketId => bond amount deposited
    mapping(bytes32 => uint128) public disputeBonds;
    // Dispute info: marketId => disputer address
    mapping(bytes32 => address) public disputers;
    // Dispute proposed outcome
    mapping(bytes32 => uint8) public disputeOutcomes;

    // Share redemption tracking: keccak256(marketId, user, outcome) => redeemed
    mapping(bytes32 => bool) public shareRedeemed;
    // Creator fee claimed: marketId => claimed
    mapping(bytes32 => bool) public creatorFeesClaimed;
    // LP refund claimed: keccak256(marketId, user) => claimed
    mapping(bytes32 => bool) public lpRefundClaimed;

    // Protocol treasury
    uint128 public protocolTreasury;

    // Voter rewards pool: address => accumulated rewards
    mapping(address => uint128) public voterRewards;

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
    mapping(bytes32 => uint128) public totalSharesIssued; // keccak256(marketId, outcome)

    // ========================================================================
    // EVENTS
    // ========================================================================

    event MarketCreated(
        bytes32 indexed marketId,
        address indexed creator,
        bytes32 questionHash,
        uint8   numOutcomes,
        uint64  deadline,
        uint128 initialLiquidity
    );

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

    event VoteSubmitted(
        bytes32 indexed marketId,
        address indexed voter,
        uint128 bondAmount
    );

    event VotesFinalized(bytes32 indexed marketId, uint8 winningOutcome);
    event ResolutionConfirmed(bytes32 indexed marketId, uint8 winningOutcome);
    event ResolutionDisputed(bytes32 indexed marketId, address disputer, uint8 proposedOutcome);

    event SharesRedeemed(bytes32 indexed marketId, address indexed redeemer);
    event RefundClaimed(bytes32 indexed marketId, address indexed claimer);

    // ========================================================================
    // MODIFIERS
    // ========================================================================

    modifier onlyDeployer() {
        require(msg.sender == deployer, "Only deployer");
        _;
    }

    modifier marketExists(bytes32 marketId) {
        require(markets[marketId].creator != address(0), "Market not found");
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
            return result;
        } else {
            FHE.allowThis(enc);
            return enc;
        }
    }

    function _fheSub(euint128 current, uint128 amount) internal returns (euint128) {
        euint128 enc = FHE.asEuint128(uint256(amount));
        euint128 result = FHE.sub(current, enc);
        FHE.allowThis(result);
        return result;
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
        require(numOutcomes >= 2 && numOutcomes <= 4, "2-4 outcomes");
        require(msg.value >= MIN_LIQUIDITY, "Min liquidity");
        require(deadline > block.timestamp, "Deadline in future");
        require(resolutionDeadline > deadline, "Resolution after deadline");

        uint128 initialLiquidity = uint128(msg.value);

        // Generate unique market ID
        bytes32 marketId = keccak256(abi.encodePacked(
            msg.sender,
            questionHash,
            deadline,
            resolutionDeadline,
            block.timestamp
        ));

        require(markets[marketId].creator == address(0), "Market exists");

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
            numOutcomes, deadline, initialLiquidity
        );

        return marketId;
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
        uint128 minSharesOut
    ) external payable marketExists(marketId) {
        Market storage market = markets[marketId];
        require(market.status == MARKET_STATUS_ACTIVE, "Not active");
        require(block.timestamp <= market.deadline, "Expired");
        require(outcome >= 1 && outcome <= market.numOutcomes, "Invalid outcome");

        uint128 amountIn = uint128(msg.value);
        require(amountIn >= MIN_TRADE_AMOUNT, "Below minimum");

        // Calculate fees
        uint128 protocolFee = (amountIn * PROTOCOL_FEE_BPS) / FEE_DENOMINATOR;
        uint128 creatorFee  = (amountIn * CREATOR_FEE_BPS) / FEE_DENOMINATOR;
        uint128 amountToPool = amountIn - protocolFee - creatorFee;

        // Accumulate fees (public)
        MarketFees storage fees = marketFees[marketId];
        fees.protocolFees += protocolFee;
        fees.creatorFees  += creatorFee;
        protocolTreasury  += protocolFee;

        // FPMM calculation (public math on public reserves)
        AMMPool storage pool = ammPools[marketId];
        uint8 n = market.numOutcomes;
        uint128 sharesOut = _calculateSharesOut(pool, outcome, n, amountToPool);

        require(sharesOut >= minSharesOut, "Slippage");
        require(sharesOut > 0, "Zero shares");

        // Update reserves (public)
        _updateReservesAfterBuy(pool, outcome, n, amountToPool, sharesOut);
        pool.totalLiquidity += amountToPool;
        pool.totalVolume    += amountIn;

        // Track ETH held
        marketCredits[marketId] += amountIn;

        // Track total shares issued (public counter)
        bytes32 oKey = _outcomeShareKey(marketId, outcome);
        totalSharesIssued[oKey] += sharesOut;

        // ---- FHE: Add shares to encrypted balance (PRIVATE) ----
        bytes32 key = _shareKey(marketId, msg.sender, outcome);
        encShareBalances[key] = _fheAdd(encShareBalances[key], sharesOut);

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
    ) external marketExists(marketId) {
        Market storage market = markets[marketId];
        require(market.status == MARKET_STATUS_ACTIVE, "Not active");
        require(block.timestamp <= market.deadline, "Expired");
        require(outcome >= 1 && outcome <= market.numOutcomes, "Invalid outcome");
        require(sharesToSell > 0, "Zero shares");

        // FPMM reverse calculation: how many tokens for sharesToSell
        AMMPool storage pool = ammPools[marketId];
        uint8 n = market.numOutcomes;
        uint128 tokensGross = _calculateTokensOut(pool, outcome, n, sharesToSell);

        // Fees on gross tokens
        uint128 protocolFee = (tokensGross * PROTOCOL_FEE_BPS) / FEE_DENOMINATOR;
        uint128 creatorFee  = (tokensGross * CREATOR_FEE_BPS) / FEE_DENOMINATOR;
        uint128 lpFee       = (tokensGross * LP_FEE_BPS) / FEE_DENOMINATOR;
        uint128 netTokens   = tokensGross - protocolFee - creatorFee - lpFee;

        require(netTokens >= minTokensOut, "Slippage");

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

        // ---- FHE: Subtract shares from encrypted balance (PRIVATE) ----
        // FHE.sub reverts on underflow → insufficient balance check
        bytes32 key = _shareKey(marketId, msg.sender, outcome);
        encShareBalances[key] = _fheSub(encShareBalances[key], sharesToSell);

        // Transfer ETH to seller
        (bool sent, ) = payable(msg.sender).call{value: netTokens}("");
        require(sent, "ETH transfer failed");

        emit SharesSold(marketId, msg.sender);
    }

    // ========================================================================
    // 4. ADD LIQUIDITY
    // ========================================================================

    function addLiquidity(bytes32 marketId) external payable marketExists(marketId) {
        Market storage market = markets[marketId];
        require(market.status == MARKET_STATUS_ACTIVE, "Not active");
        require(block.timestamp <= market.deadline, "Expired");

        uint128 amount = uint128(msg.value);
        require(amount >= MIN_LIQUIDITY, "Min liquidity");

        AMMPool storage pool = ammPools[marketId];

        // LP shares proportional to existing pool
        uint128 lpShares;
        if (pool.totalLPShares == 0) {
            lpShares = amount;
        } else {
            lpShares = (amount * pool.totalLPShares) / pool.totalLiquidity;
        }

        require(lpShares > 0, "Zero LP shares");

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
    ) external marketExists(marketId) {
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

        require(lpSharesToWithdraw > 0, "Zero shares");

        // Calculate proportional payout
        AMMPool storage pool = ammPools[marketId];
        uint128 tokensOut = (lpSharesToWithdraw * pool.totalLiquidity) / pool.totalLPShares;

        require(tokensOut > 0, "Zero payout");
        require(tokensOut <= marketCredits[marketId], "Insufficient funds");

        // Update pool
        pool.totalLPShares  -= lpSharesToWithdraw;
        pool.totalLiquidity -= tokensOut;
        marketCredits[marketId] -= tokensOut;

        // ---- FHE: Subtract LP shares (PRIVATE) ----
        // FHE.sub reverts on underflow → insufficient balance check
        bytes32 key = _lpKey(marketId, msg.sender);
        encLPBalances[key] = _fheSub(encLPBalances[key], lpSharesToWithdraw);

        (bool sent, ) = payable(msg.sender).call{value: tokensOut}("");
        require(sent, "ETH transfer failed");

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
        require(market.status == MARKET_STATUS_ACTIVE, "Not active");
        require(block.timestamp > market.deadline, "Not past deadline");

        market.status = STATUS_PENDING_RESOLUTION;

        voteTallies[marketId] = VoteTally({
            outcome1Bonds: 0,
            outcome2Bonds: 0,
            outcome3Bonds: 0,
            outcome4Bonds: 0,
            totalVoters: 0,
            totalBonded: 0,
            votingDeadline: uint64(block.timestamp) + VOTE_WINDOW,
            disputeDeadline: 0,
            finalized: false,
            winningOutcome: 0
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
        uint8   outcome
    ) external payable marketExists(marketId) {
        Market storage market = markets[marketId];
        require(
            market.status == STATUS_PENDING_RESOLUTION ||
            market.status == STATUS_DISPUTED,
            "Not in voting"
        );

        VoteTally storage tally = voteTallies[marketId];
        require(block.timestamp <= tally.votingDeadline, "Voting closed");
        require(outcome >= 1 && outcome <= market.numOutcomes, "Invalid outcome");

        uint128 bondAmount = uint128(msg.value);
        require(bondAmount >= MIN_VOTE_BOND, "Min bond");

        // Check not already voted
        bytes32 vKey = _voterKey(marketId, msg.sender);
        require(voters[vKey].bondAmount == 0, "Already voted");

        // Record vote
        voters[vKey] = VoterInfo({
            votedOutcome: outcome,
            bondAmount: bondAmount,
            claimed: false
        });

        // Tally bonds per outcome
        if (outcome == 1) tally.outcome1Bonds += bondAmount;
        else if (outcome == 2) tally.outcome2Bonds += bondAmount;
        else if (outcome == 3) tally.outcome3Bonds += bondAmount;
        else if (outcome == 4) tally.outcome4Bonds += bondAmount;

        tally.totalVoters++;
        tally.totalBonded += bondAmount;

        emit VoteSubmitted(marketId, msg.sender, bondAmount);
    }

    // ========================================================================
    // 9. FINALIZE VOTES — determine winning outcome by bond majority
    // ========================================================================

    function finalizeVotes(bytes32 marketId) external marketExists(marketId) {
        Market storage market = markets[marketId];
        require(
            market.status == STATUS_PENDING_RESOLUTION ||
            market.status == STATUS_DISPUTED,
            "Not in voting"
        );

        VoteTally storage tally = voteTallies[marketId];
        require(block.timestamp > tally.votingDeadline, "Voting not closed");
        require(!tally.finalized, "Already finalized");
        require(tally.totalVoters >= MIN_VOTERS, "Not enough voters");

        // Find outcome with highest bonds
        uint128 maxBonds = tally.outcome1Bonds;
        uint8 winner = 1;

        if (tally.outcome2Bonds > maxBonds) {
            maxBonds = tally.outcome2Bonds;
            winner = 2;
        }
        if (market.numOutcomes >= 3 && tally.outcome3Bonds > maxBonds) {
            maxBonds = tally.outcome3Bonds;
            winner = 3;
        }
        if (market.numOutcomes >= 4 && tally.outcome4Bonds > maxBonds) {
            maxBonds = tally.outcome4Bonds;
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
        require(market.status == STATUS_PENDING_FINALIZATION, "Not pending");

        VoteTally storage tally = voteTallies[marketId];
        require(block.timestamp > tally.disputeDeadline, "Dispute window open");

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
        require(market.status == STATUS_PENDING_FINALIZATION, "Not pending");

        VoteTally storage tally = voteTallies[marketId];
        require(block.timestamp <= tally.disputeDeadline, "Window closed");
        require(proposedOutcome >= 1 && proposedOutcome <= market.numOutcomes, "Invalid");
        require(proposedOutcome != tally.winningOutcome, "Same outcome");

        uint128 requiredBond = tally.totalBonded * DISPUTE_BOND_MULTIPLIER;
        uint128 bondAmount = uint128(msg.value);
        require(bondAmount >= requiredBond, "Bond too low");

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
        tally.outcome1Bonds = 0;
        tally.outcome2Bonds = 0;
        tally.outcome3Bonds = 0;
        tally.outcome4Bonds = 0;
        tally.totalVoters = 0;
        tally.totalBonded = 0;

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
    ) external marketExists(marketId) {
        Market storage market = markets[marketId];
        require(market.status == MARKET_STATUS_RESOLVED, "Not resolved");

        VoteTally storage tally = voteTallies[marketId];
        uint8 winningOutcome = tally.winningOutcome;
        require(winningOutcome >= 1, "No winner");

        require(sharesToRedeem > 0, "Zero shares");

        // Payout: each winning share is worth proportional to the pool
        AMMPool storage pool = ammPools[marketId];
        bytes32 oKey = _outcomeShareKey(marketId, winningOutcome);
        uint128 totalWinning = totalSharesIssued[oKey];
        require(totalWinning > 0, "No shares");

        uint128 payout = (sharesToRedeem * pool.totalLiquidity) / totalWinning;
        require(payout > 0, "Zero payout");
        require(payout <= marketCredits[marketId], "Insufficient funds");

        // Update state
        marketCredits[marketId] -= payout;
        totalSharesIssued[oKey] -= sharesToRedeem;

        // ---- FHE: Subtract redeemed shares (PRIVATE) ----
        // FHE.sub reverts on underflow → insufficient balance check
        bytes32 key = _shareKey(marketId, msg.sender, winningOutcome);
        encShareBalances[key] = _fheSub(encShareBalances[key], sharesToRedeem);

        (bool sent, ) = payable(msg.sender).call{value: payout}("");
        require(sent, "ETH transfer failed");

        emit SharesRedeemed(marketId, msg.sender);
    }

    // ========================================================================
    // 13. CLAIM REFUND (cancelled market — get back bet value)
    // ========================================================================

    function claimRefund(
        bytes32 marketId,
        uint8   outcome,
        uint128 sharesToRefund
    ) external marketExists(marketId) {
        Market storage market = markets[marketId];
        require(market.status == MARKET_STATUS_CANCELLED, "Not cancelled");
        require(outcome >= 1 && outcome <= market.numOutcomes, "Invalid");
        require(sharesToRefund > 0, "Zero");

        // Refund proportional to pool
        AMMPool storage pool = ammPools[marketId];
        bytes32 oKey = _outcomeShareKey(marketId, outcome);
        uint128 totalOutcome = totalSharesIssued[oKey];
        require(totalOutcome > 0, "No shares");

        // Proportional refund from pool
        uint128 refundAmount = (sharesToRefund * pool.totalLiquidity) / totalOutcome;
        require(refundAmount <= marketCredits[marketId], "Insufficient");

        marketCredits[marketId] -= refundAmount;
        totalSharesIssued[oKey] -= sharesToRefund;

        // ---- FHE: Subtract shares (PRIVATE) ----
        bytes32 key = _shareKey(marketId, msg.sender, outcome);
        encShareBalances[key] = _fheSub(encShareBalances[key], sharesToRefund);

        (bool sent, ) = payable(msg.sender).call{value: refundAmount}("");
        require(sent, "ETH transfer failed");

        emit RefundClaimed(marketId, msg.sender);
    }

    // ========================================================================
    // 14. CLAIM LP REFUND (cancelled market)
    // ========================================================================

    function claimLPRefund(
        bytes32 marketId,
        uint128 lpSharesToRefund
    ) external marketExists(marketId) {
        Market storage market = markets[marketId];
        require(market.status == MARKET_STATUS_CANCELLED, "Not cancelled");
        require(lpSharesToRefund > 0, "Zero");

        bytes32 key = _lpKey(marketId, msg.sender);
        require(!lpRefundClaimed[key], "Already claimed");

        AMMPool storage pool = ammPools[marketId];
        uint128 refund = (lpSharesToRefund * pool.totalLiquidity) / pool.totalLPShares;
        require(refund <= marketCredits[marketId], "Insufficient");

        pool.totalLPShares  -= lpSharesToRefund;
        pool.totalLiquidity -= refund;
        marketCredits[marketId] -= refund;

        // ---- FHE: Subtract LP shares (PRIVATE) ----
        encLPBalances[key] = _fheSub(encLPBalances[key], lpSharesToRefund);

        (bool sent, ) = payable(msg.sender).call{value: refund}("");
        require(sent, "ETH transfer failed");

        emit RefundClaimed(marketId, msg.sender);
    }

    // ========================================================================
    // 15. WITHDRAW CREATOR FEES
    // ========================================================================

    function withdrawCreatorFees(bytes32 marketId) external marketExists(marketId) {
        Market storage market = markets[marketId];
        require(msg.sender == market.creator, "Not creator");
        require(
            market.status == MARKET_STATUS_RESOLVED ||
            market.status == MARKET_STATUS_CANCELLED,
            "Not finalized"
        );
        require(!creatorFeesClaimed[marketId], "Already claimed");

        uint128 amount = marketFees[marketId].creatorFees;
        require(amount > 0, "No fees");

        creatorFeesClaimed[marketId] = true;

        (bool sent, ) = payable(msg.sender).call{value: amount}("");
        require(sent, "ETH transfer failed");
    }

    // ========================================================================
    // 16. CLAIM VOTER BOND (after resolution confirmed)
    // ========================================================================

    function claimVoterBond(bytes32 marketId) external marketExists(marketId) {
        Market storage market = markets[marketId];
        require(
            market.status == MARKET_STATUS_RESOLVED ||
            market.status == MARKET_STATUS_CANCELLED,
            "Not finalized"
        );

        bytes32 vKey = _voterKey(marketId, msg.sender);
        VoterInfo storage info = voters[vKey];
        require(info.bondAmount > 0, "No bond");
        require(!info.claimed, "Already claimed");

        VoteTally storage tally = voteTallies[marketId];
        uint128 payout = info.bondAmount;

        // Winning voters also get a share of voter rewards
        if (info.votedOutcome == tally.winningOutcome && tally.winningOutcome > 0) {
            MarketFees storage fees = marketFees[marketId];
            uint128 voterPool = (fees.protocolFees * VOTER_REWARD_PERCENT) / 100;

            uint128 winnerBonds = _getOutcomeBonds(tally, tally.winningOutcome);
            if (winnerBonds > 0) {
                uint128 reward = (voterPool * info.bondAmount) / winnerBonds;
                payout += reward;
                voterRewards[msg.sender] += reward;
            }
        }

        info.claimed = true;

        (bool sent, ) = payable(msg.sender).call{value: payout}("");
        require(sent, "ETH transfer failed");
    }

    // ========================================================================
    // 17. CLAIM DISPUTE BOND
    // ========================================================================

    function claimDisputeBond(bytes32 marketId) external marketExists(marketId) {
        require(msg.sender == disputers[marketId], "Not disputer");
        require(
            markets[marketId].status == MARKET_STATUS_RESOLVED ||
            markets[marketId].status == MARKET_STATUS_CANCELLED,
            "Not finalized"
        );

        uint128 bond = disputeBonds[marketId];
        require(bond > 0, "No bond");

        disputeBonds[marketId] = 0;

        (bool sent, ) = payable(msg.sender).call{value: bond}("");
        require(sent, "ETH transfer failed");
    }

    // ========================================================================
    // 18. CLAIM VOTER REWARD — withdraw accumulated voter rewards
    // ========================================================================

    function claimVoterReward() external {
        uint128 reward = voterRewards[msg.sender];
        require(reward > 0, "No rewards");

        voterRewards[msg.sender] = 0;

        (bool sent, ) = payable(msg.sender).call{value: reward}("");
        require(sent, "ETH transfer failed");
    }

    // ========================================================================
    // 19. WITHDRAW PROTOCOL FEES (deployer only)
    // ========================================================================

    function withdrawProtocolFees(uint128 amount) external onlyDeployer {
        require(amount <= protocolTreasury, "Exceeds treasury");
        protocolTreasury -= amount;

        (bool sent, ) = payable(deployer).call{value: amount}("");
        require(sent, "ETH transfer failed");
    }

    // ########################################################################
    //                    MULTISIG TREASURY
    // ########################################################################

    struct MultisigConfig {
        address signer1;
        address signer2;
        address signer3;
        uint8   threshold;        // signatures needed (2 of 3)
        bool    initialized;
    }

    struct TreasuryProposal {
        bytes32 id;
        address proposer;
        address recipient;
        uint128 amount;
        uint8   approvals;
        bool    executed;
        uint64  createdAt;
    }

    MultisigConfig public multisig;

    mapping(bytes32 => TreasuryProposal) public treasuryProposals;
    // keccak256(proposalId, signer) => approved
    mapping(bytes32 => bool) public multisigApprovals;

    event MultisigInitialized(address signer1, address signer2, address signer3, uint8 threshold);
    event TreasuryProposalCreated(bytes32 indexed proposalId, address recipient, uint128 amount);
    event TreasuryProposalApproved(bytes32 indexed proposalId, address signer);
    event TreasuryProposalExecuted(bytes32 indexed proposalId, address recipient, uint128 amount);

    modifier onlyMultisigSigner() {
        require(
            msg.sender == multisig.signer1 ||
            msg.sender == multisig.signer2 ||
            msg.sender == multisig.signer3,
            "Not multisig signer"
        );
        _;
    }

    /// @notice Initialize multisig with 3 signers (2-of-3 by default)
    function initMultisig(
        address signer1,
        address signer2,
        address signer3
    ) external onlyDeployer {
        require(!multisig.initialized, "Multisig already initialized");
        require(signer1 != address(0) && signer2 != address(0) && signer3 != address(0), "Zero signer");
        require(signer1 != signer2 && signer2 != signer3 && signer1 != signer3, "Duplicate signers");

        multisig = MultisigConfig({
            signer1: signer1,
            signer2: signer2,
            signer3: signer3,
            threshold: 2,
            initialized: true
        });

        emit MultisigInitialized(signer1, signer2, signer3, 2);
    }

    /// @notice Propose a treasury withdrawal (any multisig signer)
    function proposeTreasuryWithdrawal(
        address recipient,
        uint128 amount
    ) external onlyMultisigSigner returns (bytes32) {
        require(multisig.initialized, "Multisig not initialized");
        require(recipient != address(0), "Zero recipient");
        require(amount > 0 && amount <= protocolTreasury, "Invalid amount");

        bytes32 proposalId = keccak256(abi.encodePacked(
            msg.sender, recipient, amount, block.timestamp
        ));
        require(treasuryProposals[proposalId].proposer == address(0), "Exists");

        treasuryProposals[proposalId] = TreasuryProposal({
            id: proposalId,
            proposer: msg.sender,
            recipient: recipient,
            amount: amount,
            approvals: 1,       // proposer auto-approves
            executed: false,
            createdAt: uint64(block.timestamp)
        });

        // Auto-approve for proposer
        bytes32 approvalKey = keccak256(abi.encodePacked(proposalId, msg.sender));
        multisigApprovals[approvalKey] = true;

        emit TreasuryProposalCreated(proposalId, recipient, amount);
        emit TreasuryProposalApproved(proposalId, msg.sender);

        return proposalId;
    }

    /// @notice Approve a treasury proposal (another multisig signer)
    function approveTreasuryProposal(bytes32 proposalId) external onlyMultisigSigner {
        TreasuryProposal storage prop = treasuryProposals[proposalId];
        require(prop.proposer != address(0), "Not found");
        require(!prop.executed, "Already executed");

        bytes32 approvalKey = keccak256(abi.encodePacked(proposalId, msg.sender));
        require(!multisigApprovals[approvalKey], "Already approved");

        multisigApprovals[approvalKey] = true;
        prop.approvals++;

        emit TreasuryProposalApproved(proposalId, msg.sender);
    }

    /// @notice Execute a treasury proposal once threshold is met
    function executeTreasuryProposal(bytes32 proposalId) external onlyMultisigSigner {
        TreasuryProposal storage prop = treasuryProposals[proposalId];
        require(prop.proposer != address(0), "Not found");
        require(!prop.executed, "Already executed");
        require(prop.approvals >= multisig.threshold, "Not enough approvals");
        require(prop.amount <= protocolTreasury, "Exceeds treasury");

        prop.executed = true;
        protocolTreasury -= prop.amount;

        (bool sent, ) = payable(prop.recipient).call{value: prop.amount}("");
        require(sent, "ETH transfer failed");

        emit TreasuryProposalExecuted(proposalId, prop.recipient, prop.amount);
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

    /// @notice Get market info
    function getMarket(bytes32 marketId)
        external view
        returns (Market memory)
    {
        return markets[marketId];
    }

    /// @notice Get AMM pool info
    function getPool(bytes32 marketId)
        external view
        returns (AMMPool memory)
    {
        return ammPools[marketId];
    }

    /// @notice Get vote tally
    function getVoteTally(bytes32 marketId)
        external view
        returns (VoteTally memory)
    {
        return voteTallies[marketId];
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
            pool.reserve1 = uint128(uint256(pool.reserve1) + a - uint256(sharesOut));
            pool.reserve2 += amountToPool;
            if (n >= 3) pool.reserve3 += amountToPool;
            if (n >= 4) pool.reserve4 += amountToPool;
        } else if (outcome == 2) {
            pool.reserve1 += amountToPool;
            pool.reserve2 = uint128(uint256(pool.reserve2) + a - uint256(sharesOut));
            if (n >= 3) pool.reserve3 += amountToPool;
            if (n >= 4) pool.reserve4 += amountToPool;
        } else if (outcome == 3) {
            pool.reserve1 += amountToPool;
            pool.reserve2 += amountToPool;
            pool.reserve3 = uint128(uint256(pool.reserve3) + a - uint256(sharesOut));
            if (n >= 4) pool.reserve4 += amountToPool;
        } else {
            pool.reserve1 += amountToPool;
            pool.reserve2 += amountToPool;
            if (n >= 3) pool.reserve3 += amountToPool;
            pool.reserve4 = uint128(uint256(pool.reserve4) + a - uint256(sharesOut));
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

    /// @dev Get bonds for a specific outcome from the tally
    function _getOutcomeBonds(VoteTally storage tally, uint8 outcome) internal view returns (uint128) {
        if (outcome == 1) return tally.outcome1Bonds;
        if (outcome == 2) return tally.outcome2Bonds;
        if (outcome == 3) return tally.outcome3Bonds;
        if (outcome == 4) return tally.outcome4Bonds;
        return 0;
    }

    // ========================================================================
    // RECEIVE — allow contract to hold ETH
    // ========================================================================

    receive() external payable {}
}
