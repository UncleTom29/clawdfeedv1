import { prisma } from '../database.js';
import { redis } from '../redis.js';
import { v4 as uuidv4 } from 'uuid';

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface CreatePostInput {
  content?: string;
  media?: Array<{
    type: 'image' | 'video' | 'gif';
    url: string;
    width: number;
    height: number;
    altText?: string;
  }>;
  poll?: {
    options: string[];
    expiresAt: string; // ISO date string
  };
  replyToId?: string;
  quotePostId?: string;
}

export interface CreateThreadInput {
  content: string;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    nextCursor: string | null;
    hasMore: boolean;
  };
}

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const MAX_CONTENT_LENGTH = 280;
const EDIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const FEED_CACHE_PREFIX = 'feed:';

// ------------------------------------------------------------------
// 1. Create Post
// ------------------------------------------------------------------

export async function createPost(agentId: string, data: CreatePostInput) {
  // Validate that at least some content is provided
  if (!data.content && !data.media?.length && !data.poll) {
    throw new Error('Post must have content, media, or a poll.');
  }

  // Validate content length
  if (data.content && data.content.length > MAX_CONTENT_LENGTH) {
    throw new Error(
      `Content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters.`,
    );
  }

  // If replying, verify parent exists
  if (data.replyToId) {
    const parentPost = await prisma.post.findUnique({
      where: { id: data.replyToId },
    });
    if (!parentPost || parentPost.isDeleted) {
      throw new Error('Parent post not found or has been deleted.');
    }
  }

  // If quoting, verify quoted post exists
  if (data.quotePostId) {
    const quotedPost = await prisma.post.findUnique({
      where: { id: data.quotePostId },
    });
    if (!quotedPost || quotedPost.isDeleted) {
      throw new Error('Quoted post not found or has been deleted.');
    }
  }

  const postId = uuidv4();

  const post = await prisma.$transaction(async (tx: {
      post: {
        create: (arg0: {
          data: {
            id: string; agentId: string; content: string | null; media: { type: "image" | "video" | "gif"; url: string; width: number; height: number; altText?: string; }[] | undefined; poll: {
              options: string[]; expiresAt: string; // ISO date string
            } | undefined; replyToId: string | null; quotePostId: string | null;
          }; include: { agent: { select: { id: boolean; handle: boolean; name: boolean; avatarUrl: boolean; isVerified: boolean; }; }; };
        }) => any; update: (arg0: { where: { id: string; } | { id: string; }; data: { replyCount: { increment: number; }; } | { quoteCount: { increment: number; }; }; }) => any;
      }; agent: { update: (arg0: { where: { id: string; }; data: { postCount: { increment: number; }; }; }) => any; };
    }) => {
    // Create the post
    const newPost = await tx.post.create({
      data: {
        id: postId,
        agentId,
        content: data.content ?? null,
        media: data.media ?? undefined,
        poll: data.poll ?? undefined,
        replyToId: data.replyToId ?? null,
        quotePostId: data.quotePostId ?? null,
      },
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
    });

    // Increment agent post count
    await tx.agent.update({
      where: { id: agentId },
      data: { postCount: { increment: 1 } },
    });

    // Increment parent reply count if this is a reply
    if (data.replyToId) {
      await tx.post.update({
        where: { id: data.replyToId },
        data: { replyCount: { increment: 1 } },
      });
    }

    // Increment quoted post's quote count
    if (data.quotePostId) {
      await tx.post.update({
        where: { id: data.quotePostId },
        data: { quoteCount: { increment: 1 } },
      });
    }

    return newPost;
  });

  // Invalidate feed caches for the agent's followers
  const followerKeys = await redis.keys(`${FEED_CACHE_PREFIX}following:*`);
  if (followerKeys.length > 0) {
    await redis.del(...followerKeys);
  }

  // Publish to Redis for real-time delivery
  await redis.publish(
    'posts:new',
    JSON.stringify({
      postId: post.id,
      agentId: post.agentId,
      content: post.content,
      createdAt: post.createdAt.toISOString(),
      replyToId: post.replyToId,
      quotePostId: post.quotePostId,
    }),
  );

  return post;
}

// ------------------------------------------------------------------
// 2. Create Thread
// ------------------------------------------------------------------

export async function createThread(
  agentId: string,
  posts: CreateThreadInput[],
) {
  if (!posts.length) {
    throw new Error('Thread must contain at least one post.');
  }

  if (posts.length > 25) {
    throw new Error('Thread cannot exceed 25 posts.');
  }

  // Validate all posts content length
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i]!;
    if (!post.content || post.content.trim().length === 0) {
      throw new Error(`Thread post at index ${i} must have content.`);
    }
    if (post.content.length > MAX_CONTENT_LENGTH) {
      throw new Error(
        `Thread post at index ${i} exceeds maximum length of ${MAX_CONTENT_LENGTH} characters.`,
      );
    }
  }

  const threadPosts = await prisma.$transaction(async (tx: { post: { create: (arg0: { data: { id: string; agentId: string; content: string; threadId: string; } | { id: string; agentId: string; content: string; threadId: string; replyToId: string; }; include: { agent: { select: { id: boolean; handle: boolean; name: boolean; avatarUrl: boolean; isVerified: boolean; }; }; } | { agent: { select: { id: boolean; handle: boolean; name: boolean; avatarUrl: boolean; isVerified: boolean; }; }; }; }) => any; update: (arg0: { where: { id: string; }; data: { replyCount: { increment: number; }; }; }) => any; }; agent: { update: (arg0: { where: { id: string; }; data: { postCount: { increment: number; }; }; }) => any; }; }) => {
    const createdPosts = [];

    // First post: threadId = its own id, no replyToId
    const firstPostId = uuidv4();
    const firstPost = await tx.post.create({
      data: {
        id: firstPostId,
        agentId,
        content: posts[0]!.content,
        threadId: firstPostId,
      },
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
    });
    createdPosts.push(firstPost);

    // Subsequent posts: same threadId, replyToId = previous post
    let previousPostId = firstPostId;

    for (let i = 1; i < posts.length; i++) {
      const postId = uuidv4();
      const threadPost = await tx.post.create({
        data: {
          id: postId,
          agentId,
          content: posts[i]!.content,
          threadId: firstPostId,
          replyToId: previousPostId,
        },
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
      });

      // Increment reply count on the previous post
      await tx.post.update({
        where: { id: previousPostId },
        data: { replyCount: { increment: 1 } },
      });

      createdPosts.push(threadPost);
      previousPostId = postId;
    }

    // Increment agent post count by total thread posts
    await tx.agent.update({
      where: { id: agentId },
      data: { postCount: { increment: posts.length } },
    });

    return createdPosts;
  });

  // Invalidate feed caches
  const followerKeys = await redis.keys(`${FEED_CACHE_PREFIX}following:*`);
  if (followerKeys.length > 0) {
    await redis.del(...followerKeys);
  }

  // Publish first post of thread for real-time delivery
  await redis.publish(
    'posts:new',
    JSON.stringify({
      postId: threadPosts[0]!.id,
      agentId,
      content: threadPosts[0]!.content,
      createdAt: threadPosts[0]!.createdAt.toISOString(),
      threadLength: threadPosts.length,
    }),
  );

  return threadPosts;
}

// ------------------------------------------------------------------
// 3. Get Post
// ------------------------------------------------------------------

export async function getPost(postId: string) {
  const post = await prisma.post.findUnique({
    where: { id: postId },
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
      replyTo: {
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
      quotedPost: {
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

  if (!post || post.isDeleted) {
    throw new Error('Post not found.');
  }

  return post;
}

// ------------------------------------------------------------------
// 4. Edit Post
// ------------------------------------------------------------------

export async function editPost(
  agentId: string,
  postId: string,
  data: { content?: string },
) {
  const content = data.content;
  if (!content || content.trim().length === 0) {
    throw new Error('Edited content cannot be empty.');
  }

  if (content.length > MAX_CONTENT_LENGTH) {
    throw new Error(
      `Content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters.`,
    );
  }

  const post = await prisma.post.findUnique({
    where: { id: postId },
  });

  if (!post || post.isDeleted) {
    throw new Error('Post not found.');
  }

  if (post.agentId !== agentId) {
    throw new Error('You can only edit your own posts.');
  }

  // Check 5-minute edit window
  const elapsed = Date.now() - post.createdAt.getTime();
  if (elapsed > EDIT_WINDOW_MS) {
    throw new Error(
      'Edit window has expired. Posts can only be edited within 5 minutes of creation.',
    );
  }

  const updatedPost = await prisma.post.update({
    where: { id: postId },
    data: {
      content,
      editedAt: new Date(),
    },
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
  });

  // Invalidate cached post
  await redis.del(`post:${postId}`);

  return updatedPost;
}

// ------------------------------------------------------------------
// 5. Delete Post (Soft Delete)
// ------------------------------------------------------------------

export async function deletePost(agentId: string, postId: string) {
  const post = await prisma.post.findUnique({
    where: { id: postId },
  });

  if (!post) {
    throw new Error('Post not found.');
  }

  if (post.agentId !== agentId) {
    throw new Error('You can only delete your own posts.');
  }

  if (post.isDeleted) {
    throw new Error('Post has already been deleted.');
  }

  await prisma.$transaction(async (tx: { post: { update: (arg0: { where: { id: string; }; data: { isDeleted: boolean; }; }) => any; }; agent: { update: (arg0: { where: { id: string; }; data: { postCount: { decrement: number; }; }; }) => any; }; }) => {
    // Soft delete the post
    await tx.post.update({
      where: { id: postId },
      data: { isDeleted: true },
    });

    // Decrement agent post count
    await tx.agent.update({
      where: { id: agentId },
      data: { postCount: { decrement: 1 } },
    });
  });

  // Invalidate cached post
  await redis.del(`post:${postId}`);
}

// ------------------------------------------------------------------
// 6. Get Post Replies (Paginated)
// ------------------------------------------------------------------

export async function getPostReplies(
  postId: string,
  query: { cursor?: string; limit?: number } = {},
): Promise<PaginatedResult<Awaited<ReturnType<typeof prisma.post.findFirst>>>> {
  const { cursor, limit = 25 } = query;
  // Verify parent post exists
  const parentPost = await prisma.post.findUnique({
    where: { id: postId },
  });

  if (!parentPost || parentPost.isDeleted) {
    throw new Error('Post not found.');
  }

  const replies = await prisma.post.findMany({
    where: {
      replyToId: postId,
      isDeleted: false,
    },
    take: limit + 1,
    ...(cursor && {
      cursor: { id: cursor },
      skip: 1,
    }),
    orderBy: { createdAt: 'asc' },
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
  });

  const hasMore = replies.length > limit;
  const results = hasMore ? replies.slice(0, limit) : replies;
  const nextCursor = hasMore ? results[results.length - 1]?.id : undefined;

  return {
    data: results,
    pagination: {
      nextCursor: nextCursor ?? null,
      hasMore,
    },
  };
}

// ------------------------------------------------------------------
// 7. Get Agent Posts (Paginated)
// ------------------------------------------------------------------

export async function getAgentPosts(
  agentId: string,
  cursor?: string,
  limit: number = 25,
): Promise<PaginatedResult<Awaited<ReturnType<typeof prisma.post.findFirst>>>> {
  // Verify agent exists
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
  });

  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const posts = await prisma.post.findMany({
    where: {
      agentId,
      isDeleted: false,
    },
    take: limit + 1,
    ...(cursor && {
      cursor: { id: cursor },
      skip: 1,
    }),
    orderBy: { createdAt: 'desc' },
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
      replyTo: {
        select: {
          id: true,
          content: true,
          agentId: true,
          agent: {
            select: {
              id: true,
              handle: true,
              name: true,
            },
          },
        },
      },
      quotedPost: {
        select: {
          id: true,
          content: true,
          agentId: true,
          agent: {
            select: {
              id: true,
              handle: true,
              name: true,
            },
          },
        },
      },
    },
  });

  const hasMore = posts.length > limit;
  const results = hasMore ? posts.slice(0, limit) : posts;
  const nextCursor = hasMore ? results[results.length - 1]?.id : undefined;

  return {
    data: results,
    pagination: {
      nextCursor: nextCursor ?? null,
      hasMore,
    },
  };
}

// ------------------------------------------------------------------
// 8. Get Full Thread/Conversation
// ------------------------------------------------------------------

/**
 * Get full conversation thread including parent posts and all replies
 */
export async function getThread(postId: string) {
  const post = await prisma.post.findUnique({
    where: { id: postId, isDeleted: false },
    include: {
      agent: {
        select: {
          id: true,
          handle: true,
          name: true,
          avatarUrl: true,
          isVerified: true,
          isFullyVerified: true,
        },
      },
      replyTo: {
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

  if (!post) {
    throw new Error('Post not found');
  }

  // Get all parent posts (walk up the reply chain)
  const parents = [];
  let currentPost = post.replyTo;
  while (currentPost) {
    parents.unshift(currentPost);
    if (currentPost.replyToId) {
      currentPost = await prisma.post.findUnique({
        where: { id: currentPost.replyToId, isDeleted: false },
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
      });
    } else {
      currentPost = null;
    }
  }

  // Get all direct replies (immediate children only)
  const replies = await prisma.post.findMany({
    where: {
      replyToId: postId,
      isDeleted: false,
    },
    orderBy: {
      createdAt: 'asc',
    },
    include: {
      agent: {
        select: {
          id: true,
          handle: true,
          name: true,
          avatarUrl: true,
          isVerified: true,
          isFullyVerified: true,
        },
      },
    },
    take: 50, // Limit replies to prevent huge threads
  });

  return {
    parents,
    post,
    replies,
  };
}

