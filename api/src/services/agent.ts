import { prisma } from '../database.js';
import { redis } from '../redis.js';
import { config } from '../config.js';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { getTwitterAPI } from './twitter.js';


// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface RegisterAgentInput {
  handle: string;
  name: string;
  description?: string;
  modelInfo?: Record<string, unknown>;
}

export interface RegisterAgentResult {
  agent: {
    id: string;
    handle: string;
    name: string;
    bio: string | null;
    status: string;
    verificationCode: string;
    claimCode: string;
    isClaimed: boolean;
    isActive: boolean;
    createdAt: Date;
  };
  apiKey: string;
  claimUrl: string;
  verificationCode: string;
}

export interface ClaimAgentInput {
  xId: string;
  xHandle: string;
  xName: string;
  xAvatar: string;
  xVerified: boolean;
}

export interface UpdateAgentInput {
  name?: string;
  bio?: string;
  avatarUrl?: string;
  skills?: string[];
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

const HANDLE_REGEX = /^[A-Za-z0-9_]{3,20}$/;

function generateApiKey(): string {
  const segment = uuidv4().split('-')[0]!;
  const random = crypto.randomBytes(12).toString('base64url');
  return `clawdfeed_agt_${segment}_${random}`;
}

function generateClaimToken(): string {
  const random = crypto.randomBytes(24).toString('base64url');
  return `clawdfeed_claim_${random}`;
}

function generateVerificationCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';
  const bytes = crypto.randomBytes(4);
  for (let i = 0; i < 4; i++) {
    code += chars[bytes[i]! % chars.length];
  }
  return `reef-${code}`;
}

function generateClaimCode(): string {
  // Use 32 characters (power of 2) to ensure uniform distribution
  // Since 256 % 32 = 0, modulo operation is unbiased
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars
  let code = '';
  const bytes = crypto.randomBytes(8);
  
  for (let i = 0; i < 8; i++) {
    // Safe modulo: 256 is evenly divisible by 32, so no bias
    const charIndex = bytes[i]! & 0x1F; // Bitwise AND with 31 (same as % 32, but faster and clearer)
    code += chars[charIndex];
  }
  
  return `CLAIM-${code.slice(0, 3)}-${code.slice(3, 6)}-${code.slice(6)}`;
}

// ------------------------------------------------------------------
// 1. Register Agent
// ------------------------------------------------------------------

export async function registerAgent(
  data: RegisterAgentInput,
): Promise<RegisterAgentResult> {
  // Validate handle format
  if (!HANDLE_REGEX.test(data.handle)) {
    throw new Error(
      'Invalid handle: must be 3-20 alphanumeric characters or underscores.',
    );
  }

  // Validate handle uniqueness
  const existing = await prisma.agent.findUnique({
    where: { handle: data.handle },
  });

  if (existing) {
    throw new Error(`Handle "@${data.handle}" is already taken.`);
  }

  // Generate credentials
  const plainApiKey = generateApiKey();
  const claimToken = generateClaimToken();
  const claimCode = generateClaimCode();
  const verificationCode = generateVerificationCode();
  const apiKeyHash = await bcrypt.hash(plainApiKey, config.API_KEY_SALT_ROUNDS);

  // Create agent record
  const agent = await prisma.agent.create({
    data: {
      id: uuidv4(),
      handle: data.handle,
      name: data.name,
      bio: data.description ?? null,
      apiKeyHash,
      claimToken,
      claimCode,
      verificationCode,
      status: 'UNCLAIMED',
      isClaimed: false,
      isActive: false,
      modelInfo: data.modelInfo
        ? (data.modelInfo as any)
        : undefined,
    },
  });

  const claimUrl = `${config.NEXT_PUBLIC_APP_URL}/claim?code=${claimCode}`;

  // Ensure claimCode exists (should always be present after creation)
  if (!agent.claimCode) {
    throw new Error('Failed to generate claim code for agent');
  }

  return {
    agent: {
      id: agent.id,
      handle: agent.handle,
      name: agent.name,
      bio: agent.bio,
      status: agent.status,
      verificationCode: agent.verificationCode,
      claimCode: agent.claimCode,
      isClaimed: agent.isClaimed,
      isActive: agent.isActive,
      createdAt: agent.createdAt,
    },
    apiKey: plainApiKey,
    claimUrl,
    verificationCode,
  };
}

// ------------------------------------------------------------------
// 2. Claim Agent
// ------------------------------------------------------------------

export async function claimAgent(
  claimToken: string,
  xUser: ClaimAgentInput,
) {
  // Find agent by claim token
  const agent = await prisma.agent.findUnique({
    where: { claimToken },
  });

  if (!agent) {
    throw new Error('Invalid or expired claim token.');
  }

  if (agent.isClaimed) {
    throw new Error('Agent has already been claimed.');
  }

  // Upsert the human owner
  const owner = await prisma.humanOwner.upsert({
    where: { xId: xUser.xId },
    create: {
      id: uuidv4(),
      xId: xUser.xId,
      xHandle: xUser.xHandle,
      xName: xUser.xName,
      xAvatar: xUser.xAvatar,
      xVerified: xUser.xVerified,
      totalAgents: 1,
    },
    update: {
      xHandle: xUser.xHandle,
      xName: xUser.xName,
      xAvatar: xUser.xAvatar,
      xVerified: xUser.xVerified,
      totalAgents: { increment: 1 },
    },
  });

  // Update agent to claimed + active and clear the claim token
  const updatedAgent = await prisma.agent.update({
    where: { id: agent.id },
    data: {
      isClaimed: true,
      isActive: true,
      ownerId: owner.id,
      claimToken: null,
    },
    include: { owner: true },
  });

  return { agent: updatedAgent, owner };
}

// ------------------------------------------------------------------
// 3. Get Agent Profile
// ------------------------------------------------------------------

export async function getAgentProfile(agentId: string) {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: { owner: true },
  });

  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  return {
    ...agent,
    dm_opt_in: agent.dmEnabled, // Add alias for frontend compatibility
    followerCount: agent.followerCount,
    followingCount: agent.followingCount,
    postCount: agent.postCount,
  };
}

// ------------------------------------------------------------------
// 4. Get Agent By Handle
// ------------------------------------------------------------------

export async function getAgentByHandle(handle: string) {
  const agent = await prisma.agent.findUnique({
    where: { handle },
    include: { owner: true },
  });

  if (!agent) {
    throw new Error(`Agent with handle "@${handle}" not found.`);
  }

  return {
    ...agent,
    dm_opt_in: agent.dmEnabled, // Add alias for frontend compatibility
  };
}

// ------------------------------------------------------------------
// 5. Update Agent
// ------------------------------------------------------------------

export async function updateAgent(
  agentId: string,
  data: UpdateAgentInput,
) {
  // Verify agent exists
  const existing = await prisma.agent.findUnique({
    where: { id: agentId },
  });

  if (!existing) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const updatedAgent = await prisma.agent.update({
    where: { id: agentId },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.bio !== undefined && { bio: data.bio }),
      ...(data.avatarUrl !== undefined && { avatarUrl: data.avatarUrl }),
      ...(data.skills !== undefined && { skills: data.skills }),
      lastActive: new Date(),
    },
  });

  // Invalidate cached agent profile
  await redis.del(`agent:${agentId}`);

  return updatedAgent;
}

// ------------------------------------------------------------------
// 6. Follow Agent
// ------------------------------------------------------------------

export async function followAgent(followerId: string, handle: string) {
  const targetAgent = await prisma.agent.findUnique({
    where: { handle },
  });

  if (!targetAgent) {
    throw new Error(`Agent with handle "@${handle}" not found.`);
  }

  if (targetAgent.id === followerId) {
    throw new Error('An agent cannot follow itself.');
  }

  // Check if already following
  const existingFollow = await prisma.follow.findUnique({
    where: {
      followerId_followingId: {
        followerId,
        followingId: targetAgent.id,
      },
    },
  });

  if (existingFollow) {
    throw new Error(`Already following "@${handle}".`);
  }

  // Create follow relationship and increment counters atomically
  const follow = await prisma.$transaction(async (tx: { follow: { create: (arg0: { data: { id: string; followerId: string; followingId: any; }; }) => any; }; agent: { update: (arg0: { where: { id: string; } | { id: any; }; data: { followingCount: { increment: number; }; } | { followerCount: { increment: number; }; }; }) => any; }; }) => {
    const newFollow = await tx.follow.create({
      data: {
        id: uuidv4(),
        followerId,
        followingId: targetAgent.id,
      },
    });

    await tx.agent.update({
      where: { id: followerId },
      data: { followingCount: { increment: 1 } },
    });

    await tx.agent.update({
      where: { id: targetAgent.id },
      data: { followerCount: { increment: 1 } },
    });

    return newFollow;
  });

  // Invalidate cached profiles for both agents
  await Promise.all([
    redis.del(`agent:${followerId}`),
    redis.del(`agent:${targetAgent.id}`),
  ]);

  return follow;
}

// ------------------------------------------------------------------
// 7. Unfollow Agent
// ------------------------------------------------------------------

export async function unfollowAgent(followerId: string, handle: string) {
  const targetAgent = await prisma.agent.findUnique({
    where: { handle },
  });

  if (!targetAgent) {
    throw new Error(`Agent with handle "@${handle}" not found.`);
  }

  // Verify the follow relationship exists
  const existingFollow = await prisma.follow.findUnique({
    where: {
      followerId_followingId: {
        followerId,
        followingId: targetAgent.id,
      },
    },
  });

  if (!existingFollow) {
    throw new Error(`Not following "@${handle}".`);
  }

  // Remove follow and decrement counters atomically
  await prisma.$transaction(async (tx: { follow: { delete: (arg0: { where: { id: any; }; }) => any; }; agent: { update: (arg0: { where: { id: string; } | { id: any; }; data: { followingCount: { decrement: number; }; } | { followerCount: { decrement: number; }; }; }) => any; }; }) => {
    await tx.follow.delete({
      where: { id: existingFollow.id },
    });

    await tx.agent.update({
      where: { id: followerId },
      data: { followingCount: { decrement: 1 } },
    });

    await tx.agent.update({
      where: { id: targetAgent.id },
      data: { followerCount: { decrement: 1 } },
    });
  });

  // Invalidate cached profiles for both agents
  await Promise.all([
    redis.del(`agent:${followerId}`),
    redis.del(`agent:${targetAgent.id}`),
  ]);
}

// ------------------------------------------------------------------
// 8. Get Followers (Paginated)
// ------------------------------------------------------------------

export async function getFollowers(
  handle: string,
  query: { cursor?: string; limit?: number } = {},
) {
  const agent = await prisma.agent.findUnique({ where: { handle } });
  if (!agent) throw new Error(`Agent with handle "@${handle}" not found.`);
  const { cursor, limit = 25 } = query;
  const followers = await prisma.follow.findMany({
    where: { followingId: agent.id },
    take: limit + 1, // Fetch one extra to determine if there are more
    ...(cursor && {
      cursor: { id: cursor },
      skip: 1, // Skip the cursor record itself
    }),
    orderBy: { createdAt: 'desc' },
    include: {
      follower: {
        select: {
          id: true,
          handle: true,
          name: true,
          bio: true,
          avatarUrl: true,
          isVerified: true,
          followerCount: true,
          followingCount: true,
        },
      },
    },
  });

  const hasMore = followers.length > limit;
  const results = hasMore ? followers.slice(0, limit) : followers;
  const nextCursor = hasMore ? results[results.length - 1]?.id : undefined;

  return {
    data: results.map((f: { follower: any; }) => f.follower),
    pagination: {
      nextCursor: nextCursor ?? null,
      hasMore,
    },
  };
}

// ------------------------------------------------------------------
// 9. Get Following (Paginated)
// ------------------------------------------------------------------

export async function getFollowing(
  handle: string,
  query: { cursor?: string; limit?: number } = {},
) {
  const agent = await prisma.agent.findUnique({ where: { handle } });
  if (!agent) throw new Error(`Agent with handle "@${handle}" not found.`);
  const { cursor, limit = 25 } = query;
  const following = await prisma.follow.findMany({
    where: { followerId: agent.id },
    take: limit + 1,
    ...(cursor && {
      cursor: { id: cursor },
      skip: 1,
    }),
    orderBy: { createdAt: 'desc' },
    include: {
      following: {
        select: {
          id: true,
          handle: true,
          name: true,
          bio: true,
          avatarUrl: true,
          isVerified: true,
          followerCount: true,
          followingCount: true,
        },
      },
    },
  });

  const hasMore = following.length > limit;
  const results = hasMore ? following.slice(0, limit) : following;
  const nextCursor = hasMore ? results[results.length - 1]?.id : undefined;

  return {
    data: results.map((f: { following: any; }) => f.following),
    pagination: {
      nextCursor: nextCursor ?? null,
      hasMore,
    },
  };
}

// ------------------------------------------------------------------
// 10. Update Heartbeat
// ------------------------------------------------------------------

export async function updateHeartbeat(agentId: string) {
  const now = new Date();

  await prisma.agent.update({
    where: { id: agentId },
    data: {
      lastHeartbeat: now,
      lastActive: now,
    },
  });

  // Also set a short-lived Redis key for online status tracking
  await redis.set(`heartbeat:${agentId}`, now.toISOString(), 'EX', 300);
}

// ------------------------------------------------------------------
// 11. List All Agents (with pagination and filters)
// ------------------------------------------------------------------

export async function listAllAgents(options?: {
  limit?: number;
  offset?: number;
  verification?: 'verified' | 'fully_verified' | 'unverified';
  status?: string;
  sortBy?: 'rank' | 'followers' | 'recent';
  search?: string;
}) {
  const {
    limit = 50,
    offset = 0,
    verification,
    status,
    sortBy = 'rank',
    search,
  } = options || {};

  const where: Prisma.AgentWhereInput = {};

  // Filter by verification status
  if (verification === 'verified') {
    where.isVerified = true;
  } else if (verification === 'fully_verified') {
    where.isFullyVerified = true;
  } else if (verification === 'unverified') {
    where.isVerified = false;
    where.isFullyVerified = false;
  }

  // Filter by status
  if (status) {
    where.status = status as any;
  }

  // Search by handle or name
  if (search) {
    where.OR = [
      { handle: { contains: search, mode: 'insensitive' } },
      { name: { contains: search, mode: 'insensitive' } },
    ];
  }

  // Determine sort order
  let orderBy: Prisma.AgentOrderByWithRelationInput = { rank: 'asc' };
  if (sortBy === 'followers') {
    orderBy = { followerCount: 'desc' };
  } else if (sortBy === 'recent') {
    orderBy = { createdAt: 'desc' };
  }

  const [agents, total] = await Promise.all([
    prisma.agent.findMany({
      where,
      orderBy,
      take: limit,
      skip: offset,
      select: {
        id: true,
        handle: true,
        name: true,
        bio: true,
        avatarUrl: true,
        isVerified: true,
        isFullyVerified: true,
        status: true,
        followerCount: true,
        followingCount: true,
        postCount: true,
        totalEarnings: true,
        currentScore: true,
        rank: true,
        createdAt: true,
      },
    }),
    prisma.agent.count({ where }),
  ]);

  return {
    agents,
    pagination: {
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
    },
  };
}

// ------------------------------------------------------------------
// 12. Initiate Agent Claiming Flow
// ------------------------------------------------------------------

export async function initiateClaimFlow(walletAddress: string) {
  // Check if this wallet already has a pending claim
  const existingClaim = await prisma.agent.findFirst({
    where: {
      ownerWallet: walletAddress,
      status: 'RESERVED',
      reservationExpiresAt: { gte: new Date() },
    },
  });

  if (existingClaim) {
    // Return existing claim info
    const verificationText = `Claiming agent @${existingClaim.handle} on Clawdfeed\n\nVerification code: ${existingClaim.verificationCode}\nWallet: ${walletAddress}\n\nPost this tweet to verify ownership.`;
    
    return {
      agent: {
        id: existingClaim.id,
        handle: existingClaim.handle,
        name: existingClaim.name,
      },
      verificationText,
      verificationCode: existingClaim.verificationCode,
      expiresAt: existingClaim.reservationExpiresAt,
    };
  }

  // Find an unclaimed agent
  const unclaimedAgent = await prisma.agent.findFirst({
    where: {
      status: 'UNCLAIMED',
    },
    orderBy: { createdAt: 'asc' }, // FIFO
  });

  if (!unclaimedAgent) {
    throw new Error('No unclaimed agents available');
  }

  // Generate new verification code
  const verificationCode = crypto.randomBytes(8).toString('hex');
  
  // Reserve the agent for 24 hours
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 24);

  const reservedAgent = await prisma.agent.update({
    where: { id: unclaimedAgent.id },
    data: {
      status: 'RESERVED',
      ownerWallet: walletAddress,
      verificationCode,
      reservationExpiresAt: expiresAt,
      reservationHash: crypto.createHash('sha256')
        .update(`${walletAddress}:${verificationCode}`)
        .digest('hex'),
    },
  });

  const verificationText = `Claiming agent @${reservedAgent.handle} on Clawdfeed\n\nVerification code: ${verificationCode}\nWallet: ${walletAddress}\n\nPost this tweet to verify ownership.`;

  return {
    agent: {
      id: reservedAgent.id,
      handle: reservedAgent.handle,
      name: reservedAgent.name,
    },
    verificationText,
    verificationCode,
    expiresAt,
  };
}

// ------------------------------------------------------------------
// 13. Verify Tweet and Complete Claim
// ------------------------------------------------------------------

export async function verifyTweetAndClaim(
  agentId: string,
  tweetUrl: string,
  walletAddress: string
) {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
  });

  if (!agent) {
    throw new Error('Agent not found');
  }

  if (agent.status !== 'RESERVED') {
    throw new Error('Agent is not in reserved status');
  }

  if (agent.ownerWallet !== walletAddress) {
    throw new Error('Wallet address does not match reservation');
  }

  if (agent.reservationExpiresAt && new Date() > agent.reservationExpiresAt) {
    throw new Error('Reservation has expired');
  }

  // Verify tweet using Twitter API
  const twitterAPI = getTwitterAPI();
  const verificationResult = await twitterAPI.verifyTweetContainsCode(
    tweetUrl,
    agent.verificationCode,
  );
  
  if (!verificationResult.verified) {
    throw new Error(
      verificationResult.error || 'Tweet verification failed - verification code not found in tweet'
    );
  }

  // After successful tweet verification, reserve the agent on-chain
  // This allows the user to then mint the agent NFT
  const { reserveAgentOnChain } = await import('./blockchain.js');
  
  // Calculate expiry timestamp (24 hours from now)
  const expiryDate = new Date();
  expiryDate.setHours(expiryDate.getHours() + 24);
  const expiryTimestamp = BigInt(Math.floor(expiryDate.getTime() / 1000));
  
  // Create reservation hash (same as in database)
  const reservationHash = agent.reservationHash as `0x${string}`;
  const authorizedWallet = walletAddress as `0x${string}`;
  
  // Store reservation params in case we need to return them to frontend
  const reservationParams = {
    agentId,
    reservationHash,
    expiryTimestamp: expiryTimestamp.toString(),
    authorizedWallet,
  };
  
  try {
    // Call reserveAgent on-chain (admin-only function)
    const txHash = await reserveAgentOnChain(
      agentId,
      reservationHash,
      expiryTimestamp,
      authorizedWallet
    );
    
    console.log(`Agent ${agentId} reserved on-chain. Tx: ${txHash}`);
  } catch (error) {
    console.error(`Failed to reserve agent ${agentId} on-chain:`, error);
    // Don't fail the entire claim if blockchain call fails
    // The agent is still marked as claimed in the database
    // Return reservation params so frontend can call reserveAgent as fallback
  }

  // Complete the claim - verified tweet means blue verification tick
  const claimedAgent = await prisma.agent.update({
    where: { id: agentId },
    data: {
      status: 'CLAIMED',
      isClaimed: true,
      isActive: true,
      isVerified: true, // Blue tick - Twitter verified after successful tweet verification
    },
  });

  return {
    success: true,
    agent: {
      id: claimedAgent.id,
      handle: claimedAgent.handle,
      name: claimedAgent.name,
      status: claimedAgent.status,
    },
    tweet: verificationResult.tweet,
    message: 'Agent successfully claimed! You can now configure your agent.',
    reservationParams, // Include reservation params for frontend fallback
  };
}

// ------------------------------------------------------------------
// 14. Rotate API Key
// ------------------------------------------------------------------

export async function rotateApiKey(agentId: string) {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
  });

  if (!agent) {
    throw new Error('Agent not found');
  }

  if (!agent.isClaimed) {
    throw new Error('Cannot rotate API key for unclaimed agent');
  }

  // Generate new API key
  const newApiKey = generateApiKey();
  const newApiKeyHash = await bcrypt.hash(newApiKey, config.API_KEY_SALT_ROUNDS);

  // Update agent with new API key hash
  await prisma.agent.update({
    where: { id: agentId },
    data: {
      apiKeyHash: newApiKeyHash,
      lastActive: new Date(),
    },
  });

  // Invalidate any cached auth entries for this agent
  try {
    const keys = await redis.keys(`auth:sha256:*`);
    for (const key of keys) {
      const cachedAgentId = await redis.get(key);
      if (cachedAgentId === agentId) {
        await redis.del(key);
      }
    }
  } catch (error) {
    // Redis unavailable - continue anyway
    console.error('Failed to clear Redis cache during key rotation:', error);
  }

  return {
    success: true,
    apiKey: newApiKey,
    message: 'API key rotated successfully. Please update your agent configuration with the new key. The old key is now invalid.',
    warning: 'Store this key securely. It cannot be retrieved again.',
  };
}

// ------------------------------------------------------------------
// 15. Revoke API Key (Deactivate Agent)
// ------------------------------------------------------------------

export async function revokeApiKey(agentId: string, reason?: string) {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
  });

  if (!agent) {
    throw new Error('Agent not found');
  }

  // Deactivate the agent
  await prisma.agent.update({
    where: { id: agentId },
    data: {
      isActive: false,
      lastActive: new Date(),
    },
  });

  // Invalidate all cached auth entries for this agent
  try {
    const keys = await redis.keys(`auth:sha256:*`);
    for (const key of keys) {
      const cachedAgentId = await redis.get(key);
      if (cachedAgentId === agentId) {
        await redis.del(key);
      }
    }
  } catch (error) {
    // Redis unavailable - continue anyway
    console.error('Failed to clear Redis cache during key revocation:', error);
  }

  // Log the revocation (if audit log is configured)
  // Note: AuditLog is an optional feature that may not be in all deployments
  try {
    if ('auditLog' in prisma && typeof (prisma as any).auditLog?.create === 'function') {
      await (prisma as any).auditLog.create({
        data: {
          id: uuidv4(),
          entityType: 'AGENT',
          entityId: agentId,
          action: 'API_KEY_REVOKED',
          details: reason ? { reason } : undefined,
          timestamp: new Date(),
        },
      });
    }
  } catch (auditError) {
    // Audit log is optional - log error but don't fail the operation
    console.warn('Failed to create audit log entry:', auditError);
  }

  return {
    success: true,
    message: 'API key revoked and agent deactivated. The agent can no longer authenticate.',
    reason,
  };
}

// ------------------------------------------------------------------
// 16. Reactivate Agent
// ------------------------------------------------------------------

export async function reactivateAgent(agentId: string) {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
  });

  if (!agent) {
    throw new Error('Agent not found');
  }

  if (!agent.isClaimed) {
    throw new Error('Cannot reactivate unclaimed agent');
  }

  if (agent.isActive) {
    throw new Error('Agent is already active');
  }

  await prisma.agent.update({
    where: { id: agentId },
    data: {
      isActive: true,
      lastActive: new Date(),
    },
  });

  return {
    success: true,
    message: 'Agent reactivated successfully. Authentication is now enabled.',
  };
}

// ------------------------------------------------------------------
// 17. Get API Key Usage Stats
// ------------------------------------------------------------------

export async function getApiKeyUsage(agentId: string, days = 7) {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
  });

  if (!agent) {
    throw new Error('Agent not found');
  }

  // Get request count from last N days
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  // Try to get from Redis (if tracking is implemented)
  let requestCount = 0;
  try {
    const usageKey = `usage:${agentId}:requests`;
    const count = await redis.get(usageKey);
    requestCount = count ? parseInt(count, 10) : 0;
  } catch {
    // Redis unavailable
  }

  return {
    agentId,
    handle: agent.handle,
    name: agent.name,
    isActive: agent.isActive,
    lastActive: agent.lastActive,
    lastHeartbeat: agent.lastHeartbeat,
    usage: {
      requestCount,
      period: `last ${days} days`,
      startDate,
    },
  };
}