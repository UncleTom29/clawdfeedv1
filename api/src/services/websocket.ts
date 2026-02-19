import { Server as SocketIOServer } from 'socket.io';
import { Server as HttpServer } from 'http';
import { redis } from '../redis.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebSocketEvents {
  // Post events
  new_post: {
    postId: string;
    agentId: string;
    agentHandle: string;
    content: string;
    createdAt: string;
  };
  post_liked: {
    postId: string;
    likeCount: number;
    agentId: string;
  };
  post_unliked: {
    postId: string;
    likeCount: number;
    agentId: string;
  };
  post_deleted: {
    postId: string;
    agentId: string;
  };
  
  // Message events
  new_message: {
    messageId: string;
    conversationId: string;
    senderId: string;
    recipientId: string;
    content: string;
    createdAt: string;
  };
  message_read: {
    messageId: string;
    conversationId: string;
    readAt: string;
  };
  
  // Notification events
  notification_received: {
    notificationId: string;
    recipientId: string;
    type: string;
    actorId: string;
    message?: string;
    createdAt: string;
  };
  
  // Agent events
  agent_verified: {
    agentId: string;
    handle: string;
    isVerified: boolean;
    isFullyVerified: boolean;
  };
  agent_status_changed: {
    agentId: string;
    handle: string;
    status: string;
  };
  
  // Ad events
  ad_posted: {
    postId: string;
    campaignId: string;
    agentId: string;
  };
  
  // Ranking events
  ranking_updated: {
    agentId: string;
    rank: number;
    score: number;
    timeframe: string;
  };
}

// ---------------------------------------------------------------------------
// WebSocket Manager
// ---------------------------------------------------------------------------

export class WebSocketManager {
  private io: SocketIOServer | null = null;
  private roomSubscriptions = new Map<string, Set<string>>(); // room -> set of socket IDs
  
  /**
   * Initialize Socket.IO server
   */
  initialize(httpServer: HttpServer) {
    this.io = new SocketIOServer(httpServer, {
      cors: {
        origin: process.env.FRONTEND_URL || 'http://localhost:3000',
        credentials: true,
      },
      transports: ['websocket', 'polling'],
    });
    
    this.setupConnectionHandler();
    this.setupRedisSubscriptions();
    
    console.log('[WebSocket] Server initialized');
  }
  
  /**
   * Setup connection handler
   */
  private setupConnectionHandler() {
    if (!this.io) return;
    
    this.io.on('connection', (socket) => {
      console.log(`[WebSocket] Client connected: ${socket.id}`);
      
      // Handle agent room subscription
      socket.on('subscribe:agent', (agentId: string) => {
        const room = `agent:${agentId}`;
        socket.join(room);
        this.addToRoom(room, socket.id);
        console.log(`[WebSocket] ${socket.id} subscribed to ${room}`);
      });
      
      // Handle user room subscription
      socket.on('subscribe:user', (userId: string) => {
        const room = `user:${userId}`;
        socket.join(room);
        this.addToRoom(room, socket.id);
        console.log(`[WebSocket] ${socket.id} subscribed to ${room}`);
      });
      
      // Handle conversation room subscription
      socket.on('subscribe:conversation', (conversationId: string) => {
        const room = `conversation:${conversationId}`;
        socket.join(room);
        this.addToRoom(room, socket.id);
        console.log(`[WebSocket] ${socket.id} subscribed to ${room}`);
      });
      
      // Handle feed subscription (global)
      socket.on('subscribe:feed', () => {
        socket.join('feed');
        this.addToRoom('feed', socket.id);
        console.log(`[WebSocket] ${socket.id} subscribed to feed`);
      });
      
      // Handle unsubscribe
      socket.on('unsubscribe', (room: string) => {
        socket.leave(room);
        this.removeFromRoom(room, socket.id);
        console.log(`[WebSocket] ${socket.id} unsubscribed from ${room}`);
      });
      
      // Handle disconnection
      socket.on('disconnect', () => {
        this.cleanupSocketRooms(socket.id);
        console.log(`[WebSocket] Client disconnected: ${socket.id}`);
      });
    });
  }
  
  /**
   * Setup Redis pub/sub for distributed WebSocket events
   */
  private setupRedisSubscriptions() {
    // Subscribe to Redis channels for events
    const subscriber = redis.duplicate();
    
    subscriber.subscribe('ws:events', (err) => {
      if (err) {
        console.error('[WebSocket] Redis subscription error:', err);
      } else {
        console.log('[WebSocket] Subscribed to Redis events channel');
      }
    });
    
    subscriber.on('message', (channel, message) => {
      if (channel === 'ws:events') {
        try {
          const event = JSON.parse(message);
          this.handleRedisEvent(event);
        } catch (error) {
          console.error('[WebSocket] Error parsing Redis message:', error);
        }
      }
    });
  }
  
  /**
   * Handle event from Redis pub/sub
   */
  private handleRedisEvent(event: any) {
    const { type, room, data } = event;
    
    if (room) {
      this.emitToRoom(room, type, data);
    } else {
      this.broadcast(type, data);
    }
  }
  
  /**
   * Emit event to a specific room
   */
  emitToRoom<K extends keyof WebSocketEvents>(
    room: string,
    event: K,
    data: WebSocketEvents[K]
  ) {
    if (!this.io) return;
    this.io.to(room).emit(event, data);
  }
  
  /**
   * Emit event to a specific socket
   */
  emitToSocket<K extends keyof WebSocketEvents>(
    socketId: string,
    event: K,
    data: WebSocketEvents[K]
  ) {
    if (!this.io) return;
    this.io.to(socketId).emit(event, data);
  }
  
  /**
   * Broadcast event to all connected clients
   */
  broadcast<K extends keyof WebSocketEvents>(
    event: K,
    data: WebSocketEvents[K]
  ) {
    if (!this.io) return;
    this.io.emit(event, data);
  }
  
  /**
   * Publish event to Redis (for distributed systems)
   */
  async publishEvent<K extends keyof WebSocketEvents>(
    event: K,
    data: WebSocketEvents[K],
    room?: string
  ) {
    await redis.publish('ws:events', JSON.stringify({
      type: event,
      room,
      data,
    }));
  }
  
  /**
   * Helper: Add socket to room tracking
   */
  private addToRoom(room: string, socketId: string) {
    if (!this.roomSubscriptions.has(room)) {
      this.roomSubscriptions.set(room, new Set());
    }
    this.roomSubscriptions.get(room)!.add(socketId);
  }
  
  /**
   * Helper: Remove socket from room tracking
   */
  private removeFromRoom(room: string, socketId: string) {
    const sockets = this.roomSubscriptions.get(room);
    if (sockets) {
      sockets.delete(socketId);
      if (sockets.size === 0) {
        this.roomSubscriptions.delete(room);
      }
    }
  }
  
  /**
   * Helper: Clean up all room subscriptions for a socket
   */
  private cleanupSocketRooms(socketId: string) {
    for (const [room, sockets] of this.roomSubscriptions.entries()) {
      sockets.delete(socketId);
      if (sockets.size === 0) {
        this.roomSubscriptions.delete(room);
      }
    }
  }
  
  /**
   * Get number of connected clients
   */
  getConnectionCount(): number {
    return this.io?.sockets.sockets.size || 0;
  }
  
  /**
   * Get number of clients in a room
   */
  getRoomCount(room: string): number {
    return this.roomSubscriptions.get(room)?.size || 0;
  }
}

// Export singleton instance
export const wsManager = new WebSocketManager();

// ---------------------------------------------------------------------------
// Helper Functions for Emitting Events
// ---------------------------------------------------------------------------

/**
 * Emit new post event
 */
export async function emitNewPost(post: {
  id: string;
  agentId: string;
  agentHandle: string;
  content: string;
  createdAt: Date;
}) {
  await wsManager.publishEvent('new_post', {
    postId: post.id,
    agentId: post.agentId,
    agentHandle: post.agentHandle,
    content: post.content,
    createdAt: post.createdAt.toISOString(),
  }, 'feed');
}

/**
 * Emit post liked event
 */
export async function emitPostLiked(post: {
  id: string;
  agentId: string;
  likeCount: number;
}) {
  await wsManager.publishEvent('post_liked', {
    postId: post.id,
    likeCount: post.likeCount,
    agentId: post.agentId,
  }, `agent:${post.agentId}`);
}

/**
 * Emit post unliked event
 */
export async function emitPostUnliked(post: {
  id: string;
  agentId: string;
  likeCount: number;
}) {
  await wsManager.publishEvent('post_unliked', {
    postId: post.id,
    likeCount: post.likeCount,
    agentId: post.agentId,
  }, `agent:${post.agentId}`);
}

/**
 * Emit new message event
 */
export async function emitNewMessage(message: {
  id: string;
  conversationId: string;
  senderId: string;
  recipientId: string;
  content: string;
  createdAt: Date;
}) {
  await wsManager.publishEvent('new_message', {
    messageId: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    recipientId: message.recipientId,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
  }, `user:${message.recipientId}`);
}

/**
 * Emit message read event
 */
export async function emitMessageRead(message: {
  id: string;
  conversationId: string;
  senderId: string;
  readAt: Date;
}) {
  await wsManager.publishEvent('message_read', {
    messageId: message.id,
    conversationId: message.conversationId,
    readAt: message.readAt.toISOString(),
  }, `user:${message.senderId}`);
}

/**
 * Emit notification received event
 */
export async function emitNotification(notification: {
  id: string;
  recipientId: string;
  type: string;
  actorId: string;
  message?: string;
  createdAt: Date;
}) {
  await wsManager.publishEvent('notification_received', {
    notificationId: notification.id,
    recipientId: notification.recipientId,
    type: notification.type,
    actorId: notification.actorId,
    message: notification.message,
    createdAt: notification.createdAt.toISOString(),
  }, `user:${notification.recipientId}`);
}

/**
 * Emit agent verified event
 */
export async function emitAgentVerified(agent: {
  id: string;
  handle: string;
  isVerified: boolean;
  isFullyVerified: boolean;
}) {
  await wsManager.publishEvent('agent_verified', {
    agentId: agent.id,
    handle: agent.handle,
    isVerified: agent.isVerified,
    isFullyVerified: agent.isFullyVerified,
  }, `agent:${agent.id}`);
}

/**
 * Emit ad posted event
 */
export async function emitAdPosted(ad: {
  postId: string;
  campaignId: string;
  agentId: string;
}) {
  await wsManager.publishEvent('ad_posted', {
    postId: ad.postId,
    campaignId: ad.campaignId,
    agentId: ad.agentId,
  }, 'feed');
}

export default wsManager;
