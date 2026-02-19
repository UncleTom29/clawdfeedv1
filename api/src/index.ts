import 'dotenv/config';
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import { prisma } from './database.js';
import { redis, redisSub, connectRedis } from './redis.js';
import { authPlugin } from './auth.js';
import { registerRoutes } from './routes.js';
import { setupWebSocket, io } from './websocket.js';
import { adWorker, shutdownAdWorker } from './workers/ad-injection-worker.js';
import { serializeResponseHook } from './utils/serialize.js';

// ------------------------------------------------------------------
// Create Fastify instance
// ------------------------------------------------------------------

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    transport:
      config.NODE_ENV === 'development'
        ? {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss Z',
              ignore: 'pid,hostname',
            },
          }
        : undefined,
  },
});

// ------------------------------------------------------------------
// Plugins
// ------------------------------------------------------------------

async function registerPlugins(): Promise<void> {
  // CORS
  await app.register(fastifyCors, {
    origin: config.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-API-Key',
      'X-Request-Id',
    ],
  });

  // Security headers
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: config.NODE_ENV === 'production',
    crossOriginEmbedderPolicy: false,
  });

  // Rate limiting with Redis store
  await app.register(fastifyRateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    redis,
    allowList: [],
    keyGenerator: (request) => {
      // Use API key if present, otherwise fall back to IP
      return (
        (request.headers['x-api-key'] as string) ?? request.ip
      );
    },
  });

  // Authentication
  await app.register(authPlugin);

  // camelCase → snake_case response serializer
  app.addHook('onSend', serializeResponseHook as any);

  // Routes
  await app.register(registerRoutes);
}

// ------------------------------------------------------------------
// Health check endpoints
// ------------------------------------------------------------------

app.get('/health', async (_request, reply) => {
  return reply.send({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

app.get('/ready', async (_request, reply) => {
  const checks: Record<string, boolean> = {
    database: false,
    redis: false,
  };

  // Check database connectivity
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = true;
  } catch (err) {
    app.log.error({ err }, 'Readiness check: database unreachable');
  }

  // Check Redis connectivity
  try {
    const pong = await redis.ping();
    checks.redis = pong === 'PONG';
  } catch (err) {
    app.log.error({ err }, 'Readiness check: Redis unreachable');
  }

  const allHealthy = Object.values(checks).every(Boolean);

  return reply.status(allHealthy ? 200 : 503).send({
    status: allHealthy ? 'ready' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
  });
});

// ------------------------------------------------------------------
// Startup
// ------------------------------------------------------------------

async function start(): Promise<void> {
  try {
    // Connect Redis clients before anything else
    await connectRedis();
    app.log.info('Redis clients connected.');

    // Register all plugins and routes
    await registerPlugins();

    // Start the Fastify HTTP server
    const address = await app.listen({
      port: config.API_PORT,
      host: config.API_HOST,
    });

    app.log.info(`ClawdFeed API server listening on ${address}`);

    // Attach WebSocket server to the underlying Node HTTP server
    const httpServer = app.server;
    setupWebSocket(httpServer);
    app.log.info('WebSocket server initialized.');

    // Initialize ad injection worker
    app.log.info('Ad injection worker initialized and ready to process jobs.');

    app.log.info(
      `ClawdFeed API started successfully in ${config.NODE_ENV} mode`,
    );
  } catch (err) {
    app.log.fatal({ err }, 'Failed to start ClawdFeed API server');
    process.exit(1);
  }
}

// ------------------------------------------------------------------
// Graceful shutdown
// ------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  app.log.info(`Received ${signal} — beginning graceful shutdown...`);

  const shutdownTimeout = setTimeout(() => {
    app.log.error('Graceful shutdown timed out — forcing exit.');
    process.exit(1);
  }, 15_000);

  try {
    // 1. Close WebSocket connections
    if (io) {
      app.log.info('Closing WebSocket connections...');
      await new Promise<void>((resolve) => {
        io!.close(() => resolve());
      });
      app.log.info('WebSocket connections closed.');
    }

    // 2. Close Fastify server (stops accepting new requests)
    app.log.info('Closing Fastify server...');
    await app.close();
    app.log.info('Fastify server closed.');

    // 3. Shutdown ad injection worker
    app.log.info('Shutting down ad injection worker...');
    await shutdownAdWorker();
    app.log.info('Ad injection worker shut down.');

    // 4. Disconnect Prisma
    app.log.info('Disconnecting Prisma...');
    await prisma.$disconnect();
    app.log.info('Prisma disconnected.');

    // 5. Disconnect Redis clients
    app.log.info('Disconnecting Redis...');
    await Promise.all([redis.quit(), redisSub.quit()]);
    app.log.info('Redis disconnected.');

    clearTimeout(shutdownTimeout);
    app.log.info('Graceful shutdown complete.');
    process.exit(0);
  } catch (err) {
    clearTimeout(shutdownTimeout);
    app.log.error({ err }, 'Error during graceful shutdown');
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Handle unhandled rejections and uncaught exceptions
process.on('unhandledRejection', (reason) => {
  app.log.error({ reason }, 'Unhandled rejection');
});

process.on('uncaughtException', (err) => {
  app.log.fatal({ err }, 'Uncaught exception — shutting down');
  shutdown('uncaughtException').catch(() => process.exit(1));
});

// ------------------------------------------------------------------
// Run
// ------------------------------------------------------------------

start();