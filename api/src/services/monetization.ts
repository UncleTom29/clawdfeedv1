import { Prisma } from '@prisma/client';

/** Revenue types as defined in the Prisma schema. */
export enum RevenueType {
  AD_IMPRESSION = 'AD_IMPRESSION',
  TIP = 'TIP',
  REFERRAL = 'REFERRAL',
}
import { randomUUID } from 'node:crypto';
import { prisma } from '../database.js';
import { redis } from '../redis.js';
import { config } from '../config.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Input for recording an ad impression. */
export interface TrackAdImpressionInput {
  agentId: string;
  postId: string;
  humanViewerId?: string;
  /** Total gross revenue in USD cents for this impression. */
  revenue: number;
}

/** Result returned after tracking an ad impression. */
export interface TrackAdImpressionResult {
  revenueId: string;
  agentShare: number;
  platformShare: number;
  ownerShare: number;
}

/** Input for processing a tip payment. */
export interface ProcessTipInput {
  tipperId: string;
  agentHandle: string;
  /** Tip amount in whole US dollars. */
  amountUsd: number;
  postId?: string;
  message?: string;
}

/** Confirmation returned after a tip is processed. */
export interface ProcessTipResult {
  revenueId: string;
  paymentIntentId: string;
  amountCents: number;
  agentId: string;
  agentHandle: string;
  status: 'succeeded' | 'pending';
}

/** Breakdown of unpaid earnings by category. */
export interface PayoutBreakdown {
  adImpressions: number;
  tips: number;
  referrals: number;
}

/** Calculated payout summary for an agent. */
export interface CalculatePayoutResult {
  /** Total unpaid balance in USD cents. */
  totalCents: number;
  breakdown: PayoutBreakdown;
}

/** A single payout entry in the weekly batch. */
export interface PayoutEntry {
  agentId: string;
  agentHandle: string;
  totalCents: number;
  revenueCount: number;
  transactionHash: string;
}

/** Summary returned after processing weekly payouts. */
export interface WeeklyPayoutSummary {
  processedAt: Date;
  totalAgentsPaid: number;
  totalAmountCents: number;
  payouts: PayoutEntry[];
}

/** Earnings summary for an agent. */
export interface EarningsSummary {
  totalAllTime: number;
  unpaidBalance: number;
  last30Days: PayoutBreakdown;
  recentTransactions: RecentTransaction[];
}

/** A single recent revenue transaction. */
export interface RecentTransaction {
  id: string;
  type: RevenueType;
  amount: number;
  postId: string | null;
  tipperId: string | null;
  isPaidOut: boolean;
  paidOutAt: Date | null;
  transactionHash: string | null;
  createdAt: Date;
}

/** Referral-specific stats for an agent. */
export interface ReferralStats {
  totalReferralEarnings: number;
  unpaidReferralBalance: number;
  referralCount: number;
  recentReferrals: RecentTransaction[];
}

// ─── Revenue split constants ──────────────────────────────────────────────────

/** Fraction of ad revenue allocated to the agent. */
const AGENT_SHARE = 0.70;
/** Fraction of ad revenue allocated to the platform. */
const PLATFORM_SHARE = 0.20;
/** Fraction of ad revenue allocated to the agent's human owner. */
const OWNER_SHARE = 0.10;

/** Minimum unpaid balance (in USD cents) required to trigger a payout. */
const MINIMUM_PAYOUT_CENTS = 1000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generate a mock transaction hash that resembles a blockchain tx id.
 * In production this would come from an actual on-chain transfer.
 */
function generateMockTransactionHash(): string {
  return `0x${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '').slice(0, 32)}`;
}

/**
 * Create a mock Stripe PaymentIntent.
 * When a real Stripe secret key is configured, this will be replaced with an
 * actual Stripe SDK call. For development / testing the mock is sufficient.
 */
async function createPaymentIntent(amountCents: number, metadata: Record<string, string>): Promise<{
  id: string;
  status: 'succeeded' | 'pending';
}> {
  // If a real Stripe key is configured, delegate to the Stripe SDK.
  if (config.STRIPE_SECRET_KEY && !config.STRIPE_SECRET_KEY.startsWith('sk_test_mock')) {
    try {
      // Dynamic import so the module is only loaded when actually needed.
      const Stripe = (await import('stripe')).default;
      const stripe = new Stripe(config.STRIPE_SECRET_KEY);

      const intent = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: 'usd',
        metadata,
        // In a real integration, confirmation would happen client-side.
        // For server-initiated tips we auto-confirm.
        confirm: true,
        automatic_payment_methods: {
          enabled: true,
          allow_redirects: 'never',
        },
      });

      return {
        id: intent.id,
        status: intent.status === 'succeeded' ? 'succeeded' : 'pending',
      };
    } catch (err) {
      console.error('[monetization] Stripe PaymentIntent creation failed:', err);
      throw new Error('Payment processing failed. Please try again later.');
    }
  }

  // Mock payment intent for development / test environments.
  return {
    id: `pi_mock_${randomUUID().replace(/-/g, '')}`,
    status: 'succeeded',
  };
}

// ─── Service functions ────────────────────────────────────────────────────────

/**
 * Record an ad impression and split the revenue between agent, platform, and owner.
 *
 * Revenue is split as follows:
 * - 70 % to the agent
 * - 20 % to the platform (not stored as Revenue, tracked externally)
 * - 10 % to the agent's human owner (added to the owner's totalEarnings)
 *
 * All database mutations happen inside a single Prisma transaction to guarantee
 * atomicity.
 *
 * @param data - Ad impression details including gross revenue in cents.
 * @returns Breakdown of the revenue split and the created Revenue record id.
 * @throws Error if the agent or post does not exist.
 */
export async function trackAdImpression(
  data: TrackAdImpressionInput,
): Promise<TrackAdImpressionResult> {
  const { agentId, postId, revenue } = data;

  if (revenue <= 0) {
    throw new Error('Revenue must be a positive number.');
  }

  // Verify agent exists and fetch owner info in one query.
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, ownerId: true },
  });

  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  // Verify post exists and belongs to the agent.
  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: { id: true, agentId: true },
  });

  if (!post) {
    throw new Error(`Post not found: ${postId}`);
  }

  if (post.agentId !== agentId) {
    throw new Error(`Post ${postId} does not belong to agent ${agentId}.`);
  }

  // Calculate shares (floor to avoid fractional cents).
  const agentShare = Math.floor(revenue * AGENT_SHARE);
  const platformShare = Math.floor(revenue * PLATFORM_SHARE);
  const ownerShare = Math.floor(revenue * OWNER_SHARE);

  const result = await prisma.$transaction(async (tx: { revenue: { create: (arg0: { data: { agentId: string; type: RevenueType; amount: number; postId: string; }; }) => any; }; agent: { update: (arg0: { where: { id: string; }; data: { totalEarnings: { increment: number; }; }; }) => any; }; humanOwner: { update: (arg0: { where: { id: any; }; data: { totalEarnings: { increment: number; }; }; }) => any; }; }) => {
    // 1. Create Revenue record for the agent's share.
    const revenueRecord = await tx.revenue.create({
      data: {
        agentId,
        type: RevenueType.AD_IMPRESSION,
        amount: agentShare,
        postId,
      },
    });

    // 2. Increment the agent's lifetime earnings.
    await tx.agent.update({
      where: { id: agentId },
      data: {
        totalEarnings: { increment: agentShare },
      },
    });

    // 3. If the agent has an owner, credit the owner their share.
    if (agent.ownerId) {
      await tx.humanOwner.update({
        where: { id: agent.ownerId },
        data: {
          totalEarnings: { increment: ownerShare },
        },
      });
    }

    return revenueRecord;
  });

  return {
    revenueId: result.id,
    agentShare,
    platformShare,
    ownerShare,
  };
}

/**
 * Process a tip from a human user to an AI agent.
 *
 * Workflow:
 * 1. Look up the target agent by handle.
 * 2. Create a Stripe PaymentIntent (or mock) for the tip amount.
 * 3. Record a TIP-type Revenue entry for the full tip amount.
 * 4. Update the agent's lifetime earnings.
 * 5. Publish a real-time notification via Redis Pub/Sub.
 *
 * @param data - Tip details including tipper, target handle, and amount in USD.
 * @returns Payment confirmation with intent id and amount.
 * @throws Error if the agent is not found or payment fails.
 */
export async function processTip(
  tipperId: string,
  data: Omit<ProcessTipInput, 'tipperId'>,
): Promise<ProcessTipResult> {
  const { agentHandle, amountUsd, postId, message } = data;

  if (amountUsd <= 0) {
    throw new Error('Tip amount must be a positive number.');
  }

  const amountCents = Math.round(amountUsd * 100);

  // Look up agent by handle.
  const agent = await prisma.agent.findUnique({
    where: { handle: agentHandle },
    select: { id: true, handle: true, name: true, isActive: true },
  });

  if (!agent) {
    throw new Error(`Agent not found with handle: @${agentHandle}`);
  }

  if (!agent.isActive) {
    throw new Error(`Agent @${agentHandle} is currently inactive and cannot receive tips.`);
  }

  // Create the payment intent.
  const paymentIntent = await createPaymentIntent(amountCents, {
    type: 'tip',
    tipperId,
    agentId: agent.id,
    agentHandle: agent.handle,
    ...(postId ? { postId } : {}),
    ...(message ? { message: message.slice(0, 500) } : {}),
  });

  // Only record revenue if the payment succeeded (or is mock-succeeded).
  if (paymentIntent.status !== 'succeeded') {
    return {
      revenueId: '',
      paymentIntentId: paymentIntent.id,
      amountCents,
      agentId: agent.id,
      agentHandle: agent.handle,
      status: 'pending',
    };
  }

  // Persist the tip revenue in a transaction.
  const revenueRecord = await prisma.$transaction(async (tx: { revenue: { create: (arg0: { data: { agentId: any; type: RevenueType; amount: number; postId: string | null; tipperId: string; }; }) => any; }; agent: { update: (arg0: { where: { id: any; }; data: { totalEarnings: { increment: number; }; }; }) => any; }; }) => {
    const rev = await tx.revenue.create({
      data: {
        agentId: agent.id,
        type: RevenueType.TIP,
        amount: amountCents,
        postId: postId ?? null,
        tipperId,
      },
    });

    await tx.agent.update({
      where: { id: agent.id },
      data: {
        totalEarnings: { increment: amountCents },
      },
    });

    return rev;
  });

  // Publish real-time tip notification via Redis.
  try {
    const tipEvent = JSON.stringify({
      type: 'tip_received',
      agentId: agent.id,
      agentHandle: agent.handle,
      tipperId,
      amountCents,
      postId: postId ?? null,
      message: message ?? null,
      revenueId: revenueRecord.id,
      timestamp: new Date().toISOString(),
    });

    await redis.publish(`agent:${agent.id}:events`, tipEvent);
    await redis.publish('tips:live', tipEvent);
  } catch (err) {
    // Redis publish failures should not roll back the payment.
    console.error('[monetization] Failed to publish tip event to Redis:', err);
  }

  return {
    revenueId: revenueRecord.id,
    paymentIntentId: paymentIntent.id,
    amountCents,
    agentId: agent.id,
    agentHandle: agent.handle,
    status: 'succeeded',
  };
}

/**
 * Calculate the outstanding (unpaid) payout for a given agent.
 *
 * Returns the total unpaid balance along with a breakdown by revenue type.
 *
 * @param agentId - The agent's unique identifier.
 * @returns Payout totals and per-category breakdown in USD cents.
 * @throws Error if the agent does not exist.
 */
export async function calculatePayout(
  agentId: string,
): Promise<CalculatePayoutResult> {
  // Verify agent exists.
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true },
  });

  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  // Aggregate unpaid revenue grouped by type.
  const aggregations = await prisma.revenue.groupBy({
    by: ['type'],
    where: {
      agentId,
      isPaidOut: false,
    },
    _sum: {
      amount: true,
    },
  });

  const breakdown: PayoutBreakdown = {
    adImpressions: 0,
    tips: 0,
    referrals: 0,
  };

  let totalCents = 0;

  for (const group of aggregations) {
    const sum = group._sum.amount ?? 0;
    totalCents += sum;

    switch (group.type) {
      case RevenueType.AD_IMPRESSION:
        breakdown.adImpressions = sum;
        break;
      case RevenueType.TIP:
        breakdown.tips = sum;
        break;
      case RevenueType.REFERRAL:
        breakdown.referrals = sum;
        break;
    }
  }

  return { totalCents, breakdown };
}

/**
 * Process weekly payouts for all eligible agents.
 *
 * An agent is eligible when their unpaid revenue balance meets or exceeds the
 * minimum payout threshold ($10.00 / 1000 cents).
 *
 * For each eligible agent:
 * 1. Sum all unpaid revenue records.
 * 2. Mark every unpaid revenue record as paid with the current timestamp.
 * 3. Generate a mock transaction hash (replace with real chain tx in production).
 *
 * All mutations for a single agent happen inside a Prisma transaction to
 * guarantee consistency.
 *
 * @returns A summary of all payouts processed in this batch.
 */
export async function processWeeklyPayouts(): Promise<WeeklyPayoutSummary> {
  const processedAt = new Date();

  // Find all agents that have unpaid revenue meeting the minimum threshold.
  // We use a raw aggregation to identify eligible agent ids.
  const eligibleAgents = await prisma.revenue.groupBy({
    by: ['agentId'],
    where: {
      isPaidOut: false,
    },
    _sum: {
      amount: true,
    },
    having: {
      amount: {
        _sum: {
          gte: MINIMUM_PAYOUT_CENTS,
        },
      },
    },
  });

  if (eligibleAgents.length === 0) {
    return {
      processedAt,
      totalAgentsPaid: 0,
      totalAmountCents: 0,
      payouts: [],
    };
  }

  const payouts: PayoutEntry[] = [];
  let totalAmountCents = 0;

  for (const eligible of eligibleAgents) {
    const agentId = eligible.agentId;
    const totalCents = eligible._sum.amount ?? 0;

    try {
      const transactionHash = generateMockTransactionHash();

      await prisma.$transaction(async (tx: { revenue: { updateMany: (arg0: { where: { agentId: any; isPaidOut: boolean; }; data: { isPaidOut: boolean; paidOutAt: Date; transactionHash: string; }; }) => any; }; }) => {
        // Mark all unpaid revenues for this agent as paid.
        await tx.revenue.updateMany({
          where: {
            agentId,
            isPaidOut: false,
          },
          data: {
            isPaidOut: true,
            paidOutAt: processedAt,
            transactionHash,
          },
        });
      });

      // Fetch the agent handle for the summary.
      const agent = await prisma.agent.findUnique({
        where: { id: agentId },
        select: { handle: true },
      });

      const revenueCount = await prisma.revenue.count({
        where: {
          agentId,
          isPaidOut: true,
          paidOutAt: processedAt,
          transactionHash,
        },
      });

      payouts.push({
        agentId,
        agentHandle: agent?.handle ?? 'unknown',
        totalCents,
        revenueCount,
        transactionHash,
      });

      totalAmountCents += totalCents;
    } catch (err) {
      // Log and continue -- one failed payout should not abort the entire batch.
      console.error(
        `[monetization] Failed to process payout for agent ${agentId}:`,
        err,
      );
    }
  }

  return {
    processedAt,
    totalAgentsPaid: payouts.length,
    totalAmountCents,
    payouts,
  };
}

/**
 * Retrieve a comprehensive earnings summary for an agent.
 *
 * Includes:
 * - All-time total earnings.
 * - Current unpaid balance.
 * - Breakdown of the last 30 days by revenue type.
 * - The 20 most recent revenue transactions.
 *
 * @param agentId - The agent's unique identifier.
 * @returns Full earnings summary.
 * @throws Error if the agent does not exist.
 */
export async function getEarnings(agentId: string): Promise<EarningsSummary> {
  // Verify agent exists and get lifetime earnings.
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, totalEarnings: true },
  });

  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  // Calculate unpaid balance.
  const unpaidAgg = await prisma.revenue.aggregate({
    where: {
      agentId,
      isPaidOut: false,
    },
    _sum: {
      amount: true,
    },
  });

  const unpaidBalance = unpaidAgg._sum.amount ?? 0;

  // Last 30 days breakdown.
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const last30DaysAgg = await prisma.revenue.groupBy({
    by: ['type'],
    where: {
      agentId,
      createdAt: { gte: thirtyDaysAgo },
    },
    _sum: {
      amount: true,
    },
  });

  const last30Days: PayoutBreakdown = {
    adImpressions: 0,
    tips: 0,
    referrals: 0,
  };

  for (const group of last30DaysAgg) {
    const sum = group._sum.amount ?? 0;
    switch (group.type) {
      case RevenueType.AD_IMPRESSION:
        last30Days.adImpressions = sum;
        break;
      case RevenueType.TIP:
        last30Days.tips = sum;
        break;
      case RevenueType.REFERRAL:
        last30Days.referrals = sum;
        break;
    }
  }

  // Recent transactions (last 20).
  const recent = await prisma.revenue.findMany({
    where: { agentId },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true,
      type: true,
      amount: true,
      postId: true,
      tipperId: true,
      isPaidOut: true,
      paidOutAt: true,
      transactionHash: true,
      createdAt: true,
    },
  });

  const recentTransactions: RecentTransaction[] = recent.map((r: { id: any; type: any; amount: any; postId: any; tipperId: any; isPaidOut: any; paidOutAt: any; transactionHash: any; createdAt: any; }) => ({
    id: r.id,
    type: r.type,
    amount: r.amount,
    postId: r.postId,
    tipperId: r.tipperId,
    isPaidOut: r.isPaidOut,
    paidOutAt: r.paidOutAt,
    transactionHash: r.transactionHash,
    createdAt: r.createdAt,
  }));

  return {
    totalAllTime: agent.totalEarnings,
    unpaidBalance,
    last30Days,
    recentTransactions,
  };
}

/**
 * Retrieve referral-specific earnings and statistics for an agent.
 *
 * @param agentId - The agent's unique identifier.
 * @returns Referral earnings totals and recent referral revenue entries.
 * @throws Error if the agent does not exist.
 */
export async function getReferralStats(
  agentId: string,
): Promise<ReferralStats> {
  // Verify agent exists.
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true },
  });

  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  // Total referral earnings (all time).
  const totalAgg = await prisma.revenue.aggregate({
    where: {
      agentId,
      type: RevenueType.REFERRAL,
    },
    _sum: {
      amount: true,
    },
    _count: {
      id: true,
    },
  });

  const totalReferralEarnings = totalAgg._sum.amount ?? 0;
  const referralCount = totalAgg._count.id;

  // Unpaid referral balance.
  const unpaidAgg = await prisma.revenue.aggregate({
    where: {
      agentId,
      type: RevenueType.REFERRAL,
      isPaidOut: false,
    },
    _sum: {
      amount: true,
    },
  });

  const unpaidReferralBalance = unpaidAgg._sum.amount ?? 0;

  // Recent referral transactions.
  const recent = await prisma.revenue.findMany({
    where: {
      agentId,
      type: RevenueType.REFERRAL,
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true,
      type: true,
      amount: true,
      postId: true,
      tipperId: true,
      isPaidOut: true,
      paidOutAt: true,
      transactionHash: true,
      createdAt: true,
    },
  });

  const recentReferrals: RecentTransaction[] = recent.map((r: { id: any; type: any; amount: any; postId: any; tipperId: any; isPaidOut: any; paidOutAt: any; transactionHash: any; createdAt: any; }) => ({
    id: r.id,
    type: r.type,
    amount: r.amount,
    postId: r.postId,
    tipperId: r.tipperId,
    isPaidOut: r.isPaidOut,
    paidOutAt: r.paidOutAt,
    transactionHash: r.transactionHash,
    createdAt: r.createdAt,
  }));

  return {
    totalReferralEarnings,
    unpaidReferralBalance,
    referralCount,
    recentReferrals,
  };
}

// ─── Get Tip History for an Agent ────────────────────────────────────────────

export interface TipHistoryItem {
  id: string;
  amount: number;
  tipperId: string;
  postId: string | null;
  createdAt: Date;
  isPaidOut: boolean;
  paidOutAt: Date | null;
  transactionHash: string | null;
}

export async function getTipHistory(
  agentId: string,
  options?: {
    limit?: number;
    offset?: number;
  }
): Promise<{ tips: TipHistoryItem[]; total: number }> {
  const { limit = 50, offset = 0 } = options || {};

  const where = {
    agentId,
    type: RevenueType.TIP,
  };

  const [tips, total] = await Promise.all([
    prisma.revenue.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      select: {
        id: true,
        amount: true,
        tipperId: true,
        postId: true,
        createdAt: true,
        isPaidOut: true,
        paidOutAt: true,
        transactionHash: true,
      },
    }),
    prisma.revenue.count({ where }),
  ]);

  return {
    tips: tips.map((tip) => ({
      id: tip.id,
      amount: tip.amount,
      tipperId: tip.tipperId || '',
      postId: tip.postId,
      createdAt: tip.createdAt,
      isPaidOut: tip.isPaidOut,
      paidOutAt: tip.paidOutAt,
      transactionHash: tip.transactionHash,
    })),
    total,
  };
}

