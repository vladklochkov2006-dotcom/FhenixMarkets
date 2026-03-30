// ============================================================================
// WALLET INTEGRATION (Simplified)
// ============================================================================
// Previously contained full Aleo wallet adapter implementations for Leo, Fox,
// Soter, Puzzle, and Shield wallets. Now simplified for Privy/Ethereum wallets.
// Keeps type exports and utility functions used by store.ts.
// ============================================================================

import { devLog, devWarn } from './logger';

export type NetworkType = 'mainnet' | 'testnet';

export interface WalletAccount {
  address: string;
  network: NetworkType;
}

export interface WalletBalance {
  public: bigint;
  private: bigint;
}

export interface TransactionRequest {
  programId: string;
  functionName: string;
  inputs: string[];
  fee: number;
  privateFee?: boolean;
  network?: string;
  recordIndices?: number[];
}

export interface WalletEvents {
  onConnect: (account: WalletAccount) => void;
  onDisconnect: () => void;
  onAccountChange: (account: WalletAccount | null) => void;
  onNetworkChange: (network: NetworkType) => void;
}

export interface WalletTransactionStatusResult {
  status: 'accepted' | 'rejected' | 'pending' | 'unknown';
  transactionId?: string;
  raw?: unknown;
  source?: string;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Look up transaction status from available wallet extensions.
 * Kept for backward compatibility with store.ts.
 */
export async function lookupWalletTransactionStatus(txId: string): Promise<WalletTransactionStatusResult | null> {
  if (!txId || typeof window === 'undefined') return null;
  // No Aleo wallet extensions to poll in Privy/Ethereum mode
  return null;
}

/**
 * Fetch public ETH balance via Privy provider (ethers.js).
 * Returns balance in wei as bigint.
 */
export async function fetchPublicBalance(address: string): Promise<bigint> {
  try {
    const getProvider = (window as any).__privyGetProvider;
    if (typeof getProvider === 'function') {
      const provider = await getProvider();
      const balance = await provider.getBalance(address);
      return BigInt(balance.toString());
    }
    devLog('[wallet] No Privy provider available for balance fetch');
    return 0n;
  } catch (err) {
    devWarn('[wallet] Failed to fetch ETH balance:', err);
    return 0n;
  }
}

// ============================================================================
// WALLET TYPE
// ============================================================================

// Flexible wallet type — Privy supports many wallets dynamically.
// Known types from Privy's walletClientType: 'metamask', 'coinbase_wallet',
// 'wallet_connect', 'rainbow', 'rabby', 'phantom', 'privy' (embedded), etc.
export type WalletType = string;

// ============================================================================
// WALLET MANAGER (Stub)
// ============================================================================
// Previously managed multiple Aleo wallet adapters.
// Now a stub that provides demo mode and basic interface compatibility.
// Real wallet management is handled by Privy via PrivyWalletBridge.
// ============================================================================

export class WalletManager {
  private walletType: WalletType | null = null;
  private demoMode: boolean = false;
  private demoAccount: WalletAccount | null = null;

  getAvailableWallets(): { type: WalletType; name: string; installed: boolean; icon: string }[] {
    return [
      { type: 'demo', name: 'Demo Mode', installed: true, icon: '🎮' },
    ];
  }

  async connect(type: WalletType): Promise<WalletAccount> {
    if (type === 'demo') {
      this.demoMode = true;
      this.walletType = 'demo';
      this.demoAccount = {
        address: '0x0000000000000000000000000000000000000000',
        network: 'testnet',
      };
      return this.demoAccount;
    }
    throw new Error('Direct wallet connection is deprecated. Use Privy wallet connect instead.');
  }

  async disconnect(): Promise<void> {
    this.demoMode = false;
    this.demoAccount = null;
    this.walletType = null;
  }

  getAccount(): WalletAccount | null {
    return this.demoMode ? this.demoAccount : null;
  }

  isConnected(): boolean {
    return this.demoMode && !!this.demoAccount;
  }

  getWalletType(): WalletType | null {
    return this.walletType;
  }

  isDemoMode(): boolean {
    return this.demoMode;
  }

  async getBalance(): Promise<WalletBalance> {
    if (this.demoMode) {
      return { public: 10000000000n, private: 5000000000n };
    }
    throw new Error('Wallet not connected');
  }

  async requestTransaction(_request: TransactionRequest): Promise<string> {
    if (this.demoMode) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      return `demo_tx_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    }
    throw new Error('Wallet not connected');
  }

  async getRecords(_programId: string): Promise<any[]> {
    if (this.demoMode) return [];
    throw new Error('Wallet not connected');
  }

  async testTransaction(): Promise<string> {
    if (this.demoMode) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return `demo_test_${Date.now()}`;
    }
    throw new Error('Wallet not connected');
  }

  // shieldCredits removed — Aleo-specific, not applicable on Ethereum/Fhenix

  async signMessage(message: string): Promise<string> {
    if (this.demoMode) {
      return `demo_sig_${btoa(message).substring(0, 32)}`;
    }
    throw new Error('Wallet not connected');
  }

  onAccountChange(_callback: (account: WalletAccount | null) => void): () => void {
    return () => {};
  }

  onNetworkChange(_callback: (network: NetworkType) => void): () => void {
    return () => {};
  }
}

// Singleton instance
export const walletManager = new WalletManager();

// ============================================================================
// WALLET DISPLAY INFO
// ============================================================================
// Maps Privy walletClientType → human-readable name + emoji icon.
// Privy can return any of these (and more in the future).
// ============================================================================

const WALLET_DISPLAY_MAP: Record<string, { name: string; icon: string }> = {
  metamask:         { name: 'MetaMask',         icon: '🦊' },
  coinbase_wallet:  { name: 'Coinbase Wallet',  icon: '🔵' },
  wallet_connect:   { name: 'WalletConnect',    icon: '🔗' },
  rainbow:          { name: 'Rainbow',          icon: '🌈' },
  rabby:            { name: 'Rabby',            icon: '🐰' },
  phantom:          { name: 'Phantom',          icon: '👻' },
  zerion:           { name: 'Zerion',           icon: '⚡' },
  brave_wallet:     { name: 'Brave Wallet',     icon: '🦁' },
  trust:            { name: 'Trust Wallet',     icon: '🛡️' },
  okx_wallet:       { name: 'OKX Wallet',       icon: '⭕' },
  privy:            { name: 'Privy Wallet',     icon: '🔐' },  // embedded wallet
  demo:             { name: 'Demo Mode',        icon: '🎮' },
  unknown:          { name: 'Wallet',           icon: '💳' },
};

/**
 * Get human-readable wallet display info from a Privy walletClientType string.
 * Falls back gracefully for unknown wallet types.
 */
export function getWalletDisplayInfo(walletType: string | null | undefined): { name: string; icon: string } {
  if (!walletType) return WALLET_DISPLAY_MAP.unknown;
  const entry = WALLET_DISPLAY_MAP[walletType];
  if (entry) return entry;
  // Unknown wallet type — capitalize and show generic icon
  const name = walletType
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
  return { name, icon: '💳' };
}
