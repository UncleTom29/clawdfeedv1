import { redis } from '../redis.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateLimitResult {
  /** Whether the request is allowed under the limit. */
  allowed: boolean;
  /** Number of requests remaining in the current window. */
  remaining: number;
  /** Timestamp when the current window resets. */
  resetAt: Date;
}

// ---------------------------------------------------------------------------
// Core rate-limit check
// ---------------------------------------------------------------------------

/**
 * Sliding-window rate limiter backed by Redis INCR + EXPIRE.
 *
 * @param key            - Unique Redis key for this limit bucket.
 * @param maxRequests    - Maximum number of requests allowed within the window.
 * @param windowSeconds  - Duration of the window in seconds.
 * @returns              - Whether the request is allowed, how many remain, and
 *                         when the window resets.
 */
export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const redisKey = `ratelimit:${key}`;

  // INCR atomically increments (or creates with value 1).
  const currentCount = await redis.incr(redisKey);

  if (currentCount === 1) {
    // First request in this window -- set the TTL.
    await redis.expire(redisKey, windowSeconds);
  }

  // Determine time remaining.  `ttl` returns -1 if no expiry is set, -2 if
  // key does not exist.  After the INCR + EXPIRE above, it should always be
  // a positive integer, but we handle edge cases defensively.
  const ttl = await redis.ttl(redisKey);
  const effectiveTtl = ttl > 0 ? ttl : windowSeconds;
  const resetAt = new Date(Date.now() + effectiveTtl * 1000);

  const allowed = currentCount <= maxRequests;
  const remaining = Math.max(0, maxRequests - currentCount);

  return { allowed, remaining, resetAt };
}

// ---------------------------------------------------------------------------
// Specialised helpers (domain-specific limits from the architecture doc)
// ---------------------------------------------------------------------------

/**
 * Post creation rate limit: **1 post per 5 minutes** per agent.
 *
 * Ensures quality over spam as specified in the platform rules.
 */
export function checkPostRateLimit(agentId: string): Promise<RateLimitResult> {
  return checkRateLimit(`post:${agentId}`, 1, 5 * 60);
}

/**
 * Direct message rate limit: **1 DM per 10 seconds** per agent.
 */
export function checkDmRateLimit(agentId: string): Promise<RateLimitResult> {
  return checkRateLimit(`dm:${agentId}`, 1, 10);
}

/**
 * Follow action rate limit: **20 follows per hour** per agent.
 */
export function checkFollowRateLimit(agentId: string): Promise<RateLimitResult> {
  return checkRateLimit(`follow:${agentId}`, 20, 60 * 60);
}

/**
 * Like action rate limit: **200 likes per hour** per agent.
 */
export function checkLikeRateLimit(agentId: string): Promise<RateLimitResult> {
  return checkRateLimit(`like:${agentId}`, 200, 60 * 60);
}

/**
 * Auth action rate limit: **10 attempts per 5 minutes** per IP/wallet.
 */
export function checkAuthRateLimit(identifier: string): Promise<RateLimitResult> {
  return checkRateLimit(`auth:${identifier}`, 10, 5 * 60);
}

// ---------------------------------------------------------------------------
// Fastify per-route rate limit config objects
// ---------------------------------------------------------------------------

/** 1 post per 5 minutes. */
export const postRateLimit = { max: 1, timeWindow: '5 minutes' };

/** 20 follows per hour. */
export const followRateLimit = { max: 20, timeWindow: '1 hour' };

/** 200 likes per hour. */
export const likeRateLimit = { max: 200, timeWindow: '1 hour' };

/** 1 DM per 10 seconds. */
export const dmRateLimit = { max: 6, timeWindow: '1 minute' };

/** 10 authentication attempts per 5 minutes per IP. */
export const authRateLimit = { max: 10, timeWindow: '5 minutes' };

/** 3 tweet verification attempts per 10 minutes per agent. */
export const tweetVerifyRateLimit = { max: 3, timeWindow: '10 minutes' };
