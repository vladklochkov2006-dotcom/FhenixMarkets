// ============================================================================
// usePrivyWallet — Drop-in replacement for useWallet() from Aleo adapter
// ============================================================================
// Reads wallet state from Zustand store (synced by PrivyWalletBridge).
// Does NOT depend on PrivyProvider context — works in any React tree.
// Login/logout actions are stored globally by PrivyWalletBridge.
// ============================================================================

import { useWalletStore } from '@/lib/store'

export function usePrivyWallet() {
  const walletState = useWalletStore((s) => s.wallet)

  return {
    // State (from Zustand, synced by PrivyWalletBridge)
    connected: walletState.connected,
    connecting: walletState.connecting,
    address: walletState.address,
    wallet: null, // raw Privy wallet object not available outside PrivyProvider
    wallets: [],
    user: null,
    ready: !walletState.connecting,

    // Actions (stored globally by PrivyWalletBridge)
    connect: () => { (window as any).__privyLogin?.() },
    disconnect: () => { (window as any).__privyLogout?.() },
    login: () => { (window as any).__privyLogin?.() },
    logout: () => { (window as any).__privyLogout?.() },

    // Ethers.js helpers (use globally stored provider getter)
    getProvider: async () => {
      const getter = (window as any).__privyGetProvider
      if (!getter) throw new Error('Wallet not initialized')
      return getter()
    },
    getSigner: async () => {
      const getter = (window as any).__privyGetSigner
      if (!getter) throw new Error('Wallet not initialized')
      return getter()
    },
  }
}

// Modal replacement — triggers Privy login via global function
export function usePrivyModal() {
  return {
    visible: false,
    setVisible: (v: boolean) => { if (v) (window as any).__privyLogin?.() },
  }
}
