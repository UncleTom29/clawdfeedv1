// ---------------------------------------------------------------------------
// camelCase → snake_case response serializer
// ---------------------------------------------------------------------------
// Converts all object keys from camelCase to snake_case recursively.
// Attached as a Fastify onSend hook so every JSON response is transformed
// before it leaves the server.
// ---------------------------------------------------------------------------

/**
 * Convert a single camelCase string to snake_case.
 *
 *   "isFullyVerified" → "is_fully_verified"
 *   "avatarUrl"       → "avatar_url"
 *   "createdAt"       → "created_at"
 */
function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

// Keys that should NOT be renamed (they are values, not field names,
// or are already in the correct casing expected by the frontend).
const PASSTHROUGH_KEYS = new Set([
  // Enum string values that happen to be object keys inside JSON columns
  'LIKE',
  'REPOST',
  'BOOKMARK',
  'VIEW',
  'AGENT',
  'HUMAN',
  // Pagination keys that the frontend already expects in snake_case
  'next_cursor',
  'has_more',
]);

/**
 * Recursively transform every key in an object tree from camelCase to
 * snake_case. Arrays are traversed, primitives are returned as-is.
 */
export function transformKeys(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map(transformKeys);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    for (const key of Object.keys(source)) {
      const snakeKey = PASSTHROUGH_KEYS.has(key) ? key : camelToSnake(key);
      result[snakeKey] = transformKeys(source[key]);
    }

    return result;
  }

  // Primitives (string, number, boolean, bigint)
  if (typeof value === 'bigint') {
    return value.toString();
  }

  return value;
}

/**
 * Fastify onSend hook that rewrites JSON response bodies so all keys
 * use snake_case instead of camelCase.
 */
export async function serializeResponseHook(
  _request: unknown,
  reply: { getHeader: (name: string) => unknown },
  payload: string | Buffer | null | undefined,
): Promise<string | Buffer | null | undefined> {
  // Only transform JSON responses
  const contentType = reply.getHeader('content-type');
  if (
    typeof contentType !== 'string' ||
    !contentType.includes('application/json')
  ) {
    return payload;
  }

  if (typeof payload !== 'string') return payload;

  try {
    const parsed = JSON.parse(payload);
    const transformed = transformKeys(parsed);
    return JSON.stringify(transformed);
  } catch {
    // If parsing fails, return the original payload
    return payload;
  }
}