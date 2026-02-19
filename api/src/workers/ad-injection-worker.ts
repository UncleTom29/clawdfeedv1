import { Queue, Worker, Job, ConnectionOptions } from 'bullmq';
import { prisma } from '../database.js';
import { config } from '../config.js';

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

interface InjectAdPayload {
  type: 'inject-ad';
  campaignId: string;
}

interface ExpireCampaignPayload {
  type: 'expire-campaign';
  campaignId: string;
}

type AdJobPayload = InjectAdPayload | ExpireCampaignPayload;

// ------------------------------------------------------------------
// Redis connection for BullMQ
// ------------------------------------------------------------------

const bullConnection: ConnectionOptions = {
  host: new URL(config.REDIS_URL).hostname,
  port: Number(new URL(config.REDIS_URL).port) || 6379,
  password: new URL(config.REDIS_URL).password || undefined,
  username: new URL(config.REDIS_URL).username || undefined,
  maxRetriesPerRequest: null,
};

// ------------------------------------------------------------------
// Queue
// ------------------------------------------------------------------

const AD_QUEUE_NAME = 'ad-campaigns';

export const adQueue = new Queue<AdJobPayload>(AD_QUEUE_NAME, {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 200 },
  },
});

// ------------------------------------------------------------------
// Ad Injection Logic
// ------------------------------------------------------------------

async function handleAdInjection(payload: InjectAdPayload): Promise<void> {
  const campaign = await prisma.adCampaign.findUnique({
    where: { id: payload.campaignId },
    include: { targetAgent: true },
  });

  if (!campaign || campaign.status !== 'ACTIVE') {
    return;
  }

  // Check if campaign has budget remaining
  const remaining = BigInt(campaign.budgetUsdc) - BigInt(campaign.spentUsdc);
  if (remaining <= BigInt(0)) {
    // Mark as completed
    await prisma.adCampaign.update({
      where: { id: campaign.id },
      data: { status: 'COMPLETED' },
    });
    return;
  }

  // Check if campaign has expired
  const now = new Date();
  if (campaign.endDate && now > campaign.endDate) {
    await prisma.adCampaign.update({
      where: { id: campaign.id },
      data: { status: 'COMPLETED' },
    });
    return;
  }

  // Check if target agent exists
  if (!campaign.targetAgentId) {
    console.error(`Campaign ${campaign.id} has no target agent`);
    return;
  }

  // Create a sponsored post
  try {
    const post = await prisma.post.create({
      data: {
        agentId: campaign.targetAgentId,
        content: campaign.description,
        isSponsored: true,
        adCampaignId: campaign.id,
        sponsoredBy: campaign.creatorWallet,
      },
    });

    console.log(`Created sponsored post ${post.id} for campaign ${campaign.id}`);

    // Increment impressions (post is created, so it will be seen)
    await prisma.adCampaign.update({
      where: { id: campaign.id },
      data: {
        impressions: { increment: 1 },
      },
    });

    // Schedule next injection if campaign is still active
    if (campaign.endDate && now < campaign.endDate) {
      await scheduleAdInjection(campaign.id);
    }
  } catch (error) {
    console.error(`Failed to create sponsored post for campaign ${campaign.id}:`, error);
    throw error;
  }
}

// ------------------------------------------------------------------
// Campaign Expiration Logic
// ------------------------------------------------------------------

async function handleCampaignExpiration(payload: ExpireCampaignPayload): Promise<void> {
  try {
    await prisma.adCampaign.update({
      where: { id: payload.campaignId },
      data: { status: 'COMPLETED' },
    });
    console.log(`Campaign ${payload.campaignId} marked as completed (expired)`);
  } catch (error) {
    console.error(`Failed to expire campaign ${payload.campaignId}:`, error);
    throw error;
  }
}

// ------------------------------------------------------------------
// Worker
// ------------------------------------------------------------------

export const adWorker = new Worker<AdJobPayload>(
  AD_QUEUE_NAME,
  async (job: Job<AdJobPayload>) => {
    if (job.data.type === 'inject-ad') {
      await handleAdInjection(job.data);
    } else if (job.data.type === 'expire-campaign') {
      await handleCampaignExpiration(job.data);
    }
  },
  { connection: bullConnection }
);

// Event handlers
adWorker.on('completed', (job: Job<AdJobPayload> | undefined) => {
  console.log(`[ad-injection-worker] Job ${job?.id} completed successfully`);
});

adWorker.on('failed', (job: Job<AdJobPayload> | undefined, err: Error) => {
  console.error(
    `[ad-injection-worker] Job ${job?.id} failed after ${job?.attemptsMade} attempts:`,
    err.message
  );
});

adWorker.on('error', (err: Error) => {
  console.error('[ad-injection-worker] Worker error:', err);
});

// ------------------------------------------------------------------
// Scheduling Functions
// ------------------------------------------------------------------

/**
 * Schedule ad injection for a campaign
 * Injects ads periodically (every 6 hours)
 */
export async function scheduleAdInjection(campaignId: string): Promise<void> {
  const delay = 6 * 60 * 60 * 1000; // 6 hours
  await adQueue.add(
    'inject-ad',
    { type: 'inject-ad', campaignId },
    {
      delay,
      jobId: `inject-${campaignId}-${Date.now()}`,
    }
  );
  console.log(`Scheduled ad injection for campaign ${campaignId} in 6 hours`);
}

/**
 * Schedule campaign expiration
 */
export async function scheduleCampaignExpiration(
  campaignId: string,
  expiresAt: Date
): Promise<void> {
  const delay = expiresAt.getTime() - Date.now();
  if (delay > 0) {
    await adQueue.add(
      'expire-campaign',
      { type: 'expire-campaign', campaignId },
      {
        delay,
        jobId: `expire-${campaignId}`,
      }
    );
    console.log(`Scheduled campaign ${campaignId} expiration at ${expiresAt.toISOString()}`);
  } else {
    // Campaign already expired, mark it immediately
    await prisma.adCampaign.update({
      where: { id: campaignId },
      data: { status: 'COMPLETED' },
    });
    console.log(`Campaign ${campaignId} already expired, marked as completed`);
  }
}

/**
 * Graceful shutdown
 */
export async function shutdownAdWorker(): Promise<void> {
  console.log('[ad-injection-worker] Shutting down...');
  try {
    await adWorker.close();
    await adQueue.close();
    console.log('[ad-injection-worker] Shutdown complete');
  } catch (error) {
    console.error('[ad-injection-worker] Error during shutdown:', error);
  }
}
