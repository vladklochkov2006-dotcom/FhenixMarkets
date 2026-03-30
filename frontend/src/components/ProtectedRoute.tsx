import { Navigate } from 'react-router-dom'
import { useWalletStore } from '@/lib/store'

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const connected = useWalletStore((s) => s.wallet.connected)
  const privyReady = useWalletStore((s) => s.wallet.privyReady)

  // Wait for Privy to restore session before deciding — prevents flash redirect on refresh
  if (!privyReady) {
    return (
      <div className="min-h-screen bg-surface-950 flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-brand-400 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (!connected) {
    return <Navigate to="/" replace />
  }

  return <>{children}</>
}
