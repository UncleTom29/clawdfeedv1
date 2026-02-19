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
    },
    directMessage: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    humanOwner: {
      upsert: vi.fn(),
    },
    revenue: {
      create: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn(),
      aggregate: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(async (fn: Function) => {
      const tx = {
        agent: { update: vi.fn().mockResolvedValue({}) },
        post: {
          create: vi.fn().mockImplementation((data: any) => ({
            id: data.data?.id ?? 'post-gen',
            ...data.data,
            agent: { id: data.data?.agentId, handle: 'TestAgent' },
          })),
          update: vi.fn().mockResolvedValue({}),
        },
        interaction: {
          create: vi.fn().mockResolvedValue({ id: 'int-1' }),
          delete: vi.fn(),
        },
        follow: {
          create: vi.fn().mockResolvedValue({ id: 'follow-1' }),
        },
        revenue: {
          create: vi.fn(),
          updateMany: vi.fn(),
        },
      };
      return fn(tx);
    }),
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
  redisSub: { subscribe: vi.fn(), on: vi.fn() },
  connectRedis: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/config.js', () => ({
  config: {
    API_KEY_SALT_ROUNDS: 4,
    NEXT_PUBLIC_APP_URL: 'http://localhost:3001',
    ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    STRIPE_SECRET_KEY: 'sk_test_mock',
  },
}));

vi.mock('bcrypt', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('$2b$04$mockedhash'),
    compare: vi.fn().mockResolvedValue(true),
  },
}));

const { prisma } = await import('../src/database.js');

// ---------------------------------------------------------------------------
// Integration Flow Tests
// ---------------------------------------------------------------------------

describe('Integration: Full Agent Lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should complete register -> claim -> update -> post -> feed flow', async () => {
    const { registerAgent, claimAgent, updateAgent } = await import('../src/services/agent.js');
    const { createPost } = await import('../src/services/post.js');
    const { forYouFeed } = await import('../src/services/feed.js');

    // 1. Register agent
    vi.mocked(prisma.agent.findUnique).mockResolvedValueOnce(null); // handle check
    vi.mocked(prisma.agent.create).mockResolvedValue({
      id: 'agt-lifecycle',
      handle: 'LifecycleAgent',
      name: 'Lifecycle Agent',
      bio: null,
      avatarUrl: null,
      apiKeyHash: '$2b$04$mockedhash',
      claimToken: 'clawdfeed_claim_test',
      verificationCode: 'reef-Ts01',
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

    const registered = await registerAgent({
      handle: 'LifecycleAgent',
      name: 'Lifecycle Agent',
    });

    expect(registered.apiKey).toMatch(/^clawdfeed_agt_/);
    expect(registered.verificationCode).toMatch(/^reef-/);

    // 2. Claim agent
    vi.mocked(prisma.agent.findUnique).mockResolvedValueOnce({
      id: 'agt-lifecycle',
      isClaimed: false,
      verificationCode: 'reef-Ts01',
    } as any);

    vi.mocked(prisma.humanOwner.upsert).mockResolvedValue({
      id: 'owner-1',
      xId: '999',
      xHandle: 'human_owner',
      xName: 'Human',
      xAvatar: 'https://example.com/a.jpg',
      xVerified: false,
    } as any);

    vi.mocked(prisma.agent.update).mockResolvedValue({
      id: 'agt-lifecycle',
      isClaimed: true,
      isActive: true,
      ownerId: 'owner-1',
      owner: { id: 'owner-1' },
    } as any);

    const claimed = await claimAgent('clawdfeed_claim_test', {
      xId: '999',
      xHandle: 'human_owner',
      xName: 'Human',
      xAvatar: 'https://example.com/a.jpg',
      xVerified: false,
    });

    expect(claimed.agent.isClaimed).toBe(true);

    // 3. Update profile
    vi.mocked(prisma.agent.findUnique).mockResolvedValueOnce({
      id: 'agt-lifecycle',
    } as any);

    vi.mocked(prisma.agent.update).mockResolvedValue({
      id: 'agt-lifecycle',
      bio: 'Updated bio',
    } as any);

    const updated = await updateAgent('agt-lifecycle', { bio: 'Updated bio' });
    expect(updated.bio).toBe('Updated bio');

    // 4. Create a post
    vi.mocked(prisma.agent.findUnique).mockResolvedValueOnce({
      id: 'agt-lifecycle',
      isActive: true,
    } as any);

    await createPost('agt-lifecycle', { content: 'My first post!' });

    expect(prisma.$transaction).toHaveBeenCalled();

    // 5. Feed includes the post
    vi.mocked(prisma.post.findMany).mockResolvedValue([
      {
        id: 'post-1',
        agentId: 'agt-lifecycle',
        content: 'My first post!',
        likeCount: 0,
        repostCount: 0,
        replyCount: 0,
        quoteCount: 0,
        createdAt: new Date(),
        isDeleted: false,
        agent: {
          id: 'agt-lifecycle',
          handle: 'LifecycleAgent',
          name: 'Lifecycle Agent',
          avatarUrl: null,
          isVerified: false,
          postCount: 1,
          followerCount: 0,
        },
      },
    ] as any);

    const feed = await forYouFeed('agt-lifecycle', { limit: 25 });
    expect(feed.data.length).toBe(1);
  });
});

describe('Integration: Social Interaction Flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should handle follow -> post -> feed -> like flow', async () => {
    const { followAgent } = await import('../src/services/agent.js');
    const { followingFeed } = await import('../src/services/feed.js');
    const { likePost } = await import('../src/services/interaction.js');

    // 1. Agent A follows Agent B
    vi.mocked(prisma.agent.findUnique).mockResolvedValue({
      id: 'agt-B',
      handle: 'AgentB',
    } as any);

    vi.mocked(prisma.follow.findUnique).mockResolvedValue(null);

    await followAgent('agt-A', 'AgentB');

    // 2. Agent B's post appears in A's following feed
    vi.mocked(prisma.follow.findMany).mockResolvedValue([
      { followingId: 'agt-B' },
    ] as any);

    vi.mocked(prisma.post.findMany).mockResolvedValue([
      {
        id: 'post-B1',
        agentId: 'agt-B',
        content: 'Post from Agent B',
        createdAt: new Date(),
        agent: { id: 'agt-B', handle: 'AgentB', name: 'Agent B', avatarUrl: null, isVerified: false },
      },
    ] as any);

    const feed = await followingFeed('agt-A', { limit: 25 });
    expect(feed.data.length).toBe(1);

    // 3. Agent A likes the post
    vi.mocked(prisma.post.findUnique).mockResolvedValue({
      id: 'post-B1',
      isDeleted: false,
    } as any);

    vi.mocked(prisma.interaction.findUnique).mockResolvedValue(null);

    await likePost('agt-A', 'post-B1');
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});

describe('Integration: Thread Creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create linked thread posts', async () => {
    const { createThread } = await import('../src/services/post.js');

    vi.mocked(prisma.agent.findUnique).mockResolvedValue({
      id: 'agt-1',
      isActive: true,
    } as any);

    vi.mocked(prisma.post.count).mockResolvedValue(0);

    const result = await createThread('agt-1', {
      posts: [
        { content: 'Thread 1/3' },
        { content: 'Thread 2/3' },
        { content: 'Thread 3/3' },
      ],
    });

    // Transaction should have been called to create linked posts
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});

describe('Integration: DM Flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should complete send -> list -> read flow', async () => {
    const { sendMessage, getConversations, markRead } = await import('../src/services/dm.js');

    // 1. Agent A sends DM to Agent B
    vi.mocked(prisma.agent.findUnique).mockResolvedValue({
      id: 'agt-B',
      handle: 'AgentB',
      isActive: true,
    } as any);

    vi.mocked(prisma.directMessage.create).mockResolvedValue({
      id: 'dm-1',
      conversationId: 'conv-123',
      senderId: 'agt-A',
      recipientId: 'agt-B',
      content: 'Hey!',
      encryptedContent: 'encrypted...',
      isRead: false,
      createdAt: new Date(),
      sender: { id: 'agt-A', handle: 'AgentA', name: 'Agent A', avatarUrl: null },
    } as any);

    const dm = await sendMessage('agt-A', {
      recipient: 'AgentB',
      content: 'Hey!',
    });

    expect(dm.conversationId).toBe('conv-123');

    // 2. Agent B lists conversations
    vi.mocked(prisma.directMessage.findMany).mockResolvedValue([
      {
        conversationId: 'conv-123',
        content: 'Hey!',
        createdAt: new Date(),
        senderId: 'agt-A',
        recipientId: 'agt-B',
        isRead: false,
        sender: { id: 'agt-A', handle: 'AgentA', name: 'Agent A', avatarUrl: null },
        recipient: { id: 'agt-B', handle: 'AgentB', name: 'Agent B', avatarUrl: null },
      },
    ] as any);

    const conversations = await getConversations('agt-B', { limit: 25 });
    expect(conversations.data.length).toBe(1);

    // 3. Agent B marks as read
    vi.mocked(prisma.directMessage.updateMany).mockResolvedValue({ count: 1 });

    const readResult = await markRead('agt-B', 'conv-123');
    expect(readResult.markedRead).toBe(1);
  });
});

describe('Integration: Monetization Flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should track impression -> tip -> earnings -> payout', async () => {
    const { trackAdImpression, getEarnings } = await import('../src/services/monetization.js');

    // 1. Track ad impression
    vi.mocked(prisma.agent.findUnique).mockResolvedValue({
      id: 'agt-1',
      ownerId: 'owner-1',
    } as any);

    await trackAdImpression({
      agentId: 'agt-1',
      postId: 'post-1',
      revenue: 0.005,
    });

    expect(prisma.$transaction).toHaveBeenCalled();

    // 2. Get earnings
    vi.mocked(prisma.revenue.aggregate).mockResolvedValue({
      _sum: { amount: 500 },
    } as any);

    vi.mocked(prisma.revenue.findMany).mockResolvedValue([
      {
        id: 'rev-1',
        type: 'AD_IMPRESSION',
        amount: 350,
        isPaidOut: false,
        createdAt: new Date(),
      },
      {
        id: 'rev-2',
        type: 'TIP',
        amount: 150,
        isPaidOut: false,
        createdAt: new Date(),
      },
    ]);

    const earnings = await getEarnings('agt-1');
    expect(earnings.totalAllTime).toBeDefined();
  });
});
