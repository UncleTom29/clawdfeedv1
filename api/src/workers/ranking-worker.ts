import { Queue, Worker, Job } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { prisma } from '../database.js';
import { redis } from '../redis.js';
import { config } from '../config.js';
import { getTipEvents, formatUSDC } from '../services/blockchain.js';

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

interface CalculateRankingsPayload {
  type: 'calculate-rankings';
  fromBlock?: string;
  toBlock?: string;
}

type RankingJobPayload = CalculateRankingsPayload;

interface AgentScore {
  agentId: string;
  engagementScore: number;
  tipScore: number;
  followerScore: number;
  totalScore: number;
}

// ------------------------------------------------------------------
// Configuration
// ------------------------------------------------------------------

const QUEUE_NAME = 'agent-rankings';

const redisConnection: ConnectionOptions = {
  host: new URL(config.REDIS_URL).hostname,
  port: parseInt(new URL(config.REDIS_URL).port || '6379', 10),
};

export const rankingQueue = new Queue<RankingJobPayload>(QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
  },
});

// ------------------------------------------------------------------
// Worker
// ------------------------------------------------------------------

export const rankingWorker = new Worker<RankingJobPayload>(
  QUEUE_NAME,
  async (job: Job<RankingJobPayload>) => {
    console.log(`[RankingWorker] Processing job ${job.id}: ${job.data.type}`);

    if (job.data.type === 'calculate-rankings') {
      await calculateAgentRankings(job.data);
    }

    console.log(`[RankingWorker] Completed job ${job.id}`);
  },
  {
    connection: redisConnection,
    concurrency: 1, // Process one at a time
  },
);

// ------------------------------------------------------------------
// Job Scheduler
// ------------------------------------------------------------------

/**
 * Schedule daily ranking calculation (runs at 2 AM UTC)
 */
export async function scheduleRankingJobs() {
  // Add a repeatable job for daily ranking calculation
  await rankingQueue.add(
    'daily-ranking',
    { type: 'calculate-rankings' },
    {
      repeat: {
        pattern: '0 2 * * *', // Daily at 2 AM UTC
      },
    },
  );

  console.log('[RankingWorker] Scheduled daily ranking calculation');
}

/**
 * Trigger an immediate ranking calculation
 */
export async function triggerRankingCalculation(
  fromBlock?: string,
  toBlock?: string,
): Promise<string> {
  const job = await rankingQueue.add('manual-ranking', {
    type: 'calculate-rankings',
    fromBlock,
    toBlock,
  });

  return job.id!;
}

// ------------------------------------------------------------------
// Ranking Calculation
// ------------------------------------------------------------------

async function calculateAgentRankings(
  payload: CalculateRankingsPayload,
): Promise<void> {
  console.log('[RankingWorker] Calculating agent rankings...');

  // Get all active agents
  const agents = await prisma.agent.findMany({
    where: {
      isActive: true,
    },
    include: {
      posts: {
        where: {
          isDeleted: false,
        },
        select: {
          id: true,
          likeCount: true,
          repostCount: true,
          replyCount: true,
          quoteCount: true,
          impressionCount: true,
        },
      },
    },
  });

  console.log(`[RankingWorker] Processing ${agents.length} agents`);

  const agentScores: AgentScore[] = [];

  // Get on-chain tip events from last 24 hours
  let tipEventsByAgent: Map<string, bigint> = new Map();

  try {
    const latestBlock = await redis.get('ranking:lastProcessedBlock');
    const currentBlock = await redis.get('chain:latestBlock');

    if (latestBlock && currentBlock) {
      const fromBlock = BigInt(latestBlock);
      const toBlock = BigInt(currentBlock);

      const tipEvents = await getTipEvents(fromBlock, toBlock);

      // Aggregate tips by agent
      for (const event of tipEvents) {
        const current = tipEventsByAgent.get(event.agentId) || 0n;
        tipEventsByAgent.set(event.agentId, current + event.amount);
      }

      // Update last processed block
      await redis.set('ranking:lastProcessedBlock', toBlock.toString());
    }
  } catch (error) {
    console.error('[RankingWorker] Error fetching tip events:', error);
  }

  // Calculate scores for each agent
  for (const agent of agents) {
    // 1. Engagement Score (likes, reposts, replies, quotes)
    const totalLikes = agent.posts.reduce((sum: number, p: any) => sum + p.likeCount, 0);
    const totalReposts = agent.posts.reduce((sum: number, p: any) => sum + p.repostCount, 0);
    const totalReplies = agent.posts.reduce((sum: number, p: any) => sum + p.replyCount, 0);
    const totalQuotes = agent.posts.reduce((sum: number, p: any) => sum + p.quoteCount, 0);
    const totalImpressions = agent.posts.reduce(
      (sum: number, p: any) => sum + p.impressionCount,
      0,
    );

    const engagementScore =
      totalLikes * 1.0 +
      totalReposts * 2.0 +
      totalReplies * 3.0 +
      totalQuotes * 2.5 +
      totalImpressions * 0.01;

    // 2. Tip Score (on-chain USDC tips in last 24h)
    const tipAmount = tipEventsByAgent.get(agent.id) || 0n;
    const tipScore = Number(tipAmount) / 1_000_000; // Convert from USDC (6 decimals) to score

    // 3. Follower Score
    const followerScore = Math.log10(agent.followerCount + 1) * 100;

    // Total weighted score
    const totalScore =
      engagementScore * 0.5 + tipScore * 0.3 + followerScore * 0.2;

    agentScores.push({
      agentId: agent.id,
      engagementScore,
      tipScore,
      followerScore,
      totalScore,
    });
  }

  // Sort by total score descending
  agentScores.sort((a, b) => b.totalScore - a.totalScore);

  // Update agent ranks in database
  console.log('[RankingWorker] Updating agent ranks in database...');

  for (let i = 0; i < agentScores.length; i++) {
    const score = agentScores[i];
    if (!score) continue; // Safety check instead of non-null assertion

    const rank = i + 1;

    await prisma.agent.update({
      where: { id: score.agentId },
      data: {
        currentScore: score.totalScore,
        rank,
      },
    });
  }

  // Store top 100 in Redis for quick access
  const top100 = agentScores.slice(0, 100).map((s, idx) => ({
    agentId: s.agentId,
    rank: idx + 1,
    score: s.totalScore,
  }));

  await redis.set(
    'ranking:top100',
    JSON.stringify(top100),
    'EX',
    86400, // Expire after 24 hours
  );

  console.log('[RankingWorker] Ranking calculation complete');
  console.log(`[RankingWorker] Top 10 agents:`);

  const top10Agents = await prisma.agent.findMany({
    where: {
      id: { in: top100.slice(0, 10).map((a) => a.agentId) },
    },
    select: {
      handle: true,
      name: true,
      currentScore: true,
      rank: true,
    },
  });

  for (const agent of top10Agents) {
    console.log(
      `  #${agent.rank} @${agent.handle} - ${agent.name} (score: ${agent.currentScore.toFixed(2)})`,
    );
  }
}

// ------------------------------------------------------------------
// Graceful Shutdown
// ------------------------------------------------------------------

export async function shutdownRankingWorker(): Promise<void> {
  console.log('[RankingWorker] Shutting down...');
  await rankingWorker.close();
  await rankingQueue.close();
  console.log('[RankingWorker] Shutdown complete');
}

// ------------------------------------------------------------------
// Error Handlers
// ------------------------------------------------------------------

rankingWorker.on('failed', (job, err) => {
  console.error(
    `[RankingWorker] Job ${job?.id} failed:`,
    err.message,
  );
});

rankingWorker.on('error', (err) => {
  console.error('[RankingWorker] Worker error:', err);
});
