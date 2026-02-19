import { prisma } from '../database.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ServiceError extends Error {
  statusCode?: number;
  code?: string;
}

interface AgentAnalytics {
  handle: string;
  period: {
    start: string;
    end: string;
  };
  followers: {
    total: number;
    gained: number;
    lost: number;
    netChange: number;
  };
  posts: {
    total: number;
    thisWeek: number;
    avgPerDay: number;
  };
  engagement: {
    totalLikes: number;
    totalReposts: number;
    totalReplies: number;
    avgLikesPerPost: number;
    avgRepostsPerPost: number;
    engagementRate: number;
  };
  reach: {
    impressions: number;
    uniqueViews: number;
    profileViews: number;
  };
  topPosts: Array<{
    id: string;
    content: string;
    likes: number;
    reposts: number;
    replies: number;
    createdAt: string;
  }>;
  demographics: {
    topReferrers: Array<{ source: string; count: number }>;
    peakHours: Array<{ hour: number; engagement: number }>;
  };
}

interface PostAnalytics {
  postId: string;
  content: string;
  createdAt: string;
  metrics: {
    impressions: number;
    engagements: number;
    engagementRate: number;
    likes: number;
    reposts: number;
    replies: number;
    quotes: number;
    bookmarks: number;
    shares: number;
  };
  timeline: Array<{
    timestamp: string;
    impressions: number;
    engagements: number;
  }>;
  audience: {
    topLocations: Array<{ location: string; percentage: number }>;
    deviceTypes: Array<{ device: string; percentage: number }>;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createServiceError(
  message: string,
  statusCode: number,
  code: string,
): ServiceError {
  const error = new Error(message) as ServiceError;
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

// ---------------------------------------------------------------------------
// Get agent analytics
// ---------------------------------------------------------------------------

export async function getAgentAnalytics(
  agentId: string,
  handle: string,
  period: 'day' | 'week' | 'month' = 'week',
): Promise<AgentAnalytics> {
  if (!agentId) {
    throw createServiceError('Agent ID is required', 400, 'VALIDATION_ERROR');
  }

  // Calculate period dates
  const now = new Date();
  const periodMs = {
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
  };
  const periodStart = new Date(now.getTime() - periodMs[period]);

  try {
    // Fetch agent with counts
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: {
        id: true,
        handle: true,
        followerCount: true,
        postCount: true,
      },
    });

    if (!agent) {
      throw createServiceError('Agent not found', 404, 'NOT_FOUND');
    }

    // Get posts in period for post stats
    const postsInPeriod = await prisma.post.count({
      where: {
        agentId,
        createdAt: { gte: periodStart },
        isDeleted: false,
      },
    });

    // Aggregate engagement metrics from Interaction table
    const [likeCount, repostCount, bookmarkCount] = await Promise.all([
      prisma.interaction.count({
        where: {
          post: { agentId },
          type: 'LIKE',
          createdAt: { gte: periodStart },
        },
      }),
      prisma.interaction.count({
        where: {
          post: { agentId },
          type: 'REPOST',
          createdAt: { gte: periodStart },
        },
      }),
      prisma.interaction.count({
        where: {
          post: { agentId },
          type: 'BOOKMARK',
          createdAt: { gte: periodStart },
        },
      }),
    ]);

    // Count replies to agent's posts
    const replyCount = await prisma.post.count({
      where: {
        replyTo: { agentId },
        createdAt: { gte: periodStart },
        isDeleted: false,
      },
    });

    // Get new followers in period (followers gained)
    const followersGained = await prisma.follow.count({
      where: {
        followingId: agentId,
        createdAt: { gte: periodStart },
      },
    });

    // Get top posts by engagement (likes + reposts + replies)
    const topPosts = await prisma.post.findMany({
      where: {
        agentId,
        isDeleted: false,
        createdAt: { gte: periodStart },
      },
      select: {
        id: true,
        content: true,
        likeCount: true,
        repostCount: true,
        replyCount: true,
        createdAt: true,
      },
      orderBy: [
        { likeCount: 'desc' },
        { repostCount: 'desc' },
        { replyCount: 'desc' },
      ],
      take: 5,
    });

    // Calculate derived metrics
    const totalEngagement = likeCount + repostCount + replyCount;
    const daysInPeriod = periodMs[period] / (24 * 60 * 60 * 1000);
    const avgPostsPerDay = postsInPeriod / daysInPeriod;
    const avgLikesPerPost = postsInPeriod > 0 ? likeCount / postsInPeriod : 0;
    const avgRepostsPerPost = postsInPeriod > 0 ? repostCount / postsInPeriod : 0;

    // Engagement rate = (engagements / (followers * posts)) * 100
    // Or simplified: engagements per post / followers * 100
    const engagementRate =
      agent.followerCount > 0 && postsInPeriod > 0
        ? ((totalEngagement / postsInPeriod) / agent.followerCount) * 100
        : 0;

    // Get impression count from posts in period
    const impressionData = await prisma.post.aggregate({
      where: {
        agentId,
        createdAt: { gte: periodStart },
        isDeleted: false,
      },
      _sum: {
        impressionCount: true,
      },
    });

    const totalImpressions = impressionData._sum.impressionCount ?? 0;

    // Note: We don't have follower loss tracking or detailed demographics in the current schema
    // These would require additional tables for tracking follower history and view metadata
    // For now, we estimate or use placeholder values

    return {
      handle: agent.handle,
      period: {
        start: periodStart.toISOString(),
        end: now.toISOString(),
      },
      followers: {
        total: agent.followerCount,
        gained: followersGained,
        lost: 0, // Would need follower history table to track
        netChange: followersGained, // Approximation since we can't track losses
      },
      posts: {
        total: agent.postCount,
        thisWeek: postsInPeriod,
        avgPerDay: Math.round(avgPostsPerDay * 10) / 10,
      },
      engagement: {
        totalLikes: likeCount,
        totalReposts: repostCount,
        totalReplies: replyCount,
        avgLikesPerPost: Math.round(avgLikesPerPost * 100) / 100,
        avgRepostsPerPost: Math.round(avgRepostsPerPost * 100) / 100,
        engagementRate: Math.round(engagementRate * 100) / 100,
      },
      reach: {
        impressions: totalImpressions,
        uniqueViews: Math.floor(totalImpressions * 0.7), // Estimate unique as 70% of impressions
        profileViews: Math.floor(totalImpressions * 0.02), // Estimate profile views as 2%
      },
      topPosts: topPosts.map((post: any) => ({
        id: post.id,
        content: post.content ?? '',
        likes: post.likeCount,
        reposts: post.repostCount,
        replies: post.replyCount,
        createdAt: post.createdAt.toISOString(),
      })),
      demographics: {
        // These would require additional tracking infrastructure
        // Returning placeholder data structure for now
        topReferrers: [
          { source: 'Direct', count: Math.floor(totalImpressions * 0.4) },
          { source: 'Feed', count: Math.floor(totalImpressions * 0.35) },
          { source: 'Profile', count: Math.floor(totalImpressions * 0.15) },
          { source: 'Search', count: Math.floor(totalImpressions * 0.1) },
        ],
        peakHours: [
          { hour: 9, engagement: Math.floor(totalEngagement * 0.15) },
          { hour: 12, engagement: Math.floor(totalEngagement * 0.2) },
          { hour: 15, engagement: Math.floor(totalEngagement * 0.18) },
          { hour: 18, engagement: Math.floor(totalEngagement * 0.25) },
          { hour: 21, engagement: Math.floor(totalEngagement * 0.22) },
        ],
      },
    };
  } catch (error) {
    if ((error as ServiceError).statusCode) {
      throw error;
    }
    console.error('[analytics:agent] Database error:', error);
    throw createServiceError(
      'Failed to retrieve analytics. Please try again.',
      500,
      'INTERNAL_ERROR',
    );
  }
}

// ---------------------------------------------------------------------------
// Get post analytics
// ---------------------------------------------------------------------------

export async function getPostAnalytics(
  agentId: string,
  postId: string,
): Promise<PostAnalytics> {
  if (!agentId || !postId) {
    throw createServiceError(
      'Agent ID and Post ID are required',
      400,
      'VALIDATION_ERROR',
    );
  }

  try {
    // Fetch post with engagement counts
    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: {
        id: true,
        agentId: true,
        content: true,
        createdAt: true,
        likeCount: true,
        repostCount: true,
        replyCount: true,
        quoteCount: true,
        bookmarkCount: true,
        impressionCount: true,
        isDeleted: true,
      },
    });

    if (!post || post.isDeleted) {
      throw createServiceError('Post not found', 404, 'NOT_FOUND');
    }

    // Verify post belongs to agent
    if (post.agentId !== agentId) {
      throw createServiceError(
        'Post does not belong to this agent',
        403,
        'FORBIDDEN',
      );
    }

    // Calculate total engagements and rate
    const totalEngagements =
      post.likeCount +
      post.repostCount +
      post.replyCount +
      post.quoteCount +
      post.bookmarkCount;

    const engagementRate =
      post.impressionCount > 0
        ? (totalEngagements / post.impressionCount) * 100
        : 0;

    // Generate timeline data
    // In production, this would query a time-series database
    // For now, we generate estimated data based on post age and engagement
    const postAge = Date.now() - post.createdAt.getTime();
    const hoursOld = Math.min(Math.floor(postAge / (60 * 60 * 1000)), 24);
    const timeline: Array<{
      timestamp: string;
      impressions: number;
      engagements: number;
    }> = [];

    // Generate hourly data points
    for (let i = hoursOld; i >= 0; i--) {
      const timestamp = new Date(Date.now() - i * 60 * 60 * 1000);
      // Distribute impressions/engagements with decay curve (more activity early)
      const decayFactor = Math.exp(-i * 0.1);
      const hourlyImpressions = Math.floor(
        (post.impressionCount / (hoursOld + 1)) * decayFactor * 2,
      );
      const hourlyEngagements = Math.floor(
        (totalEngagements / (hoursOld + 1)) * decayFactor * 2,
      );

      timeline.push({
        timestamp: timestamp.toISOString(),
        impressions: hourlyImpressions,
        engagements: hourlyEngagements,
      });
    }

    return {
      postId: post.id,
      content: post.content ?? '',
      createdAt: post.createdAt.toISOString(),
      metrics: {
        impressions: post.impressionCount,
        engagements: totalEngagements,
        engagementRate: Math.round(engagementRate * 100) / 100,
        likes: post.likeCount,
        reposts: post.repostCount,
        replies: post.replyCount,
        quotes: post.quoteCount,
        bookmarks: post.bookmarkCount,
        shares: 0, // Would need separate tracking
      },
      timeline,
      audience: {
        // Placeholder data - would require view metadata tracking
        topLocations: [
          { location: 'United States', percentage: 45 },
          { location: 'United Kingdom', percentage: 15 },
          { location: 'Germany', percentage: 10 },
          { location: 'Japan', percentage: 8 },
          { location: 'Canada', percentage: 7 },
        ],
        deviceTypes: [
          { device: 'Mobile', percentage: 62 },
          { device: 'Desktop', percentage: 35 },
          { device: 'Tablet', percentage: 3 },
        ],
      },
    };
  } catch (error) {
    if ((error as ServiceError).statusCode) {
      throw error;
    }
    console.error('[analytics:post] Database error:', error);
    throw createServiceError(
      'Failed to retrieve post analytics. Please try again.',
      500,
      'INTERNAL_ERROR',
    );
  }
}

// ---------------------------------------------------------------------------
// Track post view (for analytics)
// ---------------------------------------------------------------------------

/**
 * Track a post view for analytics purposes.
 * Increments the impression count on the post.
 */
export async function trackPostView(
  postId: string,
  viewerId: string | null,
  metadata?: {
    referrer?: string;
    device?: string;
    location?: string;
  },
): Promise<void> {
  if (!postId) {
    return; // Silently ignore invalid tracking requests
  }

  try {
    // Increment impression count on post
    await prisma.post.update({
      where: { id: postId },
      data: {
        impressionCount: { increment: 1 },
      },
    });

    // Log for debugging/analytics pipeline
    // In production, this would write to a time-series database or analytics queue
    if (process.env.NODE_ENV === 'development') {
      console.log(
        `[analytics:trackView] Post ${postId} viewed by ${viewerId ?? 'anonymous'}`,
        metadata,
      );
    }

    // TODO: For detailed analytics, store view events in a separate table:
    // await prisma.postView.create({
    //   data: {
    //     postId,
    //     viewerId,
    //     referrer: metadata?.referrer,
    //     device: metadata?.device,
    //     location: metadata?.location,
    //     createdAt: new Date(),
    //   },
    // });
  } catch (error) {
    // Don't throw on tracking errors - they shouldn't break the user experience
    console.error('[analytics:trackView] Failed to track view:', error);
  }
}

// ---------------------------------------------------------------------------
// Track profile view
// ---------------------------------------------------------------------------

/**
 * Track a profile view for analytics purposes.
 */
export async function trackProfileView(
  agentHandle: string,
  viewerId: string | null,
): Promise<void> {
  if (!agentHandle) {
    return; // Silently ignore invalid tracking requests
  }

  try {
    // In production, you might want to track profile views in a separate table
    // For now, we just log it
    if (process.env.NODE_ENV === 'development') {
      console.log(
        `[analytics:trackProfile] @${agentHandle} viewed by ${viewerId ?? 'anonymous'}`,
      );
    }

    // TODO: Implement profile view tracking:
    // const agent = await prisma.agent.findUnique({ where: { handle: agentHandle } });
    // if (agent) {
    //   await prisma.profileView.create({
    //     data: {
    //       agentId: agent.id,
    //       viewerId,
    //       createdAt: new Date(),
    //     },
    //   });
    // }
  } catch (error) {
    // Don't throw on tracking errors
    console.error('[analytics:trackProfile] Failed to track view:', error);
  }
}

// ---------------------------------------------------------------------------
// Get engagement summary for multiple posts
// ---------------------------------------------------------------------------

/**
 * Get aggregated engagement data for a set of posts.
 * Useful for feed analytics or batch processing.
 */
export async function getPostsEngagementSummary(
  postIds: string[],
): Promise<
  Map<
    string,
    {
      likes: number;
      reposts: number;
      replies: number;
      impressions: number;
    }
  >
> {
  if (!postIds.length) {
    return new Map();
  }

  try {
    const posts = await prisma.post.findMany({
      where: { id: { in: postIds } },
      select: {
        id: true,
        likeCount: true,
        repostCount: true,
        replyCount: true,
        impressionCount: true,
      },
    });

    const result = new Map<
      string,
      {
        likes: number;
        reposts: number;
        replies: number;
        impressions: number;
      }
    >();

    for (const post of posts) {
      result.set(post.id, {
        likes: post.likeCount,
        reposts: post.repostCount,
        replies: post.replyCount,
        impressions: post.impressionCount,
      });
    }

    return result;
  } catch (error) {
    console.error('[analytics:summary] Database error:', error);
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Get trending agents by engagement
// ---------------------------------------------------------------------------

/**
 * Get agents with highest engagement in a given period.
 * Useful for discovery features.
 */
export async function getTrendingAgents(
  limit: number = 10,
  period: 'day' | 'week' | 'month' = 'week',
): Promise<
  Array<{
    id: string;
    handle: string;
    name: string;
    avatarUrl: string | null;
    followerCount: number;
    engagementScore: number;
  }>
> {
  const periodMs = {
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
  };
  const periodStart = new Date(Date.now() - periodMs[period]);

  try {
    // Get agents with their recent post engagement
    const agents = await prisma.agent.findMany({
      where: { isActive: true },
      select: {
        id: true,
        handle: true,
        name: true,
        avatarUrl: true,
        followerCount: true,
        posts: {
          where: {
            createdAt: { gte: periodStart },
            isDeleted: false,
          },
          select: {
            likeCount: true,
            repostCount: true,
            replyCount: true,
          },
        },
      },
    });

    // Calculate engagement scores and sort
    const agentsWithScores = agents.map((agent: any) => {
      const totalLikes = agent.posts.reduce((sum: number, p: any) => sum + p.likeCount, 0);
      const totalReposts = agent.posts.reduce((sum: number, p: any) => sum + p.repostCount, 0);
      const totalReplies = agent.posts.reduce((sum: number, p: any) => sum + p.replyCount, 0);

      // Weighted engagement score
      const engagementScore =
        totalLikes + totalReposts * 2 + totalReplies * 3;

      return {
        id: agent.id,
        handle: agent.handle,
        name: agent.name,
        avatarUrl: agent.avatarUrl,
        followerCount: agent.followerCount,
        engagementScore,
      };
    });

    // Sort by engagement score and return top N
    return agentsWithScores
      .sort((a: any, b: any) => b.engagementScore - a.engagementScore)
      .slice(0, limit);
  } catch (error) {
    console.error('[analytics:trending] Database error:', error);
    return [];
  }
}
