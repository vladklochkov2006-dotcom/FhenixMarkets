# Fhenix Markets

<div align="center">

### **Encrypted Bets. Total Privacy.**

Privacy-preserving prediction market protocol powered by Fully Homomorphic Encryption on Ethereum

[![Live on Fhenix](https://img.shields.io/badge/Live-Fhenix_Helium-8B5CF6?style=for-the-badge)](https://explorer.helium.fhenix.zone/address/0x050262EDE0E6320B2A9AB463776D87cdAfD44572)
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

Fhenix Markets uses **Fully Homomorphic Encryption (FHE)** via the Fhenix CoFHE coprocessor to encrypt user positions on-chain. The smart contract computes on encrypted data — share balances and even **trade inputs** are never stored or transmitted in plaintext.

### What's Private vs Public

| Data | Visibility | Why |
|------|-----------|-----|
| **Trade Outcome** | **Encrypted** (`InEuint8`) | Client-side encryption via `cofhejs` — observers don't know what you bet on |
| **Share balances** | **Encrypted** (`euint128`) | FHE — only owner can decrypt with permit |
| **LP positions** | **Encrypted** (`euint128`) | FHE — private liquidity provision |
| **Event logs** | **Minimal** | Events emit only `(marketId, address)` — no amounts, no outcomes |
| Market questions, AMM reserves, prices | Public | Required for price discovery |
| ETH value sent (`msg.value`) | Public | EVM limitation — ETH transfers are always visible |

### How FHE Works in This Protocol

```
    User selects Outcome → cofhejs.encrypt(outcome) → encrypted bytes
                               ↓
    Contract call: buyShares(marketId, outcomeIndex, encrypted_outcome, ...)
                               ↓
    Contract computes AMM math on public reserves (price discovery)
                               ↓
    Shares calculated → FHE.asEuint128(sharesOut) → encrypted
                               ↓
    encShareBalances[key] = FHE.add(current, FHE.select(match, encShares, 0))
                               ↓
    Event emitted: SharesBought(marketId, buyer)  ← no amounts or outcomes leaked
                               ↓
    CoFHE coprocessor handles asynchronous decryption during resolution
```

Nobody can call `balanceOf()` to see your position. Only you can decrypt via an FHE permit.

## Smart Contracts

Deployed on **Fhenix Helium (Testnet)**:

| Contract | Address | Purpose |
|----------|---------|---------|
| **FhenixMarkets** | [`0x050262EDE0E6320B2A9AB463776D87cdAfD44572`](https://explorer.helium.fhenix.zone/address/0x050262EDE0E6320B2A9AB463776D87cdAfD44572) | Markets, AMM, trading, encrypted resolution |
| **FhenixGovernance** | [`0x08e04595ACC18e4282CacB7c907b592a3031cA94`](https://explorer.helium.fhenix.zone/address/0x08e04595ACC18e4282CacB7c907b592a3031cA94) | DAO governance, resolver registry, voter bond tallies (`euint128`) |

### FhenixMarkets — Core Functions

**Trading (Client-Side Encrypted):**
| Function | Description |
|----------|-------------|
| `buyShares` | Buy shares using `InEuint8` encrypted outcome. Position is hidden. |
| `sellShares` | Sell shares back to the pool. FHE.sub reverts on insufficient balance. |
| `addLiquidity` | Provide liquidity, receive encrypted LP shares. |

**Resolution (Asynchronous FHE):**
| Function | Description |
|----------|-------------|
| `voteOutcome` | Vote using encrypted outcome (`InEuint8`). Bond tallies are `euint128`. |
| `requestVoteDecryption` | Trigger CoFHE coprocessor to decrypt the winner once voting ends. |
| `finalizeVotes` | Finalize the market based on coprocessor output. |
| `claimVoterBond` | Winners claim bond; requires individual FHE decryption of their vote. |

## Architecture

```
┌──────────────────────┐     ┌───────────────────────┐
│   Frontend           │────▶│   FHE SDK (cofhejs)    │
│   React 18 / Vite    │     │   Client-side encrypt  │
│   TypeScript          │     └───────┬───────────────┘
│                      │             │
└──────┬───────────────┘             ▼
       │                     ┌───────────────────────────────────┐
       │                     │   Fhenix Helium (Sepolia)         │
       │                     │                                   │
       │                     │   FhenixMarkets.sol               │
       ▼                     │   ├─ Encrypted Inputs (InEuint8)  │
┌──────────────┐             │   ├─ encShareBalances (euint128)  │
│   Wallets    │             │   └─ Async CoFHE Decryption       │
│   (Privy)    │             └───────────────────────────────────┘
└──────────────┘
```

## Quick Start

### Prerequisites

- Node.js 18+
- Sepolia ETH (bridged to Fhenix) or native Helium tokens
- [Fhenix Helium RPC](https://docs.fhenix.io/) configured in wallet

### Frontend

```bash
cd frontend
npm install
npm run dev
```

### Deploy Contracts

```bash
cd contracts-fhenix
npm install
npx hardhat run scripts/deploy.ts --network eth-sepolia
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Smart Contracts** | Solidity 0.8.25, Hardhat, @fhenixprotocol/cofhe-contracts |
| **FHE** | Fhenix CoFHE (euint128, InEuint8, ebool, FHE select/add/sub) |
| **SDK** | `cofhejs/web` (Client-side encryption / Ethers integration) |
| **Frontend** | React 18, TypeScript, Vite, Tailwind CSS, Framer Motion |
| **Wallet** | Privy (Embedded & Social Wallets) |
| **Network** | Fhenix Helium (chainId 11155111) |

## Privacy Guarantees

**What an on-chain observer sees:**
- A user sent ETH to the FhenixMarkets contract.
- A transaction was submitted with encrypted calldata (`InEuint8`).
- A `SharesBought` event was emitted (no outcome, no amount).

**What they cannot determine:**
- **The Outcome:** The choice is encrypted before it leaves the browser.
- **The Amount:** Share balances are stored as encrypted `euint128` ciphertexts.
- **The Winner:** Bond tallies during voting are encrypted until market finalization.

**Solved Limitations:**
- [x] **Encrypted Inputs:** Calldata no longer contains plaintext outcomes.
- [x] **Encrypted Resolution:** Voting weights are hidden until the market is finalized.

## License

MIT License — see [LICENSE](./LICENSE)

---

<div align="center">

**Built with Fhenix CoFHE on Ethereum**

[FhenixMarkets Contract](https://explorer.helium.fhenix.zone/address/0x050262EDE0E6320B2A9AB463776D87cdAfD44572) · [FhenixGovernance Contract](https://explorer.helium.fhenix.zone/address/0x08e04595ACC18e4282CacB7c907b592a3031cA94)

</div>
