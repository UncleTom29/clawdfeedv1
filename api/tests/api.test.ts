import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Mock: config (must come before any source import that transitively loads it)
// ---------------------------------------------------------------------------

vi.mock('../src/config.js', () => ({
  config: {
    NODE_ENV: 'test',
    API_PORT: 3000,
    API_HOST: '0.0.0.0',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    API_KEY_SALT_ROUNDS: 4,
    JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-chars-long',
    X_CLIENT_ID: 'test_client_id',
    X_CLIENT_SECRET: 'test_client_secret',
    X_CALLBACK_URL: 'http://localhost:3001/api/auth/callback/twitter',
    X_BEARER_TOKEN: 'test_bearer_token',
    STRIPE_SECRET_KEY: 'sk_test_mock_stripe_key',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_webhook_secret',
    NEXT_PUBLIC_API_URL: 'http://localhost:3000/api/v1',
    NEXT_PUBLIC_WS_URL: 'ws://localhost:3000',
    NEXT_PUBLIC_APP_URL: 'http://localhost:3001',
    CORS_ORIGINS: ['http://localhost:3001'],
    RATE_LIMIT_MAX: 1000,
    RATE_LIMIT_WINDOW_MS: 60000,
    FEED_GENERATION_INTERVAL_MS: 120000,
    PAYOUT_CRON: '0 0 * * 1',
    ENCRYPTION_KEY: 'a'.repeat(64),
    S3_ENDPOINT: 'http://localhost:9000',
    S3_BUCKET: 'test-bucket',
    S3_ACCESS_KEY: 'test',
    S3_SECRET_KEY: 'test',
    S3_REGION: 'us-east-1',
  },
}));

// ---------------------------------------------------------------------------
// Mock: prisma (database.js)
// ---------------------------------------------------------------------------

const prismaMock = {
  agent: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  post: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
  },
  follow: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
  interaction: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
  directMessage: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  revenue: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    aggregate: vi.fn(),
    groupBy: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  },
  humanOwner: {
    upsert: vi.fn(),
    update: vi.fn(),
  },
  $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(prismaMock)),
  $queryRaw: vi.fn(),
  $disconnect: vi.fn(),
};

vi.mock('../src/database.js', () => ({
  prisma: prismaMock,
}));

// ---------------------------------------------------------------------------
// Mock: redis
// ---------------------------------------------------------------------------

const redisMock = {
  get: vi.fn(),
  set: vi.fn(),
  incr: vi.fn(),
  expire: vi.fn(),
  del: vi.fn(),
  publish: vi.fn(),
  ping: vi.fn().mockResolvedValue('PONG'),
  ttl: vi.fn(),
  keys: vi.fn().mockResolvedValue([]),
  connect: vi.fn().mockResolvedValue(undefined),
  quit: vi.fn().mockResolvedValue(undefined),
  zrange: vi.fn().mockResolvedValue([]),
  zadd: vi.fn(),
  smembers: vi.fn().mockResolvedValue([]),
  exists: vi.fn().mockResolvedValue(0),
  pipeline: vi.fn(() => ({
    del: vi.fn().mockReturnThis(),
    zadd: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  })),
  on: vi.fn(),
  subscribe: vi.fn(),
};

const redisSubMock = {
  connect: vi.fn().mockResolvedValue(undefined),
  quit: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  subscribe: vi.fn(),
};

vi.mock('../src/redis.js', () => ({
  redis: redisMock,
  redisSub: redisSubMock,
  connectRedis: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mock: bcrypt
// ---------------------------------------------------------------------------

vi.mock('bcrypt', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('$2b$04$hashedvalue'),
    compare: vi.fn().mockResolvedValue(false),
  },
  hash: vi.fn().mockResolvedValue('$2b$04$hashedvalue'),
  compare: vi.fn().mockResolvedValue(false),
}));

// ---------------------------------------------------------------------------
// Mock: service modules (routes delegate to these)
// ---------------------------------------------------------------------------

vi.mock('../src/services/agent.js', () => ({
  registerAgent: vi.fn(),
  claimAgent: vi.fn(),
  getAgentProfile: vi.fn(),
  getAgentByHandle: vi.fn(),
  updateAgent: vi.fn(),
  followAgent: vi.fn(),
  unfollowAgent: vi.fn(),
  getFollowers: vi.fn(),
  getFollowing: vi.fn(),
}));

vi.mock('../src/services/post.js', () => ({
  createPost: vi.fn(),
  createThread: vi.fn(),
  getPost: vi.fn(),
  editPost: vi.fn(),
  deletePost: vi.fn(),
  getPostReplies: vi.fn(),
  getAgentPosts: vi.fn(),
}));

vi.mock('../src/services/interaction.js', () => ({
  likePost: vi.fn(),
  unlikePost: vi.fn(),
  repostPost: vi.fn(),
  bookmarkPost: vi.fn(),
  unbookmarkPost: vi.fn(),
  trackView: vi.fn(),
  getAgentBookmarks: vi.fn(),
}));

vi.mock('../src/services/feed.js', () => ({
  forYouFeed: vi.fn(),
  followingFeed: vi.fn(),
  trendingFeed: vi.fn(),
  trendingHashtags: vi.fn(),
  exploreFeed: vi.fn(),
}));

vi.mock('../src/services/dm.js', () => ({
  sendMessage: vi.fn(),
  getConversations: vi.fn(),
  getConversationMessages: vi.fn(),
  markRead: vi.fn(),
}));

vi.mock('../src/services/monetization.js', () => ({
  processTip: vi.fn(),
  getEarnings: vi.fn(),
  getReferralStats: vi.fn(),
  trackAdImpression: vi.fn(),
}));

// Mock fastify-plugin so auth plugin is registered directly
vi.mock('fastify-plugin', () => ({
  default: (fn: Function) => fn,
}));

// Mock websocket (not needed for API tests)
vi.mock('../src/websocket.js', () => ({
  setupWebSocket: vi.fn(),
  io: null,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are set up)
// ---------------------------------------------------------------------------

import Fastify from 'fastify';
import bcrypt from 'bcrypt';

import { registerAgent, getAgentProfile, getAgentByHandle, followAgent, unfollowAgent } from '../src/services/agent.js';
import { createPost, getPost, editPost, deletePost } from '../src/services/post.js';
import { likePost, unlikePost, repostPost, bookmarkPost } from '../src/services/interaction.js';
import { forYouFeed, followingFeed, trendingFeed } from '../src/services/feed.js';
import { sendMessage, getConversations } from '../src/services/dm.js';
import { processTip, getEarnings } from '../src/services/monetization.js';

// ---------------------------------------------------------------------------
// Test agent fixtures
// ---------------------------------------------------------------------------

const TEST_AGENT = {
  id: 'agt-test-001',
  handle: 'TestAgent',
  name: 'Test Agent',
  bio: 'A test agent',
  avatarUrl: null,
  apiKeyHash: '$2b$04$hashedvalue',
  claimToken: null,
  verificationCode: 'reef-T3ST',
  isClaimed: true,
  isActive: true,
  isVerified: false,
  modelInfo: null,
  skills: [],
  followerCount: 10,
  followingCount: 5,
  postCount: 42,
  totalEarnings: 1500,
  lastHeartbeat: new Date(),
  uptimePercentage: 99.5,
  createdAt: new Date('2026-01-01'),
  lastActive: new Date(),
  ownerId: 'owner-001',
  owner: {
    id: 'owner-001',
    xId: '12345',
    xHandle: 'humanowner',
    xName: 'Human Owner',
    xAvatar: 'https://example.com/avatar.jpg',
    xVerified: true,
    subscriptionTier: 'PRO',
  },
};

const UNCLAIMED_AGENT = {
  ...TEST_AGENT,
  id: 'agt-unclaimed',
  isClaimed: false,
  isActive: false,
};

const TEST_API_KEY = 'clawdfeed_agt_test123_secret';
const AUTH_HEADER = `Bearer ${TEST_API_KEY}`;

// ---------------------------------------------------------------------------
// App builder helper
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Register auth plugin
  const { authPlugin } = await import('../src/auth.js');
  await app.register(authPlugin);

  // Register rate limiter (no-op in test with high limits)
  await app.register(await import('@fastify/rate-limit').then((m) => m.default), {
    max: 10000,
    timeWindow: 60000,
    redis: redisMock as any,
  });

  // Health endpoints (copied from index.ts for testing)
  app.get('/health', async (_request, reply) => {
    return reply.send({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/ready', async (_request, reply) => {
    const checks: Record<string, boolean> = { database: false, redis: false };
    try {
      await prismaMock.$queryRaw`SELECT 1`;
      checks.database = true;
    } catch { /* empty */ }
    try {
      const pong = await redisMock.ping();
      checks.redis = pong === 'PONG';
    } catch { /* empty */ }
    const allHealthy = Object.values(checks).every(Boolean);
    return reply.status(allHealthy ? 200 : 503).send({
      status: allHealthy ? 'ready' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    });
  });

  // Register routes
  const { registerRoutes } = await import('../src/routes.js');
  await app.register(registerRoutes);

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Helper to set up auth to succeed for a given agent
// ---------------------------------------------------------------------------

function setupAuth(agent = TEST_AGENT) {
  // Cache hit path: redis returns agentId, prisma returns agent, bcrypt confirms
  redisMock.get.mockImplementation(async (key: string) => {
    if (key.startsWith('auth:sha256:')) return agent.id;
    return null;
  });
  redisMock.set.mockResolvedValue('OK');
  prismaMock.agent.findUnique.mockResolvedValue(agent);
  prismaMock.agent.findMany.mockResolvedValue([agent]);
  prismaMock.agent.update.mockResolvedValue(agent);
  (bcrypt.compare as ReturnType<typeof vi.fn>).mockResolvedValue(true);
}

function setupAuthFailure() {
  redisMock.get.mockResolvedValue(null);
  prismaMock.agent.findMany.mockResolvedValue([]);
  (bcrypt.compare as ReturnType<typeof vi.fn>).mockResolvedValue(false);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults for redis mocks that may be called in any request
  redisMock.ping.mockResolvedValue('PONG');
  redisMock.keys.mockResolvedValue([]);
  redisMock.set.mockResolvedValue('OK');
  redisMock.del.mockResolvedValue(1);
  redisMock.get.mockResolvedValue(null);
  redisMock.publish.mockResolvedValue(1);
  prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
  prismaMock.agent.findMany.mockResolvedValue([]);
  (bcrypt.compare as ReturnType<typeof vi.fn>).mockResolvedValue(false);
});

// =========================================================================
// 1. Health Endpoints
// =========================================================================

describe('Health Endpoints', () => {
  it('GET /health returns 200 with status ok', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();
  });

  it('GET /ready returns 200 when database and redis are up', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    redisMock.ping.mockResolvedValue('PONG');

    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ready');
    expect(body.checks.database).toBe(true);
    expect(body.checks.redis).toBe(true);
  });

  it('GET /ready returns 503 when database is down', async () => {
    prismaMock.$queryRaw.mockRejectedValue(new Error('DB offline'));
    redisMock.ping.mockResolvedValue('PONG');

    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe('degraded');
    expect(body.checks.database).toBe(false);
  });
});

// =========================================================================
// 2. Agent Registration
// =========================================================================

describe('Agent Registration', () => {
  it('POST /api/v1/agents/register succeeds with valid data (201)', async () => {
    const registrationResult = {
      agent: {
        id: 'agt-new-001',
        handle: 'NewAgent',
        name: 'New Agent',
        bio: null,
        verificationCode: 'reef-N3W1',
        isClaimed: false,
        isActive: false,
        createdAt: new Date(),
      },
      apiKey: 'clawdfeed_agt_new_secret',
      claimUrl: 'http://localhost:3001/claim/clawdfeed_claim_abc',
      verificationCode: 'reef-N3W1',
    };
    (registerAgent as ReturnType<typeof vi.fn>).mockResolvedValue(registrationResult);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/register',
      payload: {
        handle: 'NewAgent',
        name: 'New Agent',
        description: 'A brand new agent',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.data.apiKey).toBe('clawdfeed_agt_new_secret');
    expect(body.data.agent.handle).toBe('NewAgent');
  });

  it('POST /api/v1/agents/register fails with missing name (400)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/register',
      payload: { handle: 'TestHandle' },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /api/v1/agents/register fails with invalid handle format (400)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/register',
      payload: { handle: 'ab', name: 'Short Handle Agent' },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /api/v1/agents/register fails when handle is taken (409)', async () => {
    const conflictError = new Error('Handle "@DuplicateAgent" is already taken.') as Error & { statusCode: number; code: string };
    conflictError.statusCode = 409;
    conflictError.code = 'CONFLICT';
    (registerAgent as ReturnType<typeof vi.fn>).mockRejectedValue(conflictError);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/register',
      payload: { handle: 'DuplicateAgent', name: 'Duplicate' },
    });

    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('CONFLICT');
  });
});

// =========================================================================
// 3. Agent Authentication
// =========================================================================

describe('Agent Authentication', () => {
  it('GET /api/v1/agents/me succeeds with valid API key (200)', async () => {
    setupAuth();
    const profile = { ...TEST_AGENT, followerCount: 10, followingCount: 5, postCount: 42 };
    (getAgentProfile as ReturnType<typeof vi.fn>).mockResolvedValue(profile);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/agents/me',
      headers: { authorization: AUTH_HEADER },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.data.handle).toBe('TestAgent');
  });

  it('GET /api/v1/agents/me fails without Authorization header (401)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/agents/me',
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('GET /api/v1/agents/me fails with invalid API key (401)', async () => {
    setupAuthFailure();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/agents/me',
      headers: { authorization: 'Bearer invalid_key_12345' },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.success).toBe(false);
  });

  it('GET /api/v1/agents/me fails for unclaimed agent (403)', async () => {
    setupAuth(UNCLAIMED_AGENT);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/agents/me',
      headers: { authorization: AUTH_HEADER },
    });

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('AGENT_NOT_CLAIMED');
  });

  it('GET /api/v1/agents/:handle returns agent profile (200)', async () => {
    (getAgentByHandle as ReturnType<typeof vi.fn>).mockResolvedValue(TEST_AGENT);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/agents/TestAgent',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.data.handle).toBe('TestAgent');
  });
});

// =========================================================================
// 4. Post Operations
// =========================================================================

describe('Post Operations', () => {
  const TEST_POST = {
    id: 'post-001',
    agentId: TEST_AGENT.id,
    content: 'Hello ClawdFeed!',
    media: null,
    poll: null,
    replyToId: null,
    quotePostId: null,
    threadId: null,
    likeCount: 5,
    repostCount: 2,
    replyCount: 1,
    quoteCount: 0,
    bookmarkCount: 3,
    impressionCount: 100,
    isDeleted: false,
    editedAt: null,
    location: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    agent: {
      id: TEST_AGENT.id,
      handle: TEST_AGENT.handle,
      name: TEST_AGENT.name,
      avatarUrl: null,
      isVerified: false,
    },
  };

  it('POST /api/v1/posts creates a post (201)', async () => {
    setupAuth();
    (createPost as ReturnType<typeof vi.fn>).mockResolvedValue(TEST_POST);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: { authorization: AUTH_HEADER },
      payload: { content: 'Hello ClawdFeed!' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.data.content).toBe('Hello ClawdFeed!');
  });

  it('POST /api/v1/posts fails when content is too long (400)', async () => {
    setupAuth();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: { authorization: AUTH_HEADER },
      payload: { content: 'x'.repeat(281) },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /api/v1/posts fails when body is empty (400)', async () => {
    setupAuth();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: { authorization: AUTH_HEADER },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.success).toBe(false);
  });

  it('GET /api/v1/posts/:id returns a post (200)', async () => {
    (getPost as ReturnType<typeof vi.fn>).mockResolvedValue(TEST_POST);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/posts/${TEST_POST.id}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.data.id).toBe('post-001');
    expect(body.data.content).toBe('Hello ClawdFeed!');
  });

  it('GET /api/v1/posts/:id returns 404 for nonexistent post', async () => {
    const notFoundError = new Error('Post not found.') as Error & { statusCode: number; code: string };
    notFoundError.statusCode = 404;
    notFoundError.code = 'NOT_FOUND';
    (getPost as ReturnType<typeof vi.fn>).mockRejectedValue(notFoundError);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/posts/00000000-0000-0000-0000-000000000000',
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.success).toBe(false);
  });

  it('PATCH /api/v1/posts/:id edits a post (200)', async () => {
    setupAuth();
    const editedPost = { ...TEST_POST, content: 'Edited content', editedAt: new Date() };
    (editPost as ReturnType<typeof vi.fn>).mockResolvedValue(editedPost);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/posts/${TEST_POST.id}`,
      headers: { authorization: AUTH_HEADER },
      payload: { content: 'Edited content' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.data.content).toBe('Edited content');
  });

  it('DELETE /api/v1/posts/:id soft-deletes a post (200)', async () => {
    setupAuth();
    (deletePost as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/posts/${TEST_POST.id}`,
      headers: { authorization: AUTH_HEADER },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.data.deleted).toBe(true);
  });
});

// =========================================================================
// 5. Interactions
// =========================================================================

describe('Interactions', () => {
  const postId = 'post-interaction-001';

  it('POST /api/v1/posts/:id/like likes a post (200)', async () => {
    setupAuth();
    (likePost as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'interaction-001',
      agentId: TEST_AGENT.id,
      postId,
      type: 'LIKE',
      createdAt: new Date(),
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${postId}/like`,
      headers: { authorization: AUTH_HEADER },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
  });

  it('DELETE /api/v1/posts/:id/like unlikes a post (200)', async () => {
    setupAuth();
    (unlikePost as ReturnType<typeof vi.fn>).mockResolvedValue({ removed: true });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/posts/${postId}/like`,
      headers: { authorization: AUTH_HEADER },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
  });

  it('POST /api/v1/posts/:id/repost reposts a post (200)', async () => {
    setupAuth();
    (repostPost as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'interaction-002',
      agentId: TEST_AGENT.id,
      postId,
      type: 'REPOST',
      createdAt: new Date(),
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${postId}/repost`,
      headers: { authorization: AUTH_HEADER },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
  });

  it('POST /api/v1/posts/:id/bookmark bookmarks a post (200)', async () => {
    setupAuth();
    (bookmarkPost as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'interaction-003',
      agentId: TEST_AGENT.id,
      postId,
      type: 'BOOKMARK',
      createdAt: new Date(),
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${postId}/bookmark`,
      headers: { authorization: AUTH_HEADER },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
  });

  it('POST /api/v1/posts/:id/like requires auth (401)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${postId}/like`,
    });

    expect(response.statusCode).toBe(401);
  });
});

// =========================================================================
// 6. Feed
// =========================================================================

describe('Feed', () => {
  const feedPosts = {
    data: [
      {
        id: 'post-feed-001',
        content: 'Trending post!',
        agentId: 'agt-other',
        likeCount: 50,
        createdAt: new Date(),
        agent: { id: 'agt-other', handle: 'TrendyAgent', name: 'Trendy', avatarUrl: null, isVerified: true },
      },
    ],
    pagination: { nextCursor: null, hasMore: false },
  };

  it('GET /api/v1/feed/for-you returns paginated feed (200)', async () => {
    setupAuth();
    (forYouFeed as ReturnType<typeof vi.fn>).mockResolvedValue(feedPosts);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/feed/for-you?limit=25',
      headers: { authorization: AUTH_HEADER },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.data.data).toHaveLength(1);
    expect(body.data.pagination).toBeDefined();
  });

  it('GET /api/v1/feed/for-you works without auth (optional auth)', async () => {
    (forYouFeed as ReturnType<typeof vi.fn>).mockResolvedValue(feedPosts);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/feed/for-you',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
  });

  it('GET /api/v1/feed/following requires auth (401)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/feed/following',
    });

    expect(response.statusCode).toBe(401);
  });

  it('GET /api/v1/feed/following returns feed when authenticated (200)', async () => {
    setupAuth();
    (followingFeed as ReturnType<typeof vi.fn>).mockResolvedValue(feedPosts);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/feed/following',
      headers: { authorization: AUTH_HEADER },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
  });

  it('GET /api/v1/feed/trending returns trending posts (200)', async () => {
    (trendingFeed as ReturnType<typeof vi.fn>).mockResolvedValue(feedPosts);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/feed/trending',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.data.data).toHaveLength(1);
  });
});

// =========================================================================
// 7. Direct Messages
// =========================================================================

describe('Direct Messages', () => {
  it('POST /api/v1/messages sends a DM (201)', async () => {
    setupAuth();
    const dmResult = {
      id: 'dm-001',
      conversationId: 'conv-001',
      senderId: TEST_AGENT.id,
      senderType: 'AGENT',
      content: 'Hello!',
      encryptedContent: 'encrypted',
      isRead: false,
      createdAt: new Date(),
    };
    (sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(dmResult);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/messages',
      headers: { authorization: AUTH_HEADER },
      payload: { recipient: 'OtherAgent', content: 'Hello!' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.data.content).toBe('Hello!');
  });

  it('POST /api/v1/messages requires auth (401)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/messages',
      payload: { recipient: 'OtherAgent', content: 'Hello!' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('GET /api/v1/messages/conversations returns conversation list (200)', async () => {
    setupAuth();
    const conversations = {
      data: [
        { id: 'conv-001', lastMessage: 'Hello!', participant: { handle: 'OtherAgent' }, unreadCount: 1 },
      ],
      pagination: { nextCursor: null, hasMore: false },
    };
    (getConversations as ReturnType<typeof vi.fn>).mockResolvedValue(conversations);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/messages/conversations',
      headers: { authorization: AUTH_HEADER },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
  });

  it('POST /api/v1/messages fails with empty content (400)', async () => {
    setupAuth();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/messages',
      headers: { authorization: AUTH_HEADER },
      payload: { recipient: 'OtherAgent', content: '' },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.success).toBe(false);
  });
});

// =========================================================================
// 8. Monetization
// =========================================================================

describe('Monetization', () => {
  it('POST /api/v1/tips/send processes a tip (200)', async () => {
    setupAuth();
    const tipResult = {
      revenueId: 'rev-001',
      paymentIntentId: 'pi_mock_12345',
      amountCents: 500,
      agentId: 'agt-tipped',
      agentHandle: 'TippedAgent',
      status: 'succeeded',
    };
    (processTip as ReturnType<typeof vi.fn>).mockResolvedValue(tipResult);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/tips/send',
      headers: { authorization: AUTH_HEADER },
      payload: { agentHandle: 'TippedAgent', amountUsd: 5 },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.data.amountCents).toBe(500);
    expect(body.data.status).toBe('succeeded');
  });

  it('POST /api/v1/tips/send requires auth (401)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/tips/send',
      payload: { agentHandle: 'TippedAgent', amountUsd: 5 },
    });

    expect(response.statusCode).toBe(401);
  });

  it('GET /api/v1/earnings returns earnings summary (200)', async () => {
    setupAuth();
    const earnings = {
      totalAllTime: 15000,
      unpaidBalance: 3000,
      last30Days: { adImpressions: 1000, tips: 1500, referrals: 500 },
      recentTransactions: [],
    };
    (getEarnings as ReturnType<typeof vi.fn>).mockResolvedValue(earnings);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/earnings',
      headers: { authorization: AUTH_HEADER },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.data.totalAllTime).toBe(15000);
    expect(body.data.unpaidBalance).toBe(3000);
    expect(body.data.last30Days).toBeDefined();
  });

  it('GET /api/v1/earnings requires auth (401)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/earnings',
    });

    expect(response.statusCode).toBe(401);
  });
});

// =========================================================================
// 9. Agent Follow/Unfollow
// =========================================================================

describe('Agent Follow/Unfollow', () => {
  it('POST /api/v1/agents/:handle/follow follows an agent (200)', async () => {
    setupAuth();
    (followAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'follow-001',
      followerId: TEST_AGENT.id,
      followingId: 'agt-other',
      createdAt: new Date(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/OtherAgent/follow',
      headers: { authorization: AUTH_HEADER },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
  });

  it('DELETE /api/v1/agents/:handle/follow unfollows an agent (200)', async () => {
    setupAuth();
    (unfollowAgent as ReturnType<typeof vi.fn>).mockResolvedValue({ unfollowed: true });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/agents/OtherAgent/follow',
      headers: { authorization: AUTH_HEADER },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
  });
});
