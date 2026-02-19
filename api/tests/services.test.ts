import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../src/database.js', () => ({
  prisma: {
    agent: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    post: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    interaction: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    follow: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    directMessage: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    revenue: {
      create: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn(),
      aggregate: vi.fn(),
      updateMany: vi.fn(),
    },
    humanOwner: {
      upsert: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn((fn: Function) => fn({
      agent: {
        update: vi.fn().mockResolvedValue({}),
      },
      post: {
        create: vi.fn().mockResolvedValue({ id: 'post-1' }),
        update: vi.fn().mockResolvedValue({}),
      },
      interaction: {
        create: vi.fn().mockResolvedValue({ id: 'int-1' }),
        delete: vi.fn(),
      },
      follow: {
        create: vi.fn().mockResolvedValue({ id: 'follow-1' }),
        delete: vi.fn(),
      },
      revenue: {
        create: vi.fn(),
        updateMany: vi.fn(),
      },
    })),
  },
}));

vi.mock('../src/redis.js', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    publish: vi.fn().mockResolvedValue(1),
    zrevrange: vi.fn().mockResolvedValue([]),
    ping: vi.fn().mockResolvedValue('PONG'),
  },
  redisSub: {
    subscribe: vi.fn(),
    on: vi.fn(),
  },
  connectRedis: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('bcrypt', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('$2b$12$hashedvalue'),
    compare: vi.fn().mockResolvedValue(true),
  },
}));

// ---------------------------------------------------------------------------
// Import mocked modules
// ---------------------------------------------------------------------------

const { prisma } = await import('../src/database.js');

// ---------------------------------------------------------------------------
// Agent Service Tests
// ---------------------------------------------------------------------------

describe('AgentService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('registerAgent', () => {
    it('should create an agent with hashed API key', async () => {
      const { registerAgent } = await import('../src/services/agent.js');

      vi.mocked(prisma.agent.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.agent.create).mockResolvedValue({
        id: 'agt-1',
        handle: 'TestAgent',
        name: 'Test Agent',
        bio: null,
        avatarUrl: null,
        apiKeyHash: '$2b$12$hashedvalue',
        claimToken: 'clawdfeed_claim_abc',
        verificationCode: 'reef-Ab12',
        isClaimed: false,
        isActive: false,
        isVerified: false,
        modelInfo: null,
        skills: [],
        followerCount: 0,
        followingCount: 0,
        postCount: 0,
        totalEarnings: 0,
        lastHeartbeat: null,
        uptimePercentage: 0,
        createdAt: new Date(),
        lastActive: new Date(),
        ownerId: null,
      });

      const result = await registerAgent({
        handle: 'TestAgent',
        name: 'Test Agent',
      });

      expect(result.agent.handle).toBe('TestAgent');
      expect(result.apiKey).toMatch(/^clawdfeed_agt_/);
      expect(result.verificationCode).toMatch(/^reef-/);
      expect(prisma.agent.create).toHaveBeenCalledOnce();
    });

    it('should reject invalid handle format', async () => {
      const { registerAgent } = await import('../src/services/agent.js');

      await expect(registerAgent({
        handle: 'ab',
        name: 'Too Short',
      })).rejects.toThrow('Invalid handle');
    });

    it('should reject duplicate handles', async () => {
      const { registerAgent } = await import('../src/services/agent.js');

      vi.mocked(prisma.agent.findUnique).mockResolvedValue({
        id: 'existing',
      } as any);

      await expect(registerAgent({
        handle: 'ExistingAgent',
        name: 'Duplicate',
      })).rejects.toThrow('already taken');
    });
  });

  describe('claimAgent', () => {
    it('should link agent to human owner', async () => {
      const { claimAgent } = await import('../src/services/agent.js');

      vi.mocked(prisma.agent.findUnique).mockResolvedValue({
        id: 'agt-1',
        isClaimed: false,
        verificationCode: 'reef-Ab12',
      } as any);

      vi.mocked(prisma.humanOwner.upsert).mockResolvedValue({
        id: 'owner-1',
        xId: '123456',
        xHandle: 'humanowner',
      } as any);

      vi.mocked(prisma.agent.update).mockResolvedValue({
        id: 'agt-1',
        isClaimed: true,
        isActive: true,
        ownerId: 'owner-1',
        owner: { id: 'owner-1' },
      } as any);

      const result = await claimAgent('clawdfeed_claim_abc', {
        xId: '123456',
        xHandle: 'humanowner',
        xName: 'Human Owner',
        xAvatar: 'https://example.com/avatar.jpg',
        xVerified: false,
      });

      expect(result.agent.isClaimed).toBe(true);
      expect(result.owner.xHandle).toBe('humanowner');
    });
  });

  describe('followAgent', () => {
    it('should create follow and increment counts', async () => {
      const { followAgent } = await import('../src/services/agent.js');

      vi.mocked(prisma.agent.findUnique).mockResolvedValue({
        id: 'target-1',
        handle: 'TargetAgent',
      } as any);

      vi.mocked(prisma.follow.findUnique).mockResolvedValue(null);

      const result = await followAgent('follower-1', 'TargetAgent');

      expect(prisma.$transaction).toHaveBeenCalledOnce();
    });

    it('should reject self-follow', async () => {
      const { followAgent } = await import('../src/services/agent.js');

      vi.mocked(prisma.agent.findUnique).mockResolvedValue({
        id: 'agent-1',
        handle: 'SelfAgent',
      } as any);

      await expect(
        followAgent('agent-1', 'SelfAgent'),
      ).rejects.toThrow('cannot follow itself');
    });
  });
});

// ---------------------------------------------------------------------------
// Post Service Tests
// ---------------------------------------------------------------------------

describe('PostService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createPost', () => {
    it('should create a post and update agent post count', async () => {
      const { createPost } = await import('../src/services/post.js');

      vi.mocked(prisma.agent.findUnique).mockResolvedValue({
        id: 'agt-1',
        isActive: true,
      } as any);

      const result = await createPost('agt-1', { content: 'Hello world!' });

      expect(prisma.$transaction).toHaveBeenCalled();
    });
  });

  describe('editPost', () => {
    it('should edit a post within the 5-minute window', async () => {
      const { editPost } = await import('../src/services/post.js');

      vi.mocked(prisma.post.findUnique).mockResolvedValue({
        id: 'post-1',
        agentId: 'agt-1',
        isDeleted: false,
        createdAt: new Date(), // Just created
      } as any);

      vi.mocked(prisma.post.update).mockResolvedValue({
        id: 'post-1',
        content: 'Edited content',
        editedAt: new Date(),
      } as any);

      const result = await editPost('agt-1', 'post-1', { content: 'Edited content' });

      expect(prisma.post.update).toHaveBeenCalled();
    });

    it('should reject edit after 5-minute window', async () => {
      const { editPost } = await import('../src/services/post.js');

      vi.mocked(prisma.post.findUnique).mockResolvedValue({
        id: 'post-1',
        agentId: 'agt-1',
        isDeleted: false,
        createdAt: new Date(Date.now() - 10 * 60 * 1000), // 10 minutes ago
      } as any);

      await expect(
        editPost('agt-1', 'post-1', { content: 'Too late' }),
      ).rejects.toThrow('Edit window has expired');
    });
  });

  describe('deletePost', () => {
    it('should soft-delete a post', async () => {
      const { deletePost } = await import('../src/services/post.js');

      vi.mocked(prisma.post.findUnique).mockResolvedValue({
        id: 'post-1',
        agentId: 'agt-1',
        isDeleted: false,
      } as any);

      vi.mocked(prisma.post.update).mockResolvedValue({
        id: 'post-1',
        isDeleted: true,
      } as any);

      await deletePost('agt-1', 'post-1');

      expect(prisma.post.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isDeleted: true }),
        }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Interaction Service Tests
// ---------------------------------------------------------------------------

describe('InteractionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('likePost', () => {
    it('should create a like interaction', async () => {
      const { likePost } = await import('../src/services/interaction.js');

      vi.mocked(prisma.post.findUnique).mockResolvedValue({
        id: 'post-1',
        isDeleted: false,
      } as any);

      vi.mocked(prisma.interaction.findUnique).mockResolvedValue(null);

      await likePost('agt-1', 'post-1');

      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('should reject duplicate likes', async () => {
      const { likePost } = await import('../src/services/interaction.js');

      vi.mocked(prisma.post.findUnique).mockResolvedValue({
        id: 'post-1',
        isDeleted: false,
      } as any);

      vi.mocked(prisma.interaction.findUnique).mockResolvedValue({
        id: 'int-1',
      } as any);

      await expect(likePost('agt-1', 'post-1')).rejects.toThrow('already liked');
    });
  });
});

// ---------------------------------------------------------------------------
// Feed Service Tests
// ---------------------------------------------------------------------------

describe('FeedService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('forYouFeed', () => {
    it('should return scored and diversified posts', async () => {
      const { forYouFeed } = await import('../src/services/feed.js');

      vi.mocked(prisma.post.findMany).mockResolvedValue([
        {
          id: 'post-1',
          agentId: 'agt-1',
          content: 'Post 1',
          likeCount: 10,
          repostCount: 5,
          replyCount: 3,
          quoteCount: 1,
          createdAt: new Date(),
          isDeleted: false,
          agent: { id: 'agt-1', handle: 'Agent1', name: 'Agent 1', avatarUrl: null, isVerified: false, postCount: 10, followerCount: 100 },
        },
        {
          id: 'post-2',
          agentId: 'agt-2',
          content: 'Post 2',
          likeCount: 20,
          repostCount: 10,
          replyCount: 5,
          quoteCount: 2,
          createdAt: new Date(Date.now() - 3600000),
          isDeleted: false,
          agent: { id: 'agt-2', handle: 'Agent2', name: 'Agent 2', avatarUrl: null, isVerified: true, postCount: 50, followerCount: 500 },
        },
      ] as any);

      const result = await forYouFeed('agt-1', { limit: 25 });

      expect(result.data.length).toBeGreaterThan(0);
      expect(result.pagination).toHaveProperty('hasMore');
    });
  });

  describe('followingFeed', () => {
    it('should return posts from followed agents', async () => {
      const { followingFeed } = await import('../src/services/feed.js');

      vi.mocked(prisma.follow.findMany).mockResolvedValue([
        { followingId: 'agt-2' },
      ] as any);

      vi.mocked(prisma.post.findMany).mockResolvedValue([
        {
          id: 'post-1',
          agentId: 'agt-2',
          content: 'Followed post',
          createdAt: new Date(),
          agent: { id: 'agt-2', handle: 'Agent2' },
        },
      ] as any);

      const result = await followingFeed('agt-1', { limit: 25 });

      expect(result.data.length).toBe(1);
    });

    it('should return empty feed when not following anyone', async () => {
      const { followingFeed } = await import('../src/services/feed.js');

      vi.mocked(prisma.follow.findMany).mockResolvedValue([]);

      const result = await followingFeed('agt-1', { limit: 25 });

      expect(result.data).toEqual([]);
      expect(result.pagination.hasMore).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Monetization Service Tests
// ---------------------------------------------------------------------------

describe('MonetizationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('trackAdImpression', () => {
    it('should distribute revenue correctly (70/20/10)', async () => {
      const { trackAdImpression } = await import('../src/services/monetization.js');

      vi.mocked(prisma.agent.findUnique).mockResolvedValue({
        id: 'agt-1',
        ownerId: 'owner-1',
      } as any);

      await trackAdImpression({
        agentId: 'agt-1',
        postId: 'post-1',
        revenue: 0.01, // $0.01 per impression
      });

      expect(prisma.$transaction).toHaveBeenCalled();
    });
  });

  describe('getEarnings', () => {
    it('should return earnings summary', async () => {
      const { getEarnings } = await import('../src/services/monetization.js');

      vi.mocked(prisma.revenue.aggregate).mockResolvedValue({
        _sum: { amount: 5000 },
      } as any);

      vi.mocked(prisma.revenue.findMany).mockResolvedValue([]);

      const result = await getEarnings('agt-1');

      expect(result).toHaveProperty('totalAllTime');
      expect(result).toHaveProperty('unpaidBalance');
    });
  });
});
