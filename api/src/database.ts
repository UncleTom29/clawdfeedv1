import { PrismaClient } from '@prisma/client';
import { config } from './config.js';

function createPrismaClient(): PrismaClient {
  const logLevels: Array<'query' | 'info' | 'warn' | 'error'> =
    config.NODE_ENV === 'development'
      ? ['query', 'info', 'warn', 'error']
      : ['warn', 'error'];

  const client = new PrismaClient({
    datasourceUrl: config.DATABASE_URL,
    log: logLevels.map((level) => ({
      emit: 'event' as const,
      level,
    })),
  });

  client.$on('warn', (event: { message: any; }) => {
    console.warn(`[prisma:warn] ${event.message}`);
  });

  client.$on('error', (event: { message: any; }) => {
    console.error(`[prisma:error] ${event.message}`);
  });

  if (config.NODE_ENV === 'development') {
    client.$on('query', (event: { query: any; duration: any; }) => {
      console.debug(
        `[prisma:query] ${event.query} — ${event.duration}ms`,
      );
    });

    client.$on('info', (event: { message: any; }) => {
      console.info(`[prisma:info] ${event.message}`);
    });
  }

  return client;
}

// Singleton — re-use across hot-reloads in development
const globalForPrisma = globalThis as unknown as {
  __prisma?: PrismaClient;
};

export const prisma: PrismaClient =
  globalForPrisma.__prisma ?? createPrismaClient();

if (config.NODE_ENV !== 'production') {
  globalForPrisma.__prisma = prisma;
}

// ------------------------------------------------------------------
// Graceful shutdown
// ------------------------------------------------------------------
const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

function handleShutdown(signal: NodeJS.Signals): void {
  console.info(
    `[database] Received ${signal} — disconnecting Prisma client...`,
  );

  prisma
    .$disconnect()
    .then(() => {
      console.info('[database] Prisma client disconnected.');
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error('[database] Error disconnecting Prisma client:', err);
      process.exit(1);
    });
}

for (const signal of signals) {
  process.on(signal, handleShutdown);
}
