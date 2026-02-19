import { prisma } from '../database.js';
import type { Human, Subscription } from '@prisma/client';

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface HumanProfile {
  id: string;
  walletAddress: string;
  tier: string;
  subscriptionExpiresAt: Date | null;
  isProActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpgradeProInput {
  walletAddress: string;
  transactionHash: string;
  amountUsdc: string; // String for BigInt
  durationMonths: number; // Number of months for subscription
}

export interface SubscriptionInfo {
  id: string;
  amountUsdc: string;
  transactionHash: string | null;
  startsAt: Date;
  expiresAt: Date;
  isActive: boolean;
  createdAt: Date;
}

// ------------------------------------------------------------------
// 1. Get or Create Human
// ------------------------------------------------------------------

export async function getOrCreateHuman(walletAddress: string): Promise<HumanProfile> {
  // Normalize wallet address
  const normalizedWallet = walletAddress.toLowerCase();

  // Find or create human
  let human = await prisma.human.findUnique({
    where: { walletAddress: normalizedWallet },
  });

  if (!human) {
    human = await prisma.human.create({
      data: {
        walletAddress: normalizedWallet,
        tier: 'free',
      },
    });
  }

  return formatHumanProfile(human);
}

// ------------------------------------------------------------------
// 2. Get Human Profile
// ------------------------------------------------------------------

export async function getHumanProfile(walletAddress: string): Promise<HumanProfile | null> {
  const normalizedWallet = walletAddress.toLowerCase();

  const human = await prisma.human.findUnique({
    where: { walletAddress: normalizedWallet },
  });

  return human ? formatHumanProfile(human) : null;
}

// ------------------------------------------------------------------
// 3. Upgrade to Pro Tier
// ------------------------------------------------------------------

export async function upgradeToProTier(input: UpgradeProInput): Promise<HumanProfile> {
  const normalizedWallet = input.walletAddress.toLowerCase();

  // Validate input
  if (input.durationMonths < 1 || input.durationMonths > 12) {
    throw new Error('Duration must be between 1 and 12 months');
  }

  const amountBigInt = BigInt(input.amountUsdc);
  if (amountBigInt <= 0n) {
    throw new Error('Amount must be greater than 0');
  }

  // Get or create human
  let human = await prisma.human.findUnique({
    where: { walletAddress: normalizedWallet },
  });

  if (!human) {
    human = await prisma.human.create({
      data: {
        walletAddress: normalizedWallet,
        tier: 'free',
      },
    });
  }

  // Calculate subscription dates
  const now = new Date();
  const startsAt = now;
  const expiresAt = new Date(now);
  expiresAt.setMonth(expiresAt.getMonth() + input.durationMonths);

  // Create subscription record
  await prisma.subscription.create({
    data: {
      humanId: human.id,
      amountUsdc: amountBigInt,
      transactionHash: input.transactionHash,
      startsAt,
      expiresAt,
      isActive: true,
    },
  });

  // Update human tier and expiration
  const updatedHuman = await prisma.human.update({
    where: { id: human.id },
    data: {
      tier: 'pro',
      subscriptionExpiresAt: expiresAt,
    },
  });

  return formatHumanProfile(updatedHuman);
}

// ------------------------------------------------------------------
// 4. Check Pro Tier Status
// ------------------------------------------------------------------

export async function checkProTier(walletAddress: string): Promise<boolean> {
  const normalizedWallet = walletAddress.toLowerCase();

  const human = await prisma.human.findUnique({
    where: { walletAddress: normalizedWallet },
  });

  if (!human) {
    return false;
  }

  // Check if Pro tier and not expired
  if (human.tier === 'pro' && human.subscriptionExpiresAt) {
    return human.subscriptionExpiresAt > new Date();
  }

  return false;
}

// ------------------------------------------------------------------
// 5. Get Subscription History
// ------------------------------------------------------------------

export async function getSubscriptionHistory(
  walletAddress: string,
): Promise<SubscriptionInfo[]> {
  const normalizedWallet = walletAddress.toLowerCase();

  const human = await prisma.human.findUnique({
    where: { walletAddress: normalizedWallet },
  });

  if (!human) {
    return [];
  }

  const subscriptions = await prisma.subscription.findMany({
    where: { humanId: human.id },
    orderBy: { createdAt: 'desc' },
  });

  return subscriptions.map(formatSubscription);
}

// ------------------------------------------------------------------
// 6. Expire Pro Subscriptions (Background Job)
// ------------------------------------------------------------------

export async function expireProSubscriptions(): Promise<number> {
  const now = new Date();

  // Find all humans with expired Pro subscriptions
  const expiredHumans = await prisma.human.findMany({
    where: {
      tier: 'pro',
      subscriptionExpiresAt: {
        lte: now,
      },
    },
  });

  // Update them to basic tier
  const updatePromises = expiredHumans.map((human: any) =>
    prisma.human.update({
      where: { id: human.id },
      data: {
        tier: 'free',
      },
    }),
  );

  await Promise.all(updatePromises);

  // Deactivate expired subscriptions
  await prisma.subscription.updateMany({
    where: {
      isActive: true,
      expiresAt: {
        lte: now,
      },
    },
    data: {
      isActive: false,
    },
  });

  return expiredHumans.length;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function formatHumanProfile(human: Human): HumanProfile {
  const isProActive =
    human.tier === 'pro' &&
    human.subscriptionExpiresAt !== null &&
    human.subscriptionExpiresAt > new Date();

  return {
    id: human.id,
    walletAddress: human.walletAddress,
    tier: human.tier,
    subscriptionExpiresAt: human.subscriptionExpiresAt,
    isProActive,
    createdAt: human.createdAt,
    updatedAt: human.updatedAt,
  };
}

function formatSubscription(sub: Subscription): SubscriptionInfo {
  return {
    id: sub.id,
    amountUsdc: sub.amountUsdc.toString(),
    transactionHash: sub.transactionHash,
    startsAt: sub.startsAt,
    expiresAt: sub.expiresAt,
    isActive: sub.isActive,
    createdAt: sub.createdAt,
  };
}
