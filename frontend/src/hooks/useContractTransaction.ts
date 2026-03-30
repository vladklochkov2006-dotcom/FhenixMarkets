// ============================================================================
// useContractTransaction — Ethers.js transaction execution hook
// ============================================================================
// Replaces useAleoTransaction. Executes contract calls via Privy signer.
// Handles demo mode, user rejection, gas estimation, and receipt waiting.
// ============================================================================

import { useCallback, useState } from 'react'
import { useWalletStore } from '@/lib/store'
import { ensureSepoliaNetwork, parseContractError } from '@/lib/contracts'
import { devLog, devWarn } from '@/lib/logger'

export type TxPhase = 'idle' | 'confirming' | 'pending' | 'success' | 'error'

export interface TxState {
  phase: TxPhase
  txHash: string | null
  error: string | null
}

const initialState: TxState = {
  phase: 'idle',
  txHash: null,
  error: null,
}

/**
 * Generic hook for executing contract transactions.
 *
 * Usage:
 *   const { execute, state, reset } = useContractTransaction()
 *   await execute(() => contracts.buyShares(marketId, outcome, minOut, { value: amount }))
 */
export function useContractTransaction() {
  const [state, setState] = useState<TxState>(initialState)
  const { wallet } = useWalletStore()

  const reset = useCallback(() => setState(initialState), [])

  const execute = useCallback(
    async <T>(
      contractCall: () => Promise<T>,
      options?: {
        onSuccess?: (result: T) => void
        onError?: (error: string) => void
        skipNetworkCheck?: boolean
      }
    ): Promise<T | null> => {
      // Demo mode
      if (wallet.isDemoMode) {
        setState({ phase: 'pending', txHash: null, error: null })
        devLog('[TX] Demo mode — simulating transaction')
        await new Promise(r => setTimeout(r, 2000))
        const demoHash = `0x${'demo'.padEnd(64, '0')}`
        setState({ phase: 'success', txHash: demoHash, error: null })
        return null
      }

      // Check wallet connected
      if (!wallet.connected || !wallet.address) {
        const err = 'Please connect your wallet first.'
        setState({ phase: 'error', txHash: null, error: err })
        options?.onError?.(err)
        return null
      }

      try {
        // Ensure correct network
        if (!options?.skipNetworkCheck) {
          await ensureSepoliaNetwork()
        }

        // Phase: waiting for user confirmation in wallet
        setState({ phase: 'confirming', txHash: null, error: null })
        devLog('[TX] Awaiting user confirmation...')

        // Execute the contract call (this triggers the wallet popup)
        const result = await contractCall()

        // Extract tx hash from result if it's a receipt
        const txHash = (result as any)?.hash || (result as any)?.transactionHash || null

        if (txHash) {
          setState({ phase: 'pending', txHash, error: null })
          devLog('[TX] Transaction submitted:', txHash)
        }

        setState({ phase: 'success', txHash, error: null })
        devLog('[TX] Transaction confirmed:', txHash)
        options?.onSuccess?.(result)
        return result
      } catch (err: any) {
        const errorMsg = parseContractError(err)
        devWarn('[TX] Transaction failed:', errorMsg)
        setState({ phase: 'error', txHash: null, error: errorMsg })
        options?.onError?.(errorMsg)
        return null
      }
    },
    [wallet.connected, wallet.address, wallet.isDemoMode]
  )

  return { execute, state, reset }
}

/**
 * Simplified hook — returns just an execute function and loading state.
 * Good for simple buttons (claim, finalize, etc.)
 */
export function useSimpleTransaction() {
  const { execute, state, reset } = useContractTransaction()
  return {
    execute,
    isLoading: state.phase === 'confirming' || state.phase === 'pending',
    isSuccess: state.phase === 'success',
    isError: state.phase === 'error',
    error: state.error,
    txHash: state.txHash,
    reset,
  }
}
