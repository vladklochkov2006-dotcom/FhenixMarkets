// ============================================================================
// FHENIX MARKETS - Configuration
// ============================================================================
// Reads environment variables with type safety and defaults.
// Configured for Sepolia (Fhenix CoFHE coprocessor).
// ============================================================================
import { devLog } from './logger'

/**
 * Network type
 */
export type NetworkType = 'testnet' | 'mainnet';

/**
 * Wallet type — flexible, Privy supports many wallet types dynamically
 */
export type WalletType = string;

/**
 * Application configuration
 */
export interface AppConfig {
  // Network
  network: NetworkType;
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;

  // Contracts
  marketsContract: string;
  governanceContract: string;

  // Wallet
  enableDemoMode: boolean;
  defaultWallet: WalletType;

  // Features
  enableCreateMarket: boolean;
  enableBetting: boolean;
  showTestnetBanner: boolean;
  debug: boolean;

  // IPFS / Pinata
  pinataJwt: string | null;
  pinataGateway: string;

  // App
  appName: string;
  appDescription: string;
  appUrl: string;

}

/**
 * Get environment variable with fallback
 */
function getEnv(key: string, fallback: string = ''): string {
  return import.meta.env[key] ?? fallback;
}

/**
 * Get boolean environment variable
 */
function getEnvBool(key: string, fallback: boolean = false): boolean {
  const value = import.meta.env[key];
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

/**
 * Load configuration from environment variables
 */
function loadConfig(): AppConfig {
  const network = (getEnv('VITE_NETWORK', 'testnet') as NetworkType);

  return {
    // Network — Sepolia (Fhenix CoFHE coprocessor)
    network,
    chainId: 11155111,
    rpcUrl: getEnv('VITE_RPC_URL', 'https://ethereum-sepolia.publicnode.com'),
    explorerUrl: getEnv('VITE_EXPLORER_URL', 'https://sepolia.etherscan.io'),

    // Contracts — deployed on Sepolia
    marketsContract: getEnv('VITE_MARKETS_CONTRACT', '0x902926359c1b3f3275f6C9251637ADF8c8Ba79f0'),
    governanceContract: getEnv('VITE_GOVERNANCE_CONTRACT', '0xc99B0ccBFDC20D6ea99da4Ef7c7CAeE5Cd0Ad656'),

    // Wallet
    enableDemoMode: getEnvBool('VITE_ENABLE_DEMO_MODE', true),
    defaultWallet: getEnv('VITE_DEFAULT_WALLET', 'privy'),

    // Features
    enableCreateMarket: getEnvBool('VITE_ENABLE_CREATE_MARKET', true),
    enableBetting: getEnvBool('VITE_ENABLE_BETTING', true),
    showTestnetBanner: getEnvBool('VITE_SHOW_TESTNET_BANNER', true),
    debug: getEnvBool('VITE_DEBUG', false),

    // IPFS / Pinata
    pinataJwt: getEnv('VITE_PINATA_JWT') || null,
    pinataGateway: getEnv('VITE_PINATA_GATEWAY', 'https://gateway.pinata.cloud'),

    // App
    appName: getEnv('VITE_APP_NAME', 'Fhenix Markets'),
    appDescription: getEnv('VITE_APP_DESCRIPTION', 'Privacy-Preserving Prediction Markets on Fhenix'),
    appUrl: getEnv('VITE_APP_URL', 'https://fhenix.markets'),

};
}

/**
 * Application configuration singleton
 */
export const config: AppConfig = loadConfig();

/**
 * Check if running in development mode
 */
export const isDev = import.meta.env.DEV;

/**
 * Check if running in production mode
 */
export const isProd = import.meta.env.PROD;

/**
 * Log debug message (only in debug mode)
 */
export function debug(...args: unknown[]): void {
  if (config.debug) {
    devLog('[Fhenix Markets]', ...args);
  }
}

/**
 * Get transaction URL on Etherscan
 */
export function getTransactionUrl(txHash: string): string {
  return `${config.explorerUrl}/tx/${txHash}`;
}

/**
 * Get address URL on Etherscan
 */
export function getAddressUrl(address: string): string {
  return `${config.explorerUrl}/address/${address}`;
}

/**
 * Get contract URL on Etherscan
 */
export function getContractUrl(address?: string): string {
  return `${config.explorerUrl}/address/${address || config.marketsContract}`;
}

// Export default config
export default config;
