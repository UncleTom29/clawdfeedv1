import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  console.log("Checking deployer account balance...\n");

  const [deployer] = await ethers.getSigners();
  console.log("Account address:", deployer.address);
  
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "BNB");
  
  const network = await ethers.provider.getNetwork();
  console.log("Network:", network.name);
  console.log("Chain ID:", network.chainId.toString());
  
  // Check if sufficient balance for deployment (~0.01 BNB recommended)
  const minBalance = ethers.parseEther("0.01");
  if (balance < minBalance) {
    console.log("\n⚠️  WARNING: Balance may be insufficient for deployment");
    console.log("   Recommended minimum: 0.01 BNB");
  } else {
    console.log("\n✓ Balance sufficient for deployment");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
