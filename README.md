# Fhenix Markets

<div align="center">

### **Encrypted Bets. Total Privacy.**

Privacy-preserving prediction market protocol powered by Fully Homomorphic Encryption on Ethereum

[![Live on Sepolia](https://img.shields.io/badge/Live-Sepolia-0AD9DC?style=for-the-badge)](https://sepolia.etherscan.io/address/0x5CDd4A82Ec52E2009072d21DF8EF233841de607B)
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

Fhenix Markets uses **Fully Homomorphic Encryption (FHE)** via the Fhenix CoFHE coprocessor. Trade choices are encrypted client-side before leaving the browser, share balances are stored on-chain as encrypted ciphertexts, and vote tallies remain hidden until resolution.

### What's Private vs Public

| Data | Visibility | How |
|------|-----------|-----|
| **Trade outcome (buyShares)** | Encrypted (`InEuint8`) | Client-side encryption via `@cofhe/sdk/web` before submission |
| **Vote outcome (voteOutcome)** | Encrypted (`InEuint8`) | Fully encrypted — no plaintext parameter at all |
| **Share balances** | Encrypted (`euint128`) | FHE storage — only owner can decrypt via permit |
| **LP positions** | Encrypted (`euint128`) | FHE storage — private liquidity provision |
| **Per-outcome bond tallies** | Encrypted (`euint128`) | Remain encrypted until `revealOutcomeTally` with threshold signature |
| **Vote locks, delegations, rewards** | Private mappings | No public getters — can't query another user's stake |
| **Event logs** | Minimal | Trade/vote events emit only `(marketId, address)` — `Data: 0x` |
| Market metadata, AMM reserves, prices | Public | Required for price discovery |
| `msg.value` (ETH sent) | Public | EVM limitation — ETH transfers are always visible |

### How FHE Works in This Protocol

```
  User selects Yes/No → client.encryptInputs([Encryptable.uint8(outcome)]).execute()
                               ↓
  Contract call: buyShares(marketId, outcome, InEuint8 encOutcome, minSharesOut)
                               ↓
  FPMM math computed on public reserves (price discovery)
                               ↓
  euint8 eOutcome = FHE.asEuint8(encOutcome)
  euint128 eShares = FHE.asEuint128(sharesOut)
  encShareBalances[key] = FHE.add(current, FHE.select(match, eShares, 0))
                               ↓
  Event: SharesBought(marketId, buyer)   ← no outcome, no amount
                               ↓
  Resolution: client.decryptForTx(encBond).execute() → (plaintext, signature)
              contract.revealOutcomeTally(marketId, outcome, plaintext, signature)
              FHE.publishDecryptResult(encBond, plaintext, signature)
```

Nobody can call `balanceOf()` to see your position. Only you can decrypt via an FHE permit.

## Smart Contracts

Deployed on **Ethereum Sepolia** (chainId `11155111`) with the Fhenix CoFHE coprocessor:

| Contract | Address | Purpose |
|----------|---------|---------|
| **FhenixMarkets** | [`0x5CDd4A82Ec52E2009072d21DF8EF233841de607B`](https://sepolia.etherscan.io/address/0x5CDd4A82Ec52E2009072d21DF8EF233841de607B) | Markets, FPMM AMM, encrypted trading & resolution |
| **FhenixGovernance** | [`0x75042ED84d417a4c897ACf1f4112467bC041d6a3`](https://sepolia.etherscan.io/address/0x75042ED84d417a4c897ACf1f4112467bC041d6a3) | DAO governance, resolver registry, encrypted vote weights |

### FhenixMarkets — Core Functions

**Trading (client-side encrypted input):**
| Function | Description |
|----------|-------------|
| `createMarket` | Create market with question, 2–4 outcomes, deadlines, initial ETH liquidity |
| `buyShares(marketId, outcome, InEuint8 encOutcome, minSharesOut)` | Buy shares — encrypted outcome used for private balance assignment |
| `sellShares` | Sell shares back to pool. FHE.sub reverts on insufficient balance |
| `addLiquidity` / `withdrawLiquidity` | Provide/remove liquidity, encrypted LP shares |

**Encrypted balance queries (owner-only via permit):**
| Function | Description |
|----------|-------------|
| `getEncryptedShareBalance(marketId, user, outcome)` | Returns `euint128` handle — decrypt via `@cofhe/sdk` |
| `getEncryptedLPBalance(marketId, user)` | Returns `euint128` handle for LP position |

**Resolution (async FHE via CoFHE coprocessor):**
| Function | Description |
|----------|-------------|
| `voteOutcome(marketId, InEuint8 encOutcome)` | Vote with fully encrypted outcome (no plaintext) |
| `finalizeVotes` / `confirmResolution` | Tally results after 12 h window + dispute period |
| `revealOutcomeTally` | On-chain reveal via `FHE.publishDecryptResult(handle, plaintext, signature)` |
| `claimVoterBond` | Winners reclaim bond; losers slashed. Uses `revealVoterOutcome` for individual proof |
| `requestUnshieldShares` | Request async decryption of balance → `revealUnshieldResult` → `executeUnshield` |

**Reentrancy-guarded:** `sellShares`, `withdrawLiquidity`, `redeemShares`, `claimRefund`, `claimLPRefund`.

## Architecture

```
┌──────────────────────┐     ┌──────────────────────────┐
│   Frontend (PWA)     │────▶│   @cofhe/sdk/web          │
│   React 18 / Vite    │     │   createCofheConfig +     │
│   TypeScript         │     │   client.connect(...)     │
│                      │     │   encryptInputs / decrypt │
└──────┬───────────────┘     └───────┬──────────────────┘
       │ privy wallet                │ encrypted calldata
       ▼                             ▼
┌──────────────┐             ┌──────────────────────────────────────┐
│  Privy Auth  │             │  Ethereum Sepolia (chainId 11155111) │
│  (MetaMask,  │             │                                      │
│   Coinbase,  │────────────▶│  FhenixMarkets.sol                   │
│   embedded)  │             │  ├─ FPMM AMM (public reserves)       │
└──────────────┘             │  ├─ encShareBalances (euint128)      │
                             │  ├─ encLPBalances (euint128)         │
                             │  ├─ InEuint8 encrypted inputs        │
                             │  └─ revealOutcomeTally w/ threshold  │
                             │                                      │
                             │  FhenixGovernance.sol                │
                             │  └─ DAO + encrypted vote tallies     │
                             │                                      │
                             │  CoFHE Coprocessor (off-chain)       │
                             │  └─ Threshold network decrypts       │
                             └──────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 18+
- Sepolia ETH for gas ([faucet](https://sepoliafaucet.com))
- EVM wallet (MetaMask, WalletConnect, or Privy embedded)

### Frontend

```bash
cd frontend
npm install
cp .env.example .env   # optional: override contract addresses / Privy app id
npm run dev
```

### Deploy contracts

```bash
cd contracts-fhenix
npm install
# set DEPLOYER_PRIVATE_KEY in .env
npx hardhat compile
npx hardhat run scripts/deploy.ts --network eth-sepolia
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Smart Contracts** | Solidity 0.8.25, Hardhat, `@fhenixprotocol/cofhe-contracts@0.1.3` |
| **FHE primitives** | `euint128`, `euint8`, `ebool`, `FHE.add/sub/select/publishDecryptResult/getDecryptResultSafe` |
| **Client SDK** | `@cofhe/sdk/web@0.4.0` (three-step flow: `createCofheConfig` → `createCofheClient` → `client.connect`) |
| **Encryption API** | `client.encryptInputs([Encryptable.uint8(...)]).execute()` |
| **Decryption API** | `client.decryptForView(handle).execute()` (off-chain UI) + `client.decryptForTx(handle).execute()` (on-chain reveal) |
| **Frontend** | React 18, TypeScript, Vite 5, Tailwind CSS, Framer Motion, PWA manifest |
| **Wallet** | Privy (MetaMask, WalletConnect, Coinbase, embedded wallets) |
| **State** | Zustand with permit caching (5-min TTL per ciphertext handle) |
| **Persistence** | Supabase + localStorage (AES-256-GCM client-side encrypted user data) |
| **Metadata** | IPFS via Pinata |
| **Network** | Ethereum Sepolia (chainId 11155111) + Fhenix CoFHE coprocessor |

## Client SDK Integration

The frontend uses the new `@cofhe/sdk` (April 2026 release). Old `cofhejs` flow has been fully migrated:

```typescript
// 1. Create config + client
const config = createCofheConfig({ supportedChains: [sepolia] })
const client = createCofheClient(config)

// 2. Connect viem clients
await client.connect(publicClient, walletClient)

// 3. Encrypt outcome before buyShares
const [encOutcome] = await client
  .encryptInputs([Encryptable.uint8(BigInt(outcome))])
  .execute()
await contract.buyShares(marketId, outcome, encOutcome, minSharesOut, { value: amount })

// 4. Decrypt balance for UI (cached for 5 minutes)
const balance = await client.decryptForView(encHandle).execute()

// 5. Decrypt for on-chain reveal (returns signature)
const { decryptedValue, signature } = await client.decryptForTx(encHandle).execute()
await contract.revealOutcomeTally(marketId, outcome, decryptedValue, signature)
```

## Privacy Guarantees

**What an on-chain observer sees:**
- A user sent ETH to the FhenixMarkets contract
- A transaction was submitted with encrypted calldata (`InEuint8`)
- `SharesBought(marketId, buyer)` event emitted (empty `Data: 0x`)
- A CoFHE `TaskCreated` event (encrypted FHE operation queued)

**What they cannot determine:**
- **The outcome** — encrypted before leaving browser, not in calldata
- **The share count** — stored as `euint128` ciphertext, no `balanceOf()`
- **LP position size** — same as share balances
- **Vote direction** — bond tallies are encrypted until market finalization
- **Vote locks / delegations / rewards** — mappings are `private`, no getters

**Known EVM limitations (next wave):**
- `msg.value` is always public — observers know the ETH amount of each trade
- AMM reserve deltas reveal aggregate trade direction (not individual positions, but trends)
- `UnshieldRequested` event still carries `outcome` + `amount` — scheduled for event-privacy fix in next deployment cycle

## Project Structure

```
fhenix-markets/
├── contracts-fhenix/
│   ├── contracts/
│   │   ├── FhenixMarkets.sol        # FPMM AMM + FHE balances + encrypted resolution
│   │   └── FhenixGovernance.sol     # DAO + encrypted vote weights
│   ├── scripts/deploy.ts
│   └── hardhat.config.ts            # Sepolia-only network
├── frontend/
│   ├── src/
│   │   ├── components/              # Trading panels, modals, claim UI
│   │   ├── hooks/                   # Privy wallet integration
│   │   ├── lib/
│   │   │   ├── contracts.ts         # @cofhe/sdk init, encrypt/decrypt wrappers, tx helpers
│   │   │   ├── amm.ts               # FPMM math mirroring on-chain formulas
│   │   │   ├── supabase.ts          # AES-256-GCM encrypted persistence
│   │   │   └── abis/                # FhenixMarkets + FhenixGovernance ABIs
│   │   └── pages/                   # Dashboard, CreateMarket, MarketDetail, MyBets, Governance
│   └── public/                      # PWA manifest + icons
└── supabase-schema.sql
```

## License

MIT License — see [LICENSE](./LICENSE)

---

<div align="center">

**Built with Fhenix CoFHE on Ethereum Sepolia**

[FhenixMarkets](https://sepolia.etherscan.io/address/0x5CDd4A82Ec52E2009072d21DF8EF233841de607B) · [FhenixGovernance](https://sepolia.etherscan.io/address/0x75042ED84d417a4c897ACf1f4112467bC041d6a3) · [Fhenix Docs](https://cofhe-docs.fhenix.zone/)

</div>
