import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getOrCreateHuman,
  upgradeToProTier,
  checkProTier,
  getSubscriptionHistory,
} from '../src/services/human.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockHuman = {
  id: 'human-1',
  walletAddress: '0x123456789',
  tier: 'basic',
  subscriptionExpiresAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockProHuman = {
  id: 'human-2',
  walletAddress: '0xabcdef123',
  tier: 'pro',
  subscriptionExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockSubscription = {
  id: 'sub-1',
  humanId: 'human-1',
  amountUsdc: BigInt(10000000), // 10 USDC (6 decimals)
  transactionHash: '0xabcd1234',
  startsAt: new Date(),
  expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  isActive: true,
  createdAt: new Date(),
};

vi.mock('../src/database.js', () => ({
  prisma: {
    human: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    subscription: {
      create: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

import { prisma } from '../src/database.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Human Tier Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getOrCreateHuman', () => {
    it('should create a new human if not exists', async () => {
      vi.mocked(prisma.human.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.human.create).mockResolvedValue(mockHuman);

      const result = await getOrCreateHuman('0x123456789');

      expect(result.walletAddress).toBe('0x123456789');
      expect(result.tier).toBe('basic');
      expect(result.isProActive).toBe(false);
      expect(prisma.human.create).toHaveBeenCalledWith({
        data: {
          walletAddress: '0x123456789',
          tier: 'basic',
        },
      });
    });

    it('should return existing human', async () => {
      vi.mocked(prisma.human.findUnique).mockResolvedValue(mockHuman);

      const result = await getOrCreateHuman('0x123456789');

      expect(result.walletAddress).toBe('0x123456789');
      expect(prisma.human.create).not.toHaveBeenCalled();
    });
  });

  describe('upgradeToProTier', () => {
    it('should upgrade user to Pro tier', async () => {
      vi.mocked(prisma.human.findUnique).mockResolvedValue(mockHuman);
      vi.mocked(prisma.subscription.create).mockResolvedValue(mockSubscription);
      vi.mocked(prisma.human.update).mockResolvedValue({
        ...mockHuman,
        tier: 'pro',
        subscriptionExpiresAt: mockSubscription.expiresAt,
      });

      const result = await upgradeToProTier({
        walletAddress: '0x123456789',
        transactionHash: '0xabcd1234',
        amountUsdc: '10',
        durationMonths: 1,
      });

      expect(result.tier).toBe('pro');
      expect(result.subscriptionExpiresAt).toBeTruthy();
      expect(prisma.subscription.create).toHaveBeenCalled();
      expect(prisma.human.update).toHaveBeenCalled();
    });

    it('should reject invalid duration', async () => {
      await expect(
        upgradeToProTier({
          walletAddress: '0x123456789',
          transactionHash: '0xabcd1234',
          amountUsdc: '10',
          durationMonths: 0,
        })
      ).rejects.toThrow('Duration must be between 1 and 12 months');
    });

    it('should reject zero amount', async () => {
      await expect(
        upgradeToProTier({
          walletAddress: '0x123456789',
          transactionHash: '0xabcd1234',
          amountUsdc: '0',
          durationMonths: 1,
        })
      ).rejects.toThrow('Amount must be greater than 0');
    });
  });

  describe('checkProTier', () => {
    it('should return true for active Pro user', async () => {
      vi.mocked(prisma.human.findUnique).mockResolvedValue(mockProHuman);

      const result = await checkProTier('0xabcdef123');

      expect(result).toBe(true);
    });

    it('should return false for basic user', async () => {
      vi.mocked(prisma.human.findUnique).mockResolvedValue(mockHuman);

      const result = await checkProTier('0x123456789');

      expect(result).toBe(false);
    });

    it('should return false for non-existent user', async () => {
      vi.mocked(prisma.human.findUnique).mockResolvedValue(null);

      const result = await checkProTier('0xnonexistent');

      expect(result).toBe(false);
    });

    it('should return false for expired Pro subscription', async () => {
      const expiredHuman = {
        ...mockProHuman,
        subscriptionExpiresAt: new Date(Date.now() - 1000), // Expired
      };
      vi.mocked(prisma.human.findUnique).mockResolvedValue(expiredHuman);

      const result = await checkProTier('0xabcdef123');

      expect(result).toBe(false);
    });
  });

  describe('getSubscriptionHistory', () => {
    it('should return subscription history for user', async () => {
      vi.mocked(prisma.human.findUnique).mockResolvedValue(mockHuman);
      vi.mocked(prisma.subscription.findMany).mockResolvedValue([mockSubscription]);

      const result = await getSubscriptionHistory('0x123456789');

      expect(result).toHaveLength(1);
      expect(result[0].amountUsdc).toBe('10000000');
      expect(result[0].transactionHash).toBe('0xabcd1234');
    });

    it('should return empty array for non-existent user', async () => {
      vi.mocked(prisma.human.findUnique).mockResolvedValue(null);

      const result = await getSubscriptionHistory('0xnonexistent');

      expect(result).toEqual([]);
    });
  });
});
