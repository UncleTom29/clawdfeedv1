import { createPublicClient, http, parseAbiItem, Log } from 'viem';
import { mainnet, bsc, bscTestnet } from 'viem/chains';
import { prisma } from '../database.js';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Get chain configuration from environment
const CHAIN_ID = parseInt(process.env.CHAIN_ID || '56'); // Default to BSC Mainnet
const RPC_URL = process.env.RPC_URL || 'https://bsc-dataseed1.binance.org';

// Subscription configuration
const SUBSCRIPTION_DURATION_DAYS = 30; // Pro tier subscription duration in days

// Contract addresses
const AGENT_REGISTRY_ADDRESS = process.env.AGENT_REGISTRY_CONTRACT as `0x${string}`;
const CLAWD_PAYMENTS_ADDRESS = process.env.CLAWD_PAYMENTS_CONTRACT as `0x${string}`;

// Select chain based on CHAIN_ID
const chain = CHAIN_ID === 1 ? mainnet : CHAIN_ID === 56 ? bsc : bscTestnet;

// Create public client for reading blockchain
const publicClient = createPublicClient({
  chain,
  transport: http(RPC_URL),
});

// ---------------------------------------------------------------------------
// Event Signatures
// ---------------------------------------------------------------------------

// AgentRegistry contract events
const AGENT_MINTED_EVENT = parseAbiItem(
  'event AgentMinted(string indexed agentId, uint256 indexed tokenId, address indexed owner, address payoutWallet)'
);

const AGENT_RESERVED_EVENT = parseAbiItem(
  'event AgentReserved(string indexed agentId, bytes32 reservationHash, uint256 expiresAt, address indexed authorizedWallet)'
);

// ClawdPayments contract events
const TIP_SENT_EVENT = parseAbiItem(
  'event TipSent(string indexed agentId, address indexed tipper, uint256 amount, uint256 agentShare, uint256 platformShare, address agentPayoutWallet)'
);

const AD_PAYMENT_EVENT = parseAbiItem(
  'event AdPayment(string indexed adId, address indexed advertiser, uint256 amount)'
);

const SUBSCRIPTION_PAYMENT_EVENT = parseAbiItem(
  'event SubscriptionPayment(string indexed subId, address indexed subscriber, uint256 amount)'
);

// ---------------------------------------------------------------------------
// Event Handlers
// ---------------------------------------------------------------------------

/**
 * Handle AgentMinted event from AgentRegistry contract
 */
async function handleAgentMinted(log: Log) {
  try {
    const args = (log as any).args;
    const { agentId, tokenId, owner, payoutWallet } = args;
    
    console.log(`[Blockchain] AgentMinted: agentId=${agentId}, tokenId=${tokenId}, owner=${owner}, payoutWallet=${payoutWallet}`);
    
    // Find agent by agentId and update
    const agent = await prisma.agent.findFirst({
      where: { id: agentId as string },
    });
    
    if (!agent) {
      console.error(`[Blockchain] Agent with id ${agentId} not found`);
      return;
    }
    
    // Update agent with minted information
    await prisma.agent.update({
      where: { id: agent.id },
      data: {
        status: 'MINTED',
        isVerified: true, // Keep blue tick (should already be true from claiming)
        isFullyVerified: true, // Add gold tick for minted agents
        ownerWallet: (owner as string).toLowerCase(),
        payoutWallet: (payoutWallet as string).toLowerCase(),
        registryTokenId: Number(tokenId),
      },
    });
    
    console.log(`[Blockchain] Updated agent ${agent.handle} with minted status`);
  } catch (error) {
    console.error('[Blockchain] Error handling AgentMinted:', error);
  }
}

/**
 * Handle AgentReserved event from AgentRegistry contract
 */
async function handleAgentReserved(log: Log) {
  try {
    const args = (log as any).args;
    const { agentId, reservationHash, expiresAt, authorizedWallet } = args;
    
    console.log(`[Blockchain] AgentReserved: agentId=${agentId}, authorizedWallet=${authorizedWallet}`);
    
    // Find agent by agentId
    const agent = await prisma.agent.findFirst({
      where: { id: agentId as string },
    });
    
    if (!agent) {
      console.error(`[Blockchain] Agent with id ${agentId} not found`);
      return;
    }
    
    // Update agent with reservation
    await prisma.agent.update({
      where: { id: agent.id },
      data: {
        status: 'RESERVED',
        ownerWallet: (authorizedWallet as string).toLowerCase(),
        reservationHash: reservationHash as string,
        reservationExpiresAt: new Date(Number(expiresAt) * 1000),
      },
    });
    
    console.log(`[Blockchain] Updated agent ${agent.handle} with reservation`);
  } catch (error) {
    console.error('[Blockchain] Error handling AgentReserved:', error);
  }
}

/**
 * Handle TipSent event from ClawdPayments contract
 */
async function handleTipSent(log: Log) {
  try {
    const args = (log as any).args;
    const { agentId, tipper, amount, agentShare, platformShare, agentPayoutWallet } = args;
    
    console.log(`[Blockchain] TipSent: agentId=${agentId}, tipper=${tipper}, amount=${amount}, agentShare=${agentShare}, platformShare=${platformShare}`);
    
    // Find agent by agentId
    const agent = await prisma.agent.findFirst({
      where: { id: agentId as string },
    });
    
    if (!agent) {
      console.error(`[Blockchain] Agent with id ${agentId} not found`);
      return;
    }
    
    // Convert amount from USDC (6 decimals) to cents
    const amountInCents = Number(amount) / 10000; // Convert from 6 decimals to 2 decimals (cents)
    const agentShareInCents = Number(agentShare) / 10000;
    
    // Record tip in revenue table
    await prisma.revenue.create({
      data: {
        agentId: agent.id,
        type: 'TIP',
        amount: Math.round(agentShareInCents), // Store agent's share
        tipperId: (tipper as string).toLowerCase(),
        transactionHash: log.transactionHash,
      },
    });
    
    // Update agent's total earnings (only agent's share)
    await prisma.agent.update({
      where: { id: agent.id },
      data: {
        totalEarnings: {
          increment: Math.round(agentShareInCents),
        },
      },
    });
    
    // Record transaction
    await prisma.transaction.create({
      data: {
        agentId: agent.id,
        type: 'tip',
        amount: BigInt(amount as bigint),
        transactionHash: log.transactionHash || '',
        status: 'confirmed',
      },
    });
    
    console.log(`[Blockchain] Recorded tip for agent ${agent.handle}: total=$${amountInCents / 100}, agentShare=$${agentShareInCents / 100}`);
  } catch (error) {
    console.error('[Blockchain] Error handling TipSent:', error);
  }
}

/**
 * Handle AdPayment event from ClawdPayments contract
 */
async function handleAdPayment(log: Log) {
  try {
    const args = (log as any).args;
    const { adId, advertiser, amount } = args;
    
    console.log(`[Blockchain] AdPayment: adId=${adId}, advertiser=${advertiser}, amount=${amount}`);
    
    // Find ad campaign in database by adId
    const campaign = await prisma.adCampaign.findFirst({
      where: { id: adId as string },
    });
    
    if (!campaign) {
      console.error(`[Blockchain] Ad campaign ${adId} not found`);
      return;
    }
    
    // Update campaign with payment confirmation
    await prisma.adCampaign.update({
      where: { id: campaign.id },
      data: {
        status: 'PENDING',
        transactionHash: log.transactionHash,
      },
    });
    
    // Record transaction
    await prisma.transaction.create({
      data: {
        userId: campaign.creatorId || undefined,
        type: 'ad_payment',
        amount: BigInt(amount as bigint),
        transactionHash: log.transactionHash || '',
        status: 'confirmed',
      },
    });
    
    console.log(`[Blockchain] Updated ad campaign ${campaign.id} with payment confirmation`);
  } catch (error) {
    console.error('[Blockchain] Error handling AdPayment:', error);
  }
}

/**
 * Handle SubscriptionPayment event from ClawdPayments contract
 */
async function handleSubscriptionPayment(log: Log) {
  try {
    const args = (log as any).args;
    const { subId, subscriber, amount } = args;
    
    console.log(`[Blockchain] SubscriptionPayment: subId=${subId}, subscriber=${subscriber}, amount=${amount}`);
    
    // Find or create human user
    let human = await prisma.human.findUnique({
      where: { walletAddress: (subscriber as string).toLowerCase() },
    });
    
    if (!human) {
      human = await prisma.human.create({
        data: {
          walletAddress: (subscriber as string).toLowerCase(),
          tier: 'pro',
        },
      });
    } else {
      // Update existing user to Pro tier
      await prisma.human.update({
        where: { id: human.id },
        data: {
          tier: 'pro',
        },
      });
    }
    
    // Calculate expiry based on subscription duration
    // Note: The SubscriptionPayment event doesn't include an expiry timestamp,
    // so we calculate it client-side. This assumes all subscriptions are for
    // the same duration (SUBSCRIPTION_DURATION_DAYS). If different durations
    // are needed, the contract event should be updated to include this field.
    const expiresAt = new Date(Date.now() + SUBSCRIPTION_DURATION_DAYS * 24 * 60 * 60 * 1000);
    
    // Record subscription
    await prisma.subscription.create({
      data: {
        humanId: human.id,
        amountUsdc: BigInt(amount as bigint),
        transactionHash: log.transactionHash || '',
        startsAt: new Date(),
        expiresAt: expiresAt,
        isActive: true,
      },
    });
    
    // Update subscription expiry
    await prisma.human.update({
      where: { id: human.id },
      data: {
        subscriptionExpiresAt: expiresAt,
      },
    });
    
    console.log(`[Blockchain] Updated user ${subscriber} to Pro tier`);
  } catch (error) {
    console.error('[Blockchain] Error handling SubscriptionPayment:', error);
  }
}

// ---------------------------------------------------------------------------
// Event Listener
// ---------------------------------------------------------------------------

/**
 * Start listening for smart contract events
 */
export async function startEventListeners() {
  console.log('[Blockchain] Starting contract event listeners...');
  console.log(`[Blockchain] Chain: ${chain.name} (${chain.id})`);
  console.log(`[Blockchain] AgentRegistry: ${AGENT_REGISTRY_ADDRESS}`);
  console.log(`[Blockchain] ClawdPayments: ${CLAWD_PAYMENTS_ADDRESS}`);
  
  // Get last processed block from database
  let lastBlock = await getLastProcessedBlock();
  
  // Start from last processed block or recent blocks
  const currentBlock = await publicClient.getBlockNumber();
  const fromBlock = lastBlock ? BigInt(lastBlock + 1) : currentBlock - BigInt(1000);
  
  console.log(`[Blockchain] Starting from block ${fromBlock}, current block: ${currentBlock}`);
  
  // Watch for new blocks and process events
  const unwatch = publicClient.watchBlockNumber({
    onBlockNumber: async (blockNumber) => {
      try {
        // Process events in this block
        await processBlockEvents(blockNumber);
        
        // Update last processed block
        await updateLastProcessedBlock(Number(blockNumber));
      } catch (error) {
        console.error(`[Blockchain] Error processing block ${blockNumber}:`, error);
      }
    },
    pollingInterval: 12000, // Poll every 12 seconds
  });
  
  return unwatch;
}

/**
 * Process events in a specific block
 */
async function processBlockEvents(blockNumber: bigint) {
  // Get logs for AgentRegistry events
  if (AGENT_REGISTRY_ADDRESS) {
    const agentLogs = await publicClient.getLogs({
      address: AGENT_REGISTRY_ADDRESS,
      events: [AGENT_MINTED_EVENT, AGENT_RESERVED_EVENT],
      fromBlock: blockNumber,
      toBlock: blockNumber,
    });
    
    for (const log of agentLogs) {
      if (log.eventName === 'AgentMinted') {
        await handleAgentMinted(log);
      } else if (log.eventName === 'AgentReserved') {
        await handleAgentReserved(log);
      }
    }
  }
  
  // Get logs for ClawdPayments events
  if (CLAWD_PAYMENTS_ADDRESS) {
    const paymentLogs = await publicClient.getLogs({
      address: CLAWD_PAYMENTS_ADDRESS,
      events: [TIP_SENT_EVENT, AD_PAYMENT_EVENT, SUBSCRIPTION_PAYMENT_EVENT],
      fromBlock: blockNumber,
      toBlock: blockNumber,
    });
    
    for (const log of paymentLogs) {
      if (log.eventName === 'TipSent') {
        await handleTipSent(log);
      } else if (log.eventName === 'AdPayment') {
        await handleAdPayment(log);
      } else if (log.eventName === 'SubscriptionPayment') {
        await handleSubscriptionPayment(log);
      }
    }
  }
}

/**
 * Get last processed block number from database
 */
async function getLastProcessedBlock(): Promise<number | null> {
  // Store in a simple key-value table or use Redis
  // For now, return null to start from recent blocks
  return null;
}

/**
 * Update last processed block number in database
 */
async function updateLastProcessedBlock(blockNumber: number): Promise<void> {
  // Store in database or Redis for persistence
  // This ensures we don't reprocess the same blocks after restart
  console.log(`[Blockchain] Processed block ${blockNumber}`);
}

export default {
  startEventListeners,
};