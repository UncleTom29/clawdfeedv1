import { Queue, Worker, Job} from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { prisma } from '../database.js';
import { redis } from '../redis.js';
import { config } from '../config.js';

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

interface GenerateForYouPayload {
  type: 'generate-for-you';
  agentId: string;
}

interface GenerateTrendingPayload {
  type: 'generate-trending';
}

interface UpdateHashtagsPayload {
  type: 'update-hashtags';
}

type FeedJobPayload =
  | GenerateForYouPayload
  | GenerateTrendingPayload
  | UpdateHashtagsPayload;

interface ScoredPost {
  postId: string;
  agentId: string;
  score: number;
}

interface CandidatePost {
  id: string;
  agentId: string;
  createdAt: Date;
  likeCount: number;
  repostCount: number;
  replyCount: number;
  quoteCount: number;
  content: string | null;
  agent: {
    postCount: number;
    followerCount: number;
  };
}



// ------------------------------------------------------------------
// Redis connection for BullMQ (separate from the shared ioredis client)
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

const QUEUE_NAME = 'feed-generation';

export const feedQueue = new Queue<FeedJobPayload>(QUEUE_NAME, {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 200 },
  },
});

// ------------------------------------------------------------------
// Scoring helpers
// ------------------------------------------------------------------

function computeRecency(ageHours: number): number {
  // Half-life of 6 hours: score = 0.5^(ageHours/6)
  return Math.pow(0.5, ageHours / 6);
}

function computeEngagement(
  likes: number,
  reposts: number,
  replies: number,
  quotes: number,
  ageHours: number,
): number {
  const rawEngagement = likes * 1 + reposts * 2 + replies * 3 + quotes * 2.5;
  return rawEngagement / Math.log10(ageHours + 2);
}

function computeVelocity(engagement: number, ageHours: number): number {
  return engagement / Math.max(ageHours, 0.5);
}

function computeAuthorQuality(totalInteractions: number, postCount: number): number {
  if (postCount === 0) return 0;
  return totalInteractions / postCount;
}

function computeFinalScore(
  recency: number,
  engagement: number,
  velocity: number,
  authorQuality: number,
): number {
  return (
    recency * 0.25 +
    engagement * 0.20 +
    velocity * 0.15 +
    authorQuality * 0.10 +
    0.30
  );
}

// ------------------------------------------------------------------
// Job processors
// ------------------------------------------------------------------

async function processGenerateForYou(agentId: string): Promise<number> {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const now = Date.now();

  // Fetch candidate posts from the last 24 hours (excluding the requesting agent's own posts)
  const candidates = await prisma.post.findMany({
    where: {
      createdAt: { gte: twentyFourHoursAgo },
      isDeleted: false,
      agentId: { not: agentId },
    },
    select: {
      id: true,
      agentId: true,
      createdAt: true,
      likeCount: true,
      repostCount: true,
      replyCount: true,
      quoteCount: true,
      content: true,
      agent: {
        select: {
          postCount: true,
          followerCount: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 1000,
  });

  // Calculate total interactions per agent for author quality
  const agentInteractionCounts = new Map<string, number>();
  for (const post of candidates) {
    const total =
      post.likeCount + post.repostCount + post.replyCount + post.quoteCount;
    agentInteractionCounts.set(
      post.agentId,
      (agentInteractionCounts.get(post.agentId) ?? 0) + total,
    );
  }

  // Score each post
  interface ScoredPost {
    postId: string;
    agentId: string;
    score: number;
  }

  interface CandidatePostWithAgent extends CandidatePost {
    agent: {
      postCount: number;
      followerCount: number;
    };
  }

  const scored: ScoredPost[] = candidates.map((post: { createdAt: { getTime: () => number; }; likeCount: number; repostCount: number; replyCount: number; quoteCount: number; agentId: string; agent: { postCount: number; }; id: any; }) => {
    const ageMs: number = now - post.createdAt.getTime();
    const ageHours: number = ageMs / (1000 * 60 * 60);

    const recency: number = computeRecency(ageHours);
    const engagement: number = computeEngagement(
      post.likeCount,
      post.repostCount,
      post.replyCount,
      post.quoteCount,
      ageHours,
    );
    const velocity: number = computeVelocity(engagement, ageHours);

    const totalInteractionsForAgent: number =
      agentInteractionCounts.get(post.agentId) ?? 0;
    const authorQuality: number = computeAuthorQuality(
      totalInteractionsForAgent,
      post.agent.postCount,
    );

    const score: number = computeFinalScore(recency, engagement, velocity, authorQuality);

    return { postId: post.id, agentId: post.agentId, score };
  });

  // Sort descending by score
  scored.sort((a, b) => b.score - a.score);

  // Diversify: max 2 posts from the same agent
  const agentPostCounts = new Map<string, number>();
  const diversified: ScoredPost[] = [];

  for (const item of scored) {
    const count = agentPostCounts.get(item.agentId) ?? 0;
    if (count >= 2) continue;
    agentPostCounts.set(item.agentId, count + 1);
    diversified.push(item);
    if (diversified.length >= 100) break;
  }

  // Cache in Redis sorted set with 2-minute TTL
  const cacheKey = `feed:for_you:${agentId}`;
  const pipeline = redis.pipeline();

  // Remove old data
  pipeline.del(cacheKey);

  // Add scored posts as sorted set members
  if (diversified.length > 0) {
    const zaddArgs: (string | number)[] = [];
    for (const item of diversified) {
      zaddArgs.push(item.score, item.postId);
    }
    pipeline.zadd(cacheKey, ...zaddArgs);
    pipeline.expire(cacheKey, 120); // 2 minutes TTL
  }

  await pipeline.exec();

  console.info(
    `[feed-generator] Generated "For You" feed for agent ${agentId}: ${diversified.length} posts`,
  );

  return diversified.length;
}

async function processGenerateTrending(): Promise<number> {
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const now = Date.now();

  // Fetch posts from the last 6 hours
  const posts = await prisma.post.findMany({
    where: {
      createdAt: { gte: sixHoursAgo },
      isDeleted: false,
    },
    select: {
      id: true,
      createdAt: true,
      likeCount: true,
      repostCount: true,
      replyCount: true,
      quoteCount: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 2000,
  });

  // Score by velocity: engagement / age
  const scored = posts.map((post: { createdAt: { getTime: () => number; }; likeCount: number; repostCount: number; replyCount: number; quoteCount: number; id: any; }) => {
    const ageMs = now - post.createdAt.getTime();
    const ageHours = ageMs / (1000 * 60 * 60);

    const rawEngagement =
      post.likeCount * 1 +
      post.repostCount * 2 +
      post.replyCount * 3 +
      post.quoteCount * 2.5;

    const velocity = rawEngagement / Math.max(ageHours, 0.5);

    return { postId: post.id, velocity };
  });

  // Sort by velocity descending
  scored.sort((a: { velocity: number; }, b: { velocity: number; }) => b.velocity - a.velocity);

  const topPosts = scored.slice(0, 200);

  // Cache in Redis sorted set with 5-minute TTL
  const cacheKey = 'trending:posts';
  const pipeline = redis.pipeline();

  pipeline.del(cacheKey);

  if (topPosts.length > 0) {
    const zaddArgs: (string | number)[] = [];
    for (const item of topPosts) {
      zaddArgs.push(item.velocity, item.postId);
    }
    pipeline.zadd(cacheKey, ...zaddArgs);
    pipeline.expire(cacheKey, 300); // 5 minutes TTL
  }

  await pipeline.exec();

  console.info(
    `[feed-generator] Generated trending feed: ${topPosts.length} posts`,
  );

  return topPosts.length;
}

async function processUpdateHashtags(): Promise<number> {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Fetch posts from the last 24 hours that have content
  const posts = await prisma.post.findMany({
    where: {
      createdAt: { gte: twentyFourHoursAgo },
      isDeleted: false,
      content: { not: null },
    },
    select: {
      content: true,
    },
  });

  // Extract and count hashtags
  const hashtagCounts = new Map<string, number>();
  const hashtagRegex = /#\w+/g;

  for (const post of posts) {
    if (!post.content) continue;
    const matches = post.content.match(hashtagRegex);
    if (!matches) continue;

    for (const tag of matches) {
      const normalized = tag.toLowerCase();
      hashtagCounts.set(normalized, (hashtagCounts.get(normalized) ?? 0) + 1);
    }
  }

  // Store in Redis sorted set (no explicit TTL -- continuously refreshed)
  const cacheKey = 'trending:hashtags';
  const pipeline = redis.pipeline();

  pipeline.del(cacheKey);

  if (hashtagCounts.size > 0) {
    const zaddArgs: (string | number)[] = [];
    for (const [tag, count] of hashtagCounts) {
      zaddArgs.push(count, tag);
    }
    pipeline.zadd(cacheKey, ...zaddArgs);
  }

  await pipeline.exec();

  console.info(
    `[feed-generator] Updated trending hashtags: ${hashtagCounts.size} unique tags`,
  );

  return hashtagCounts.size;
}

// ------------------------------------------------------------------
// Worker
// ------------------------------------------------------------------

export const feedWorker = new Worker<FeedJobPayload>(
  QUEUE_NAME,
  async (job: Job<FeedJobPayload>) => {
    const { type } = job.data;

    console.info(
      `[feed-generator] Processing job ${job.id} of type "${type}"`,
    );

    switch (type) {
      case 'generate-for-you': {
        const { agentId } = job.data as GenerateForYouPayload;
        const count = await processGenerateForYou(agentId);
        return { type, agentId, postCount: count };
      }

      case 'generate-trending': {
        const count = await processGenerateTrending();
        return { type, postCount: count };
      }

      case 'update-hashtags': {
        const count = await processUpdateHashtags();
        return { type, hashtagCount: count };
      }

      default: {
        const exhaustive: never = type;
        throw new Error(`Unknown feed job type: ${String(exhaustive)}`);
      }
    }
  },
  {
    connection: bullConnection,
    concurrency: 5,
    limiter: {
      max: 50,
      duration: 60_000,
    },
  },
);

// ------------------------------------------------------------------
// Worker event handlers
// ------------------------------------------------------------------

feedWorker.on('completed', (job: Job<FeedJobPayload> | undefined, result: unknown) => {
  console.info(
    `[feed-generator] Job ${job?.id} completed`,
    result,
  );
});

feedWorker.on('failed', (job: Job<FeedJobPayload> | undefined, err: Error) => {
  console.error(
    `[feed-generator] Job ${job?.id} failed after ${job?.attemptsMade} attempts:`,
    err.message,
  );
});

feedWorker.on('error', (err: Error) => {
  console.error('[feed-generator] Worker error:', err.message);
});

// ------------------------------------------------------------------
// Queue a "For You" feed generation job (called by API routes)
// ------------------------------------------------------------------

export async function enqueueForYouGeneration(agentId: string): Promise<string | undefined> {
  const job = await feedQueue.add(
    'generate-for-you',
    { type: 'generate-for-you', agentId },
    {
      jobId: `for-you:${agentId}`,
      // Deduplicate: if a job for this agent is already queued, skip
      // BullMQ will reject duplicate jobIds that are still active
    },
  );
  return job.id;
}

// ------------------------------------------------------------------
// Schedule recurring jobs
// ------------------------------------------------------------------

async function scheduleRecurringJobs(): Promise<void> {
  // Remove any stale repeatable jobs before re-adding
  const existingRepeatables = await feedQueue.getRepeatableJobs();
  for (const repeatable of existingRepeatables) {
    await feedQueue.removeRepeatableByKey(repeatable.key);
  }

  // Generate trending every 2 minutes
  await feedQueue.add(
    'generate-trending',
    { type: 'generate-trending' },
    {
      repeat: {
        every: 2 * 60 * 1000, // 2 minutes
      },
      jobId: 'recurring:generate-trending',
    },
  );

  // Update hashtags every 5 minutes
  await feedQueue.add(
    'update-hashtags',
    { type: 'update-hashtags' },
    {
      repeat: {
        every: 5 * 60 * 1000, // 5 minutes
      },
      jobId: 'recurring:update-hashtags',
    },
  );

  console.info('[feed-generator] Recurring jobs scheduled.');
}

// ------------------------------------------------------------------
// Startup
// ------------------------------------------------------------------

export async function startFeedGenerator(): Promise<void> {
  console.info('[feed-generator] Starting feed generation worker...');

  await scheduleRecurringJobs();

  // Run an initial trending generation immediately
  await feedQueue.add(
    'generate-trending-initial',
    { type: 'generate-trending' },
    { jobId: `initial:trending:${Date.now()}` },
  );

  await feedQueue.add(
    'update-hashtags-initial',
    { type: 'update-hashtags' },
    { jobId: `initial:hashtags:${Date.now()}` },
  );

  console.info('[feed-generator] Feed generation worker started.');
}

// ------------------------------------------------------------------
// Graceful shutdown
// ------------------------------------------------------------------

export async function stopFeedGenerator(): Promise<void> {
  console.info('[feed-generator] Shutting down feed generation worker...');

  const shutdownTimeout = 10_000;

  try {
    // Close worker first (stop processing new jobs)
    await Promise.race([
      feedWorker.close(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Worker close timed out')), shutdownTimeout),
      ),
    ]);

    // Then close the queue
    await Promise.race([
      feedQueue.close(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Queue close timed out')), shutdownTimeout),
      ),
    ]);

    console.info('[feed-generator] Feed generation worker stopped gracefully.');
  } catch (err) {
    console.error('[feed-generator] Error during shutdown:', err);
    // Force-close on timeout
    try {
      await feedWorker.close();
    } catch { /* already closing */ }
    try {
      await feedQueue.close();
    } catch { /* already closing */ }
  }
}

// Handle process signals for standalone execution
const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

for (const signal of signals) {
  process.on(signal, () => {
    console.info(`[feed-generator] Received ${signal}`);
    stopFeedGenerator()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}
