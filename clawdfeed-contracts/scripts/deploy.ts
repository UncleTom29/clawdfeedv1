import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  console.log("Starting deployment to BNB Chain...\n");

  // Get deployer account
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);
  
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", ethers.formatEther(balance), "BNB\n");

  // Get platform wallet from environment or use deployer as fallback
  const platformWallet = process.env.PLATFORM_WALLET || deployer.address;
  console.log("Platform wallet:", platformWallet);

  // Get USDC address from environment
  const usdcAddress = process.env.USDC_ADDRESS || "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
  console.log("USDC address:", usdcAddress, "\n");

  // Deploy AgentRegistry
  console.log("Deploying AgentRegistry...");
  const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
  const agentRegistry = await AgentRegistry.deploy();
  await agentRegistry.waitForDeployment();
  const agentRegistryAddress = await agentRegistry.getAddress();
  console.log("✓ AgentRegistry deployed to:", agentRegistryAddress, "\n");

  // Deploy ClawdPayments
  console.log("Deploying ClawdPayments...");
  const ClawdPayments = await ethers.getContractFactory("ClawdPayments");
  const clawdPayments = await ClawdPayments.deploy(
    usdcAddress,
    agentRegistryAddress,
    platformWallet
  );
  await clawdPayments.waitForDeployment();
  const clawdPaymentsAddress = await clawdPayments.getAddress();
  console.log("✓ ClawdPayments deployed to:", clawdPaymentsAddress, "\n");

  // Save deployment info
  const deploymentInfo = {
    network: "bsc",
    chainId: 56,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    contracts: {
      AgentRegistry: agentRegistryAddress,
      ClawdPayments: clawdPaymentsAddress,
    },
    config: {
      usdcAddress,
      platformWallet,
    },
  };

  const deploymentsDir = path.join(__dirname, "../deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const deploymentFile = path.join(deploymentsDir, `bsc-${Date.now()}.json`);
  fs.writeFileSync(deploymentFile, JSON.stringify(deploymentInfo, null, 2));
  console.log("Deployment info saved to:", deploymentFile, "\n");

  // Update .env file
  const envPath = path.join(__dirname, "../.env");
  let envContent = "";
  
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, "utf-8");
    // Update existing addresses
    envContent = envContent.replace(
      /AGENT_REGISTRY_ADDRESS=.*/,
      `AGENT_REGISTRY_ADDRESS=${agentRegistryAddress}`
    );
    envContent = envContent.replace(
      /CLAWD_PAYMENTS_ADDRESS=.*/,
      `CLAWD_PAYMENTS_ADDRESS=${clawdPaymentsAddress}`
    );
  } else {
    // Create new .env with addresses
    envContent = `AGENT_REGISTRY_ADDRESS=${agentRegistryAddress}\nCLAWD_PAYMENTS_ADDRESS=${clawdPaymentsAddress}\n`;
  }
  
  fs.writeFileSync(envPath, envContent);
  console.log("✓ Updated .env with contract addresses\n");

  console.log("========================================");
  console.log("Deployment Summary:");
  console.log("========================================");
  console.log("AgentRegistry:  ", agentRegistryAddress);
  console.log("ClawdPayments:  ", clawdPaymentsAddress);
  console.log("========================================\n");

  console.log("Next steps:");
  console.log("1. Verify contracts on BSCScan:");
  console.log("   npx hardhat run scripts/verify.ts --network bsc");
  console.log("2. Update frontend contract addresses");
  console.log("3. Update API blockchain service with new addresses\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
