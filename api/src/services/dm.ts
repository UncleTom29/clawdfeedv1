import { prisma } from '../database.js';
import { redis } from '../redis.js';
import { config } from '../config.js';
import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { checkProTier } from './human.js';

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

interface SendMessageInput {
  recipient: string;
  content: string;
}

interface SendHumanToAgentMessageInput {
  senderWallet: string;
  recipientHandle: string;
  content: string;
}

interface PaginatedResult<T> {
  data: T[];
  pagination: {
    nextCursor: string | null;
    hasMore: boolean;
  };
}

// ------------------------------------------------------------------
// Encryption helpers
// ------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const keyHex =
    config.ENCRYPTION_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  return Buffer.from(keyHex, 'hex');
}

/**
 * Encrypt content using AES-256-GCM.
 * Returns a base64 string of iv:tag:ciphertext.
 */
function encryptContent(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const tag = cipher.getAuthTag();

  // Concatenate: iv (hex) + : + tag (hex) + : + ciphertext (hex)
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt content encrypted with encryptContent.
 */
function decryptContent(encryptedStr: string): string {
  const key = getEncryptionKey();
  const parts = encryptedStr.split(':');

  if (parts.length !== 3) {
    throw new Error('Invalid encrypted content format.');
  }

  const iv = Buffer.from(parts[0]!, 'hex');
  const tag = Buffer.from(parts[1]!, 'hex');
  const ciphertext = parts[2]!;

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Generate a deterministic conversation ID from two agent IDs.
 * Sorted so that the same two agents always produce the same conversation ID.
 */
function makeConversationId(agentA: string, agentB: string): string {
  const sorted = [agentA, agentB].sort();
  return crypto
    .createHash('sha256')
    .update(`${sorted[0]}:${sorted[1]}`)
    .digest('hex')
    .slice(0, 32);
}

// ------------------------------------------------------------------
// 1. Send Message
// ------------------------------------------------------------------

/**
 * Send a direct message to another agent.
 */
export async function sendMessage(
  senderId: string,
  data: SendMessageInput,
) {
  const { recipient, content } = data;

  if (!content || content.trim().length === 0) {
    throw new Error('Message content cannot be empty.');
  }

  if (content.length > 1000) {
    throw new Error('Message content must be at most 1000 characters.');
  }

  // Look up recipient agent by handle
  const recipientAgent = await prisma.agent.findUnique({
    where: { handle: recipient },
    select: { id: true, handle: true, isActive: true },
  });

  if (!recipientAgent) {
    throw new Error(`Agent with handle "@${recipient}" not found.`);
  }

  if (!recipientAgent.isActive) {
    throw new Error(`Agent @${recipient} is not currently active.`);
  }

  if (recipientAgent.id === senderId) {
    throw new Error('You cannot send a message to yourself.');
  }

  const conversationId = makeConversationId(senderId, recipientAgent.id);
  const encryptedContent = encryptContent(content);

  const message = await prisma.directMessage.create({
    data: {
      id: uuidv4(),
      conversationId,
      senderId,
      recipientId: recipientAgent.id,
      content,
      encryptedContent,
    },
  });

  // Fetch sender agent data for real-time notification
  // In this function, sender is always an agent (agent-to-agent messaging)
  const senderAgent = await prisma.agent.findUnique({
    where: { id: senderId },
    select: {
      id: true,
      handle: true,
      name: true,
      avatarUrl: true,
    },
  });

  // Publish to Redis for real-time delivery
  try {
    await redis.publish(
      'dm:new',
      JSON.stringify({
        recipientId: recipientAgent.id,
        message: {
          id: message.id,
          conversationId,
          senderId,
          senderHandle: senderAgent?.handle ?? 'human_user',
          content,
          createdAt: message.createdAt.toISOString(),
        },
      }),
    );
  } catch {
    // Best-effort; DM is already persisted.
  }

  return message;
}

// ------------------------------------------------------------------
// 2. Get Conversations
// ------------------------------------------------------------------

/**
 * List conversations for an agent, with the most recent message in each.
 * Returns format compatible with frontend expectations.
 */
export async function getConversations(
  agentId: string,
  query: { cursor?: string; limit?: number } = {},
): Promise<PaginatedResult<unknown>> {
  const { limit = 25 } = query;

  // Get distinct conversation IDs for this agent
  const messages = await prisma.directMessage.findMany({
    where: {
      OR: [{ senderId: agentId }, { recipientId: agentId }],
    },
    distinct: ['conversationId'],
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    select: {
      conversationId: true,
      content: true,
      createdAt: true,
      senderId: true,
      recipientId: true,
      senderType: true,
      recipientType: true,
      isRead: true,
    },
  });

  const hasMore = messages.length > limit;
  const results = hasMore ? messages.slice(0, limit) : messages;

  // Collect all agent IDs for batch query
  const agentIdsToFetch = results
    .map((msg: any) => {
      const otherAgentType = msg.senderId === agentId ? msg.recipientType : msg.senderType;
      if (otherAgentType === 'AGENT') {
        return msg.senderId === agentId ? msg.recipientId : msg.senderId;
      }
      return null;
    })
    .filter((id): id is string => id !== null);

  // Fetch all agents in a single query
  const agents = await prisma.agent.findMany({
    where: { id: { in: agentIdsToFetch } },
    select: {
      id: true,
      handle: true,
      name: true,
      avatarUrl: true,
      isVerified: true,
      isFullyVerified: true,
      dmEnabled: true,
    },
  });

  const agentMap = new Map(agents.map(a => [a.id, a]));

  // Build conversation objects with participants array and unread count
  const conversations = await Promise.all(
    results.map(async (msg: any) => {
      // Determine the other party in the conversation
      const otherAgentId = msg.senderId === agentId ? msg.recipientId : msg.senderId;
      const otherAgentType = msg.senderId === agentId ? msg.recipientType : msg.senderType;
      
      // Get agent data from map if available
      const otherAgent = otherAgentType === 'AGENT' ? agentMap.get(otherAgentId) : null;

      // Calculate unread count for this conversation
      const unreadCount = await prisma.directMessage.count({
        where: {
          conversationId: msg.conversationId,
          recipientId: agentId,
          isRead: false,
        },
      });

      return {
        id: msg.conversationId,
        participants: otherAgent ? [
          {
            id: otherAgent.id,
            handle: otherAgent.handle,
            name: otherAgent.name,
            avatar_url: otherAgent.avatarUrl,
            is_verified: otherAgent.isVerified,
            is_fully_verified: otherAgent.isFullyVerified,
            dm_opt_in: otherAgent.dmEnabled,
          },
        ] : [
          {
            id: otherAgentId,
            type: 'HUMAN',
            wallet: otherAgentId, // This is a wallet address, not an agent ID
            handle: 'human_user',
            name: 'Human User',
            avatar_url: null,
            is_verified: false,
            is_fully_verified: false,
            dm_opt_in: true,
          },
        ],
        last_message: {
          content: msg.content,
          created_at: msg.createdAt,
          sender_type: msg.senderType.toLowerCase(),
        },
        unread_count: unreadCount,
        updated_at: msg.createdAt,
      };
    }),
  );

  return {
    data: conversations,
    pagination: {
      nextCursor: null,
      hasMore,
    },
  };
}

// ------------------------------------------------------------------
// 3. Get Conversation Messages
// ------------------------------------------------------------------

/**
 * Get paginated messages in a specific conversation.
 */
export async function getConversationMessages(
  agentId: string,
  conversationId: string,
  query: { cursor?: string; limit?: number } = {},
): Promise<PaginatedResult<unknown>> {
  const { cursor, limit = 50 } = query;

  // Verify agent is part of this conversation
  const participation = await prisma.directMessage.findFirst({
    where: {
      conversationId,
      OR: [{ senderId: agentId }, { recipientId: agentId }],
    },
  });

  if (!participation) {
    throw new Error('You are not a participant in this conversation.');
  }

  const messages = await prisma.directMessage.findMany({
    where: { conversationId },
    take: limit + 1,
    ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      conversationId: true,
      senderId: true,
      senderType: true,
      recipientId: true,
      recipientType: true,
      content: true,
      media: true,
      isRead: true,
      readAt: true,
      createdAt: true,
    },
  });

  const hasMore = messages.length > limit;
  const results = hasMore ? messages.slice(0, limit) : messages;
  const nextCursor = hasMore
    ? results[results.length - 1]?.id ?? null
    : null;

  // Fetch agent data for all agent senders
  const agentIds = results
    .filter((msg: any) => msg.senderType === 'AGENT')
    .map((msg: any) => msg.senderId);
  const uniqueAgentIds = [...new Set(agentIds)];
  
  const agents = await prisma.agent.findMany({
    where: { id: { in: uniqueAgentIds } },
    select: {
      id: true,
      handle: true,
      name: true,
      avatarUrl: true,
      isVerified: true,
      dmEnabled: true,
    },
  });
  
  const agentMap = new Map(agents.map(a => [a.id, a]));

  // Format messages for frontend
  const formattedMessages = results.map((msg: any) => {
    const senderAgent = msg.senderType === 'AGENT' ? agentMap.get(msg.senderId) : null;
    
    return {
      id: msg.id,
      conversation_id: msg.conversationId,
      sender_id: msg.senderId,
      sender_type: msg.senderType.toLowerCase(), // 'agent' or 'human'
      content: msg.content,
      media: msg.media ? (msg.media as any[]) : [],
      is_read: msg.isRead,
      read_at: msg.readAt,
      created_at: msg.createdAt,
      sender_handle: senderAgent?.handle ?? (msg.senderType === 'HUMAN' ? 'human_user' : 'unknown'),
      sender_name: senderAgent?.name ?? (msg.senderType === 'HUMAN' ? 'Human User' : 'Unknown'),
      sender_avatar_url: senderAgent?.avatarUrl ?? null,
    };
  });

  return {
    data: formattedMessages,
    pagination: { nextCursor, hasMore },
  };
}

// ------------------------------------------------------------------
// 4. Mark Read
// ------------------------------------------------------------------

/**
 * Mark all unread messages in a conversation as read for this agent.
 */
export async function markRead(
  agentId: string,
  conversationId: string,
) {
  // Update all unread messages where this agent is the recipient
  const result = await prisma.directMessage.updateMany({
    where: {
      conversationId,
      recipientId: agentId,
      isRead: false,
    },
    data: {
      isRead: true,
      readAt: new Date(),
    },
  });

  return { markedRead: result.count };
}

// ------------------------------------------------------------------
// 4b. Get Unread Message Count
// ------------------------------------------------------------------

/**
 * Get the total number of unread direct messages for an agent.
 */
export async function getUnreadMessageCount(agentId: string): Promise<{ count: number }> {
  const count = await prisma.directMessage.count({
    where: {
      recipientId: agentId,
      isRead: false,
    },
  });

  return { count };
}

// ------------------------------------------------------------------
// 5. Send Human-to-Agent DM (Pro Tier Required)
// ------------------------------------------------------------------

/**
 * Send a DM from a human to an agent.
 * Requires Pro tier and agent must have DMs enabled.
 */
export async function sendHumanToAgentMessage(
  data: SendHumanToAgentMessageInput,
) {
  const { senderWallet, recipientHandle, content } = data;

  if (!content || content.trim().length === 0) {
    throw new Error('Message content cannot be empty.');
  }

  if (content.length > 1000) {
    throw new Error('Message content must be at most 1000 characters.');
  }

  // Normalize wallet address
  const normalizedWallet = senderWallet.toLowerCase();

  // Check if sender has Pro tier
  const isProUser = await checkProTier(normalizedWallet);
  if (!isProUser) {
    throw new Error('Pro tier subscription required to send DMs to agents.');
  }

  // Look up recipient agent by handle
  const recipientAgent = await prisma.agent.findUnique({
    where: { handle: recipientHandle },
    select: { id: true, handle: true, isActive: true, dmEnabled: true },
  });

  if (!recipientAgent) {
    throw new Error(`Agent with handle "@${recipientHandle}" not found.`);
  }

  if (!recipientAgent.isActive) {
    throw new Error(`Agent @${recipientHandle} is not currently active.`);
  }

  if (!recipientAgent.dmEnabled) {
    throw new Error(`Agent @${recipientHandle} has DMs disabled.`);
  }

  // Generate conversation ID (human wallet + agent ID)
  const conversationId = crypto
    .createHash('sha256')
    .update(`human:${normalizedWallet}:agent:${recipientAgent.id}`)
    .digest('hex')
    .slice(0, 32);

  const encryptedContent = encryptContent(content);

  // Create DM with human as sender
  const message = await prisma.directMessage.create({
    data: {
      id: uuidv4(),
      conversationId,
      senderId: normalizedWallet, // Store wallet address
      recipientId: recipientAgent.id,
      senderType: 'HUMAN',
      recipientType: 'AGENT',
      content,
      encryptedContent,
    },
  });

  // Publish to Redis for real-time delivery
  try {
    await redis.publish(
      'dm:new',
      JSON.stringify({
        recipientId: recipientAgent.id,
        message: {
          id: message.id,
          conversationId,
          senderWallet: normalizedWallet,
          senderType: 'HUMAN',
          content,
          createdAt: message.createdAt.toISOString(),
        },
      }),
    );
  } catch {
    // Best-effort; DM is already persisted.
  }

  return message;
}

// ------------------------------------------------------------------
// 6. Toggle Agent DM Settings
// ------------------------------------------------------------------

/**
 * Toggle DM enabled/disabled for an agent (owner only).
 */
export async function toggleAgentDmEnabled(
  agentId: string,
  enabled: boolean,
) {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, handle: true, dmEnabled: true },
  });

  if (!agent) {
    throw new Error('Agent not found');
  }

  const updatedAgent = await prisma.agent.update({
    where: { id: agentId },
    data: { dmEnabled: enabled },
    select: {
      id: true,
      handle: true,
      dmEnabled: true,
    },
  });

  return updatedAgent;
}

// ------------------------------------------------------------------
// 7. Get Human-to-Agent Conversations (for Agent)
// ------------------------------------------------------------------

/**
 * Get conversations for an agent including human-to-agent DMs.
 */
export async function getAgentConversationsWithHumans(
  agentId: string,
  query: { cursor?: string; limit?: number } = {},
): Promise<PaginatedResult<unknown>> {
  const { limit = 25 } = query;

  // Get distinct conversation IDs for this agent
  const messages = await prisma.directMessage.findMany({
    where: {
      recipientId: agentId,
    },
    distinct: ['conversationId'],
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    select: {
      conversationId: true,
      content: true,
      createdAt: true,
      senderId: true,
      senderType: true,
      recipientId: true,
      isRead: true,
    },
  });

  const hasMore = messages.length > limit;
  const results = hasMore ? messages.slice(0, limit) : messages;

  // Fetch agent data for all AGENT senders
  const agentSenderIds = results
    .filter((msg: any) => msg.senderType === 'AGENT')
    .map((msg: any) => msg.senderId);
  
  const senderAgents = await prisma.agent.findMany({
    where: { id: { in: agentSenderIds } },
    select: {
      id: true,
      handle: true,
      name: true,
      avatarUrl: true,
    },
  });
  
  const senderAgentMap = new Map(senderAgents.map(a => [a.id, a]));

  // Build conversation objects
  const conversations = results.map((msg: any) => {
    if (msg.senderType === 'HUMAN') {
      return {
        conversationId: msg.conversationId,
        participant: {
          type: 'HUMAN',
          wallet: msg.senderId,
        },
        lastMessage: {
          content: msg.content,
          createdAt: msg.createdAt,
          isRead: msg.isRead,
          sentByMe: false,
        },
      };
    } else {
      const senderAgent = senderAgentMap.get(msg.senderId);
      return {
        conversationId: msg.conversationId,
        participant: {
          type: 'AGENT',
          id: senderAgent?.id,
          handle: senderAgent?.handle,
          name: senderAgent?.name,
          avatarUrl: senderAgent?.avatarUrl,
        },
        lastMessage: {
          content: msg.content,
          createdAt: msg.createdAt,
          isRead: msg.isRead,
          sentByMe: msg.senderId === agentId,
        },
      };
    }
  });

  return {
    data: conversations,
    pagination: {
      nextCursor: null,
      hasMore,
    },
  };
}

// ------------------------------------------------------------------
// 8. Get Human Conversations (for Human Users)
// ------------------------------------------------------------------

/**
 * List conversations for a human user with agents.
 */
export async function getHumanConversations(
  walletAddress: string,
  query: { cursor?: string; limit?: number } = {},
): Promise<PaginatedResult<unknown>> {
  const { limit = 25 } = query;
  const normalizedWallet = walletAddress.toLowerCase();

  // Get distinct conversation IDs for this human
  const messages = await prisma.directMessage.findMany({
    where: {
      OR: [
        { senderId: normalizedWallet, senderType: 'HUMAN' },
        { recipientId: normalizedWallet, recipientType: 'HUMAN' },
      ],
    },
    distinct: ['conversationId'],
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    select: {
      conversationId: true,
      content: true,
      createdAt: true,
      senderId: true,
      recipientId: true,
      senderType: true,
      recipientType: true,
      isRead: true,
    },
  });

  const hasMore = messages.length > limit;
  const results = hasMore ? messages.slice(0, limit) : messages;

  // Fetch all agent data for conversations
  // For human conversations, the other party should always be an agent
  const agentIds = results
    .map((msg: any) => {
      // If human sent the message, recipient is the agent
      if (msg.senderType === 'HUMAN' && msg.recipientType === 'AGENT') {
        return msg.recipientId;
      }
      // If agent sent the message to human, sender is the agent
      if (msg.senderType === 'AGENT' && msg.recipientType === 'HUMAN') {
        return msg.senderId;
      }
      return null;
    })
    .filter((id): id is string => id !== null);
  
  const agents = await prisma.agent.findMany({
    where: { id: { in: agentIds } },
    select: {
      id: true,
      handle: true,
      name: true,
      avatarUrl: true,
      isVerified: true,
      isFullyVerified: true,
      dmEnabled: true,
    },
  });
  
  const agentMap = new Map(agents.map(a => [a.id, a]));

  // Build conversation objects with agent participants and unread count
  const conversations = await Promise.all(
    results.map(async (msg: any) => {
      // The agent is the other party in the conversation
      const agentId = msg.senderType === 'AGENT' ? msg.senderId : msg.recipientId;
      const agent = agentMap.get(agentId);

      // Calculate unread count for this conversation
      const unreadCount = await prisma.directMessage.count({
        where: {
          conversationId: msg.conversationId,
          recipientId: normalizedWallet,
          recipientType: 'HUMAN',
          isRead: false,
        },
      });

      return {
        id: msg.conversationId,
        participants: agent ? [
          {
            id: agent.id,
            handle: agent.handle,
            name: agent.name,
            avatar_url: agent.avatarUrl,
            is_verified: agent.isVerified,
            is_fully_verified: agent.isFullyVerified,
            dm_opt_in: agent.dmEnabled,
          },
        ] : [],
        last_message: {
          content: msg.content,
          created_at: msg.createdAt,
          sender_type: msg.senderType.toLowerCase(),
        },
        unread_count: unreadCount,
        updated_at: msg.createdAt,
      };
    }),
  );

  return {
    data: conversations,
    pagination: {
      nextCursor: null,
      hasMore,
    },
  };
}

// ------------------------------------------------------------------
// 9. Get Human Conversation Messages
// ------------------------------------------------------------------

/**
 * Get paginated messages in a specific conversation for a human user.
 */
export async function getHumanConversationMessages(
  walletAddress: string,
  conversationId: string,
  query: { cursor?: string; limit?: number } = {},
): Promise<PaginatedResult<unknown>> {
  const { cursor, limit = 50 } = query;
  const normalizedWallet = walletAddress.toLowerCase();

  // Verify human is part of this conversation
  const participation = await prisma.directMessage.findFirst({
    where: {
      conversationId,
      OR: [
        { senderId: normalizedWallet, senderType: 'HUMAN' },
        { recipientId: normalizedWallet, recipientType: 'HUMAN' },
      ],
    },
  });

  if (!participation) {
    throw new Error('You are not a participant in this conversation.');
  }

  const messages = await prisma.directMessage.findMany({
    where: { conversationId },
    take: limit + 1,
    ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      conversationId: true,
      senderId: true,
      senderType: true,
      content: true,
      media: true,
      isRead: true,
      readAt: true,
      createdAt: true,
    },
  });

  const hasMore = messages.length > limit;
  const results = hasMore ? messages.slice(0, limit) : messages;
  const nextCursor = hasMore
    ? results[results.length - 1]?.id ?? null
    : null;

  // Format messages for frontend
  const formattedMessages = results.map((msg: any) => ({
    id: msg.id,
    conversation_id: msg.conversationId,
    sender_id: msg.senderId,
    sender_type: msg.senderType.toLowerCase(),
    content: msg.content,
    media: msg.media ? (msg.media as any[]) : [],
    is_read: msg.isRead,
    read_at: msg.readAt,
    created_at: msg.createdAt,
  }));

  return {
    data: formattedMessages,
    pagination: { nextCursor, hasMore },
  };
}

// ------------------------------------------------------------------
// 10. Mark Human Conversation Read
// ------------------------------------------------------------------

/**
 * Mark all unread messages in a conversation as read for a human user.
 */
export async function markHumanConversationRead(
  walletAddress: string,
  conversationId: string,
) {
  const normalizedWallet = walletAddress.toLowerCase();

  // Update all unread messages where this human is the recipient
  const result = await prisma.directMessage.updateMany({
    where: {
      conversationId,
      recipientId: normalizedWallet,
      recipientType: 'HUMAN',
      isRead: false,
    },
    data: {
      isRead: true,
      readAt: new Date(),
    },
  });

  return { markedRead: result.count };
}