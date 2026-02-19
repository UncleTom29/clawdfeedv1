import { run } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  console.log("Starting contract verification on BSCScan...\n");

  // Load deployment info from .env
  const agentRegistryAddress = process.env.AGENT_REGISTRY_ADDRESS;
  const clawdPaymentsAddress = process.env.CLAWD_PAYMENTS_ADDRESS;
  const usdcAddress = process.env.USDC_ADDRESS || "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
  const platformWallet = process.env.PLATFORM_WALLET;

  if (!agentRegistryAddress || !clawdPaymentsAddress) {
    console.error("Error: Contract addresses not found in .env file");
    console.log("Please deploy contracts first: npx hardhat run scripts/deploy.ts --network bsc");
    process.exit(1);
  }

  if (!platformWallet) {
    console.error("Error: PLATFORM_WALLET not found in .env file");
    process.exit(1);
  }

  // Verify AgentRegistry
  console.log("Verifying AgentRegistry at:", agentRegistryAddress);
  try {
    await run("verify:verify", {
      address: agentRegistryAddress,
      constructorArguments: [],
    });
    console.log("✓ AgentRegistry verified successfully\n");
  } catch (error: any) {
    if (error.message.includes("Already Verified")) {
      console.log("✓ AgentRegistry already verified\n");
    } else {
      console.error("Error verifying AgentRegistry:", error.message, "\n");
    }
  }

  // Verify ClawdPayments
  console.log("Verifying ClawdPayments at:", clawdPaymentsAddress);
  try {
    await run("verify:verify", {
      address: clawdPaymentsAddress,
      constructorArguments: [usdcAddress, agentRegistryAddress, platformWallet],
    });
    console.log("✓ ClawdPayments verified successfully\n");
  } catch (error: any) {
    if (error.message.includes("Already Verified")) {
      console.log("✓ ClawdPayments already verified\n");
    } else {
      console.error("Error verifying ClawdPayments:", error.message, "\n");
    }
  }

  console.log("========================================");
  console.log("Verification Summary:");
  console.log("========================================");
  console.log("AgentRegistry:  ", agentRegistryAddress);
  console.log("ClawdPayments:  ", clawdPaymentsAddress);
  console.log("========================================\n");

  console.log("View contracts on BSCScan:");
  console.log(`AgentRegistry: https://bscscan.com/address/${agentRegistryAddress}`);
  console.log(`ClawdPayments: https://bscscan.com/address/${clawdPaymentsAddress}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
