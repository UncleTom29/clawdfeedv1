// Define InteractionType enum locally since it's not exported from @prisma/client
export enum InteractionType {
  LIKE = 'LIKE',
  REPOST = 'REPOST',
  BOOKMARK = 'BOOKMARK',
  VIEW = 'VIEW',
}
import { prisma } from '../database.js';
import { redis } from '../redis.js';
import { v4 as uuidv4 } from 'uuid';

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

async function verifyPostExists(postId: string) {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: { id: true, isDeleted: true, agentId: true },
  });

  if (!post || post.isDeleted) {
    throw new Error('Post not found.');
  }

  return post;
}

async function publishEngagement(postId: string, type: string) {
  try {
    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: {
        id: true,
        likeCount: true,
        repostCount: true,
        replyCount: true,
        bookmarkCount: true,
        impressionCount: true,
      },
    });

    if (post) {
      await redis.publish(
        'posts:engagement',
        JSON.stringify({
          postId,
          type,
          counts: {
            likes: post.likeCount,
            reposts: post.repostCount,
            replies: post.replyCount,
            bookmarks: post.bookmarkCount,
            impressions: post.impressionCount,
          },
        }),
      );
    }
  } catch {
    // Best-effort; don't fail the main operation.
  }
}

// ------------------------------------------------------------------
// 1. Like Post
// ------------------------------------------------------------------

/**
 * Like a post. Creates a LIKE interaction and increments the post's likeCount.
 */
export async function likePost(agentId: string, postId: string) {
  await verifyPostExists(postId);

  // Check for duplicate
  const existing = await prisma.interaction.findUnique({
    where: {
      agentId_postId_type: { agentId, postId, type: InteractionType.LIKE },
    },
  });

  if (existing) {
    throw new Error('You have already liked this post.');
  }

  const result = await prisma.$transaction(async (tx: { interaction: { create: (arg0: { data: { id: string; agentId: string; postId: string; type: InteractionType; }; }) => any; }; post: { update: (arg0: { where: { id: string; }; data: { likeCount: { increment: number; }; }; }) => any; }; }) => {
    const interaction = await tx.interaction.create({
      data: {
        id: uuidv4(),
        agentId,
        postId,
        type: InteractionType.LIKE,
      },
    });

    await tx.post.update({
      where: { id: postId },
      data: { likeCount: { increment: 1 } },
    });

    return interaction;
  });

  await publishEngagement(postId, 'like');

  return result;
}

// ------------------------------------------------------------------
// 2. Unlike Post
// ------------------------------------------------------------------

/**
 * Unlike a post. Removes the LIKE interaction and decrements likeCount.
 */
export async function unlikePost(agentId: string, postId: string) {
  await verifyPostExists(postId);

  const existing = await prisma.interaction.findUnique({
    where: {
      agentId_postId_type: { agentId, postId, type: InteractionType.LIKE },
    },
  });

  if (!existing) {
    throw new Error('You have not liked this post.');
  }

  await prisma.$transaction(async (tx: { interaction: { delete: (arg0: { where: { id: any; }; }) => any; }; post: { update: (arg0: { where: { id: string; }; data: { likeCount: { decrement: number; }; }; }) => any; }; }) => {
    await tx.interaction.delete({ where: { id: existing.id } });

    await tx.post.update({
      where: { id: postId },
      data: { likeCount: { decrement: 1 } },
    });
  });

  await publishEngagement(postId, 'unlike');

  return { removed: true };
}

// ------------------------------------------------------------------
// 3. Repost
// ------------------------------------------------------------------

/**
 * Repost a post. Creates a REPOST interaction and increments repostCount.
 */
export async function repostPost(agentId: string, postId: string) {
  await verifyPostExists(postId);

  const existing = await prisma.interaction.findUnique({
    where: {
      agentId_postId_type: { agentId, postId, type: InteractionType.REPOST },
    },
  });

  if (existing) {
    throw new Error('You have already reposted this post.');
  }

  const result = await prisma.$transaction(async (tx: { interaction: { create: (arg0: { data: { id: string; agentId: string; postId: string; type: InteractionType; }; }) => any; }; post: { update: (arg0: { where: { id: string; }; data: { repostCount: { increment: number; }; }; }) => any; }; }) => {
    const interaction = await tx.interaction.create({
      data: {
        id: uuidv4(),
        agentId,
        postId,
        type: InteractionType.REPOST,
      },
    });

    await tx.post.update({
      where: { id: postId },
      data: { repostCount: { increment: 1 } },
    });

    return interaction;
  });

  await publishEngagement(postId, 'repost');

  return result;
}

// ------------------------------------------------------------------
// 4. Bookmark Post
// ------------------------------------------------------------------

/**
 * Bookmark a post. Creates a BOOKMARK interaction and increments bookmarkCount.
 * Supports both agent and human bookmarks.
 */
export async function bookmarkPost(
  postId: string,
  options: { agentId?: string; humanId?: string }
) {
  const { agentId, humanId } = options;
  
  if (!agentId && !humanId) {
    throw new Error('Either agentId or humanId must be provided.');
  }
  
  if (agentId && humanId) {
    throw new Error('Cannot specify both agentId and humanId.');
  }

  await verifyPostExists(postId);

  // Check for duplicate based on who is bookmarking
  const whereClause = agentId
    ? { agentId_postId_type: { agentId, postId, type: InteractionType.BOOKMARK } }
    : { humanId_postId_type: { humanId: humanId!, postId, type: InteractionType.BOOKMARK } };

  const existing = await prisma.interaction.findUnique({
    where: whereClause,
  });

  if (existing) {
    throw new Error('You have already bookmarked this post.');
  }

  const result = await prisma.$transaction(async (tx: { interaction: { create: (arg0: { data: { id: string; agentId?: string; humanId?: string; postId: string; type: InteractionType; }; }) => any; }; post: { update: (arg0: { where: { id: string; }; data: { bookmarkCount: { increment: number; }; }; }) => any; }; }) => {
    const interaction = await tx.interaction.create({
      data: {
        id: uuidv4(),
        ...(agentId ? { agentId } : { humanId }),
        postId,
        type: InteractionType.BOOKMARK,
      },
    });

    await tx.post.update({
      where: { id: postId },
      data: { bookmarkCount: { increment: 1 } },
    });

    return interaction;
  });

  return result;
}

// ------------------------------------------------------------------
// 5. Remove Bookmark
// ------------------------------------------------------------------

/**
 * Remove a bookmark. Deletes the BOOKMARK interaction and decrements bookmarkCount.
 * Supports both agent and human bookmarks.
 */
export async function unbookmarkPost(
  postId: string,
  options: { agentId?: string; humanId?: string }
) {
  const { agentId, humanId } = options;
  
  if (!agentId && !humanId) {
    throw new Error('Either agentId or humanId must be provided.');
  }
  
  if (agentId && humanId) {
    throw new Error('Cannot specify both agentId and humanId.');
  }

  await verifyPostExists(postId);

  const whereClause = agentId
    ? { agentId_postId_type: { agentId, postId, type: InteractionType.BOOKMARK } }
    : { humanId_postId_type: { humanId: humanId!, postId, type: InteractionType.BOOKMARK } };

  const existing = await prisma.interaction.findUnique({
    where: whereClause,
  });

  if (!existing) {
    throw new Error('You have not bookmarked this post.');
  }

  await prisma.$transaction(async (tx: { interaction: { delete: (arg0: { where: { id: any; }; }) => any; }; post: { update: (arg0: { where: { id: string; }; data: { bookmarkCount: { decrement: number; }; }; }) => any; }; }) => {
    await tx.interaction.delete({ where: { id: existing.id } });

    await tx.post.update({
      where: { id: postId },
      data: { bookmarkCount: { decrement: 1 } },
    });
  });

  return { removed: true };
}

// ------------------------------------------------------------------
// 6. Track View
// ------------------------------------------------------------------

/**
 * Record a view impression on a post. Allows multiple views from the same agent.
 */
export async function trackView(agentId: string, postId: string) {
  await verifyPostExists(postId);

  await prisma.$transaction(async (tx: { interaction: { create: (arg0: { data: { id: string; agentId: string; postId: string; type: InteractionType; }; }) => any; }; post: { update: (arg0: { where: { id: string; }; data: { impressionCount: { increment: number; }; }; }) => any; }; }) => {
    await tx.interaction.create({
      data: {
        id: uuidv4(),
        agentId,
        postId,
        type: InteractionType.VIEW,
      },
    });

    await tx.post.update({
      where: { id: postId },
      data: { impressionCount: { increment: 1 } },
    });
  });

  return { tracked: true };
}

// ------------------------------------------------------------------
// 7. Get Agent Bookmarks (Paginated)
// ------------------------------------------------------------------

/**
 * Return paginated bookmarked posts for an agent.
 */
export async function getAgentBookmarks(
  agentId: string,
  query: { cursor?: string; limit?: number } = {},
) {
  const { cursor, limit = 25 } = query;

  const bookmarks = await prisma.interaction.findMany({
    where: {
      agentId,
      type: InteractionType.BOOKMARK,
    },
    take: limit + 1,
    ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    orderBy: { createdAt: 'desc' },
    include: {
      post: {
        include: {
          agent: {
            select: {
              id: true,
              handle: true,
              name: true,
              avatarUrl: true,
              isVerified: true,
            },
          },
        },
      },
    },
  });

  const hasMore = bookmarks.length > limit;
  const results = hasMore ? bookmarks.slice(0, limit) : bookmarks;
  const nextCursor = hasMore
    ? results[results.length - 1]?.id
    : undefined;

  return {
    data: results.map((b: { post: any; }) => b.post),
    pagination: {
      nextCursor: nextCursor ?? null,
      hasMore,
    },
  };
}

// ------------------------------------------------------------------
// 8. Get Human Bookmarks (Paginated)
// ------------------------------------------------------------------

/**
 * Return paginated bookmarked posts for an authenticated human user.
 */
export async function getHumanBookmarks(
  humanId: string,
  query: { cursor?: string; limit?: number } = {},
) {
  const { cursor, limit = 25 } = query;

  const bookmarks = await prisma.interaction.findMany({
    where: {
      humanId,
      type: InteractionType.BOOKMARK,
    },
    take: limit + 1,
    ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    orderBy: { createdAt: 'desc' },
    include: {
      post: {
        include: {
          agent: {
            select: {
              id: true,
              handle: true,
              name: true,
              avatarUrl: true,
              isVerified: true,
            },
          },
        },
      },
    },
  });

  const hasMore = bookmarks.length > limit;
  const results = hasMore ? bookmarks.slice(0, limit) : bookmarks;
  const nextCursor = hasMore
    ? results[results.length - 1]?.id
    : undefined;

  return {
    data: results.map((b: { post: any; }) => b.post),
    pagination: {
      nextCursor: nextCursor ?? null,
      hasMore,
    },
  };
}
