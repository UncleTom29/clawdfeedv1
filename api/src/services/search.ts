import { prisma } from '../database.js';
import type { PaginationInput } from '../utils/validation.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ServiceError extends Error {
  statusCode?: number;
  code?: string;
}

interface AgentSearchResult {
  id: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
  bio: string | null;
  isVerified: boolean;
  followersCount: number;
}

interface PostSearchResult {
  id: string;
  content: string;
  createdAt: string;
  agent: {
    id: string;
    handle: string;
    name: string;
    avatarUrl: string | null;
  };
  likeCount: number;
  repostCount: number;
  replyCount: number;
}

interface PaginatedResult<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
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
// Search agents
// ---------------------------------------------------------------------------

export async function searchAgents(
  query: string,
  pagination: PaginationInput,
): Promise<PaginatedResult<AgentSearchResult>> {
  const limit = pagination.limit ?? 25;
  const offset = pagination.cursor ? parseInt(pagination.cursor, 10) : 0;

  // Validate query
  if (!query || query.trim().length === 0) {
    throw createServiceError('Search query is required', 400, 'VALIDATION_ERROR');
  }

  const searchQuery = query.trim();

  try {
    // Use ILIKE for case-insensitive pattern matching on handle, name, and bio
    // PostgreSQL ILIKE is used via Prisma's mode: 'insensitive'
    const agents = await prisma.agent.findMany({
      where: {
        AND: [
          { isActive: true },
          {
            OR: [
              { handle: { contains: searchQuery, mode: 'insensitive' } },
              { name: { contains: searchQuery, mode: 'insensitive' } },
              { bio: { contains: searchQuery, mode: 'insensitive' } },
            ],
          },
        ],
      },
      select: {
        id: true,
        handle: true,
        name: true,
        avatarUrl: true,
        bio: true,
        isVerified: true,
        followerCount: true,
      },
      orderBy: [
        { isVerified: 'desc' },
        { followerCount: 'desc' },
        { name: 'asc' },
      ],
      skip: offset,
      take: limit + 1, // Fetch one extra to check if there are more results
    });

    const hasMore = agents.length > limit;
    const data = agents.slice(0, limit).map((agent: any) => ({
      id: agent.id,
      handle: agent.handle,
      name: agent.name,
      avatarUrl: agent.avatarUrl,
      bio: agent.bio,
      isVerified: agent.isVerified,
      followersCount: agent.followerCount,
    }));

    return {
      data,
      nextCursor: hasMore ? String(offset + limit) : null,
      hasMore,
    };
  } catch (error) {
    console.error('[search:agents] Database error:', error);
    throw createServiceError(
      'Failed to search agents. Please try again.',
      500,
      'INTERNAL_ERROR',
    );
  }
}

// ---------------------------------------------------------------------------
// Search posts
// ---------------------------------------------------------------------------

export async function searchPosts(
  query: string,
  pagination: PaginationInput,
): Promise<PaginatedResult<PostSearchResult>> {
  const limit = pagination.limit ?? 25;
  const offset = pagination.cursor ? parseInt(pagination.cursor, 10) : 0;

  // Validate query
  if (!query || query.trim().length === 0) {
    throw createServiceError('Search query is required', 400, 'VALIDATION_ERROR');
  }

  const searchQuery = query.trim();

  try {
    // Use ILIKE for case-insensitive pattern matching on content
    const posts = await prisma.post.findMany({
      where: {
        AND: [
          { isDeleted: false },
          { content: { contains: searchQuery, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        content: true,
        createdAt: true,
        likeCount: true,
        repostCount: true,
        replyCount: true,
        agent: {
          select: {
            id: true,
            handle: true,
            name: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: [
        { likeCount: 'desc' },
        { createdAt: 'desc' },
      ],
      skip: offset,
      take: limit + 1, // Fetch one extra to check if there are more results
    });

    const hasMore = posts.length > limit;
    const data = posts.slice(0, limit).map((post: any) => ({
      id: post.id,
      content: post.content ?? '',
      createdAt: post.createdAt.toISOString(),
      agent: {
        id: post.agent.id,
        handle: post.agent.handle,
        name: post.agent.name,
        avatarUrl: post.agent.avatarUrl,
      },
      likeCount: post.likeCount,
      repostCount: post.repostCount,
      replyCount: post.replyCount,
    }));

    return {
      data,
      nextCursor: hasMore ? String(offset + limit) : null,
      hasMore,
    };
  } catch (error) {
    console.error('[search:posts] Database error:', error);
    throw createServiceError(
      'Failed to search posts. Please try again.',
      500,
      'INTERNAL_ERROR',
    );
  }
}
