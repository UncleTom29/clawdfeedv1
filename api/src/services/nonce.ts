import { redis } from '../redis.js';
import { v4 as uuidv4 } from 'uuid';

// ------------------------------------------------------------------
// Nonce Service for Replay Attack Prevention
// ------------------------------------------------------------------

const NONCE_EXPIRY = 300; // 5 minutes in seconds
const NONCE_PREFIX = 'nonce:';

/**
 * Generate a new nonce for a wallet address
 */
export async function generateNonce(walletAddress: string): Promise<string> {
  const nonce = uuidv4();
  const key = `${NONCE_PREFIX}${walletAddress}:${nonce}`;
  
  // Store nonce in Redis with expiry
  await redis.setex(key, NONCE_EXPIRY, '1');
  
  return nonce;
}

/**
 * Verify a nonce without consuming it
 */
export async function verifyNonce(
  walletAddress: string,
  nonce: string,
): Promise<boolean> {
  const key = `${NONCE_PREFIX}${walletAddress}:${nonce}`;
  
  // Check if nonce exists
  const exists = await redis.get(key);
  
  return !!exists;
}

/**
 * Verify and consume a nonce atomically (one-time use only).
 *
 * Uses a Lua script to GET + DEL in a single atomic operation so that
 * concurrent requests cannot both observe the same nonce.
 */
export async function verifyAndConsumeNonce(
  walletAddress: string,
  nonce: string,
): Promise<boolean> {
  const key = `${NONCE_PREFIX}${walletAddress}:${nonce}`;

  // Atomic get-and-delete: returns the value if the key existed, nil otherwise.
  const result = await redis.eval(
    `local v = redis.call('GET', KEYS[1])
     if v then redis.call('DEL', KEYS[1]) end
     return v`,
    1,
    key,
  );

  return result !== null;
}

/**
 * Clean up expired nonces (called periodically by worker)
 */
export async function cleanupExpiredNonces(): Promise<number> {
  // Redis will automatically expire keys, but this provides manual cleanup
  const pattern = `${NONCE_PREFIX}*`;
  let cleaned = 0;
  
  // Scan for all nonce keys
  let cursor = '0';
  do {
    const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = result[0];
    const keys = result[1];
    
    // Check TTL and delete expired ones
    for (const key of keys) {
      const ttl = await redis.ttl(key);
      if (ttl === -1 || ttl === -2) {
        // -1: no expiry, -2: doesn't exist
        await redis.del(key);
        cleaned++;
      }
    }
  } while (cursor !== '0');
  
  return cleaned;
}