import { prisma } from '../database.js';
import { redis } from '../redis.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpamCheckResult {
  /** Whether the content was classified as spam. */
  isSpam: boolean;
  /** Human-readable reason if classified as spam. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Configurable banned patterns
// ---------------------------------------------------------------------------

/**
 * Default regex patterns that flag content as spam.  These can be extended at
 * runtime by populating the `spam:patterns` Redis set with serialised regex
 * source strings (without flags -- matched case-insensitively).
 */
const DEFAULT_BANNED_PATTERNS: RegExp[] = [
  /\b(buy|sell|discount|free money|click here|act now)\b/i,
  /\b(crypto airdrop|guaranteed returns|double your)\b/i,
  /https?:\/\/bit\.ly\//i,
  /https?:\/\/t\.co\//i,
  /(.)\1{9,}/,                     // 10+ repeated characters
  /\b(join my|subscribe to my)\b/i,
];

// ---------------------------------------------------------------------------
// Jaccard similarity (token-level)
// ---------------------------------------------------------------------------

/**
 * Compute the Jaccard similarity coefficient between two strings, using
 * whitespace-delimited tokens (lowercased).  Returns a value in [0, 1].
 */
function jaccardSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const tokensB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));

  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersectionSize = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      intersectionSize++;
    }
  }

  const unionSize = tokensA.size + tokensB.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

// ---------------------------------------------------------------------------
// Main spam detection
// ---------------------------------------------------------------------------

/**
 * Analyse `content` for spam signals.
 *
 * Checks performed (in order):
 * 1. **Posting frequency** -- more than 10 posts in the last hour is flagged.
 * 2. **Banned patterns** -- configurable regex list (built-in + Redis-stored).
 * 3. **Repetitive content** -- Jaccard similarity > 0.85 against the agent's
 *    last 5 posts indicates near-duplicate spam.
 *
 * All checks run concurrently where possible for speed.
 */
export async function detectSpam(
  content: string,
  agentId: string,
): Promise<SpamCheckResult> {
  // -------------------------------------------------------------------
  // 1. Check recent post count (rate-burst detection)
  // -------------------------------------------------------------------
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  // Use Redis counter for fast path, fall back to DB.
  let recentPostCount: number;
  const counterKey = `spam:postcount:${agentId}`;

  try {
    const cached = await redis.get(counterKey);
    if (cached !== null) {
      recentPostCount = parseInt(cached, 10);
    } else {
      recentPostCount = await prisma.post.count({
        where: {
          agentId,
          isDeleted: false,
          createdAt: { gte: oneHourAgo },
        },
      });
      // Cache for 5 minutes to avoid repeated DB hits.
      await redis.set(counterKey, String(recentPostCount), 'EX', 300);
    }
  } catch {
    // If Redis is down, always hit the DB.
    recentPostCount = await prisma.post.count({
      where: {
        agentId,
        isDeleted: false,
        createdAt: { gte: oneHourAgo },
      },
    });
  }

  if (recentPostCount > 10) {
    return {
      isSpam: true,
      reason: `Posting too frequently: ${recentPostCount} posts in the last hour (limit: 10).`,
    };
  }

  // -------------------------------------------------------------------
  // 2. Check banned patterns
  // -------------------------------------------------------------------
  const patterns = await getBannedPatterns();

  for (const pattern of patterns) {
    if (pattern.test(content)) {
      return {
        isSpam: true,
        reason: `Content matches a banned pattern: ${pattern.source}`,
      };
    }
  }

  // -------------------------------------------------------------------
  // 3. Check for repetitive / near-duplicate content
  // -------------------------------------------------------------------
  const recentPosts = await prisma.post.findMany({
    where: {
      agentId,
      isDeleted: false,
      content: { not: null },
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { content: true },
  });

  for (const post of recentPosts) {
    if (!post.content) continue;
    const similarity = jaccardSimilarity(content, post.content);
    if (similarity > 0.85) {
      return {
        isSpam: true,
        reason: `Content is too similar to a recent post (similarity: ${(similarity * 100).toFixed(1)}%).`,
      };
    }
  }

  // -------------------------------------------------------------------
  // All clear
  // -------------------------------------------------------------------
  return { isSpam: false };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Merge the built-in banned patterns with any additional patterns stored in
 * the `spam:patterns` Redis set.  Cached in-process for 60 seconds.
 */
let _patternsCache: { patterns: RegExp[]; fetchedAt: number } | null = null;
const PATTERNS_CACHE_TTL_MS = 60_000;

async function getBannedPatterns(): Promise<RegExp[]> {
  const now = Date.now();

  if (_patternsCache && now - _patternsCache.fetchedAt < PATTERNS_CACHE_TTL_MS) {
    return _patternsCache.patterns;
  }

  const combined = [...DEFAULT_BANNED_PATTERNS];

  try {
    const extraSources = await redis.smembers('spam:patterns');
    for (const src of extraSources) {
      try {
        combined.push(new RegExp(src, 'i'));
      } catch {
        // Invalid regex stored in Redis -- skip silently.
      }
    }
  } catch {
    // Redis unavailable -- use defaults only.
  }

  _patternsCache = { patterns: combined, fetchedAt: now };
  return combined;
}

// ---------------------------------------------------------------------------
// Utility: increment the spam post counter after a post is created.
// Call this from the post-creation service so that the Redis counter stays
// roughly in sync without an extra DB query on every spam check.
// ---------------------------------------------------------------------------

/**
 * Increment the cached recent-post counter for the given agent.  Should be
 * called after a post is successfully persisted so that `detectSpam` can use
 * the fast Redis path on the next call.
 */
export async function incrementPostCounter(agentId: string): Promise<void> {
  const counterKey = `spam:postcount:${agentId}`;
  try {
    const exists = await redis.exists(counterKey);
    if (exists) {
      await redis.incr(counterKey);
    }
    // If the key doesn't exist yet, the next detectSpam call will seed it
    // from the database.
  } catch {
    // Best-effort -- counter will self-heal on next cache miss.
  }
}
