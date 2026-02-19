import Redis from 'ioredis';
import type { RedisOptions } from 'ioredis';
import { config } from './config.js';

// ------------------------------------------------------------------
// Shared options
// ------------------------------------------------------------------

const BASE_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: null, // Required by BullMQ; lets ioredis retry indefinitely
  enableReadyCheck: true,
  retryStrategy(times: number): number | null {
    if (times > 20) {
      console.error(
        `[redis] Could not reconnect after ${times} attempts — giving up.`,
      );
      return null; // stop retrying
    }
    // Exponential back-off capped at 5 seconds
    const delay = Math.min(times * 200, 5_000);
    console.warn(`[redis] Reconnecting in ${delay}ms (attempt ${times})...`);
    return delay;
  },
  reconnectOnError(err: Error): boolean | 1 | 2 {
    const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
    if (targetErrors.some((e) => err.message.includes(e))) {
      // Reconnect and re-send the failed command
      return 2;
    }
    return false;
  },
};

// ------------------------------------------------------------------
// Factory
// ------------------------------------------------------------------

function createRedisClient(name: string): Redis {
  const client = new Redis(config.REDIS_URL, {
    ...BASE_OPTIONS,
    connectionName: name,
    lazyConnect: true,
  });

  client.on('connect', () => {
    console.info(`[redis:${name}] Connected.`);
  });

  client.on('ready', () => {
    console.info(`[redis:${name}] Ready to accept commands.`);
  });

  client.on('error', (err: Error) => {
    console.error(`[redis:${name}] Error:`, err.message);
  });

  client.on('close', () => {
    console.warn(`[redis:${name}] Connection closed.`);
  });

  client.on('reconnecting', () => {
    console.info(`[redis:${name}] Reconnecting...`);
  });

  return client;
}

// ------------------------------------------------------------------
// Singleton instances
// ------------------------------------------------------------------

const globalForRedis = globalThis as unknown as {
  __redis?: Redis;
  __redisSub?: Redis;
};

/** General-purpose Redis client for caching, rate limiting, BullMQ, etc. */
export const redis: Redis =
  globalForRedis.__redis ?? createRedisClient('clawdfeed');

/** Dedicated subscriber client for Redis Pub/Sub channels. */
export const redisSub: Redis =
  globalForRedis.__redisSub ?? createRedisClient('clawdfeed-sub');

if (config.NODE_ENV !== 'production') {
  globalForRedis.__redis = redis;
  globalForRedis.__redisSub = redisSub;
}

// ------------------------------------------------------------------
// Connection helper
// ------------------------------------------------------------------

/**
 * Eagerly connect both Redis clients.
 * Call this during server startup so connection errors surface early.
 */
export async function connectRedis(): Promise<void> {
  await Promise.all([redis.connect(), redisSub.connect()]);
  console.info('[redis] All clients connected.');
}

// ------------------------------------------------------------------
// Graceful shutdown
// ------------------------------------------------------------------

async function disconnectRedis(): Promise<void> {
  const timeout = 5_000;

  const quit = (client: Redis, name: string): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        console.warn(
          `[redis:${name}] Graceful quit timed out — forcing disconnect.`,
        );
        client.disconnect();
        resolve();
      }, timeout);

      client
        .quit()
        .then(() => {
          clearTimeout(timer);
          console.info(`[redis:${name}] Disconnected gracefully.`);
          resolve();
        })
        .catch(() => {
          clearTimeout(timer);
          client.disconnect();
          resolve();
        });
    });

  await Promise.all([
    quit(redis, 'clawdfeed'),
    quit(redisSub, 'clawdfeed-sub'),
  ]);
}

const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

function handleShutdown(signal: NodeJS.Signals): void {
  console.info(`[redis] Received ${signal} — disconnecting clients...`);

  disconnectRedis()
    .then(() => {
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error('[redis] Error during disconnect:', err);
      process.exit(1);
    });
}

for (const signal of signals) {
  process.on(signal, handleShutdown);
}
