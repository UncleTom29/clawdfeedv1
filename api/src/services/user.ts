import { prisma } from '../database.js';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { verifyMessage } from 'viem';

/**
 * Authenticate user via wallet signature and return JWT
 */
export async function authenticateWallet(
  walletAddress: string,
  message: string,
  signature: string
): Promise<{ token: string; user: any }> {
  // Verify the signature
  const isValid = await verifyMessage({
    address: walletAddress as `0x${string}`,
    message,
    signature: signature as `0x${string}`,
  });

  if (!isValid) {
    throw new Error('Invalid signature');
  }

  // Get or create human user
  let user = await prisma.human.findUnique({
    where: { walletAddress },
    include: {
      subscriptions: {
        where: {
          isActive: true,
          expiresAt: { gte: new Date() },
        },
        orderBy: { expiresAt: 'desc' },
        take: 1,
      },
    },
  });

  if (!user) {
    user = await prisma.human.create({
      data: {
        walletAddress,
        tier: 'free',
      },
      include: {
        subscriptions: true,
      },
    });
  }

  // Generate JWT token
  const token = jwt.sign(
    {
      sub: user.id,
      wallet: user.walletAddress,
      tier: user.tier,
      type: 'wallet',
    },
    config.JWT_SECRET,
    { expiresIn: '30d' }
  );

  return {
    token,
    user: {
      id: user.id,
      walletAddress: user.walletAddress,
      tier: user.tier,
      subscriptionExpiresAt: user.subscriptionExpiresAt,
    },
  };
}

/**
 * Get current user profile with tier, agents owned, and settings
 */
export async function getCurrentUserProfile(userId: string) {
  const user = await prisma.human.findUnique({
    where: { id: userId },
    include: {
      subscriptions: {
        where: {
          isActive: true,
          expiresAt: { gte: new Date() },
        },
        orderBy: { expiresAt: 'desc' },
        take: 1,
      },
    },
  });

  if (!user) {
    throw new Error('User not found');
  }

  // Get agents owned by this wallet
  const ownedAgents = await prisma.agent.findMany({
    where: {
      ownerWallet: user.walletAddress,
      status: { in: ['CLAIMED', 'MINTED'] },
    },
    select: {
      id: true,
      handle: true,
      name: true,
      avatarUrl: true,
      isVerified: true,
      isFullyVerified: true,
      followerCount: true,
      totalEarnings: true,
    },
  });

  // Get or create user settings
  let settings = await prisma.userSettings.findUnique({
    where: { userId: user.id },
  });

  if (!settings) {
    settings = await prisma.userSettings.create({
      data: { userId: user.id },
    });
  }

  return {
    id: user.id,
    walletAddress: user.walletAddress,
    tier: user.tier,
    subscriptionExpiresAt: user.subscriptionExpiresAt,
    ownedAgents,
    settings: {
      notifications: {
        notifyOnLike: settings.notifyOnLike,
        notifyOnRepost: settings.notifyOnRepost,
        notifyOnReply: settings.notifyOnReply,
        notifyOnFollow: settings.notifyOnFollow,
        notifyOnMention: settings.notifyOnMention,
        notifyOnTip: settings.notifyOnTip,
        notifyOnDm: settings.notifyOnDm,
        emailNotifications: settings.emailNotifications,
        pushNotifications: settings.pushNotifications,
      },
      privacy: {
        dmPermissions: settings.dmPermissions,
        profileVisibility: settings.profileVisibility,
        showTipHistory: settings.showTipHistory,
        showFollowerCount: settings.showFollowerCount,
      },
      appearance: {
        theme: settings.theme,
        language: settings.language,
      },
    },
  };
}

/**
 * Get user's tier status
 */
export async function getUserTierStatus(userId: string) {
  const user = await prisma.human.findUnique({
    where: { id: userId },
  });

  if (!user) {
    throw new Error('User not found');
  }

  const isPro = user.tier === 'pro';
  const isExpired = user.subscriptionExpiresAt
    ? new Date() > user.subscriptionExpiresAt
    : true;

  return {
    tier: user.tier,
    isPro: isPro && !isExpired,
    expiresAt: user.subscriptionExpiresAt,
    needsUpgrade: !isPro || isExpired,
  };
}

/**
 * Update user settings (notifications, privacy, appearance)
 */
export async function updateUserSettings(
  userId: string,
  updates: {
    notifications?: Partial<{
      notifyOnLike: boolean;
      notifyOnRepost: boolean;
      notifyOnReply: boolean;
      notifyOnFollow: boolean;
      notifyOnMention: boolean;
      notifyOnTip: boolean;
      notifyOnDm: boolean;
      emailNotifications: boolean;
      pushNotifications: boolean;
    }>;
    privacy?: Partial<{
      dmPermissions: string;
      profileVisibility: string;
      showTipHistory: boolean;
      showFollowerCount: boolean;
    }>;
    appearance?: Partial<{
      theme: string;
      language: string;
    }>;
  }
) {
  // Get or create settings
  let settings = await prisma.userSettings.findUnique({
    where: { userId },
  });

  if (!settings) {
    settings = await prisma.userSettings.create({
      data: { userId },
    });
  }

  // Build update data
  const updateData: Partial<{
    notifyOnLike: boolean;
    notifyOnRepost: boolean;
    notifyOnReply: boolean;
    notifyOnFollow: boolean;
    notifyOnMention: boolean;
    notifyOnTip: boolean;
    notifyOnDm: boolean;
    emailNotifications: boolean;
    pushNotifications: boolean;
    dmPermissions: string;
    profileVisibility: string;
    showTipHistory: boolean;
    showFollowerCount: boolean;
    theme: string;
    language: string;
  }> = {};
  
  if (updates.notifications) {
    Object.assign(updateData, updates.notifications);
  }
  
  if (updates.privacy) {
    Object.assign(updateData, updates.privacy);
  }
  
  if (updates.appearance) {
    Object.assign(updateData, updates.appearance);
  }

  // Update settings
  const updated = await prisma.userSettings.update({
    where: { userId },
    data: updateData,
  });

  return {
    notifications: {
      notifyOnLike: updated.notifyOnLike,
      notifyOnRepost: updated.notifyOnRepost,
      notifyOnReply: updated.notifyOnReply,
      notifyOnFollow: updated.notifyOnFollow,
      notifyOnMention: updated.notifyOnMention,
      notifyOnTip: updated.notifyOnTip,
      notifyOnDm: updated.notifyOnDm,
      emailNotifications: updated.emailNotifications,
      pushNotifications: updated.pushNotifications,
    },
    privacy: {
      dmPermissions: updated.dmPermissions,
      profileVisibility: updated.profileVisibility,
      showTipHistory: updated.showTipHistory,
      showFollowerCount: updated.showFollowerCount,
    },
    appearance: {
      theme: updated.theme,
      language: updated.language,
    },
  };
}

/**
 * Update user privacy settings specifically
 */
export async function updatePrivacySettings(
  userId: string,
  settings: {
    dmPermissions?: string;
    profileVisibility?: string;
    showTipHistory?: boolean;
    showFollowerCount?: boolean;
  }
) {
  return updateUserSettings(userId, { privacy: settings });
}

/**
 * Get agents owned by current user
 */
export async function getOwnedAgents(walletAddress: string) {
  const agents = await prisma.agent.findMany({
    where: {
      ownerWallet: walletAddress,
      status: { in: ['CLAIMED', 'MINTED'] },
    },
    include: {
      _count: {
        select: {
          posts: true,
          followers: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return agents.map((agent) => ({
    id: agent.id,
    handle: agent.handle,
    name: agent.name,
    bio: agent.bio,
    avatarUrl: agent.avatarUrl,
    isVerified: agent.isVerified,
    isFullyVerified: agent.isFullyVerified,
    status: agent.status,
    followerCount: agent.followerCount,
    postCount: agent._count.posts,
    totalEarnings: agent.totalEarnings,
    dmEnabled: agent.dmEnabled,
    payoutWallet: agent.payoutWallet,
    createdAt: agent.createdAt,
  }));
}

/**
 * Get user's transaction history
 */
export async function getUserTransactions(
  userId: string,
  options?: {
    type?: string;
    limit?: number;
    offset?: number;
  }
) {
  const where: any = { userId };
  
  if (options?.type) {
    where.type = options.type;
  }

  const transactions = await prisma.transaction.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: options?.limit || 50,
    skip: options?.offset || 0,
  });

  const total = await prisma.transaction.count({ where });

  return {
    transactions,
    pagination: {
      total,
      limit: options?.limit || 50,
      offset: options?.offset || 0,
    },
  };
}
