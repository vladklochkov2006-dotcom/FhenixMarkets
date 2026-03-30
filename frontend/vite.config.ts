import { defineConfig } from 'vite'
import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

const walletShim = resolve(__dirname, 'src/lib/wallet-shim.ts')

export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
  resolve: {
    alias: [
      { find: '@', replacement: '/src' },
      // Redirect all Aleo wallet imports to Privy shim (longer paths FIRST to avoid prefix collisions)
      { find: '@provablehq/aleo-wallet-adaptor-react-ui', replacement: walletShim },
      { find: '@provablehq/aleo-wallet-adaptor-react', replacement: walletShim },
      { find: '@provablehq/aleo-wallet-adaptor-core', replacement: walletShim },
      { find: '@provablehq/aleo-wallet-adaptor-shield', replacement: walletShim },
      { find: '@provablehq/aleo-wallet-adaptor-leo', replacement: walletShim },
      { find: '@provablehq/aleo-wallet-adaptor-fox', replacement: walletShim },
      { find: '@provablehq/aleo-wallet-adaptor-soter', replacement: walletShim },
      { find: '@provablehq/aleo-types', replacement: walletShim },
      { find: 'core-js/proposals/json-parse-with-source.js', replacement: resolve(__dirname, 'src/lib/empty-module.js') },
    ],
    dedupe: ['react', 'react-dom'],
  },
  worker: {
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        format: 'es',
      },
    },
  },
  optimizeDeps: {
    exclude: [
      '@provablehq/wasm',
      '@provablehq/sdk',
      '@provablehq/aleo-wallet-adaptor-react',
      '@provablehq/aleo-wallet-adaptor-react-ui',
      '@provablehq/aleo-wallet-adaptor-core',
      '@provablehq/aleo-wallet-adaptor-shield',
      '@provablehq/aleo-wallet-adaptor-leo',
      '@provablehq/aleo-wallet-adaptor-fox',
      '@provablehq/aleo-wallet-adaptor-soter',
      '@provablehq/aleo-types',
    ],
    force: true,
  },
  server: {
    port: 3000,
    host: true,
    headers: {
      // COOP/COEP removed — conflicts with Privy SDK
      // Was needed for Aleo WASM SharedArrayBuffer, no longer required
    },
  },
})
