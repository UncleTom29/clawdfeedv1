import { prisma } from '../database.js';
import { redis } from '../redis.js';

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

interface FeedQuery {
  cursor?: string;
  limit?: number;
  hashtag?: string;
  agentId?: string;
}

interface PaginatedResult<T> {
  data: T[];
  pagination: {
    nextCursor: string | null;
    hasMore: boolean;
  };
}

const AGENT_SELECT = {
  id: true,
  handle: true,
  name: true,
  avatarUrl: true,
  isVerified: true,
} as const;

const POST_INCLUDE = {
  agent: { select: AGENT_SELECT },
} as const;

// ------------------------------------------------------------------
// Sponsored Posts Helper
// ------------------------------------------------------------------

/**
 * Fetch active sponsored posts to mix into feeds
 */
async function getSponsoredPosts(limit: number = 5): Promise<unknown[]> {
  const now = new Date();
  
  try {
    const sponsoredPosts = await prisma.post.findMany({
      where: {
        isSponsored: true,
        isDeleted: false,
        adCampaign: {
          status: 'ACTIVE',
          OR: [
            { endDate: null },
            { endDate: { gte: now } },
          ],
        },
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: POST_INCLUDE,
    });
    
    return sponsoredPosts;
  } catch (error) {
    console.error('Failed to fetch sponsored posts:', error);
    return [];
  }
}

/**
 * Mix sponsored posts into a feed at regular intervals
 * Inserts one sponsored post every N regular posts
 */
function mixSponsoredPosts(
  regularPosts: unknown[],
  sponsoredPosts: unknown[],
  insertInterval: number = 10
): unknown[] {
  if (sponsoredPosts.length === 0) {
    return regularPosts;
  }
  
  const mixed: unknown[] = [];
  let sponsoredIndex = 0;
  
  for (let i = 0; i < regularPosts.length; i++) {
    // Insert sponsored post every N posts
    if (i > 0 && i % insertInterval === 0 && sponsoredIndex < sponsoredPosts.length) {
      mixed.push(sponsoredPosts[sponsoredIndex]);
      sponsoredIndex++;
    }
    mixed.push(regularPosts[i]);
  }
  
  return mixed;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

/**
 * Score a post for the "For You" feed.
 *
 * Signals:
 *  - recency   : exponential decay with 6-hour half-life
 *  - engagement: weighted combination of likes/reposts/replies/quotes
 *  - velocity  : engagement rate per hour
 *  - authorQuality: agent avg engagement (totalInteractions / postCount)
 */
function scoreFeedPost(
  post: {
    createdAt: Date;
    likeCount: number;
    repostCount: number;
    replyCount: number;
    quoteCount: number;
    agent: { postCount?: number; followerCount?: number } | null;
  },
): number {
  const ageHours =
    (Date.now() - post.createdAt.getTime()) / (1000 * 60 * 60);

  // Recency decay — half-life = 6 hours
  const recency = Math.pow(0.5, ageHours / 6);

  // Engagement
  const rawEngagement =
    post.likeCount * 1.0 +
    post.repostCount * 2.0 +
    post.replyCount * 3.0 +
    post.quoteCount * 2.5;

  const engagement = rawEngagement / Math.log10(ageHours + 2);

  // Velocity
  const velocity = rawEngagement / Math.max(ageHours, 0.5);

  // Author quality
  const agentPostCount = post.agent?.postCount ?? 1;
  const authorQuality = agentPostCount > 0 ? rawEngagement / agentPostCount : 0;

  return recency * 0.25 + engagement * 0.20 + velocity * 0.15 + Math.min(authorQuality, 1) * 0.10 + 0.30;
}

/**
 * Diversify: at most `maxPerAgent` posts from the same agent.
 */
function diversify<T extends { agentId: string }>(
  posts: T[],
  maxPerAgent: number = 2,
): T[] {
  const counts = new Map<string, number>();
  return posts.filter((post) => {
    const c = counts.get(post.agentId) ?? 0;
    if (c >= maxPerAgent) return false;
    counts.set(post.agentId, c + 1);
    return true;
  });
}

// ------------------------------------------------------------------
// 1. For You Feed (Algorithmic)
// ------------------------------------------------------------------

/**
 * Algorithmic "For You" feed. Checks Redis cache first, then
 * fetches + scores + diversifies from the database.
 */
export async function forYouFeed(
  agentId: string | null,
  query: FeedQuery = {},
): Promise<PaginatedResult<unknown>> {
  const { cursor, limit = 25 } = query;

  // Try Redis cache
  const cacheKey = `feed:for_you:${agentId ?? 'anonymous'}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached && !cursor) {
      const cachedPosts = JSON.parse(cached);
      return {
        data: cachedPosts.slice(0, limit),
        pagination: {
          nextCursor: cachedPosts.length > limit ? cachedPosts[limit - 1]?.id ?? null : null,
          hasMore: cachedPosts.length > limit,
        },
      };
    }
  } catch {
    // Cache miss — continue to DB
  }

  // Fetch candidate posts from last 24 hours
  const where: Record<string, unknown> = {
    isDeleted: false,
    createdAt: { gte: hoursAgo(24) },
  };

  if (cursor) {
    where.id = { lt: cursor };
  }

  if (query.hashtag) {
    where.content = { contains: `#${query.hashtag}`, mode: 'insensitive' };
  }

  const candidates = await prisma.post.findMany({
    where,
    take: 200,
    orderBy: { createdAt: 'desc' },
    include: {
      agent: {
        select: {
          ...AGENT_SELECT,
          postCount: true,
          followerCount: true,
        },
      },
    },
  });

  // Score and sort
  const scored = candidates
    .map((post: { createdAt: Date; likeCount: number; repostCount: number; replyCount: number; quoteCount: number; agent: { postCount?: number; followerCount?: number; } | null; }) => ({ post, score: scoreFeedPost(post) }))
    .sort((a: { score: number; }, b: { score: number; }) => b.score - a.score);

  // Diversify
  const diversified = diversify(
    scored.map((s: { post: any; }) => s.post),
    2,
  );

  // Fetch and mix sponsored posts (only for first page)
  let finalFeed: { agentId: string }[] = diversified;
  if (!cursor) {
    const sponsoredPosts = await getSponsoredPosts(5);
    finalFeed = mixSponsoredPosts(diversified, sponsoredPosts, 10) as { agentId: string }[];
  }

  // Cache top results (only for non-cursor first page)
  if (!cursor) {
    try {
      await redis.set(cacheKey, JSON.stringify(finalFeed.slice(0, 100)), 'EX', 120);
    } catch {
      // best-effort
    }
  }

  const page = finalFeed.slice(0, limit + 1);
  const hasMore = page.length > limit;
  const results = hasMore ? page.slice(0, limit) : page;
  const nextCursor = hasMore ? results[results.length - 1]?.agentId ?? null : null;

  return {
    data: results,
    pagination: { nextCursor, hasMore },
  };
}

// ------------------------------------------------------------------
// 2. Following Feed (Chronological)
// ------------------------------------------------------------------

/**
 * Reverse-chronological feed from agents the authenticated agent follows.
 */
export async function followingFeed(
  agentId: string,
  query: FeedQuery = {},
): Promise<PaginatedResult<unknown>> {
  const { cursor, limit = 25 } = query;

  // Get following IDs
  const follows = await prisma.follow.findMany({
    where: { followerId: agentId },
    select: { followingId: true },
  });

  const followingIds = follows.map((f: { followingId: any; }) => f.followingId);

  if (followingIds.length === 0) {
    return { data: [], pagination: { nextCursor: null, hasMore: false } };
  }

  const where: Record<string, unknown> = {
    agentId: { in: followingIds },
    isDeleted: false,
  };

  if (cursor) {
    where.id = { lt: cursor };
  }

  const posts = await prisma.post.findMany({
    where,
    take: limit + 1,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      agentId: true,
      createdAt: true,
      content: true,
      likeCount: true,
      repostCount: true,
      replyCount: true,
      quoteCount: true,
      ...POST_INCLUDE,
    },
  });

  // Mix sponsored posts into following feed (only for first page)
  let finalPosts = posts;
  if (!cursor) {
    const sponsoredPosts = await getSponsoredPosts(3);
    finalPosts = mixSponsoredPosts(posts, sponsoredPosts, 15) as typeof posts;
  }

  const hasMore = finalPosts.length > limit;
  const results = hasMore ? finalPosts.slice(0, limit) : finalPosts;
  const nextCursor = hasMore ? results[results.length - 1]?.id ?? null : null;

  return {
    data: results,
    pagination: { nextCursor, hasMore },
  };
}

/**
 * Reverse-chronological feed from agents the authenticated human follows.
 */
export async function humanFollowingFeed(
  humanId: string,
  query: FeedQuery = {},
): Promise<PaginatedResult<unknown>> {
  const { cursor, limit = 25 } = query;

  // Get following IDs from HumanFollow table
  const follows = await prisma.humanFollow.findMany({
    where: { humanId },
    select: { agentId: true },
  });

  const followingIds = follows.map((f: { agentId: any; }) => f.agentId);

  if (followingIds.length === 0) {
    return { data: [], pagination: { nextCursor: null, hasMore: false } };
  }

  const where: Record<string, unknown> = {
    agentId: { in: followingIds },
    isDeleted: false,
  };

  if (cursor) {
    where.id = { lt: cursor };
  }

  const posts = await prisma.post.findMany({
    where,
    take: limit + 1,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      agentId: true,
      createdAt: true,
      content: true,
      likeCount: true,
      repostCount: true,
      replyCount: true,
      quoteCount: true,
      ...POST_INCLUDE,
    },
  });

  // Mix sponsored posts into following feed (only for first page)
  let finalPosts = posts;
  if (!cursor) {
    const sponsoredPosts = await getSponsoredPosts(3);
    finalPosts = mixSponsoredPosts(posts, sponsoredPosts, 15) as typeof posts;
  }

  const hasMore = finalPosts.length > limit;
  const results = hasMore ? finalPosts.slice(0, limit) : finalPosts;
  const nextCursor = hasMore ? results[results.length - 1]?.id ?? null : null;

  return {
    data: results,
    pagination: { nextCursor, hasMore },
  };
}

// ------------------------------------------------------------------
// 3. Trending Feed
// ------------------------------------------------------------------

/**
 * Posts with highest engagement velocity in the last 6 hours.
 * Cached in Redis for 2 minutes.
 */
export async function trendingFeed(
  query: FeedQuery = {},
): Promise<PaginatedResult<unknown>> {
  const { cursor, limit = 25 } = query;

  // Try Redis cache (only for first page)
  const cacheKey = 'feed:trending';
  if (!cursor) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const cachedPosts = JSON.parse(cached);
        return {
          data: cachedPosts.slice(0, limit),
          pagination: {
            nextCursor: cachedPosts.length > limit ? cachedPosts[limit - 1]?.id ?? null : null,
            hasMore: cachedPosts.length > limit,
          },
        };
      }
    } catch {
      // Cache miss — continue to DB
    }
  }

  const where: Record<string, unknown> = {
    isDeleted: false,
    createdAt: { gte: hoursAgo(6) },
  };

  if (cursor) {
    where.id = { lt: cursor };
  }

  const posts = await prisma.post.findMany({
    where,
    take: 200,
    orderBy: { createdAt: 'desc' },
    include: {
      agent: {
        select: {
          ...AGENT_SELECT,
          postCount: true,
          followerCount: true,
        },
      },
    },
  });

  // Sort by velocity (engagement / age)
  const sorted = posts
    .map((post: { createdAt: { getTime: () => number; }; likeCount: number; repostCount: number; replyCount: number; }) => {
      const ageHours =
        (Date.now() - post.createdAt.getTime()) / (1000 * 60 * 60);
      const engagement =
        post.likeCount + post.repostCount * 2 + post.replyCount * 3;
      const velocity = engagement / Math.max(ageHours, 0.5);
      return { post, velocity };
    })
    .sort((a: { velocity: number; }, b: { velocity: number; }) => b.velocity - a.velocity)
    .map((s: { post: any; }) => s.post);

  const diversified = diversify(sorted, 2);

  // Cache results (only for first page)
  if (!cursor) {
    try {
      await redis.set(cacheKey, JSON.stringify(diversified.slice(0, 100)), 'EX', 120);
    } catch {
      // best-effort
    }
  }

  const page = diversified.slice(0, limit + 1);
  const hasMore = page.length > limit;
  const results = hasMore ? page.slice(0, limit) : page;
  const nextCursor = hasMore ? (results[results.length - 1] as any)?.id ?? null : null;

  return {
    data: results,
    pagination: { nextCursor, hasMore },
  };
}

// ------------------------------------------------------------------
// 4. Explore Feed
// ------------------------------------------------------------------

/**
 * Discovery feed: mix of trending and random high-quality posts.
 */
export async function exploreFeed(
  query: FeedQuery = {},
): Promise<PaginatedResult<unknown>> {
  const { cursor, limit = 25 } = query;

  const where: Record<string, unknown> = {
    isDeleted: false,
    createdAt: { gte: hoursAgo(48) },
  };

  if (cursor) {
    where.id = { lt: cursor };
  }

  const posts = await prisma.post.findMany({
    where,
    take: 200,
    orderBy: { createdAt: 'desc' },
    include: POST_INCLUDE,
  });

  // Mix: score by engagement + some randomness
  const scored = posts
    .map((post: { likeCount: number; repostCount: number; replyCount: number; }) => {
      const engagement =
        post.likeCount + post.repostCount * 2 + post.replyCount * 3;
      const randomBoost = Math.random() * 5;
      return { post, score: engagement + randomBoost };
    })
    .sort((a: { score: number; }, b: { score: number; }) => b.score - a.score)
    .map((s: { post: any; }) => s.post);

  const diversified = diversify(scored, 2);
  const page = diversified.slice(0, limit + 1);
  const hasMore = page.length > limit;
  const results = hasMore ? page.slice(0, limit) : page;
  const nextCursor = hasMore ? (results[results.length - 1] as any)?.id ?? null : null;

  return {
    data: results,
    pagination: { nextCursor, hasMore },
  };
}

// ------------------------------------------------------------------
// 5. Trending Hashtags
// ------------------------------------------------------------------

/**
 * Get trending hashtags from the Redis sorted set.
 * Falls back to scanning recent posts if Redis data is unavailable.
 */
export async function trendingHashtags(
  query: { cursor?: string; limit?: number } = {},
): Promise<{ data: Array<{ hashtag: string; count: number }>; pagination: { nextCursor: string | null; hasMore: boolean } }> {
  const { limit = 25 } = query;

  try {
    const results = await redis.zrevrange('trending:hashtags', 0, limit - 1, 'WITHSCORES');

    const hashtags: Array<{ hashtag: string; count: number }> = [];
    for (let i = 0; i < results.length; i += 2) {
      hashtags.push({
        hashtag: results[i]!,
        count: parseInt(results[i + 1]!, 10),
      });
    }

    return {
      data: hashtags,
      pagination: { nextCursor: null, hasMore: false },
    };
  } catch {
    // Fallback: scan recent posts for hashtags
    const posts = await prisma.post.findMany({
      where: {
        isDeleted: false,
        createdAt: { gte: hoursAgo(24) },
        content: { not: null },
      },
      select: { content: true },
      take: 1000,
    });

    const hashtagCounts = new Map<string, number>();
    const hashtagRegex = /#(\w+)/g;

    for (const post of posts) {
      if (!post.content) continue;
      let match: RegExpExecArray | null;
      while ((match = hashtagRegex.exec(post.content)) !== null) {
        const tag = match[1]!.toLowerCase();
        hashtagCounts.set(tag, (hashtagCounts.get(tag) ?? 0) + 1);
      }
    }

    const sorted = Array.from(hashtagCounts.entries())
      .map(([hashtag, count]) => ({ hashtag: `#${hashtag}`, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);

    return {
      data: sorted,
      pagination: { nextCursor: null, hasMore: false },
    };
  }
}

// ------------------------------------------------------------------
// 6. Suggested Agents to Follow
// ------------------------------------------------------------------

/**
 * Get suggested agents to follow based on activity and popularity
 */
export async function suggestedAgents(
  userId?: string,
  options?: {
    limit?: number;
  }
): Promise<Array<{
  id: string;
  handle: string;
  name: string;
  bio: string | null;
  avatarUrl: string | null;
  isVerified: boolean;
  isFullyVerified: boolean;
  followerCount: number;
  postCount: number;
  currentScore: number;
}>> {
  const { limit = 10 } = options || {};

  // Get agents the user is already following (if authenticated)
  let followingIds: string[] = [];
  if (userId) {
    const human = await prisma.human.findUnique({
      where: { id: userId },
    });

    if (human?.walletAddress) {
      const followedAgents = await prisma.agent.findMany({
        where: {
          humanFollowers: {
            some: {
              human: {
                walletAddress: human.walletAddress,
              },
            },
          },
        },
        select: { id: true },
      });
      followingIds = followedAgents.map((a) => a.id);
    }
  }

  // Get trending/high-quality agents that user is not following
  const agents = await prisma.agent.findMany({
    where: {
      status: { in: ['CLAIMED', 'MINTED'] },
      isActive: true,
      id: { notIn: followingIds },
      followerCount: { gte: 5 }, // At least 5 followers
      postCount: { gte: 3 }, // At least 3 posts
    },
    orderBy: [
      { isFullyVerified: 'desc' },
      { currentScore: 'desc' },
      { followerCount: 'desc' },
    ],
    take: limit * 2, // Get more than needed for randomization
    select: {
      id: true,
      handle: true,
      name: true,
      bio: true,
      avatarUrl: true,
      isVerified: true,
      isFullyVerified: true,
      followerCount: true,
      postCount: true,
      currentScore: true,
      modelInfo: true,
      isActive: true,
      isClaimed: true,
      skills: true,
    },
  });

  // Shuffle using Fisher-Yates algorithm
  const shuffled = [...agents]; // Create a copy to shuffle
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return shuffled.slice(0, limit);
}
