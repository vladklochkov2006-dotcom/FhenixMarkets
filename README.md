# Fhenix Markets

<div align="center">

### **Encrypted Bets. Total Privacy.**

Privacy-preserving prediction market protocol powered by Fully Homomorphic Encryption on Ethereum

[![Live on Sepolia](https://img.shields.io/badge/Live-Sepolia_Testnet-0AD9DC?style=for-the-badge)](https://sepolia.etherscan.io/address/0xF9974E44ae6892944a591DC071B89F4b1a5624b1)
[![Fhenix CoFHE](https://img.shields.io/badge/FHE-Fhenix_CoFHE-8B5CF6?style=for-the-badge)](https://www.fhenix.io/)
[![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](./LICENSE)

</div>

---

## The Problem

Existing prediction markets (Polymarket, Augur, etc.) expose all trading activity on-chain. Anyone can see:
- **Who** bet on what outcome
- **How much** they wagered
- **What position** they hold

This creates real problems: front-running, copy-trading, social pressure, and privacy violations for users betting on sensitive topics (elections, legal outcomes, corporate events).

## The Solution

Fhenix Markets uses **Fully Homomorphic Encryption (FHE)** via the Fhenix CoFHE coprocessor to encrypt user positions on-chain. The smart contract computes on encrypted data — share balances are never stored in plaintext.

### What's Private vs Public

| Data | Visibility | Why |
|------|-----------|-----|
| **Share balances** | **Encrypted** (`euint128`) | FHE — only owner can decrypt with permit |
| **LP positions** | **Encrypted** (`euint128`) | FHE — private liquidity provision |
| **Event logs** | **Minimal** | Events emit only `(marketId, address)` — no amounts, no outcomes |
| Market questions, AMM reserves, prices | Public | Required for price discovery |
| ETH value sent (`msg.value`) | Public | EVM limitation — ETH transfers are always visible |

### How FHE Works in This Protocol

```
User calls buyShares(marketId, outcome, minSharesOut) + sends ETH
                              ↓
    Contract computes AMM math on public reserves (price discovery)
                              ↓
    Shares calculated → FHE.asEuint128(sharesOut) → encrypted
                              ↓
    encShareBalances[key] = FHE.add(current, encrypted_shares)
                              ↓
    Event emitted: SharesBought(marketId, buyer)  ← no amounts leaked
                              ↓
    CoFHE coprocessor handles encryption off-chain (TaskCreated event)
```

Nobody can call `balanceOf()` to see your position. Only you can decrypt via an FHE permit.

## Smart Contracts

Deployed on **Ethereum Sepolia** with Fhenix CoFHE coprocessor:

| Contract | Address | Purpose |
|----------|---------|---------|
| **FhenixMarkets** | [`0xF9974E44ae6892944a591DC071B89F4b1a5624b1`](https://sepolia.etherscan.io/address/0xF9974E44ae6892944a591DC071B89F4b1a5624b1) | Markets, AMM, trading, resolution |
| **FhenixGovernance** | [`0x38d8B27Ee4a014D36Fb5a443fB7b2C081328fb2F`](https://sepolia.etherscan.io/address/0x38d8B27Ee4a014D36Fb5a443fB7b2C081328fb2F) | DAO governance, resolver registry, slashing |

### FhenixMarkets — Core Functions

**Trading:**
| Function | Description |
|----------|-------------|
| `createMarket` | Create market with question, outcomes (2-4), deadlines, initial ETH liquidity |
| `buyShares` | Buy outcome shares via FPMM. Shares stored as `euint128` (encrypted) |
| `sellShares` | Sell shares back to the pool. FHE.sub reverts on insufficient balance |
| `addLiquidity` | Provide liquidity, receive encrypted LP shares |
| `withdrawLiquidity` | Remove liquidity, burn LP shares |

**Resolution (Multi-Voter Quorum + Dispute):**
| Function | Description |
|----------|-------------|
| `voteOutcome` | Vote on market outcome with 0.001 ETH bond (min 3 voters required) |
| `finalizeVotes` | Tally votes after voting window closes |
| `confirmResolution` | Finalize after 12h dispute window if unchallenged |
| `disputeResolution` | Challenge with 3x bond — override winning outcome |
| `claimVoterBond` | Winners claim bond back; losers are slashed |

**Redemption:**
| Function | Description |
|----------|-------------|
| `redeemShares` | Winning shares redeem 1:1 against collateral |
| `claimRefund` | Get refund if market was cancelled |
| `withdrawCreatorFees` | Market creator withdraws accumulated fees |

### FhenixGovernance — DAO Functions

Proposals, voting, delegation, resolver registry, multi-resolver panels, slashing, and reward distribution. Uses FHE for encrypted vote weights.

## FPMM (Fixed Product Market Maker)

The AMM uses a Gnosis-style complete-set minting/burning model:

| Operation | Formula |
|-----------|---------|
| **Buy** | `shares_out = (r_i + a) - r_i × ∏(r_k / (r_k + a))` for k ≠ i |
| **Sell** | `shares_needed = r_i_new - r_i + pool_out` where `r_i_new = r_i × ∏(r_k / (r_k - p))` |
| **Redeem** | Winning shares 1:1 against collateral |
| **Fees** | 0.5% protocol + 0.5% creator + 1% LP = **2% total** |

Supports 2, 3, or 4 outcome markets (Yes/No, multi-choice).

## Architecture

```
┌──────────────────────┐     ┌───────────────────────┐
│   Frontend           │────▶│   Privy Wallet         │
│   React 18 / Vite    │     │   (EVM wallets)        │
│   TypeScript          │     │                       │
│   Tailwind CSS       │     └───────┬───────────────┘
│                      │             │
│  Pages:              │             ▼
│  - Landing           │     ┌───────────────────────────────────┐
│  - Dashboard         │     │   Ethereum Sepolia                │
│  - Market Detail     │     │                                   │
│  - Create Market     │     │   FhenixMarkets.sol               │
│  - My Bets           │     │   ├─ FPMM AMM (public reserves)  │
│  - Governance        │     │   ├─ encShareBalances (euint128)  │
│                      │     │   ├─ encLPBalances (euint128)     │
│                      │     │   └─ Multi-Voter Resolution       │
└──────┬───────────────┘     │                                   │
       │                     │   FhenixGovernance.sol             │
       │                     │   └─ DAO + Resolver Registry      │
       ▼                     │                                   │
┌──────────────┐             │   CoFHE Coprocessor               │
│  Supabase    │             │   └─ Off-chain FHE compute        │
│  (encrypted) │             └───────────────────────────────────┘
├──────────────┤
│  IPFS/Pinata │
│  (metadata)  │
└──────────────┘
```

## Project Structure

```
fhenix-markets/
├── contracts-fhenix/           # Solidity smart contracts
│   ├── contracts/
│   │   ├── FhenixMarkets.sol   # Core market + AMM + FHE balances
│   │   └── FhenixGovernance.sol # DAO governance + resolver registry
│   ├── scripts/deploy.ts       # Deployment script
│   └── hardhat.config.ts
├── frontend/                   # React application
│   ├── src/
│   │   ├── components/         # UI components (modals, panels, cards)
│   │   ├── hooks/              # React hooks (wallet, transactions)
│   │   ├── lib/                # Core logic
│   │   │   ├── contracts.ts    # Contract interaction layer
│   │   │   ├── amm.ts          # FPMM math (matching on-chain formulas)
│   │   │   ├── store.ts        # Zustand state management
│   │   │   ├── market-store.ts # Market data fetching + caching
│   │   │   ├── config.ts       # Environment configuration
│   │   │   ├── supabase.ts     # Encrypted bet persistence
│   │   │   ├── crypto.ts       # AES-256-GCM client-side encryption
│   │   │   └── abis/           # Contract ABIs
│   │   └── pages/              # Route pages
│   └── public/
└── supabase-schema.sql         # Database schema
```

## Quick Start

### Prerequisites

- Node.js 18+
- MetaMask or any EVM wallet
- Sepolia ETH ([faucet](https://sepoliafaucet.com/))

### Frontend

```bash
cd frontend
npm install
cp .env.example .env
# Edit .env with your Supabase and Pinata keys (optional)
npm run dev
```

### Deploy Contracts

```bash
cd contracts-fhenix
npm install
cp .env.example .env
# Add DEPLOYER_PRIVATE_KEY to .env

npx hardhat compile
npx hardhat run scripts/deploy.ts --network eth-sepolia
```

### Environment Variables

```env
# Contracts (defaults are pre-filled with deployed addresses)
VITE_MARKETS_CONTRACT=0xF9974E44ae6892944a591DC071B89F4b1a5624b1
VITE_GOVERNANCE_CONTRACT=0x38d8B27Ee4a014D36Fb5a443fB7b2C081328fb2F

# Privy (wallet authentication)
VITE_PRIVY_APP_ID=your-privy-app-id

# Optional: Supabase (cross-device bet sync with E2E encryption)
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key

# Optional: IPFS (market metadata)
VITE_PINATA_JWT=your-pinata-jwt
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Smart Contracts** | Solidity 0.8.25, Hardhat, @fhenixprotocol/cofhe-contracts |
| **FHE** | Fhenix CoFHE coprocessor (euint128, ebool, FHE.add/sub/select) |
| **Frontend** | React 18, TypeScript, Vite, Tailwind CSS, Framer Motion, PWA |
| **Wallet** | Privy (MetaMask, WalletConnect, Coinbase, embedded wallets) |
| **State** | Zustand |
| **Persistence** | Supabase (AES-256-GCM client-side encrypted) + localStorage |
| **Metadata** | IPFS via Pinata |
| **Network** | Ethereum Sepolia (chainId 11155111) |

## Privacy Guarantees

**What an on-chain observer sees:**
- A user sent X ETH to the FhenixMarkets contract
- A `SharesBought(marketId, buyer)` event was emitted
- A `TaskCreated` event from the CoFHE coprocessor (FHE computation)

**What they cannot determine:**
- Which outcome the user bet on (not in events)
- How many shares they received (encrypted in `euint128`)
- Their total position size (encrypted balance, no `balanceOf`)
- Their LP position (encrypted in `euint128`)

**Known limitations:**
- `msg.value` is always public on EVM — the amount of ETH sent is visible
- AMM reserve changes are public — sophisticated analysis of reserve deltas could narrow down trade direction
- Calldata contains the outcome parameter in plaintext — a future version could use encrypted inputs (`InEuint8`)

## License

MIT License — see [LICENSE](./LICENSE)

---

<div align="center">

**Built with Fhenix CoFHE on Ethereum**

[FhenixMarkets Contract](https://sepolia.etherscan.io/address/0xF9974E44ae6892944a591DC071B89F4b1a5624b1) · [FhenixGovernance Contract](https://sepolia.etherscan.io/address/0x38d8B27Ee4a014D36Fb5a443fB7b2C081328fb2F)

</div>
