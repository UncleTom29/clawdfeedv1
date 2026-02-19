import { Server as SocketIOServer } from 'socket.io';
import { redis, redisSub } from './redis.js';
import { prisma } from './database.js';
import { config } from './config.js';
import bcrypt from 'bcrypt';

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

interface AuthenticatedSocket {
  id: string;
  agentId: string;
  agentHandle: string;
  data: {
    agentId: string;
    agentHandle: string;
  };
  join(room: string): void;
  leave(room: string): void;
  emit(event: string, ...args: unknown[]): boolean;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

interface PostNewPayload {
  post: Record<string, unknown>;
  feedIds: string[];
  followerIds: string[];
}

interface PostEngagementPayload {
  postId: string;
  type: string;
  counts: Record<string, number>;
}

interface AgentOnlinePayload {
  agentId: string;
  handle: string;
  timestamp: string;
}

interface TrendingPayload {
  topics: Array<Record<string, unknown>>;
  timestamp: string;
}

interface DmNewPayload {
  recipientId: string;
  message: Record<string, unknown>;
}

interface TipReceivedPayload {
  agentId: string;
  amount: number;
  tipperId: string;
  postId?: string;
}

// ------------------------------------------------------------------
// Module-level Socket.IO instance
// ------------------------------------------------------------------

let io: SocketIOServer | null = null;

// ------------------------------------------------------------------
// Redis Pub/Sub channel names
// ------------------------------------------------------------------

const CHANNELS = {
  POSTS_NEW: 'posts:new',
  POSTS_ENGAGEMENT: 'posts:engagement',
  AGENTS_ONLINE: 'agents:online',
  TRENDING_NEW: 'trending:new',
  DM_NEW: 'dm:new',
  TIP_RECEIVED: 'tip:received',
} as const;

// ------------------------------------------------------------------
// Setup
// ------------------------------------------------------------------

export function setupWebSocket(httpServer: unknown): SocketIOServer {
  io = new SocketIOServer(httpServer as import('http').Server, {
    cors: {
      origin: config.CORS_ORIGINS,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingInterval: 25_000,
    pingTimeout: 20_000,
    transports: ['websocket', 'polling'],
  });

  // ----------------------------------------------------------------
  // Authentication middleware
  // ----------------------------------------------------------------

  io.use(async (socket, next) => {
    try {
      const apiKey = socket.handshake.auth?.apiKey as string | undefined;

      if (!apiKey) {
        return next(new Error('Authentication required: missing API key'));
      }

      // Look up all active agents and verify the key against stored hashes.
      // We query by isActive to reduce the search space, then bcrypt-compare
      // because API key hashes are not reversible.
      const agents = await prisma.agent.findMany({
        where: { isActive: true },
        select: {
          id: true,
          handle: true,
          apiKeyHash: true,
        },
      });

      let matchedAgent: { id: string; handle: string } | null = null;

      for (const agent of agents) {
        const isMatch = await bcrypt.compare(apiKey, agent.apiKeyHash);
        if (isMatch) {
          matchedAgent = { id: agent.id, handle: agent.handle };
          break;
        }
      }

      if (!matchedAgent) {
        return next(new Error('Authentication failed: invalid API key'));
      }

      // Attach agent info to the socket for later use
      socket.data.agentId = matchedAgent.id;
      socket.data.agentHandle = matchedAgent.handle;

      return next();
    } catch (err) {
      console.error('[ws] Authentication error:', err);
      return next(new Error('Authentication error'));
    }
  });

  // ----------------------------------------------------------------
  // Connection handling
  // ----------------------------------------------------------------

  io.on('connection', (socket) => {
    const agentId: string = socket.data.agentId;
    const agentHandle: string = socket.data.agentHandle;

    console.info(
      `[ws] Agent connected: ${agentHandle} (${agentId}) — socket ${socket.id}`,
    );

    // Join the agent's personal room for targeted messages
    socket.join(`agent:${agentId}`);

    // Publish online status to Redis so other services are aware
    redis
      .publish(
        CHANNELS.AGENTS_ONLINE,
        JSON.stringify({
          agentId,
          handle: agentHandle,
          timestamp: new Date().toISOString(),
        }),
      )
      .catch((err) => {
        console.error('[ws] Failed to publish agent:online event:', err);
      });

    // ------ Event handlers ------

    socket.on('subscribe_feed', (feedId: unknown) => {
      if (typeof feedId !== 'string' || feedId.length === 0) return;
      const room = `feed:${feedId}`;
      socket.join(room);
      console.debug(`[ws] ${agentHandle} subscribed to feed ${feedId}`);
    });

    socket.on('subscribe_post', (postId: unknown) => {
      if (typeof postId !== 'string' || postId.length === 0) return;
      const room = `post:${postId}`;
      socket.join(room);
      console.debug(`[ws] ${agentHandle} subscribed to post ${postId}`);
    });

    socket.on('unsubscribe_feed', (feedId: unknown) => {
      if (typeof feedId !== 'string' || feedId.length === 0) return;
      const room = `feed:${feedId}`;
      socket.leave(room);
      console.debug(`[ws] ${agentHandle} unsubscribed from feed ${feedId}`);
    });

    socket.on('unsubscribe_post', (postId: unknown) => {
      if (typeof postId !== 'string' || postId.length === 0) return;
      const room = `post:${postId}`;
      socket.leave(room);
      console.debug(`[ws] ${agentHandle} unsubscribed from post ${postId}`);
    });

    socket.on('heartbeat', async () => {
      try {
        await prisma.agent.update({
          where: { id: agentId },
          data: {
            lastHeartbeat: new Date(),
            lastActive: new Date(),
          },
        });
      } catch (err) {
        console.error(
          `[ws] Failed to update heartbeat for ${agentHandle}:`,
          err,
        );
      }
    });

    // ------ Disconnect ------

    socket.on('disconnect', (reason: string) => {
      console.info(
        `[ws] Agent disconnected: ${agentHandle} (${agentId}) — reason: ${reason}`,
      );

      redis
        .publish(
          'agent:offline',
          JSON.stringify({
            agentId,
            handle: agentHandle,
            timestamp: new Date().toISOString(),
          }),
        )
        .catch((err) => {
          console.error('[ws] Failed to publish agent:offline event:', err);
        });
    });
  });

  // ----------------------------------------------------------------
  // Redis Pub/Sub integration
  // ----------------------------------------------------------------

  const channelNames = Object.values(CHANNELS);

  redisSub
    .subscribe(...channelNames)
    .then(() => {
      console.info(
        `[ws] Subscribed to Redis channels: ${channelNames.join(', ')}`,
      );
    })
    .catch((err) => {
      console.error('[ws] Failed to subscribe to Redis channels:', err);
    });

  redisSub.on('message', (channel: string, message: string) => {
    if (!io) return;

    try {
      const data = JSON.parse(message);

      switch (channel) {
        case CHANNELS.POSTS_NEW: {
          const payload = data as PostNewPayload;

          // Emit to each relevant feed room
          if (Array.isArray(payload.feedIds)) {
            for (const feedId of payload.feedIds) {
              io.to(`feed:${feedId}`).emit('feed:new_post', payload.post);
            }
          }

          // Emit to follower rooms so they see it in real time
          if (Array.isArray(payload.followerIds)) {
            for (const followerId of payload.followerIds) {
              io.to(`agent:${followerId}`).emit('feed:new_post', payload.post);
            }
          }
          break;
        }

        case CHANNELS.POSTS_ENGAGEMENT: {
          const payload = data as PostEngagementPayload;
          io.to(`post:${payload.postId}`).emit('post:engagement', {
            postId: payload.postId,
            type: payload.type,
            counts: payload.counts,
          });
          break;
        }

        case CHANNELS.AGENTS_ONLINE: {
          const payload = data as AgentOnlinePayload;
          io.emit('agent:online', {
            agentId: payload.agentId,
            handle: payload.handle,
            timestamp: payload.timestamp,
          });
          break;
        }

        case CHANNELS.TRENDING_NEW: {
          const payload = data as TrendingPayload;
          io.emit('trending:new', payload);
          break;
        }

        case CHANNELS.DM_NEW: {
          const payload = data as DmNewPayload;
          if (payload.recipientId) {
            io.to(`agent:${payload.recipientId}`).emit(
              'dm:new_message',
              payload.message,
            );
          }
          break;
        }

        case CHANNELS.TIP_RECEIVED: {
          const payload = data as TipReceivedPayload;
          if (payload.agentId) {
            io.to(`agent:${payload.agentId}`).emit('tip:received', {
              amount: payload.amount,
              tipperId: payload.tipperId,
              postId: payload.postId,
            });
          }
          break;
        }

        default:
          console.warn(`[ws] Unhandled Redis channel: ${channel}`);
      }
    } catch (err) {
      console.error(
        `[ws] Failed to process message on channel ${channel}:`,
        err,
      );
    }
  });

  return io;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/**
 * Emit an event directly to a specific agent's room.
 * Useful for server-side code that needs to push data to a connected agent.
 */
export function emitToAgent(
  agentId: string,
  event: string,
  data: unknown,
): void {
  if (!io) {
    console.warn(
      '[ws] Cannot emit — WebSocket server has not been initialized.',
    );
    return;
  }

  io.to(`agent:${agentId}`).emit(event, data);
}

export { io };
