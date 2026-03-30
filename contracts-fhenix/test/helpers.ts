import { ethers } from "hardhat";

// Address where cofhe-contracts FHE.sol expects the TaskManager
const TASK_MANAGER_ADDRESS = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";

/**
 * Deploy the MockTaskManager contract at the CoFHE TaskManager address.
 * Must be called before any contract that uses FHE operations.
 */
export async function deployMockTaskManager() {
  const MockTaskManager = await ethers.getContractFactory("MockTaskManager");
  const mock = await MockTaskManager.deploy();
  await mock.waitForDeployment();

  // Get the deployed bytecode
  const mockAddress = await mock.getAddress();
  const deployedBytecode = await ethers.provider.getCode(mockAddress);

  // Inject the mock bytecode at the TaskManager address
  await ethers.provider.send("hardhat_setCode", [
    TASK_MANAGER_ADDRESS,
    deployedBytecode,
  ]);

  return mock;
}

/**
 * Deploy FhenixMarkets with mock TaskManager
 */
export async function deployMarkets() {
  await deployMockTaskManager();

  const FhenixMarkets = await ethers.getContractFactory("FhenixMarkets");
  const markets = await FhenixMarkets.deploy();
  await markets.waitForDeployment();
  return markets;
}

/**
 * Deploy FhenixGovernance with mock TaskManager
 */
export async function deployGovernance(marketsAddress?: string) {
  if (!marketsAddress) {
    const markets = await deployMarkets();
    marketsAddress = await markets.getAddress();
  } else {
    await deployMockTaskManager();
  }

  const FhenixGovernance = await ethers.getContractFactory("FhenixGovernance");
  const governance = await FhenixGovernance.deploy();
  await governance.waitForDeployment();

  const [deployer] = await ethers.getSigners();
  await governance.initGovernance(
    deployer.address,
    deployer.address,
    deployer.address,
    marketsAddress
  );

  return governance;
}

/**
 * Helper: create a market and return its ID
 */
export async function createTestMarket(
  markets: any,
  options?: {
    numOutcomes?: number;
    liquidity?: bigint;
    deadlineOffset?: number;
  }
) {
  const opts = {
    numOutcomes: 2,
    liquidity: ethers.parseEther("1"),
    deadlineOffset: 7 * 24 * 60 * 60, // 7 days
    ...options,
  };

  const questionHash = ethers.keccak256(ethers.toUtf8Bytes("Will ETH hit 10k?"));
  // Use block.timestamp instead of Date.now() — Hardhat node has its own clock
  const block = await ethers.provider.getBlock("latest");
  const now = block!.timestamp;
  const deadline = now + opts.deadlineOffset;
  const resolutionDeadline = deadline + 3 * 24 * 60 * 60;
  const [creator] = await ethers.getSigners();

  const tx = await markets.createMarket(
    questionHash,
    1, // category
    opts.numOutcomes,
    deadline,
    resolutionDeadline,
    creator.address, // resolver
    { value: opts.liquidity }
  );

  const receipt = await tx.wait();

  // Extract marketId from MarketCreated event
  const event = receipt.logs.find(
    (log: any) => {
      try {
        return markets.interface.parseLog(log)?.name === "MarketCreated";
      } catch {
        return false;
      }
    }
  );

  const parsed = markets.interface.parseLog(event);
  return parsed!.args[0] as string; // marketId
}
