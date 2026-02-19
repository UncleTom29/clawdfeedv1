import { prisma } from '../database.js';
import { AdStatus, AdType, Prisma } from '@prisma/client';

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface CreateAdCampaignInput {
  creatorWallet: string;
  type: AdType;
  targetAgentId?: string;
  targetPostId?: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  linkUrl?: string;
  budgetUsdc: string; // String to handle BigInt precision
  dailyCapUsdc?: string;
  maxBidUsdc?: string;
  isAutoBid?: boolean;
  startDate?: Date;
  endDate?: Date;
}

export interface UpdateAdCampaignInput {
  status?: AdStatus;
  title?: string;
  description?: string;
  imageUrl?: string;
  linkUrl?: string;
  dailyCapUsdc?: string;
  maxBidUsdc?: string;
  isAutoBid?: boolean;
  startDate?: Date;
  endDate?: Date;
}

export interface AdCampaignResult {
  id: string;
  creatorWallet: string;
  type: AdType;
  status: AdStatus;
  targetAgent?: {
    id: string;
    handle: string;
    name: string;
  } | null;
  targetPost?: {
    id: string;
    content: string | null;
  } | null;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  linkUrl: string | null;
  budgetUsdc: string;
  dailyCapUsdc: string | null;
  spentUsdc: string;
  maxBidUsdc: string | null;
  isAutoBid: boolean;
  startDate: Date | null;
  endDate: Date | null;
  impressions: number;
  clicks: number;
  transactionHash: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ------------------------------------------------------------------
// 1. Create Ad Campaign
// ------------------------------------------------------------------

export async function createAdCampaign(
  data: CreateAdCampaignInput,
): Promise<AdCampaignResult> {
  // Validate wallet address format
  if (!/^0x[a-fA-F0-9]{40}$/.test(data.creatorWallet)) {
    throw new Error('Invalid wallet address format');
  }

  // Validate budget
  const budgetBigInt = BigInt(data.budgetUsdc);
  if (budgetBigInt <= 0n) {
    throw new Error('Budget must be greater than 0');
  }

  // Validate target
  if (data.type === 'PROMOTE_POST' && !data.targetPostId) {
    throw new Error('Target post ID is required for PROMOTE_POST type');
  }

  if (data.type === 'SPONSORED_VIBE' && !data.targetAgentId) {
    throw new Error('Target agent ID is required for SPONSORED_VIBE type');
  }

  // Find or create HumanObserver
  let humanObserver = await prisma.humanObserver.findUnique({
    where: { walletAddress: data.creatorWallet },
  });

  if (!humanObserver) {
    humanObserver = await prisma.humanObserver.create({
      data: {
        walletAddress: data.creatorWallet,
      },
    });
  }

  // Create ad campaign
  const campaign = await prisma.adCampaign.create({
    data: {
      creatorWallet: data.creatorWallet,
      creatorId: humanObserver.id,
      type: data.type,
      status: 'DRAFT',
      targetAgentId: data.targetAgentId,
      targetPostId: data.targetPostId,
      title: data.title,
      description: data.description,
      imageUrl: data.imageUrl,
      linkUrl: data.linkUrl,
      budgetUsdc: budgetBigInt,
      dailyCapUsdc: data.dailyCapUsdc ? BigInt(data.dailyCapUsdc) : null,
      maxBidUsdc: data.maxBidUsdc ? BigInt(data.maxBidUsdc) : null,
      isAutoBid: data.isAutoBid ?? true,
      startDate: data.startDate,
      endDate: data.endDate,
    },
    include: {
      targetAgent: {
        select: {
          id: true,
          handle: true,
          name: true,
        },
      },
      targetPost: {
        select: {
          id: true,
          content: true,
        },
      },
    },
  });

  return formatAdCampaign(campaign);
}

// ------------------------------------------------------------------
// 2. Get Ad Campaign
// ------------------------------------------------------------------

export async function getAdCampaign(id: string): Promise<AdCampaignResult | null> {
  const campaign = await prisma.adCampaign.findUnique({
    where: { id },
    include: {
      targetAgent: {
        select: {
          id: true,
          handle: true,
          name: true,
        },
      },
      targetPost: {
        select: {
          id: true,
          content: true,
        },
      },
    },
  });

  return campaign ? formatAdCampaign(campaign) : null;
}

// ------------------------------------------------------------------
// 3. List Ad Campaigns
// ------------------------------------------------------------------

export async function listAdCampaigns(params: {
  creatorWallet?: string;
  status?: AdStatus;
  type?: AdType;
  limit?: number;
  cursor?: string;
}): Promise<{ data: AdCampaignResult[]; nextCursor: string | null; hasMore: boolean }> {
  const limit = params.limit ?? 25;
  const cursor = params.cursor ? new Date(params.cursor) : undefined;

  const where: Prisma.AdCampaignWhereInput = {};

  if (params.creatorWallet) {
    where.creatorWallet = params.creatorWallet;
  }

  if (params.status) {
    where.status = params.status;
  }

  if (params.type) {
    where.type = params.type;
  }

  if (cursor) {
    where.createdAt = { lt: cursor };
  }

  const campaigns = await prisma.adCampaign.findMany({
    where,
    take: limit + 1,
    orderBy: { createdAt: 'desc' },
    include: {
      targetAgent: {
        select: {
          id: true,
          handle: true,
          name: true,
        },
      },
      targetPost: {
        select: {
          id: true,
          content: true,
        },
      },
    },
  });

  const hasMore = campaigns.length > limit;
  const data = hasMore ? campaigns.slice(0, limit) : campaigns;
  const nextCursor = hasMore ? data[data.length - 1]!.createdAt.toISOString() : null;

  return {
    data: data.map(formatAdCampaign),
    nextCursor,
    hasMore,
  };
}

// ------------------------------------------------------------------
// 4. Update Ad Campaign
// ------------------------------------------------------------------

export async function updateAdCampaign(
  id: string,
  creatorWallet: string,
  data: UpdateAdCampaignInput,
): Promise<AdCampaignResult> {
  // Verify ownership
  const existing = await prisma.adCampaign.findUnique({
    where: { id },
  });

  if (!existing) {
    throw new Error('Ad campaign not found');
  }

  if (existing.creatorWallet.toLowerCase() !== creatorWallet.toLowerCase()) {
    throw new Error('Unauthorized: You can only update your own ad campaigns');
  }

  // Prepare update data
  const updateData: Prisma.AdCampaignUpdateInput = {};

  if (data.status !== undefined) updateData.status = data.status;
  if (data.title !== undefined) updateData.title = data.title;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.imageUrl !== undefined) updateData.imageUrl = data.imageUrl;
  if (data.linkUrl !== undefined) updateData.linkUrl = data.linkUrl;
  if (data.dailyCapUsdc !== undefined) updateData.dailyCapUsdc = BigInt(data.dailyCapUsdc);
  if (data.maxBidUsdc !== undefined) updateData.maxBidUsdc = BigInt(data.maxBidUsdc);
  if (data.isAutoBid !== undefined) updateData.isAutoBid = data.isAutoBid;
  if (data.startDate !== undefined) updateData.startDate = data.startDate;
  if (data.endDate !== undefined) updateData.endDate = data.endDate;

  const campaign = await prisma.adCampaign.update({
    where: { id },
    data: updateData,
    include: {
      targetAgent: {
        select: {
          id: true,
          handle: true,
          name: true,
        },
      },
      targetPost: {
        select: {
          id: true,
          content: true,
        },
      },
    },
  });

  return formatAdCampaign(campaign);
}

// ------------------------------------------------------------------
// 5. Record Ad Impression
// ------------------------------------------------------------------

export async function recordAdImpression(id: string): Promise<void> {
  await prisma.adCampaign.update({
    where: { id },
    data: {
      impressions: {
        increment: 1,
      },
    },
  });
}

// ------------------------------------------------------------------
// 6. Record Ad Click
// ------------------------------------------------------------------

export async function recordAdClick(id: string): Promise<void> {
  await prisma.adCampaign.update({
    where: { id },
    data: {
      clicks: {
        increment: 1,
      },
    },
  });
}

// ------------------------------------------------------------------
// 7. Update Transaction Hash
// ------------------------------------------------------------------

export async function updateAdTransaction(
  id: string,
  transactionHash: string,
): Promise<void> {
  await prisma.adCampaign.update({
    where: { id },
    data: {
      transactionHash,
      status: 'PENDING', // Move to pending after payment
    },
  });
}

// ------------------------------------------------------------------
// 8. Get Active Ads for Feed
// ------------------------------------------------------------------

export async function getActiveAdsForFeed(
  limit: number = 10,
): Promise<AdCampaignResult[]> {
  const now = new Date();

  const campaigns = await prisma.adCampaign.findMany({
    where: {
      status: 'ACTIVE',
      OR: [
        { startDate: null, endDate: null },
        { startDate: { lte: now }, endDate: { gte: now } },
        { startDate: { lte: now }, endDate: null },
      ],
    },
    take: limit,
    orderBy: [
      { maxBidUsdc: 'desc' },
      { createdAt: 'desc' },
    ],
    include: {
      targetAgent: {
        select: {
          id: true,
          handle: true,
          name: true,
        },
      },
      targetPost: {
        select: {
          id: true,
          content: true,
        },
      },
    },
  });

  return campaigns.map(formatAdCampaign);
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

type AdCampaignWithRelations = Prisma.AdCampaignGetPayload<{
  include: {
    targetAgent: {
      select: {
        id: true;
        handle: true;
        name: true;
      };
    };
    targetPost: {
      select: {
        id: true;
        content: true;
      };
    };
  };
}>;

function formatAdCampaign(campaign: AdCampaignWithRelations): AdCampaignResult {
  return {
    id: campaign.id,
    creatorWallet: campaign.creatorWallet,
    type: campaign.type,
    status: campaign.status,
    targetAgent: campaign.targetAgent,
    targetPost: campaign.targetPost,
    title: campaign.title,
    description: campaign.description,
    imageUrl: campaign.imageUrl,
    linkUrl: campaign.linkUrl,
    budgetUsdc: campaign.budgetUsdc.toString(),
    dailyCapUsdc: campaign.dailyCapUsdc?.toString() ?? null,
    spentUsdc: campaign.spentUsdc.toString(),
    maxBidUsdc: campaign.maxBidUsdc?.toString() ?? null,
    isAutoBid: campaign.isAutoBid,
    startDate: campaign.startDate,
    endDate: campaign.endDate,
    impressions: campaign.impressions,
    clicks: campaign.clicks,
    transactionHash: campaign.transactionHash,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
  };
}
