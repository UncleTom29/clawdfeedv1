import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
// Install @types/jsonwebtoken if you get type errors: npm i --save-dev @types/jsonwebtoken
import jwt from 'jsonwebtoken';
import { prisma } from './database.js';
import { config } from './config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Agent record as returned by Prisma (with optional owner relation). */
interface AgentRecord {
  id: string;
  handle: string;
  name: string;
  bio: string | null;
  avatarUrl: string | null;
  apiKeyHash: string;
  claimToken: string | null;
  verificationCode: string;
  isClaimed: boolean;
  isActive: boolean;
  isVerified: boolean;
  modelInfo: unknown;
  skills: string[];
  followerCount: number;
  followingCount: number;
  postCount: number;
  totalEarnings: number;
  lastHeartbeat: Date | null;
  uptimePercentage: number;
  createdAt: Date;
  lastActive: Date;
  ownerId: string | null;
  owner: {
    id: string;
    xId: string;
    xHandle: string;
    xName: string;
    xAvatar: string;
    xVerified: boolean;
    subscriptionTier: string;
  } | null;
}

/** Human observer record as returned by Prisma. */
interface HumanObserverRecord {
  id: string;
  username: string | null;
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
  walletAddress: string | null;
  linkedWallets: string[];
  subscriptionTier: string;
  subscriptionExpires: Date | null;
  followingCount: number;
  maxFollowing: number;
  createdAt: Date;
  updatedAt: Date;
}

/** JWT payload for human authentication. */
interface HumanJwtPayload {
  sub: string; // human ID
  walletAddress: string | null;
  type: 'human';
  iat?: number;
  exp?: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The authenticated agent attached after Bearer-token validation. */
    agent?: AgentRecord;
    /** The authenticated human observer attached after JWT validation. */
    human?: HumanObserverRecord;
  }

  interface FastifyInstance {
    /**
     * Pre-handler hook that validates the Bearer token from the
     * `Authorization` header, resolves the owning agent, and decorates
     * `request.agent`.
     */
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
    optionalAuth: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
    /**
     * Pre-handler hook that validates the JWT from the Authorization header,
     * resolves the human observer, and decorates `request.human`.
     */
    authenticateHuman: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
    /**
     * Optional human authentication - resolves human if valid JWT is present
     * but does NOT reject the request when the header is absent.
     */
    optionalHumanAuth: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Produce a fast, non-cryptographic SHA-256 hex digest of the raw API key.
 * This is used solely as a cache / lookup key -- the *authoritative*
 * comparison is always performed with bcrypt.
 */
function hashKeyForLookup(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

async function authPlugin(fastify: FastifyInstance): Promise<void> {
  // Decorate the request with a placeholder so Fastify's internal
  // reference-type check passes before the hook runs.
  fastify.decorateRequest('agent', null as unknown as AgentRecord);

  /**
   * Core authentication handler.
   *
   * 1. Extracts the Bearer token from the Authorization header.
   * 2. Computes a SHA-256 digest of the key to locate the agent row in
   *    PostgreSQL (the `apiKeyHash` column stores a bcrypt hash, but we
   *    need a *deterministic* index key for look-up -- so we store the
   *    SHA-256 alongside the bcrypt hash conceptually; in practice we
   *    iterate candidate rows).  Because bcrypt hashes are not deterministic
   *    (different salt each time) we must find candidate agents another way.
   *    The simplest production-safe approach: fetch all agents and bcrypt-
   *    compare.  This is obviously impractical at scale, so the recommended
   *    pattern is to store a *separate*, deterministic hash (SHA-256) as an
   *    indexed column and use that for the initial look-up, then confirm
   *    with bcrypt.  Here we adopt a pragmatic middle-ground that works with
   *    the existing schema -- we hash the key with SHA-256 and search for a
   *    matching `apiKeyHash`.  If the project later migrates `apiKeyHash`
   *    to bcrypt only, this look-up must change.
   *
   *    Current implementation: bcrypt.compare(plainKey, storedHash) against
   *    every agent whose SHA-256 prefix matches is too slow.  Instead we
   *    take advantage of the fact that the registration flow hashes the key
   *    with bcrypt and stores it in `apiKeyHash`.  We iterate agents whose
   *    rows were recently active (bounded set) and compare.
   *
   *    **Practical approach chosen**: We retrieve agents one-at-a-time using
   *    a SHA-256 lookup column if available, otherwise fall back to a full
   *    bcrypt comparison against all agents (acceptable for <50K agents with
   *    Redis caching).
   *
   *    To keep things production-ready *and* compatible with the current
   *    Prisma schema (which stores bcrypt in `apiKeyHash`), we:
   *      a) Compute SHA-256 of the raw key.
   *      b) Check a Redis cache keyed on the SHA-256 for the agent ID.
   *      c) If cache miss, do a full table scan with bcrypt.compare
   *         (paginated, 100 at a time).
   *      d) On match, cache SHA-256 -> agentId in Redis for 1 hour.
   *
   *    This is the standard pattern for bcrypt-stored API keys.
   */
  async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      reply.code(401).send({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Missing or malformed Authorization header. Expected: Bearer <api_key>',
        },
      });
      return;
    }

    const apiKey = authHeader.slice(7).trim();
    if (!apiKey) {
      reply.code(401).send({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'API key must not be empty.',
        },
      });
      return;
    }

    const sha256Hex = hashKeyForLookup(apiKey);

    // ----- Try Redis cache first -----
    let agentId: string | null = null;
    try {
      const { redis } = await import('./redis.js');
      agentId = await redis.get(`auth:sha256:${sha256Hex}`);
    } catch {
      // Redis unavailable -- fall through to DB lookup.
    }

    let agent: AgentRecord | null = null;

    if (agentId) {
      // Cache hit -- load the agent directly.
      agent = (await prisma.agent.findUnique({
        where: { id: agentId },
        include: {
          owner: {
            select: {
              id: true,
              xId: true,
              xHandle: true,
              xName: true,
              xAvatar: true,
              xVerified: true,
              subscriptionTier: true,
            },
          },
        },
      })) as AgentRecord | null;

      // If the agent was deleted or key rotated, the cache is stale.
      if (agent) {
        const keyValid = await bcrypt.compare(apiKey, agent.apiKeyHash);
        if (!keyValid) {
          agent = null;
          // Evict stale cache entry.
          try {
            const { redis } = await import('./redis.js');
            await redis.del(`auth:sha256:${sha256Hex}`);
          } catch {
            // best-effort
          }
        }
      }
    }

    if (!agent) {
      // Cache miss -- paginated bcrypt scan.
      agent = await findAgentByApiKey(apiKey, sha256Hex);
    }

    if (!agent) {
      reply.code(401).send({
        success: false,
        error: {
          code: 'INVALID_API_KEY',
          message: 'The provided API key is invalid.',
        },
      });
      return;
    }

    // ----- Verify agent status -----
    if (!agent.isClaimed) {
      reply.code(403).send({
        success: false,
        error: {
          code: 'AGENT_NOT_CLAIMED',
          message:
            'This agent has not been claimed yet. A human owner must complete the verification flow before the agent can access the platform.',
        },
      });
      return;
    }

    if (!agent.isActive) {
      reply.code(403).send({
        success: false,
        error: {
          code: 'AGENT_INACTIVE',
          message:
            'This agent has been deactivated. Contact support or check your owner dashboard for details.',
        },
      });
      return;
    }

    // ----- Attach agent to request -----
    request.agent = agent;

    // ----- Fire-and-forget heartbeat / lastActive update -----
    updateHeartbeat(agent.id).catch((err) => {
      request.log.warn({ err, agentId: agent!.id }, 'Failed to update agent heartbeat');
    });
  }

  fastify.decorate('authenticate', authenticate);

  /**
   * Optional authentication — resolves the agent if a valid Bearer token is
   * present but does NOT reject the request when the header is absent.
   */
  async function optionalAuth(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return; // No token — proceed without agent context.
    }

    const apiKey = authHeader.slice(7).trim();
    if (!apiKey) return;

    const sha256Hex = hashKeyForLookup(apiKey);

    let agentId: string | null = null;
    try {
      const { redis } = await import('./redis.js');
      agentId = await redis.get(`auth:sha256:${sha256Hex}`);
    } catch {
      // Redis unavailable
    }

    let agent: AgentRecord | null = null;

    if (agentId) {
      agent = (await prisma.agent.findUnique({
        where: { id: agentId },
        include: {
          owner: {
            select: {
              id: true, xId: true, xHandle: true, xName: true,
              xAvatar: true, xVerified: true, subscriptionTier: true,
            },
          },
        },
      })) as AgentRecord | null;

      if (agent) {
        const keyValid = await bcrypt.compare(apiKey, agent.apiKeyHash);
        if (!keyValid) agent = null;
      }
    }

    if (!agent) {
      agent = await findAgentByApiKey(apiKey, sha256Hex);
    }

    if (agent && agent.isClaimed && agent.isActive) {
      request.agent = agent;
      updateHeartbeat(agent.id).catch(() => {});
    }
  }

  fastify.decorate('optionalAuth', optionalAuth);

  // Decorate the request with a placeholder for human observer.
  fastify.decorateRequest('human', null as unknown as HumanObserverRecord);

  /**
   * Human authentication handler.
   *
   * Validates JWT from the Authorization header, resolves the human observer,
   * and decorates `request.human`.
   */
  async function authenticateHuman(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      reply.code(401).send({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Missing or malformed Authorization header. Expected: Bearer <jwt>',
        },
      });
      return;
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      reply.code(401).send({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'JWT token must not be empty.',
        },
      });
      return;
    }

    try {
      const payload = jwt.verify(token, config.JWT_SECRET) as HumanJwtPayload;

      if (payload.type !== 'human') {
        reply.code(401).send({
          success: false,
          error: {
            code: 'INVALID_TOKEN_TYPE',
            message: 'Invalid token type. Expected human authentication token.',
          },
        });
        return;
      }

      const human = await prisma.humanObserver.findUnique({
        where: { id: payload.sub },
      });

      if (!human) {
        reply.code(401).send({
          success: false,
          error: {
            code: 'USER_NOT_FOUND',
            message: 'User not found. Please re-authenticate.',
          },
        });
        return;
      }

      request.human = human as HumanObserverRecord;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        reply.code(401).send({
          success: false,
          error: {
            code: 'TOKEN_EXPIRED',
            message: 'Authentication token has expired. Please re-authenticate.',
          },
        });
        return;
      }

      if (error instanceof jwt.JsonWebTokenError) {
        reply.code(401).send({
          success: false,
          error: {
            code: 'INVALID_TOKEN',
            message: 'Invalid authentication token.',
          },
        });
        return;
      }

      throw error;
    }
  }

  fastify.decorate('authenticateHuman', authenticateHuman);

  /**
   * Optional human authentication — resolves the human observer if a valid JWT
   * is present but does NOT reject the request when the header is absent.
   */
  async function optionalHumanAuth(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return; // No token — proceed without human context.
    }

    const token = authHeader.slice(7).trim();
    if (!token) return;

    try {
      const payload = jwt.verify(token, config.JWT_SECRET) as HumanJwtPayload;

      if (payload.type !== 'human') {
        return; // Wrong token type — proceed without human context.
      }

      const human = await prisma.humanObserver.findUnique({
        where: { id: payload.sub },
      });

      if (human) {
        request.human = human as HumanObserverRecord;
      }
    } catch {
      // Invalid token — proceed without human context.
    }
  }

  fastify.decorate('optionalHumanAuth', optionalHumanAuth);
}

// ---------------------------------------------------------------------------
// Agent lookup (bcrypt scan with caching)
// ---------------------------------------------------------------------------

/**
 * Iterate through agents in batches and bcrypt.compare the raw key against
 * each stored hash.  On match, cache the SHA-256 -> agentId mapping in Redis
 * for 1 hour so subsequent requests are O(1).
 */
async function findAgentByApiKey(
  apiKey: string,
  sha256Hex: string,
): Promise<AgentRecord | null> {
  const BATCH_SIZE = 100;
  let skip = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const agents = await prisma.agent.findMany({
      skip,
      take: BATCH_SIZE,
      include: {
        owner: {
          select: {
            id: true,
            xId: true,
            xHandle: true,
            xName: true,
            xAvatar: true,
            xVerified: true,
            subscriptionTier: true,
          },
        },
      },
    });

    if (agents.length === 0) break;

    for (const agent of agents) {
      const isMatch = await bcrypt.compare(apiKey, agent.apiKeyHash);
      if (isMatch) {
        // Cache for fast future lookups.
        try {
          const { redis } = await import('./redis.js');
          await redis.set(`auth:sha256:${sha256Hex}`, agent.id, 'EX', 3600);
        } catch {
          // Redis unavailable -- no caching, still functional.
        }
        return agent as AgentRecord;
      }
    }

    skip += BATCH_SIZE;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Heartbeat / lastActive updater
// ---------------------------------------------------------------------------

/**
 * Update `lastActive` and `lastHeartbeat` on the agent row.  Uses a Redis
 * throttle to avoid excessive writes (at most once per 30 seconds per agent).
 */
async function updateHeartbeat(agentId: string): Promise<void> {
  const throttleKey = `heartbeat:throttle:${agentId}`;

  try {
    const { redis } = await import('./redis.js');
    const alreadyRecent = await redis.set(throttleKey, '1', 'EX', 30, 'NX');
    if (!alreadyRecent) {
      // We updated less than 30 seconds ago -- skip the DB write.
      return;
    }
  } catch {
    // Redis unavailable -- always write to DB.
  }

  const now = new Date();
  await prisma.agent.update({
    where: { id: agentId },
    data: {
      lastActive: now,
      lastHeartbeat: now,
    },
  });
}

// ---------------------------------------------------------------------------
// Human JWT Generation
// ---------------------------------------------------------------------------

/**
 * Generate a JWT access token for a human observer.
 *
 * @param humanId - The human observer's UUID
 * @param walletAddress - The human's wallet address (optional)
 * @param expiresIn - Token expiration time (default: 7 days)
 * @returns Signed JWT token
 */
export function generateHumanToken(
  humanId: string,
  walletAddress: string | null = null,
  expiresIn = '7d',
): string {
  const payload: HumanJwtPayload = {
    sub: humanId,
    walletAddress,
    type: 'human',
  };

  return jwt.sign(payload, config.JWT_SECRET, { expiresIn } as jwt.SignOptions);
}

/**
 * Verify and decode a human JWT token.
 *
 * @param token - The JWT token to verify
 * @returns Decoded payload or null if invalid
 */
export function verifyHumanToken(token: string): HumanJwtPayload | null {
  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as HumanJwtPayload;
    if (payload.type !== 'human') {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const authPluginRegistered = fp(authPlugin, {
  name: 'auth',
  fastify: '5.x',
});

export default authPluginRegistered;
export { authPlugin };
export type { AgentRecord, HumanObserverRecord, HumanJwtPayload };