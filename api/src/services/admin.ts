import { prisma } from '../database.js';
import { AdStatus, Prisma } from '@prisma/client';
import { reserveAgentOnChain } from './blockchain.js';
import { scheduleAdInjection, scheduleCampaignExpiration } from '../workers/ad-injection-worker.js';

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface AdminStats {
  totalAgents: number;
  claimedAgents: number;
  mintedAgents: number;
  pendingAds: number;
  activeAds: number;
  totalRevenue: string; // USDC in 6 decimals
}

export interface AdminAgent {
  id: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
  status: string;
  isVerified: boolean;
  isFullyVerified: boolean;
  dmEnabled: boolean;
  ownerWallet: string | null;
  createdAt: Date;
  postCount: number;
  followerCount: number;
}

export interface AdminAd {
  id: string;
  creatorWallet: string;
  type: string;
  status: AdStatus;
  budgetUsdc: string;
  spentUsdc: string;
  impressions: number;
  clicks: number;
  createdAt: Date;
}

// ------------------------------------------------------------------
// 1. Get Admin Statistics
// ------------------------------------------------------------------

export async function getAdminStats(): Promise<AdminStats> {
  const [
    totalAgents,
    claimedAgents,
    mintedAgents,
    pendingAds,
    activeAds,
    totalRevenue,
  ] = await Promise.all([
    prisma.agent.count(),
    prisma.agent.count({ where: { isClaimed: true } }),
    prisma.agent.count({ where: { isFullyVerified: true } }),
    prisma.adCampaign.count({ where: { status: 'PENDING' } }),
    prisma.adCampaign.count({ where: { status: 'ACTIVE' } }),
    prisma.adCampaign.aggregate({
      _sum: { spentUsdc: true },
    }),
  ]);

  return {
    totalAgents,
    claimedAgents,
    mintedAgents,
    pendingAds,
    activeAds,
    totalRevenue: (totalRevenue._sum.spentUsdc ?? BigInt(0)).toString(),
  };
}

// ------------------------------------------------------------------
// 2. List Agents (with pagination and filters)
// ------------------------------------------------------------------

export async function listAgentsAdmin(params: {
  status?: 'UNCLAIMED' | 'RESERVED' | 'CLAIMED' | 'MINTED';
  isVerified?: boolean;
  cursor?: string;
  limit?: number;
}): Promise<{ data: AdminAgent[]; nextCursor: string | null; hasMore: boolean }> {
  const limit = params.limit ?? 25;

  const where: Prisma.AgentWhereInput = {};

  if (params.status) {
    where.status = params.status;
  }

  if (params.isVerified !== undefined) {
    where.isVerified = params.isVerified;
  }

  const agents = await prisma.agent.findMany({
    where,
    take: limit + 1,
    cursor: params.cursor ? { id: params.cursor } : undefined,
    skip: params.cursor ? 1 : 0,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      handle: true,
      name: true,
      avatarUrl: true,
      status: true,
      isVerified: true,
      isFullyVerified: true,
      dmEnabled: true,
      ownerWallet: true,
      createdAt: true,
      postCount: true,
      followerCount: true,
    },
  });

  const hasMore = agents.length > limit;
  const data = hasMore ? agents.slice(0, limit) : agents;
  const nextCursor = hasMore ? data[data.length - 1]!.id : null;

  return {
    data,
    nextCursor,
    hasMore,
  };
}

// ------------------------------------------------------------------
// 3. Approve Agent Verification
// ------------------------------------------------------------------

export async function approveAgentVerification(
  agentId: string,
  approve: boolean,
  adminWallet: string,
): Promise<{ success: boolean; message: string }> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
  });

  if (!agent) {
    throw new Error('Agent not found');
  }

  if (approve) {
    // Approve: set isVerified to true
    await prisma.agent.update({
      where: { id: agentId },
      data: {
        isVerified: true,
        status: agent.status === 'UNCLAIMED' ? 'RESERVED' : agent.status,
      },
    });

    // Optionally reserve on-chain if not already reserved
    if (!agent.reservationHash && agent.ownerWallet) {
      try {
        // Generate reservation hash (keccak256 of agentId + secret)
        const { keccak256, toHex } = await import('viem');
        const reservationHash = keccak256(toHex(`${agentId}-${Date.now()}`));
        const expiryTimestamp = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60); // 7 days
        
        await reserveAgentOnChain(agentId, reservationHash, expiryTimestamp, agent.ownerWallet as `0x${string}`);
        
        // Update agent with reservation details
        await prisma.agent.update({
          where: { id: agentId },
          data: {
            reservationHash,
            reservationExpiresAt: new Date(Number(expiryTimestamp) * 1000),
          },
        });
      } catch (error) {
        console.error('Failed to reserve agent on-chain:', error);
        // Continue even if on-chain reservation fails
      }
    }

    return {
      success: true,
      message: `Agent @${agent.handle} has been verified`,
    };
  } else {
    // Reject: set isVerified to false
    await prisma.agent.update({
      where: { id: agentId },
      data: { isVerified: false },
    });

    return {
      success: true,
      message: `Agent @${agent.handle} verification has been revoked`,
    };
  }
}

// ------------------------------------------------------------------
// 4. List Ad Campaigns (Admin view)
// ------------------------------------------------------------------

export async function listAdsAdmin(params: {
  status?: AdStatus;
  cursor?: string;
  limit?: number;
}): Promise<{ data: AdminAd[]; nextCursor: string | null; hasMore: boolean }> {
  const limit = params.limit ?? 25;

  const where: Prisma.AdCampaignWhereInput = {};

  if (params.status) {
    where.status = params.status;
  }

  const ads = await prisma.adCampaign.findMany({
    where,
    take: limit + 1,
    cursor: params.cursor ? { id: params.cursor } : undefined,
    skip: params.cursor ? 1 : 0,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      creatorWallet: true,
      type: true,
      status: true,
      budgetUsdc: true,
      spentUsdc: true,
      impressions: true,
      clicks: true,
      createdAt: true,
    },
  });

  const hasMore = ads.length > limit;
  const data = hasMore ? ads.slice(0, limit) : ads;
  const nextCursor = hasMore ? data[data.length - 1]!.id : null;

  return {
    data: data.map((ad: any) => ({
      ...ad,
      budgetUsdc: ad.budgetUsdc.toString(),
      spentUsdc: ad.spentUsdc.toString(),
    })),
    nextCursor,
    hasMore,
  };
}

// ------------------------------------------------------------------
// 5. Approve/Reject Ad Campaign
// ------------------------------------------------------------------

export async function approveAdCampaign(
  adId: string,
  approve: boolean,
  reason?: string,
): Promise<{ success: boolean; message: string }> {
  const ad = await prisma.adCampaign.findUnique({
    where: { id: adId },
  });

  if (!ad) {
    throw new Error('Ad campaign not found');
  }

  if (ad.status !== 'PENDING') {
    throw new Error('Only pending ads can be approved or rejected');
  }

  const newStatus: AdStatus = approve ? 'ACTIVE' : 'REJECTED';

  await prisma.adCampaign.update({
    where: { id: adId },
    data: { status: newStatus },
  });

  // Schedule ad injection and expiration if approved
  if (approve) {
    // Schedule first ad injection immediately (or with a small delay)
    await scheduleAdInjection(adId);
    
    // Schedule campaign expiration if there's an end date
    if (ad.endDate) {
      await scheduleCampaignExpiration(adId, ad.endDate);
    }
  }

  return {
    success: true,
    message: approve
      ? `Ad campaign has been approved and is now active`
      : `Ad campaign has been rejected${reason ? `: ${reason}` : ''}`,
  };
}

// ------------------------------------------------------------------
// 6. Moderate Post (Delete/Restore/Flag)
// ------------------------------------------------------------------

export async function moderatePost(
  postId: string,
  action: 'DELETE' | 'RESTORE' | 'FLAG',
  reason?: string,
): Promise<{ success: boolean; message: string }> {
  const post = await prisma.post.findUnique({
    where: { id: postId },
  });

  if (!post) {
    throw new Error('Post not found');
  }

  if (action === 'DELETE') {
    await prisma.post.update({
      where: { id: postId },
      data: { isDeleted: true },
    });

    return {
      success: true,
      message: `Post has been deleted${reason ? `: ${reason}` : ''}`,
    };
  } else if (action === 'RESTORE') {
    await prisma.post.update({
      where: { id: postId },
      data: { isDeleted: false },
    });

    return {
      success: true,
      message: 'Post has been restored',
    };
  } else {
    // FLAG - for now just mark as deleted, could add a separate flag field later
    await prisma.post.update({
      where: { id: postId },
      data: { isDeleted: true },
    });

    return {
      success: true,
      message: `Post has been flagged${reason ? `: ${reason}` : ''}`,
    };
  }
}

// ------------------------------------------------------------------
// 7. Check if wallet is admin
// ------------------------------------------------------------------

export function isAdminWallet(walletAddress: string): boolean {
  const adminWallets = (process.env.ADMIN_WALLETS || '').split(',').map((w) => w.trim().toLowerCase());
  return adminWallets.includes(walletAddress.toLowerCase());
}

// ------------------------------------------------------------------
// 8. Get DM-Eligible Agents for Manual Payouts
// ------------------------------------------------------------------

export async function getDmEligibleAgents(params: {
  cursor?: string;
  limit?: number;
}): Promise<{ data: AdminAgent[]; nextCursor: string | null; hasMore: boolean }> {
  const limit = params.limit ?? 25;

  // Find agents that are:
  // 1. Minted (fully verified)
  // 2. Have DMs enabled
  const agents = await prisma.agent.findMany({
    where: {
      isFullyVerified: true,
      dmEnabled: true,
    },
    take: limit + 1,
    cursor: params.cursor ? { id: params.cursor } : undefined,
    skip: params.cursor ? 1 : 0,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      handle: true,
      name: true,
      avatarUrl: true,
      status: true,
      isVerified: true,
      isFullyVerified: true,
      ownerWallet: true,
      payoutWallet: true,
      dmEnabled: true,
      createdAt: true,
      postCount: true,
      followerCount: true,
      totalEarnings: true,
    },
  });

  const hasMore = agents.length > limit;
  const data = hasMore ? agents.slice(0, limit) : agents;
  const nextCursor = hasMore ? data[data.length - 1]!.id : null;

  return {
    data,
    nextCursor,
    hasMore,
  };
}

// ------------------------------------------------------------------
// 9. Record Manual Payout Distribution
// ------------------------------------------------------------------

export async function recordManualPayout(
  agentId: string,
  amountUsdc: string,
  transactionHash: string,
  adminWallet: string,
): Promise<{ success: boolean; message: string }> {
  // Verify agent exists and is eligible
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: {
      id: true,
      handle: true,
      isFullyVerified: true,
      dmEnabled: true,
      payoutWallet: true,
    },
  });

  if (!agent) {
    throw new Error('Agent not found');
  }

  if (!agent.isFullyVerified) {
    throw new Error('Agent must be fully verified (minted) to receive payouts');
  }

  if (!agent.dmEnabled) {
    throw new Error('Agent must have DMs enabled to receive subscription revenue payouts');
  }

  if (!agent.payoutWallet) {
    throw new Error('Agent must have a payout wallet configured');
  }

  const amountCents = parseInt(amountUsdc) * 100; // Convert USDC to cents

  // Create revenue record
  await prisma.revenue.create({
    data: {
      agentId,
      type: 'TIP', // Using TIP type for manual distributions
      amount: amountCents,
      isPaidOut: true,
      paidOutAt: new Date(),
      transactionHash,
    },
  });

  // Update agent total earnings
  await prisma.agent.update({
    where: { id: agentId },
    data: {
      totalEarnings: {
        increment: amountCents,
      },
    },
  });

  return {
    success: true,
    message: `Manual payout of ${amountUsdc} USDC recorded for @${agent.handle}`,
  };
}

// ------------------------------------------------------------------
// 10. Update Agent Settings (Verification Tick, DM Opt-In)
// ------------------------------------------------------------------

export async function updateAgentSettings(
  agentId: string,
  updates: {
    verificationTick?: 'none' | 'blue' | 'gold';
    dmOptIn?: boolean;
  },
  adminWallet: string,
): Promise<{ success: boolean; agent: AdminAgent }> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
  });

  if (!agent) {
    throw new Error('Agent not found');
  }

  const updateData: Prisma.AgentUpdateInput = {};

  if (updates.verificationTick !== undefined) {
    if (updates.verificationTick === 'none') {
      updateData.isVerified = false;
      updateData.isFullyVerified = false;
    } else if (updates.verificationTick === 'blue') {
      updateData.isVerified = true;
      updateData.isFullyVerified = false;
    } else if (updates.verificationTick === 'gold') {
      updateData.isVerified = true;
      updateData.isFullyVerified = true;
    }
  }

  if (updates.dmOptIn !== undefined) {
    updateData.dmEnabled = updates.dmOptIn;
  }

  const updatedAgent = await prisma.agent.update({
    where: { id: agentId },
    data: updateData,
    select: {
      id: true,
      handle: true,
      name: true,
      avatarUrl: true,
      status: true,
      isVerified: true,
      isFullyVerified: true,
      dmEnabled: true,
      ownerWallet: true,
      createdAt: true,
      postCount: true,
      followerCount: true,
    },
  });

  return {
    success: true,
    agent: {
      id: updatedAgent.id,
      handle: updatedAgent.handle,
      name: updatedAgent.name,
      avatarUrl: updatedAgent.avatarUrl,
      status: updatedAgent.status,
      isVerified: updatedAgent.isVerified,
      isFullyVerified: updatedAgent.isFullyVerified,
      dmEnabled: updatedAgent.dmEnabled,
      ownerWallet: updatedAgent.ownerWallet,
      createdAt: updatedAgent.createdAt,
      postCount: updatedAgent.postCount,
      followerCount: updatedAgent.followerCount,
    },
  };
}

// ------------------------------------------------------------------
// 11. Pause Ad Campaign
// ------------------------------------------------------------------

export async function pauseAdCampaign(
  adId: string,
  adminWallet: string,
): Promise<{ success: boolean; message: string }> {
  const ad = await prisma.adCampaign.findUnique({
    where: { id: adId },
  });

  if (!ad) {
    throw new Error('Ad campaign not found');
  }

  if (ad.status !== 'ACTIVE') {
    throw new Error('Only active campaigns can be paused');
  }

  await prisma.adCampaign.update({
    where: { id: adId },
    data: { status: 'PAUSED' },
  });

  return {
    success: true,
    message: `Ad campaign ${adId} has been paused`,
  };
}

// ------------------------------------------------------------------
// 12. Resume Ad Campaign
// ------------------------------------------------------------------

export async function resumeAdCampaign(
  adId: string,
  adminWallet: string,
): Promise<{ success: boolean; message: string }> {
  const ad = await prisma.adCampaign.findUnique({
    where: { id: adId },
  });

  if (!ad) {
    throw new Error('Ad campaign not found');
  }

  if (ad.status !== 'PAUSED') {
    throw new Error('Only paused campaigns can be resumed');
  }

  await prisma.adCampaign.update({
    where: { id: adId },
    data: { status: 'ACTIVE' },
  });

  // Reschedule ad injection
  await scheduleAdInjection(adId);

  return {
    success: true,
    message: `Ad campaign ${adId} has been resumed`,
  };
}

// ------------------------------------------------------------------
// 13. List All Users with Stats
// ------------------------------------------------------------------

export async function listAllUsers(params: {
  cursor?: string;
  limit?: number;
  tier?: string;
}): Promise<{
  users: Array<{
    id: string;
    walletAddress: string;
    tier: string;
    subscriptionExpiresAt: Date | null;
    createdAt: Date;
    agentsOwned: number;
    totalTransactions: number;
  }>;
  pagination: {
    nextCursor: string | null;
    hasMore: boolean;
  };
}> {
  const { cursor, limit = 50, tier } = params;

  const where: any = {};
  if (tier) {
    where.tier = tier;
  }

  const users = await prisma.human.findMany({
    where,
    take: limit + 1,
    ...(cursor && {
      cursor: { id: cursor },
      skip: 1,
    }),
    orderBy: { createdAt: 'desc' },
    include: {
      subscriptions: {
        where: { isActive: true },
        orderBy: { expiresAt: 'desc' },
        take: 1,
      },
      _count: {
        select: {
          subscriptions: true,
        },
      },
    },
  });

  const hasMore = users.length > limit;
  const results = hasMore ? users.slice(0, limit) : users;
  const nextCursor = hasMore ? results[results.length - 1]?.id : null;

  // Get agents owned by each user
  const usersWithStats = await Promise.all(
    results.map(async (user) => {
      const agentsOwned = await prisma.agent.count({
        where: {
          ownerWallet: user.walletAddress,
          status: { in: ['CLAIMED', 'MINTED'] },
        },
      });

      const totalTransactions = await prisma.transaction.count({
        where: { userId: user.id },
      });

      return {
        id: user.id,
        walletAddress: user.walletAddress,
        tier: user.tier,
        subscriptionExpiresAt: user.subscriptionExpiresAt,
        createdAt: user.createdAt,
        agentsOwned,
        totalTransactions,
      };
    })
  );

  return {
    users: usersWithStats,
    pagination: {
      nextCursor: nextCursor || null,
      hasMore,
    },
  };
}

// ------------------------------------------------------------------
// 14. Get Payment Transactions and Platform Balance
// ------------------------------------------------------------------

export async function getPaymentTransactions(params: {
  cursor?: string;
  limit?: number;
  type?: string;
  status?: string;
}): Promise<{
  transactions: Array<{
    id: string;
    userId: string | null;
    agentId: string | null;
    type: string;
    amount: bigint;
    transactionHash: string;
    status: string;
    createdAt: Date;
    user?: {
      walletAddress: string;
    };
    agent?: {
      handle: string;
      name: string;
    };
  }>;
  platformBalance: {
    totalTips: string;
    totalSubscriptions: string;
    totalAdPayments: string;
    totalPayouts: string;
    availableBalance: string;
  };
  pagination: {
    nextCursor: string | null;
    hasMore: boolean;
  };
}> {
  const { cursor, limit = 50, type, status } = params;

  const where: any = {};
  if (type) {
    where.type = type;
  }
  if (status) {
    where.status = status;
  }

  const transactions = await prisma.transaction.findMany({
    where,
    take: limit + 1,
    ...(cursor && {
      cursor: { id: cursor },
      skip: 1,
    }),
    orderBy: { createdAt: 'desc' },
  });

  const hasMore = transactions.length > limit;
  const results = hasMore ? transactions.slice(0, limit) : transactions;
  const nextCursor = hasMore ? results[results.length - 1]?.id : null;

  // Get user and agent info for each transaction
  const transactionsWithDetails = await Promise.all(
    results.map(async (tx) => {
      const details: any = { ...tx };
      
      if (tx.userId) {
        const user = await prisma.human.findUnique({
          where: { id: tx.userId },
          select: { walletAddress: true },
        });
        details.user = user;
      }
      
      if (tx.agentId) {
        const agent = await prisma.agent.findUnique({
          where: { id: tx.agentId },
          select: { handle: true, name: true },
        });
        details.agent = agent;
      }
      
      return details;
    })
  );

  // Calculate platform balance
  const [tipStats, subStats, adStats, payoutStats] = await Promise.all([
    prisma.transaction.aggregate({
      where: { type: 'tip', status: 'confirmed' },
      _sum: { amount: true },
    }),
    prisma.transaction.aggregate({
      where: { type: 'subscription', status: 'confirmed' },
      _sum: { amount: true },
    }),
    prisma.transaction.aggregate({
      where: { type: 'ad_payment', status: 'confirmed' },
      _sum: { amount: true },
    }),
    prisma.transaction.aggregate({
      where: { type: 'payout', status: 'confirmed' },
      _sum: { amount: true },
    }),
  ]);

  const totalTips = tipStats._sum.amount || BigInt(0);
  const totalSubscriptions = subStats._sum.amount || BigInt(0);
  const totalAdPayments = adStats._sum.amount || BigInt(0);
  const totalPayouts = payoutStats._sum.amount || BigInt(0);
  const availableBalance = totalTips + totalSubscriptions + totalAdPayments - totalPayouts;

  return {
    transactions: transactionsWithDetails,
    platformBalance: {
      totalTips: (Number(totalTips) / 1_000_000).toFixed(2), // Convert to USDC
      totalSubscriptions: (Number(totalSubscriptions) / 1_000_000).toFixed(2),
      totalAdPayments: (Number(totalAdPayments) / 1_000_000).toFixed(2),
      totalPayouts: (Number(totalPayouts) / 1_000_000).toFixed(2),
      availableBalance: (Number(availableBalance) / 1_000_000).toFixed(2),
    },
    pagination: {
      nextCursor: nextCursor || null,
      hasMore,
    },
  };
}

// ------------------------------------------------------------------
// 15. Manual USDC Distribution to Agents
// ------------------------------------------------------------------

export async function distributeUsdcToAgents(
  distributions: Array<{
    agentId: string;
    amount: number; // Amount in USDC
    reason?: string;
  }>,
  adminWallet: string
): Promise<{
  success: boolean;
  distributed: number;
  transactions: Array<{
    agentId: string;
    amount: number;
    transactionId: string;
  }>;
}> {
  const results = [];
  let totalDistributed = 0;

  for (const dist of distributions) {
    const agent = await prisma.agent.findUnique({
      where: { id: dist.agentId },
    });

    if (!agent) {
      throw new Error(`Agent ${dist.agentId} not found`);
    }

    // Record the payout in revenue table
    const revenue = await prisma.revenue.create({
      data: {
        agentId: dist.agentId,
        type: 'REFERRAL', // Using REFERRAL as a generic admin payout type
        amount: Math.round(dist.amount * 100), // Convert to cents
        isPaidOut: true,
        paidOutAt: new Date(),
        transactionHash: `admin-payout-${Date.now()}`,
      },
    });

    // Update agent's total earnings
    await prisma.agent.update({
      where: { id: dist.agentId },
      data: {
        totalEarnings: {
          increment: Math.round(dist.amount * 100),
        },
      },
    });

    // Record transaction for tracking
    const transaction = await prisma.transaction.create({
      data: {
        agentId: dist.agentId,
        type: 'payout',
        amount: BigInt(Math.round(dist.amount * 1_000_000)), // Convert to USDC (6 decimals)
        transactionHash: revenue.transactionHash || '',
        status: 'confirmed',
        metadata: {
          reason: dist.reason || 'Admin manual distribution',
          adminWallet,
        },
      },
    });

    results.push({
      agentId: dist.agentId,
      amount: dist.amount,
      transactionId: transaction.id,
    });

    totalDistributed += dist.amount;
  }

  return {
    success: true,
    distributed: totalDistributed,
    transactions: results,
  };
}

