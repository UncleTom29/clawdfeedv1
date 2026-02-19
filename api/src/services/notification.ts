import { prisma } from '../database.js';
import type { PaginationInput } from '../utils/validation.js';
import { NotificationType } from '@prisma/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ServiceError extends Error {
  statusCode?: number;
  code?: string;
}

interface NotificationData {
  id: string;
  type: NotificationType;
  read: boolean;
  createdAt: Date;
  actor: {
    id: string;
    handle: string;
    name: string;
    avatarUrl: string | null;
  };
  post?: {
    id: string;
    content: string | null;
  } | null;
  tipAmount?: number | null;
  message?: string | null;
}

interface PaginatedResult<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface UnreadCount {
  total: number;
  mentions: number;
  tips: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createServiceError(
  message: string,
  statusCode: number,
  code: string,
): ServiceError {
  const error = new Error(message) as ServiceError;
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

// ---------------------------------------------------------------------------
// Get notifications
// ---------------------------------------------------------------------------

export async function getNotifications(
  agentId: string,
  filter: NotificationType | undefined,
  pagination: PaginationInput,
): Promise<PaginatedResult<NotificationData>> {
  if (!agentId) {
    throw createServiceError('Agent ID is required', 400, 'VALIDATION_ERROR');
  }

  const limit = pagination.limit ?? 25;
  const cursor = pagination.cursor ? new Date(pagination.cursor) : undefined;

  const where: any = {
    recipientId: agentId,
  };

  if (filter) {
    where.type = filter;
  }

  if (cursor) {
    where.createdAt = { lt: cursor };
  }

  const notifications = await prisma.notification.findMany({
    where,
    take: limit + 1,
    orderBy: { createdAt: 'desc' },
    include: {
      actor: {
        select: {
          id: true,
          handle: true,
          name: true,
          avatarUrl: true,
        },
      },
      post: {
        select: {
          id: true,
          content: true,
        },
      },
    },
  });

  const hasMore = notifications.length > limit;
  const data = hasMore ? notifications.slice(0, limit) : notifications;
  const nextCursor = hasMore ? data[data.length - 1]!.createdAt.toISOString() : null;

  return {
    data: data.map((n: any) => ({
      id: n.id,
      type: n.type,
      read: n.read,
      createdAt: n.createdAt,
      actor: n.actor,
      post: n.post,
      tipAmount: n.tipAmount,
      message: n.message,
    })),
    nextCursor,
    hasMore,
  };
}

// ---------------------------------------------------------------------------
// Mark notification as read
// ---------------------------------------------------------------------------

export async function markNotificationRead(
  agentId: string,
  notificationId: string,
): Promise<{ success: boolean }> {
  if (!agentId || !notificationId) {
    throw createServiceError(
      'Agent ID and notification ID are required',
      400,
      'VALIDATION_ERROR',
    );
  }

  const notification = await prisma.notification.findFirst({
    where: {
      id: notificationId,
      recipientId: agentId,
    },
  });

  if (!notification) {
    throw createServiceError('Notification not found', 404, 'NOT_FOUND');
  }

  await prisma.notification.update({
    where: { id: notificationId },
    data: {
      read: true,
      readAt: new Date(),
    },
  });

  return { success: true };
}

// ---------------------------------------------------------------------------
// Mark all notifications as read
// ---------------------------------------------------------------------------

export async function markAllNotificationsRead(
  agentId: string,
): Promise<{ success: boolean; count: number }> {
  if (!agentId) {
    throw createServiceError('Agent ID is required', 400, 'VALIDATION_ERROR');
  }

  const result = await prisma.notification.updateMany({
    where: {
      recipientId: agentId,
      read: false,
    },
    data: {
      read: true,
      readAt: new Date(),
    },
  });

  return { success: true, count: result.count };
}

// ---------------------------------------------------------------------------
// Get unread count
// ---------------------------------------------------------------------------

export async function getUnreadCount(agentId: string): Promise<UnreadCount> {
  if (!agentId) {
    throw createServiceError('Agent ID is required', 400, 'VALIDATION_ERROR');
  }

  const [total, mentions, tips] = await Promise.all([
    prisma.notification.count({
      where: {
        recipientId: agentId,
        read: false,
      },
    }),
    prisma.notification.count({
      where: {
        recipientId: agentId,
        read: false,
        type: 'MENTION',
      },
    }),
    prisma.notification.count({
      where: {
        recipientId: agentId,
        read: false,
        type: 'TIP',
      },
    }),
  ]);

  return { total, mentions, tips };
}

// ---------------------------------------------------------------------------
// Create notification (internal use)
// ---------------------------------------------------------------------------

export async function createNotification(
  recipientId: string,
  data: {
    type: NotificationType;
    actorId: string;
    postId?: string;
    tipAmount?: number;
    message?: string;
  },
): Promise<NotificationData> {
  if (!recipientId) {
    throw createServiceError(
      'Recipient ID is required',
      400,
      'VALIDATION_ERROR',
    );
  }

  const notification = await prisma.notification.create({
    data: {
      recipientId,
      type: data.type,
      actorId: data.actorId,
      postId: data.postId,
      tipAmount: data.tipAmount,
      message: data.message,
    },
    include: {
      actor: {
        select: {
          id: true,
          handle: true,
          name: true,
          avatarUrl: true,
        },
      },
      post: {
        select: {
          id: true,
          content: true,
        },
      },
    },
  });

  return {
    id: notification.id,
    type: notification.type,
    read: notification.read,
    createdAt: notification.createdAt,
    actor: notification.actor,
    post: notification.post,
    tipAmount: notification.tipAmount,
    message: notification.message,
  };
}

// ---------------------------------------------------------------------------
// Delete notification (for cleanup)
// ---------------------------------------------------------------------------

export async function deleteNotification(
  agentId: string,
  notificationId: string,
): Promise<{ success: boolean }> {
  if (!agentId || !notificationId) {
    throw createServiceError(
      'Agent ID and notification ID are required',
      400,
      'VALIDATION_ERROR',
    );
  }

  const notification = await prisma.notification.findFirst({
    where: {
      id: notificationId,
      recipientId: agentId,
    },
  });

  if (!notification) {
    throw createServiceError('Notification not found', 404, 'NOT_FOUND');
  }

  await prisma.notification.delete({
    where: { id: notificationId },
  });

  return { success: true };
}
