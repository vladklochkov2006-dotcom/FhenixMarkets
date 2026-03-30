// ============================================================================
// PRIVY WALLET BRIDGE
// ============================================================================
// Runs inside a SEPARATE React root with PrivyProvider.
// Syncs Privy wallet state → useWalletStore (Zustand).
// Stores login/logout/provider functions on window for global access.
// ============================================================================

import { useEffect, useRef } from 'react'
import { usePrivy, useWallets } from '@privy-io/react-auth'
import { BrowserProvider } from 'ethers'
import { useWalletStore, useBetsStore } from '@/lib/store'
import { devLog, devWarn } from '../lib/logger'

export function PrivyWalletBridge() {
  const { ready, authenticated, user, login, logout } = usePrivy()
  const { wallets } = useWallets()
  const prevAddress = useRef<string | null>(null)

  // Store login/logout globally so main app tree can call them
  useEffect(() => {
    ;(window as any).__privyLogin = login
    ;(window as any).__privyLogout = logout
    return () => {
      delete (window as any).__privyLogin
      delete (window as any).__privyLogout
    }
  }, [login, logout])

  // Sync Privy state → Zustand wallet store
  useEffect(() => {
    if (!ready) return

    // Mark Privy as ready so ProtectedRoute knows session check is done
    if (!useWalletStore.getState().wallet.privyReady) {
      useWalletStore.setState({
        wallet: { ...useWalletStore.getState().wallet, privyReady: true },
      })
    }

    const wallet = wallets.find(w => (w as any).chainType === 'ethereum') || wallets[0]
    const address = wallet?.address || null
    const isConnected = authenticated && !!address

    // Store provider/signer getters globally
    if (wallet) {
      ;(window as any).__privyGetProvider = async () => {
        const provider = await wallet.getEthereumProvider()
        return new BrowserProvider(provider)
      }
      ;(window as any).__privyGetSigner = async () => {
        const provider = await wallet.getEthereumProvider()
        const ethersProvider = new BrowserProvider(provider)
        return ethersProvider.getSigner()
      }
    }

    // Detect address change
    if (address && address !== prevAddress.current) {
      devLog('[PrivyBridge] Address changed:', address?.slice(0, 10))
      const isFirstConnect = !prevAddress.current
      prevAddress.current = address

      // Detect wallet client type from Privy (e.g. 'metamask', 'coinbase_wallet', 'privy', etc.)
      const detectedWalletType = wallet?.walletClientType || 'unknown'
      devLog('[PrivyBridge] Wallet client type:', detectedWalletType)

      useWalletStore.setState({
        wallet: {
          ...useWalletStore.getState().wallet,
          connected: true,
          connecting: false,
          address,
          walletType: detectedWalletType,
          isDemoMode: false,
        },
      })

      // Load user bets for this address
      useBetsStore.getState().loadBetsForAddress(address)

      // Fetch ETH balance
      setTimeout(() => {
        useWalletStore.getState().refreshBalance()
      }, 500)

      // Notify main app tree that wallet connected (for navigation)
      if (isFirstConnect) {
        window.dispatchEvent(new CustomEvent('privy:connected', { detail: { address } }))
      }
    }

    // Handle disconnect
    if (!isConnected && prevAddress.current) {
      devWarn('[PrivyBridge] Disconnected')
      prevAddress.current = null
      delete (window as any).__privyGetProvider
      delete (window as any).__privyGetSigner
      useWalletStore.setState({
        wallet: {
          ...useWalletStore.getState().wallet,
          connected: false,
          connecting: false,
          address: null,
          walletType: null,
          isDemoMode: false,
          encryptionKey: null,
          balance: { public: 0n, private: 0n },
        },
      })
    }

    // Update connecting state
    if (!authenticated && !useWalletStore.getState().wallet.connected) {
      useWalletStore.setState({
        wallet: {
          ...useWalletStore.getState().wallet,
          connecting: false,
        },
      })
    }
  }, [ready, authenticated, wallets, user])

  return null
}
