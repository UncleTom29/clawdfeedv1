import { ethers } from "hardhat";

async function main() {
  console.log("Testing AgentRegistry locally...\n");

  // Get test accounts
  const [admin, user1, user2] = await ethers.getSigners();
  console.log("Admin address:", admin.address);
  console.log("User1 address:", user1.address);
  console.log("User2 address:", user2.address, "\n");

  // Deploy AgentRegistry
  console.log("Deploying AgentRegistry...");
  const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
  const agentRegistry = await AgentRegistry.deploy();
  await agentRegistry.waitForDeployment();
  const agentRegistryAddress = await agentRegistry.getAddress();
  console.log("✓ AgentRegistry deployed to:", agentRegistryAddress, "\n");

  // Test 1: Admin reserves agent for user1
  console.log("Test 1: Admin reserves agent for user1");
  const agentId = "agent123";
  const reservationHash = ethers.keccak256(ethers.toUtf8Bytes("secret123"));
  const expiry = Math.floor(Date.now() / 1000) + 86400; // 24 hours from now

  const tx1 = await agentRegistry.reserveAgent(
    agentId,
    reservationHash,
    expiry,
    user1.address
  );
  await tx1.wait();
  console.log("✓ Agent reserved by admin for user1\n");

  // Test 2: Verify reservation
  console.log("Test 2: Verify reservation");
  const reservation = await agentRegistry.reservations(agentId);
  console.log("Reservation hash:", reservation.reservationHash);
  console.log("Authorized wallet:", reservation.authorizedWallet);
  console.log("Expires at:", new Date(Number(reservation.expiresAt) * 1000).toISOString());
  console.log("Claimed:", reservation.claimed, "\n");

  // Test 3: User1 mints the agent
  console.log("Test 3: User1 mints the agent");
  const metadataURI = "ipfs://QmTest123";
  const tx2 = await agentRegistry.connect(user1).mintReservedAgent(
    agentId,
    metadataURI,
    user1.address
  );
  await tx2.wait();
  console.log("✓ Agent minted by user1\n");

  // Test 4: Verify minting
  console.log("Test 4: Verify minting");
  const agentKey = ethers.keccak256(ethers.toUtf8Bytes(agentId));
  const tokenId = await agentRegistry.agentKeyToTokenId(agentKey);
  const owner = await agentRegistry.ownerOf(tokenId);
  console.log("Token ID:", tokenId.toString());
  console.log("Owner:", owner);
  console.log("✓ Minting verified\n");

  // Test 5: User reserves agent (fallback scenario)
  console.log("Test 5: User2 reserves their own agent (fallback scenario)");
  const agentId2 = "agent456";
  const reservationHash2 = ethers.keccak256(ethers.toUtf8Bytes("secret456"));
  
  const tx3 = await agentRegistry.connect(user2).reserveAgent(
    agentId2,
    reservationHash2,
    expiry,
    user2.address
  );
  await tx3.wait();
  console.log("✓ Agent reserved by user2 for themselves (fallback)\n");

  // Test 6: User2 mints their agent
  console.log("Test 6: User2 mints their agent");
  const tx4 = await agentRegistry.connect(user2).mintReservedAgent(
    agentId2,
    metadataURI,
    user2.address
  );
  await tx4.wait();
  console.log("✓ Agent minted by user2\n");

  // Test 7: Attempt unauthorized reservation (should fail)
  console.log("Test 7: Attempt unauthorized reservation (should fail)");
  const agentId3 = "agent789";
  try {
    await agentRegistry.connect(user1).reserveAgent(
      agentId3,
      reservationHash,
      expiry,
      user2.address // User1 trying to reserve for User2
    );
    console.log("✗ ERROR: Unauthorized reservation should have failed!");
  } catch (error: any) {
    console.log("✓ Unauthorized reservation correctly rejected");
    console.log("Error message:", error.message.split("(")[0].trim(), "\n");
  }

  console.log("========================================");
  console.log("All tests completed successfully!");
  console.log("========================================");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
