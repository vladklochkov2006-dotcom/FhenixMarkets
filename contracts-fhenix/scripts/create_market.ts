import { ethers } from "hardhat";

async function main() {
    const [deployer] = await ethers.getSigners();
    const marketsAddress = "0x050262EDE0E6320B2A9AB463776D87cdAfD44572";
    const FhenixMarkets = await ethers.getContractFactory("FhenixMarkets");
    const markets = FhenixMarkets.attach(marketsAddress) as any;

    const question = "Will Bitcoin price exceed $100,000 by December 31, 2024?";
    const questionHash = ethers.id(question);
    const category = 1; // Crypto
    const numOutcomes = 2;
    const deadline = Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 30); // 30 days
    const resolutionDeadline = deadline + (60 * 60 * 24 * 7); // 7 days after
    const resolver = deployer.address;
    const initialLiquidity = ethers.parseEther("0.02");

    console.log("Creating market:", question);
    const tx = await markets.createMarket(
        questionHash,
        category,
        numOutcomes,
        deadline,
        resolutionDeadline,
        resolver,
        { value: initialLiquidity }
    );

    const receipt = await tx.wait();
    console.log("Market created! Hash:", questionHash);
    console.log("Transaction:", receipt.hash);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
