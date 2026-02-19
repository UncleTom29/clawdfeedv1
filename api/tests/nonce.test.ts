import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../src/redis.js', () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    setex: vi.fn(),
    del: vi.fn(),
    scan: vi.fn(),
    ttl: vi.fn(),
  },
}));

// Import after mocking
import { generateNonce, verifyNonce, verifyAndConsumeNonce } from '../src/services/nonce.js';
import { redis } from '../src/redis.js';

describe('Nonce Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateNonce', () => {
    it('should generate a nonce and store it in Redis with expiry', async () => {
      vi.mocked(redis.setex).mockResolvedValue('OK');

      const walletAddress = '0x1234567890abcdef';
      const nonce = await generateNonce(walletAddress);

      // Should return a non-empty string (UUID)
      expect(nonce).toBeDefined();
      expect(typeof nonce).toBe('string');
      expect(nonce.length).toBeGreaterThan(0);

      // Should store in Redis with 5-minute expiry
      expect(redis.setex).toHaveBeenCalledWith(
        `nonce:${walletAddress}:${nonce}`,
        300,
        '1'
      );
    });
  });

  describe('verifyNonce', () => {
    it('should return true when nonce exists in Redis', async () => {
      vi.mocked(redis.get).mockResolvedValue('1');

      const walletAddress = '0x1234567890abcdef';
      const nonce = 'test-nonce-123';

      const result = await verifyNonce(walletAddress, nonce);

      expect(result).toBe(true);
      expect(redis.get).toHaveBeenCalledWith(
        `nonce:${walletAddress}:${nonce}`
      );
      // Should NOT delete the nonce
      expect(redis.del).not.toHaveBeenCalled();
    });

    it('should return false when nonce does not exist', async () => {
      vi.mocked(redis.get).mockResolvedValue(null);

      const walletAddress = '0x1234567890abcdef';
      const nonce = 'expired-nonce';

      const result = await verifyNonce(walletAddress, nonce);

      expect(result).toBe(false);
      expect(redis.get).toHaveBeenCalledWith(
        `nonce:${walletAddress}:${nonce}`
      );
    });
  });

  describe('verifyAndConsumeNonce', () => {
    it('should return true and delete nonce when it exists', async () => {
      vi.mocked(redis.get).mockResolvedValue('1');
      vi.mocked(redis.del).mockResolvedValue(1);

      const walletAddress = '0x1234567890abcdef';
      const nonce = 'test-nonce-456';

      const result = await verifyAndConsumeNonce(walletAddress, nonce);

      expect(result).toBe(true);
      expect(redis.get).toHaveBeenCalledWith(
        `nonce:${walletAddress}:${nonce}`
      );
      // Should delete the nonce (consume it)
      expect(redis.del).toHaveBeenCalledWith(
        `nonce:${walletAddress}:${nonce}`
      );
    });

    it('should return false when nonce does not exist', async () => {
      vi.mocked(redis.get).mockResolvedValue(null);

      const walletAddress = '0x1234567890abcdef';
      const nonce = 'non-existent-nonce';

      const result = await verifyAndConsumeNonce(walletAddress, nonce);

      expect(result).toBe(false);
      // Should not attempt to delete if nonce doesn't exist
      expect(redis.del).not.toHaveBeenCalled();
    });

    it('should not allow reusing the same nonce (one-time use)', async () => {
      const walletAddress = '0x1234567890abcdef';
      const nonce = 'test-nonce-789';

      // First call: nonce exists
      vi.mocked(redis.get).mockResolvedValueOnce('1');
      vi.mocked(redis.del).mockResolvedValue(1);

      const firstResult = await verifyAndConsumeNonce(walletAddress, nonce);
      expect(firstResult).toBe(true);

      // Second call: nonce no longer exists (was consumed)
      vi.mocked(redis.get).mockResolvedValueOnce(null);

      const secondResult = await verifyAndConsumeNonce(walletAddress, nonce);
      expect(secondResult).toBe(false);

      // Nonce should only be deleted once
      expect(redis.del).toHaveBeenCalledTimes(1);
    });
  });

  describe('Authentication Flow', () => {
    it('should support verify-then-consume flow without double consumption', async () => {
      const walletAddress = '0x1234567890abcdef';
      const nonce = 'flow-test-nonce';

      // Step 1: Generate nonce
      vi.mocked(redis.setex).mockResolvedValue('OK');
      await generateNonce(walletAddress);

      // Step 2: Verify nonce (should not consume it)
      vi.mocked(redis.get).mockResolvedValueOnce('1');
      const verifyResult = await verifyNonce(walletAddress, nonce);
      expect(verifyResult).toBe(true);
      expect(redis.del).not.toHaveBeenCalled();

      // Step 3: Verify and consume nonce (should succeed)
      vi.mocked(redis.get).mockResolvedValueOnce('1');
      vi.mocked(redis.del).mockResolvedValue(1);
      const consumeResult = await verifyAndConsumeNonce(walletAddress, nonce);
      expect(consumeResult).toBe(true);
      expect(redis.del).toHaveBeenCalledTimes(1);

      // Step 4: Try to use nonce again (should fail)
      vi.mocked(redis.get).mockResolvedValueOnce(null);
      const reuseResult = await verifyAndConsumeNonce(walletAddress, nonce);
      expect(reuseResult).toBe(false);
    });
  });
});
