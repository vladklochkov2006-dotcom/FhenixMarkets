import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "cofhe-hardhat-plugin";
import "dotenv/config";

const PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY || "0x" + "0".repeat(64);

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.25",
    settings: {
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 1,
      },
      evmVersion: "cancun",
    },
  },

  networks: {
    // Sepolia — primary deployment target (Fhenix CoFHE coprocessor)
    "eth-sepolia": {
      url: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia.publicnode.com",
      chainId: 11155111,
      accounts: [PRIVATE_KEY],
      gasMultiplier: 1.2,
    },
    // Local dev
    localhost: {
      url: "http://127.0.0.1:8545",
    },
  },

  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
