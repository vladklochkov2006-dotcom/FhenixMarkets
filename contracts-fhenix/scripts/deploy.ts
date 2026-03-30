import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)));

  // 1. Deploy FhenixMarkets
  console.log("\n--- Deploying FhenixMarkets ---");
  const FhenixMarkets = await ethers.getContractFactory("FhenixMarkets");
  const markets = await FhenixMarkets.deploy();
  await markets.waitForDeployment();
  const marketsAddress = await markets.getAddress();
  console.log("FhenixMarkets deployed to:", marketsAddress);

  // 2. Deploy FhenixGovernance
  console.log("\n--- Deploying FhenixGovernance ---");
  const FhenixGovernance = await ethers.getContractFactory("FhenixGovernance");
  const governance = await FhenixGovernance.deploy();
  await governance.waitForDeployment();
  const governanceAddress = await governance.getAddress();
  console.log("FhenixGovernance deployed to:", governanceAddress);

  // 3. Initialize governance with deployer as all 3 guardians (for testnet)
  console.log("\n--- Initializing Governance ---");
  const tx = await governance.initGovernance(
    deployer.address,
    deployer.address,
    deployer.address,
    marketsAddress
  );
  await tx.wait();
  console.log("Governance initialized");

  // Summary
  console.log("\n========================================");
  console.log("Deployment complete!");
  console.log("========================================");
  console.log("FhenixMarkets:    ", marketsAddress);
  console.log("FhenixGovernance: ", governanceAddress);
  console.log("Deployer:         ", deployer.address);
  console.log("========================================");
  console.log("\nAdd these to your frontend .env:");
  console.log(`VITE_MARKETS_CONTRACT=${marketsAddress}`);
  console.log(`VITE_GOVERNANCE_CONTRACT=${governanceAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
