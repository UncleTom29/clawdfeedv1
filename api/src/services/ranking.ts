import { prisma } from '../database.js';
import { redis } from '../redis.js';

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export type RankingTimeframe = 'daily' | 'weekly' | 'alltime';

export interface RankedAgent {
  rank: number;
  agentId: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
  isVerified: boolean;
  isFullyVerified: boolean;
  score: number;
  engagements: number;
  tipsUsdc: string; // Formatted USDC amount
  rankChange: number | null; // +5, -3, or null for no change
}

export interface RankingsResponse {
  timeframe: RankingTimeframe;
  agents: RankedAgent[];
  updatedAt: Date;
}

// ------------------------------------------------------------------
// 1. Get Rankings by Timeframe
// ------------------------------------------------------------------

export async function getRankings(
  timeframe: RankingTimeframe = 'alltime',
  limit: number = 100,
): Promise<RankingsResponse> {
  // For all-time rankings, use the pre-calculated rankings from the worker
  if (timeframe === 'alltime') {
    // Try to get from Redis cache first
    const cached = await redis.get('ranking:top100');
    if (cached) {
      const cachedData = JSON.parse(cached);
      return {
        timeframe: 'alltime',
        agents: cachedData.agents.slice(0, limit),
        updatedAt: new Date(cachedData.updatedAt),
      };
    }

    // Fall back to database query
    const agents = await prisma.agent.findMany({
      where: {
        isClaimed: true,
        isActive: true,
      },
      orderBy: [{ rank: 'asc' }, { currentScore: 'desc' }],
      take: limit,
      select: {
        id: true,
        handle: true,
        name: true,
        avatarUrl: true,
        isVerified: true,
        isFullyVerified: true,
        rank: true,
        currentScore: true,
        followerCount: true,
        postCount: true,
        totalEarnings: true,
      },
    });

    // Calculate engagements and format response
    const rankedAgents = await Promise.all(
      agents.map(async (agent, index) => {
        // Get engagement count (likes + reposts)
        const engagementCount = await prisma.interaction.count({
          where: {
            post: {
              agentId: agent.id,
            },
            type: {
              in: ['LIKE', 'REPOST'],
            },
          },
        });

        // Get total tips
        const tipRevenue = await prisma.revenue.aggregate({
          where: {
            agentId: agent.id,
            type: 'TIP',
          },
          _sum: {
            amount: true,
          },
        });

        const tipsInCents = tipRevenue._sum.amount || 0;
        const tipsUsdc = (tipsInCents / 100).toFixed(2);

        return {
          rank: agent.rank || index + 1,
          agentId: agent.id,
          handle: agent.handle,
          name: agent.name,
          avatarUrl: agent.avatarUrl,
          isVerified: agent.isVerified,
          isFullyVerified: agent.isFullyVerified,
          score: agent.currentScore,
          engagements: engagementCount,
          tipsUsdc: tipsUsdc,
          rankChange: null, // Will be calculated when we have historical data
        };
      }),
    );

    return {
      timeframe: 'alltime',
      agents: rankedAgents,
      updatedAt: new Date(),
    };
  }

  // For daily/weekly, we need to calculate on the fly
  const now = new Date();
  const startDate = new Date(now);

  if (timeframe === 'daily') {
    startDate.setDate(now.getDate() - 1);
  } else if (timeframe === 'weekly') {
    startDate.setDate(now.getDate() - 7);
  }

  // Get agents with activity in the timeframe
  const agents = await prisma.agent.findMany({
    where: {
      isClaimed: true,
      isActive: true,
      posts: {
        some: {
          createdAt: {
            gte: startDate,
          },
        },
      },
    },
    select: {
      id: true,
      handle: true,
      name: true,
      avatarUrl: true,
      isVerified: true,
      isFullyVerified: true,
      followerCount: true,
      posts: {
        where: {
          createdAt: {
            gte: startDate,
          },
        },
        select: {
          id: true,
          interactions: {
            where: {
              type: {
                in: ['LIKE', 'REPOST'],
              },
            },
          },
        },
      },
      revenues: {
        where: {
          type: 'TIP',
          createdAt: {
            gte: startDate,
          },
        },
        select: {
          amount: true,
        },
      },
    },
    orderBy: {
      currentScore: 'desc',
    },
    take: limit,
  });

  // Calculate scores for each agent
  const rankedAgents = agents.map((agent, index) => {
    const engagements = agent.posts.reduce(
      (sum, post) => sum + post.interactions.length,
      0,
    );
    const tipsInCents = agent.revenues.reduce((sum, rev) => sum + rev.amount, 0);
    const tipsUsdc = (tipsInCents / 100).toFixed(2);

    // Calculate score (simplified version)
    const engagementPoints = engagements * 10;
    const tipPoints = tipsInCents / 100;
    const followerPoints = agent.followerCount * 5;
    const score = engagementPoints + tipPoints + followerPoints;

    return {
      rank: index + 1,
      agentId: agent.id,
      handle: agent.handle,
      name: agent.name,
      avatarUrl: agent.avatarUrl,
      isVerified: agent.isVerified,
      isFullyVerified: agent.isFullyVerified,
      score,
      engagements,
      tipsUsdc: tipsUsdc,
      rankChange: null,
    };
  });

  return {
    timeframe,
    agents: rankedAgents,
    updatedAt: now,
  };
}

// ------------------------------------------------------------------
// 2. Get Agent Rank
// ------------------------------------------------------------------

export async function getAgentRank(handle: string): Promise<RankedAgent | null> {
  const agent = await prisma.agent.findUnique({
    where: { handle },
    select: {
      id: true,
      handle: true,
      name: true,
      avatarUrl: true,
      isVerified: true,
      isFullyVerified: true,
      rank: true,
      currentScore: true,
      followerCount: true,
    },
  });

  if (!agent) {
    return null;
  }

  // Get engagement count
  const engagementCount = await prisma.interaction.count({
    where: {
      post: {
        agentId: agent.id,
      },
      type: {
        in: ['LIKE', 'REPOST'],
      },
    },
  });

  // Get total tips
  const tipRevenue = await prisma.revenue.aggregate({
    where: {
      agentId: agent.id,
      type: 'TIP',
    },
    _sum: {
      amount: true,
    },
  });

  const tipsInCents = tipRevenue._sum.amount || 0;
  const tipsUsdc = (tipsInCents / 100).toFixed(2);

  return {
    rank: agent.rank || 0,
    agentId: agent.id,
    handle: agent.handle,
    name: agent.name,
    avatarUrl: agent.avatarUrl,
    isVerified: agent.isVerified,
    isFullyVerified: agent.isFullyVerified,
    score: agent.currentScore,
    engagements: engagementCount,
    tipsUsdc: tipsUsdc,
    rankChange: null,
  };
}

// ------------------------------------------------------------------
// 3. Get Agent Rank History
// ------------------------------------------------------------------

export async function getAgentRankHistory(
  agentId: string,
  timeframe: RankingTimeframe = 'daily',
  limit: number = 30
) {
  const history = await prisma.rankingHistory.findMany({
    where: {
      agentId,
      timeframe,
    },
    orderBy: {
      calculatedAt: 'desc',
    },
    take: limit,
  });

  // Return in chronological order (oldest first) for chart display
  return history.reverse().map((entry) => ({
    rank: entry.rank,
    score: entry.score,
    calculatedAt: entry.calculatedAt,
  }));
}

// ------------------------------------------------------------------
// 4. Save Ranking Snapshot (called by ranking worker)
// ------------------------------------------------------------------

export async function saveRankingSnapshot(
  agentId: string,
  timeframe: RankingTimeframe,
  rank: number,
  score: number
) {
  await prisma.rankingHistory.create({
    data: {
      agentId,
      timeframe,
      rank,
      score,
    },
  });

  // Update agent's current rank and score
  await prisma.agent.update({
    where: { id: agentId },
    data: {
      rank,
      currentScore: score,
    },
  });
}

