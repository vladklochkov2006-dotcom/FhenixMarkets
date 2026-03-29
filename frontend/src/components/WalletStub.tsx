// Stub wallet providers that replace Aleo wallet adapters.
// Provides no-op implementations so useWallet() / useWalletModal() never crash.

import React, { createContext, useContext } from 'react'

// ── useWallet stub ──
const walletDefaults = {
  connected: false,
  connecting: false,
  address: null,
  wallet: null,
  wallets: [],
  publicKey: null,
  signMessage: async () => new Uint8Array(),
  requestRecords: async () => [],
  requestRecordPlaintexts: async () => [],
  decrypt: async () => '',
  selectWallet: () => {},
  connect: async () => {},
  disconnect: async () => {},
}

const WalletContext = createContext<any>(walletDefaults)

export function StubWalletProvider({ children }: { children: React.ReactNode }) {
  return <WalletContext.Provider value={walletDefaults}>{children}</WalletContext.Provider>
}

export function useWallet() {
  return useContext(WalletContext)
}

// ── useWalletModal stub ──
const WalletModalContext = createContext<{ visible: boolean; setVisible: (v: boolean) => void }>({
  visible: false,
  setVisible: () => {},
})

export function StubWalletModalProvider({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = React.useState(false)
  return <WalletModalContext.Provider value={{ visible, setVisible }}>{children}</WalletModalContext.Provider>
}

export function useWalletModal() {
  return useContext(WalletModalContext)
}

// ── WalletModalProvider (alias used by some imports) ──
export const WalletModalProvider = StubWalletModalProvider

// ── Adapter stubs (imported from various @provablehq packages) ──
export class ShieldWalletAdapter { name = 'Shield' }
export class LeoWalletAdapter { name = 'Leo' }
export class FoxWalletAdapter { name = 'Fox' }
export class SoterWalletAdapter { name = 'Soter' }

// ── Enum/constant stubs ──
export const DecryptPermission = { AutoDecrypt: 'AutoDecrypt', NoDecrypt: 'NoDecrypt' }
export const Network = { TESTNET: 'testnet', MAINNET: 'mainnet' }

// ── Re-exports for compatibility ──
export const AleoWalletProvider = StubWalletProvider
