import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { PrivyProvider } from '@privy-io/react-auth'
import { defineChain } from 'viem'
import App from './App'
import { PrivyWalletBridge } from './components/PrivyWalletBridge'
import './styles/globals.css'

function applyInitialTheme() {
  const root = document.documentElement
  root.classList.add('dark')
  root.classList.remove('light')
  root.style.colorScheme = 'dark'
}

applyInitialTheme()

const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID || 'cmnc3fdce00rn0clduliqd11u'

const sepoliaChain = defineChain({
  id: 11155111,
  name: 'Sepolia',
  nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://ethereum-sepolia.publicnode.com'] },
  },
  blockExplorers: {
    default: { name: 'Etherscan', url: 'https://sepolia.etherscan.io' },
  },
  testnet: true,
})

// ── Main App (always renders immediately) ──
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)

// ── Privy Provider (separate React root — syncs wallet state via Zustand) ──
// This ensures the app always renders even if Privy is slow or blocked.
const privyRoot = document.createElement('div')
privyRoot.id = 'privy-root'
document.body.appendChild(privyRoot)

ReactDOM.createRoot(privyRoot).render(
  <React.StrictMode>
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        appearance: {
          theme: 'dark',
          accentColor: '#0AD9DC',
          logo: '/fhenix-logo.svg',
        },
        loginMethods: ['wallet', 'email'],
        embeddedWallets: {
          ethereum: {
            createOnLogin: 'users-without-wallets',
          },
        },
        defaultChain: sepoliaChain,
        supportedChains: [sepoliaChain],
      }}
    >
      <PrivyWalletBridge />
    </PrivyProvider>
  </React.StrictMode>,
)
