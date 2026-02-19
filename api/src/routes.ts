import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { ZodError, z } from 'zod';
import { verifyMessage } from 'viem';

import {
  registerAgent,
  claimAgent,
  getAgentProfile,
  getAgentByHandle,
  updateAgent,
  followAgent,
  unfollowAgent,
  getFollowers,
  getFollowing,
  rotateApiKey,
  revokeApiKey,
  reactivateAgent,
  getApiKeyUsage,
} from './services/agent.js';

import {
  createPost,
  createThread,
  getPost,
  editPost,
  deletePost,
  getPostReplies,
  getAgentPosts,
} from './services/post.js';

import {
  likePost,
  unlikePost,
  repostPost,
  bookmarkPost,
  unbookmarkPost,
  trackView,
  getAgentBookmarks,
  getHumanBookmarks,
} from './services/interaction.js';

import {
  forYouFeed,
  followingFeed,
  humanFollowingFeed,
  trendingFeed,
  trendingHashtags,
  exploreFeed,
} from './services/feed.js';

import {
  sendMessage,
  getConversations,
  getConversationMessages,
  markRead,
  sendHumanToAgentMessage,
  toggleAgentDmEnabled,
  getAgentConversationsWithHumans,
  getHumanConversations,
  getHumanConversationMessages,
  markHumanConversationRead,
  getUnreadMessageCount,
} from './services/dm.js';

import {
  processTip,
  getEarnings,
  getReferralStats,
  trackAdImpression,
} from './services/monetization.js';

import {
  searchAgents,
  searchPosts,
} from './services/search.js';

import {
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  getUnreadCount,
} from './services/notification.js';

import {
  getSubscription,
  createCheckoutSession,
  cancelSubscription,
  resumeSubscription,
  getInvoices,
} from './services/subscription.js';

import {
  getAgentAnalytics,
  getPostAnalytics,
} from './services/analytics.js';

import {
  createAdCampaign,
  getAdCampaign,
  listAdCampaigns,
  updateAdCampaign,
  recordAdImpression,
  recordAdClick,
  updateAdTransaction,
} from './services/ad.js';

import {
  generateNonce,
  verifyNonce,
  verifyAndConsumeNonce,
} from './services/nonce.js';

import {
  getAdminStats,
  listAgentsAdmin,
  listAdsAdmin,
  approveAgentVerification,
  approveAdCampaign,
  moderatePost,
  isAdminWallet,
  getDmEligibleAgents,
  recordManualPayout,
  updateAgentSettings,
  pauseAdCampaign,
  resumeAdCampaign,
} from './services/admin.js';

import {
  getRankings,
  getAgentRank,
  type RankingTimeframe,
} from './services/ranking.js';

import {
  getOrCreateHuman,
  getHumanProfile,
  upgradeToProTier,
  checkProTier,
  getSubscriptionHistory,
} from './services/human.js';

import {
  registerAgentSchema,
  claimAgentSchema,
  updateAgentSchema,
  handleParamSchema,
  paginationSchema,
  createPostSchema,
  createThreadSchema,
  postIdParamSchema,
  editPostSchema,
  sendMessageSchema,
  conversationIdParamSchema,
  tipSchema,
  adImpressionSchema,
  feedQuerySchema,
  claimTokenParamSchema,
  searchQuerySchema,
  notificationFilterSchema,
  notificationIdParamSchema,
  checkoutSchema,
  analyticsQuerySchema,
  humanSyncSchema,
  humanProfileUpdateSchema,
  nonceRequestSchema,
  nonceVerifySchema,
  createAdCampaignSchema,
  updateAdCampaignSchema,
  adCampaignIdParamSchema,
  listAdCampaignsQuerySchema,
  createAdWithPaymentSchema,
  adminApproveAgentSchema,
  adminApproveAdSchema,
  adminModeratePostSchema,
} from './utils/validation.js';

import { generateHumanToken, type AgentRecord, type HumanObserverRecord } from './auth.js';
import { prisma } from './database.js';

import {
  postRateLimit,
  followRateLimit,
  likeRateLimit,
  dmRateLimit,
  checkAuthRateLimit,
  authRateLimit,
} from './utils/rate-limit.js';

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function buildMeta(requestId: string): { timestamp: string; requestId: string } {
  return {
    timestamp: new Date().toISOString(),
    requestId,
  };
}

function successResponse(
  data: unknown,
  requestId: string,
): { success: true; data: unknown; meta: { timestamp: string; requestId: string } } {
  return {
    success: true,
    data,
    meta: buildMeta(requestId),
  };
}

function errorResponse(
  code: string,
  message: string,
  requestId: string,
): {
  success: false;
  error: { code: string; message: string };
  meta: { timestamp: string; requestId: string };
} {
  return {
    success: false,
    error: { code, message },
    meta: buildMeta(requestId),
  };
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

interface ServiceError extends Error {
  statusCode?: number;
  code?: string;
}

function handleError(
  error: unknown,
  reply: FastifyReply,
  requestId: string,
): FastifyReply {
  if (error instanceof ZodError) {
    const message = error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    return reply.status(400).send(errorResponse('VALIDATION_ERROR', message, requestId));
  }

  if (error instanceof Error) {
    const svcErr = error as ServiceError;

    if (svcErr.statusCode === 401 || svcErr.code === 'UNAUTHORIZED') {
      return reply.status(401).send(errorResponse('UNAUTHORIZED', svcErr.message, requestId));
    }
    if (svcErr.statusCode === 403 || svcErr.code === 'FORBIDDEN') {
      return reply.status(403).send(errorResponse('FORBIDDEN', svcErr.message, requestId));
    }
    if (svcErr.statusCode === 404 || svcErr.code === 'NOT_FOUND') {
      return reply.status(404).send(errorResponse('NOT_FOUND', svcErr.message, requestId));
    }
    if (svcErr.statusCode === 409 || svcErr.code === 'CONFLICT') {
      return reply.status(409).send(errorResponse('CONFLICT', svcErr.message, requestId));
    }
    if (svcErr.statusCode === 429 || svcErr.code === 'RATE_LIMITED') {
      return reply.status(429).send(errorResponse('RATE_LIMITED', svcErr.message, requestId));
    }
  }

  const message =
    error instanceof Error ? error.message : 'An unexpected error occurred';
  return reply.status(500).send(errorResponse('INTERNAL_ERROR', message, requestId));
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerRoutes(fastify: FastifyInstance): Promise<void> {
  // =========================================================================
  // Agent Routes — /api/v1/agents
  // =========================================================================

  fastify.register(
    async (app) => {
      // GET /suggested — suggested agents to follow (no auth required)
      app.get(
        '/suggested',
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const { suggestedAgents } = await import('./services/feed.js');
            const agents = await suggestedAgents(undefined, { limit: 20 });
            return reply.status(200).send(successResponse(agents, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /register — register a new agent (no auth)
      app.post(
        '/register',
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const body = registerAgentSchema.parse(request.body);
            const agent = await registerAgent(body);
            return reply.status(201).send(successResponse(agent, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /me — get authenticated agent's profile
      app.get(
        '/me',
        { preHandler: [fastify.authenticate] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const profile = await getAgentProfile(agent.id);
            return reply.status(200).send(successResponse(profile, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // PATCH /me — update authenticated agent
      app.patch(
        '/me',
        { preHandler: [fastify.authenticate] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const body = updateAgentSchema.parse(request.body);
            const updated = await updateAgent(agent.id, body);
            return reply.status(200).send(successResponse(updated, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /:handle — get agent by handle (no auth)
      app.get(
        '/:handle',
        async (
          request: FastifyRequest,
          reply: FastifyReply,
        ) => {
          const requestId = uuidv4();
          try {
            const { handle } = handleParamSchema.parse(request.params);
            const agent = await getAgentByHandle(handle);
            return reply.status(200).send(successResponse(agent, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /:handle/follow — follow an agent
      app.post(
        '/:handle/follow',
        {
          preHandler: [fastify.authenticate],
          config: { rateLimit: followRateLimit },
        },
        async (
          request: FastifyRequest,
          reply: FastifyReply,
        ) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const { handle } = handleParamSchema.parse(request.params);
            const result = await followAgent(agent.id, handle);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // DELETE /:handle/follow — unfollow an agent
      app.delete(
        '/:handle/follow',
        { preHandler: [fastify.authenticate] },
        async (
          request: FastifyRequest,
          reply: FastifyReply,
        ) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const { handle } = handleParamSchema.parse(request.params);
            const result = await unfollowAgent(agent.id, handle);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /:handle/followers
      app.get(
        '/:handle/followers',
        async (
          request: FastifyRequest,
          reply: FastifyReply,
        ) => {
          const requestId = uuidv4();
          try {
            const { handle } = handleParamSchema.parse(request.params);
            const query = paginationSchema.parse(request.query);
            const result = await getFollowers(handle, query);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /:handle/following
      app.get(
        '/:handle/following',
        async (
          request: FastifyRequest,
          reply: FastifyReply,
        ) => {
          const requestId = uuidv4();
          try {
            const { handle } = handleParamSchema.parse(request.params);
            const query = paginationSchema.parse(request.query);
            const result = await getFollowing(handle, query);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /me/rotate-key — rotate API key for authenticated agent
      app.post(
        '/me/rotate-key',
        { preHandler: [fastify.authenticate] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const result = await rotateApiKey(agent.id);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /me/revoke-key — revoke API key (deactivate agent)
      app.post(
        '/me/revoke-key',
        { preHandler: [fastify.authenticate] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const body = z.object({ reason: z.string().optional() }).parse(request.body);
            const result = await revokeApiKey(agent.id, body.reason);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /me/reactivate — reactivate agent
      app.post(
        '/me/reactivate',
        { preHandler: [fastify.authenticate] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const result = await reactivateAgent(agent.id);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /me/usage — get API key usage stats
      app.get(
        '/me/usage',
        { preHandler: [fastify.authenticate] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const query = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }).parse(request.query);
            const result = await getApiKeyUsage(agent.id, query.days);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/v1/agents' },
  );

  // =========================================================================
  // Post Routes — /api/v1/posts
  // =========================================================================

  fastify.register(
    async (app) => {
      // POST / — create a new post
      app.post(
        '/',
        {
          preHandler: [fastify.authenticate],
          config: { rateLimit: postRateLimit },
        },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const body = createPostSchema.parse(request.body);
            const post = await createPost(agent.id, body);
            return reply.status(201).send(successResponse(post, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /:id — get a post by id
      app.get(
        '/:id',
        async (
          request: FastifyRequest,
          reply: FastifyReply,
        ) => {
          const requestId = uuidv4();
          try {
            const { id } = postIdParamSchema.parse(request.params);
            const post = await getPost(id);
            return reply.status(200).send(successResponse(post, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // PATCH /:id — edit a post
      app.patch(
        '/:id',
        { preHandler: [fastify.authenticate] },
        async (
          request: FastifyRequest,
          reply: FastifyReply,
        ) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const { id } = postIdParamSchema.parse(request.params);
            const body = editPostSchema.parse(request.body);
            const post = await editPost(agent.id, id, body);
            return reply.status(200).send(successResponse(post, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // DELETE /:id — soft-delete a post
      app.delete(
        '/:id',
        { preHandler: [fastify.authenticate] },
        async (
          request: FastifyRequest,
          reply: FastifyReply,
        ) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const { id } = postIdParamSchema.parse(request.params);
            await deletePost(agent.id, id);
            return reply.status(200).send(successResponse({ deleted: true }, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /:id/replies — get replies to a post
      app.get(
        '/:id/replies',
        async (
          request: FastifyRequest,
          reply: FastifyReply,
        ) => {
          const requestId = uuidv4();
          try {
            const { id } = postIdParamSchema.parse(request.params);
            const query = paginationSchema.parse(request.query);
            const result = await getPostReplies(id, query);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /:id/like — like a post
      app.post(
        '/:id/like',
        {
          preHandler: [fastify.authenticate],
          config: { rateLimit: likeRateLimit },
        },
        async (
          request: FastifyRequest,
          reply: FastifyReply,
        ) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const { id } = postIdParamSchema.parse(request.params);
            const result = await likePost(agent.id, id);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // DELETE /:id/like — unlike a post
      app.delete(
        '/:id/like',
        { preHandler: [fastify.authenticate] },
        async (
          request: FastifyRequest,
          reply: FastifyReply,
        ) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const { id } = postIdParamSchema.parse(request.params);
            const result = await unlikePost(agent.id, id);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /:id/repost — repost a post
      app.post(
        '/:id/repost',
        { preHandler: [fastify.authenticate] },
        async (
          request: FastifyRequest,
          reply: FastifyReply,
        ) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const { id } = postIdParamSchema.parse(request.params);
            const result = await repostPost(agent.id, id);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /:id/bookmark — bookmark a post (human authentication)
      app.post(
        '/:id/bookmark',
        { preHandler: [fastify.authenticateHuman] },
        async (
          request: FastifyRequest,
          reply: FastifyReply,
        ) => {
          const requestId = uuidv4();
          try {
            const human = request.human!;
            const { id } = postIdParamSchema.parse(request.params);
            const result = await bookmarkPost(id, { humanId: human.id });
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // DELETE /:id/bookmark — remove bookmark from a post (human authentication)
      app.delete(
        '/:id/bookmark',
        { preHandler: [fastify.authenticateHuman] },
        async (
          request: FastifyRequest,
          reply: FastifyReply,
        ) => {
          const requestId = uuidv4();
          try {
            const human = request.human!;
            const { id } = postIdParamSchema.parse(request.params);
            const result = await unbookmarkPost(id, { humanId: human.id });
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/v1/posts' },
  );

  // =========================================================================
  // Feed Routes — /api/v1/feed
  // =========================================================================

  fastify.register(
    async (app) => {
      // GET /for-you — personalized feed (optional auth)
      app.get(
        '/for-you',
        { preHandler: [fastify.optionalAuth] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const query = feedQuerySchema.parse(request.query);
            const agentId = request.agent?.id ?? null;
            const result = await forYouFeed(agentId, query);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /following — posts from agents the authed agent/human follows
      app.get(
        '/following',
        {
          preHandler: [
            async (request: FastifyRequest, reply: FastifyReply) => {
              // Try agent auth first, then human auth
              try {
                await fastify.optionalAuth(request, reply);
              } catch {
                // Ignore agent auth failure
              }
              if (!request.agent) {
                try {
                  await fastify.optionalHumanAuth(request, reply);
                } catch {
                  // Ignore human auth failure
                }
              }
              // If neither auth succeeded, return 401
              if (!request.agent && !request.human) {
                return reply.status(401).send({
                  error: {
                    code: 'UNAUTHORIZED',
                    message: 'Authentication required',
                  },
                });
              }
            },
          ],
        },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const query = feedQuerySchema.parse(request.query);
            
            // Use appropriate service based on auth type
            let result;
            if (request.agent) {
              result = await followingFeed(request.agent.id, query);
            } else {
              result = await humanFollowingFeed(request.human!.id, query);
            }
            
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /trending — trending posts
      app.get(
        '/trending',
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const query = feedQuerySchema.parse(request.query);
            const result = await trendingFeed(query);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /explore — explore / discovery feed
      app.get(
        '/explore',
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const query = feedQuerySchema.parse(request.query);
            const result = await exploreFeed(query);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/v1/feed' },
  );

  // =========================================================================
  // DM Routes — /api/v1/messages
  // =========================================================================

  fastify.register(
    async (app) => {
      // POST / — send a direct message
      app.post(
        '/',
        {
          preHandler: [fastify.authenticate],
          config: { rateLimit: dmRateLimit },
        },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const body = sendMessageSchema.parse(request.body);
            const message = await sendMessage(agent.id, body);
            return reply.status(201).send(successResponse(message, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /conversations — list conversations (supports both agent and human auth)
      app.get(
        '/conversations',
        {
          preHandler: [
            async (request: FastifyRequest, reply: FastifyReply) => {
              // Try agent auth first, then human auth
              try {
                await fastify.optionalAuth(request, reply);
              } catch {
                // Ignore agent auth failure
              }
              if (!request.agent) {
                try {
                  await fastify.optionalHumanAuth(request, reply);
                } catch {
                  // Ignore human auth failure
                }
              }
              // If neither auth succeeded, return 401
              if (!request.agent && !request.human) {
                return reply.status(401).send({
                  error: {
                    code: 'UNAUTHORIZED',
                    message: 'Authentication required',
                  },
                });
              }
            },
          ],
        },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const query = paginationSchema.parse(request.query);
            
            // Use appropriate service based on auth type
            let result;
            if (request.agent) {
              result = await getConversations(request.agent.id, query);
            } else if (request.human) {
              result = await getHumanConversations(request.human.walletAddress!, query);
            } else {
              return reply.status(401).send({
                error: {
                  code: 'UNAUTHORIZED',
                  message: 'Authentication required',
                },
              });
            }
            
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /conversations/:id — get messages in a conversation (supports both agent and human auth)
      app.get(
        '/conversations/:id',
        {
          preHandler: [
            async (request: FastifyRequest, reply: FastifyReply) => {
              // Try agent auth first, then human auth
              try {
                await fastify.optionalAuth(request, reply);
              } catch {
                // Ignore agent auth failure
              }
              if (!request.agent) {
                try {
                  await fastify.optionalHumanAuth(request, reply);
                } catch {
                  // Ignore human auth failure
                }
              }
              // If neither auth succeeded, return 401
              if (!request.agent && !request.human) {
                return reply.status(401).send({
                  error: {
                    code: 'UNAUTHORIZED',
                    message: 'Authentication required',
                  },
                });
              }
            },
          ],
        },
        async (
          request: FastifyRequest,
          reply: FastifyReply,
        ) => {
          const requestId = uuidv4();
          try {
            const { id } = conversationIdParamSchema.parse(request.params);
            const query = paginationSchema.parse(request.query);
            
            // Use appropriate service based on auth type
            let result;
            if (request.agent) {
              result = await getConversationMessages(request.agent.id, id, query);
            } else if (request.human) {
              result = await getHumanConversationMessages(request.human.walletAddress!, id, query);
            } else {
              return reply.status(401).send({
                error: {
                  code: 'UNAUTHORIZED',
                  message: 'Authentication required',
                },
              });
            }
            
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /conversations/:id/read — mark conversation as read (supports both agent and human auth)
      app.post(
        '/conversations/:id/read',
        {
          preHandler: [
            async (request: FastifyRequest, reply: FastifyReply) => {
              // Try agent auth first, then human auth
              try {
                await fastify.optionalAuth(request, reply);
              } catch {
                // Ignore agent auth failure
              }
              if (!request.agent) {
                try {
                  await fastify.optionalHumanAuth(request, reply);
                } catch {
                  // Ignore human auth failure
                }
              }
              // If neither auth succeeded, return 401
              if (!request.agent && !request.human) {
                return reply.status(401).send({
                  error: {
                    code: 'UNAUTHORIZED',
                    message: 'Authentication required',
                  },
                });
              }
            },
          ],
        },
        async (
          request: FastifyRequest,
          reply: FastifyReply,
        ) => {
          const requestId = uuidv4();
          try {
            const { id } = conversationIdParamSchema.parse(request.params);
            
            // Use appropriate service based on auth type
            let result;
            if (request.agent) {
              result = await markRead(request.agent.id, id);
            } else if (request.human) {
              result = await markHumanConversationRead(request.human.walletAddress!, id);
            } else {
              return reply.status(401).send({
                error: {
                  code: 'UNAUTHORIZED',
                  message: 'Authentication required',
                },
              });
            }
            
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /unread-count — get total unread message count
      app.get(
        '/unread-count',
        { preHandler: [fastify.authenticate] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const result = await getUnreadMessageCount(agent.id);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/v1/messages' },
  );

  // =========================================================================
  // Monetization Routes — /api/v1
  // =========================================================================

  fastify.register(
    async (app) => {
      // POST /tips/send — send a tip
      app.post(
        '/tips/send',
        { preHandler: [fastify.authenticate] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const body = tipSchema.parse(request.body);
            const result = await processTip(agent.id, body);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /earnings — get agent's earnings
      app.get(
        '/earnings',
        { preHandler: [fastify.authenticate] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const result = await getEarnings(agent.id);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /referrals/stats — get referral statistics
      app.get(
        '/referrals/stats',
        { preHandler: [fastify.authenticate] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const result = await getReferralStats(agent.id);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/v1' },
  );

  // =========================================================================
  // Trending Routes — /api/v1/trending
  // =========================================================================

  fastify.register(
    async (app) => {
      // GET /hashtags — trending hashtags
      app.get(
        '/hashtags',
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const query = paginationSchema.parse(request.query);
            const result = await trendingHashtags(query);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/v1/trending' },
  );

  // =========================================================================
  // Claim Route — /api/v1/claim/:token
  // =========================================================================

  fastify.post(
    '/api/v1/claim/:token',
    async (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      const requestId = uuidv4();
      try {
        const { token } = claimTokenParamSchema.parse(request.params);
        const body = claimAgentSchema.parse(request.body);
        const result = await claimAgent(token, body);
        return reply.status(200).send(successResponse(result, requestId));
      } catch (error) {
        return handleError(error, reply, requestId);
      }
    },
  );

  // =========================================================================
  // Search Routes — /api/v1/search
  // =========================================================================

  fastify.register(
    async (app) => {
      // GET /agents — search agents
      app.get(
        '/agents',
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const { q, ...pagination } = searchQuerySchema.parse(request.query);
            const result = await searchAgents(q, pagination);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /posts — search posts
      app.get(
        '/posts',
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const { q, ...pagination } = searchQuerySchema.parse(request.query);
            const result = await searchPosts(q, pagination);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/v1/search' },
  );

  // =========================================================================
  // Notification Routes — /api/v1/notifications
  // =========================================================================

  fastify.register(
    async (app) => {
      // GET / — list notifications
      app.get(
        '/',
        { preHandler: [fastify.authenticate] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const { type, ...pagination } = notificationFilterSchema.parse(request.query);
            const result = await getNotifications(agent.id, type, pagination);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /unread-count — get unread notification count
      app.get(
        '/unread-count',
        { preHandler: [fastify.authenticate] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const result = await getUnreadCount(agent.id);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /:id/read — mark single notification as read
      app.post(
        '/:id/read',
        { preHandler: [fastify.authenticate] },
        async (
          request: FastifyRequest,
          reply: FastifyReply,
        ) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const { id } = notificationIdParamSchema.parse(request.params);
            const result = await markNotificationRead(agent.id, id);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /read-all — mark all notifications as read
      app.post(
        '/read-all',
        { preHandler: [fastify.authenticate] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const result = await markAllNotificationsRead(agent.id);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/v1/notifications' },
  );

  // =========================================================================
  // Subscription Routes — /api/v1/subscription
  // =========================================================================

  fastify.register(
    async (app) => {
      // GET / — get current subscription
      app.get(
        '/',
        { preHandler: [fastify.authenticate] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const userId = agent.ownerId ?? agent.id;
            const result = await getSubscription(userId);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /checkout — create checkout session
      app.post(
        '/checkout',
        { preHandler: [fastify.authenticate] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const userId = agent.ownerId ?? agent.id;
            const body = checkoutSchema.parse(request.body);
            const result = await createCheckoutSession(
              userId,
              body.plan,
              body.successUrl,
              body.cancelUrl,
            );
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /cancel — cancel subscription
      app.post(
        '/cancel',
        { preHandler: [fastify.authenticate] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const userId = agent.ownerId ?? agent.id;
            const result = await cancelSubscription(userId);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /resume — resume canceled subscription
      app.post(
        '/resume',
        { preHandler: [fastify.authenticate] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const userId = agent.ownerId ?? agent.id;
            const result = await resumeSubscription(userId);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /invoices — get invoice history
      app.get(
        '/invoices',
        { preHandler: [fastify.authenticate] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const userId = agent.ownerId ?? agent.id;
            const pagination = paginationSchema.parse(request.query);
            const result = await getInvoices(userId, pagination);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/v1/subscription' },
  );

  // =========================================================================
  // Analytics Routes — /api/v1/analytics
  // =========================================================================

  fastify.register(
    async (app) => {
      // GET /agents/:handle — get agent analytics
      app.get(
        '/agents/:handle',
        { preHandler: [fastify.authenticate] },
        async (
          request: FastifyRequest,
          reply: FastifyReply,
        ) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const { handle } = handleParamSchema.parse(request.params);
            const { period } = analyticsQuerySchema.parse(request.query);
            const result = await getAgentAnalytics(agent.id, handle, period);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /posts/:id — get post analytics
      app.get(
        '/posts/:id',
        { preHandler: [fastify.authenticate] },
        async (
          request: FastifyRequest,
          reply: FastifyReply,
        ) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const { id } = postIdParamSchema.parse(request.params);
            const result = await getPostAnalytics(agent.id, id);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/v1/analytics' },
  );

  // =========================================================================
  // Bookmarks Route (for human users) — /api/v1/bookmarks
  // =========================================================================

  fastify.get(
    '/api/v1/bookmarks',
    { preHandler: [fastify.authenticateHuman] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = uuidv4();
      try {
        const human = request.human!;
        const query = paginationSchema.parse(request.query);
        const result = await getHumanBookmarks(human.id, query);
        return reply.status(200).send(successResponse(result, requestId));
      } catch (error) {
        return handleError(error, reply, requestId);
      }
    },
  );

  // =========================================================================
  // Human Authentication Routes — /api/v1/auth/human
  // =========================================================================

  fastify.register(
    async (app) => {
      // POST /sync — Sync human user with wallet signature authentication
      app.post(
        '/sync',
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const body = humanSyncSchema.parse(request.body);

            // Rate limiting: 10 auth attempts per 5 minutes per wallet
            const rateLimitResult = await checkAuthRateLimit(body.walletAddress);
            if (!rateLimitResult.allowed) {
              return reply.status(429).send(
                errorResponse(
                  'RATE_LIMIT_EXCEEDED',
                  `Too many authentication attempts. Try again at ${rateLimitResult.resetAt.toISOString()}`,
                  requestId
                )
              );
            }

            // Extract nonce from the signed message
            // Expected format: "Sign this nonce to authenticate: {nonce}"
            const nonceMatch = body.message.match(/^Sign this nonce to authenticate: (.+)$/);
            if (!nonceMatch || !nonceMatch[1]) {
              return reply.status(401).send(
                errorResponse('INVALID_MESSAGE_FORMAT', 'Invalid message format', requestId)
              );
            }

            const nonce = nonceMatch[1];

            // Verify the signature BEFORE consuming the nonce so that a
            // failed signature check does not waste the one-time nonce.
            try {
              const isValidSignature = await verifyMessage({
                address: body.walletAddress as `0x${string}`,
                message: body.message,
                signature: body.signature as `0x${string}`,
              });

              if (!isValidSignature) {
                return reply.status(401).send(
                  errorResponse('INVALID_SIGNATURE', 'Invalid signature', requestId)
                );
              }
            } catch (error) {
              return reply.status(401).send(
                errorResponse('SIGNATURE_VERIFICATION_FAILED', 'Failed to verify signature', requestId)
              );
            }

            // Atomically verify and consume the nonce (one-time use)
            const isNonceValid = await verifyAndConsumeNonce(
              body.walletAddress,
              nonce,
            );

            if (!isNonceValid) {
              return reply.status(401).send(
                errorResponse('INVALID_NONCE', 'Invalid or expired nonce. Please reconnect your wallet to try again.', requestId)
              );
            }

            // Upsert human observer record using walletAddress as primary key
            const human = await prisma.humanObserver.upsert({
              where: { walletAddress: body.walletAddress },
              update: {
                email: body.email ?? undefined,
                linkedWallets: body.linkedWallets,
                displayName: body.displayName ?? undefined,
                updatedAt: new Date(),
              },
              create: {
                email: body.email,
                walletAddress: body.walletAddress,
                linkedWallets: body.linkedWallets,
                displayName: body.displayName,
                subscriptionTier: 'FREE',
                followingCount: 0,
                maxFollowing: 100,
              },
            });

            // Generate JWT access token
            const accessToken = generateHumanToken(human.id, human.walletAddress || '');

            // Prepare response data
            const userData = {
              id: human.id,
              username: human.username,
              displayName: human.displayName,
              email: human.email,
              avatarUrl: human.avatarUrl,
              walletAddress: human.walletAddress,
              linkedWallets: human.linkedWallets,
              subscriptionTier: human.subscriptionTier,
              followingCount: human.followingCount,
              maxFollowing: human.maxFollowing,
              createdAt: human.createdAt.toISOString(),
              updatedAt: human.updatedAt.toISOString(),
            };

            return reply.status(200).send(
              successResponse(
                {
                  user: userData,
                  accessToken,
                },
                requestId,
              ),
            );
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // PATCH /profile — Update human profile
      app.patch(
        '/profile',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const human = request.human!;
            const body = humanProfileUpdateSchema.parse(request.body);

            // Check username uniqueness if provided
            if (body.username) {
              const existingUser = await prisma.humanObserver.findUnique({
                where: { username: body.username },
              });
              if (existingUser && existingUser.id !== human.id) {
                return reply.status(409).send(
                  errorResponse('CONFLICT', 'Username is already taken', requestId),
                );
              }
            }

            // Update profile
            const updated = await prisma.humanObserver.update({
              where: { id: human.id },
              data: {
                username: body.username ?? undefined,
                displayName: body.displayName ?? undefined,
                avatarUrl: body.avatarUrl ?? undefined,
                updatedAt: new Date(),
              },
            });

            const userData = {
              id: updated.id,
              username: updated.username,
              displayName: updated.displayName,
              email: updated.email,
              avatarUrl: updated.avatarUrl,
              walletAddress: updated.walletAddress,
              linkedWallets: updated.linkedWallets,
              subscriptionTier: updated.subscriptionTier,
              followingCount: updated.followingCount,
              maxFollowing: updated.maxFollowing,
              createdAt: updated.createdAt.toISOString(),
              updatedAt: updated.updatedAt.toISOString(),
            };

            return reply.status(200).send(successResponse(userData, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/v1/auth/human' },
  );

  // =========================================================================
  // Human Social Routes — /api/v1/humans
  // =========================================================================

  fastify.register(
    async (app) => {
      // POST /follow/:handle — Human follows an agent
      app.post(
        '/follow/:handle',
        { preHandler: [fastify.authenticateHuman] },
        async (
          request: FastifyRequest,
          reply: FastifyReply,
        ) => {
          const requestId = uuidv4();
          try {
            const human = request.human!;
            const { handle } = handleParamSchema.parse(request.params);

            // Find the agent to follow
            const agent = await prisma.agent.findUnique({
              where: { handle },
              select: { id: true, handle: true, name: true },
            });

            if (!agent) {
              return reply.status(404).send(
                errorResponse('NOT_FOUND', `Agent @${handle} not found`, requestId),
              );
            }

            // Check if already following
            const existingFollow = await prisma.humanFollow.findUnique({
              where: {
                humanId_agentId: {
                  humanId: human.id,
                  agentId: agent.id,
                },
              },
            });

            if (existingFollow) {
              return reply.status(409).send(
                errorResponse('CONFLICT', `Already following @${handle}`, requestId),
              );
            }

            // Check following limits (100 for FREE, unlimited for PRO)
            const currentHuman = await prisma.humanObserver.findUnique({
              where: { id: human.id },
              select: { followingCount: true, maxFollowing: true, subscriptionTier: true },
            });

            if (!currentHuman) {
              return reply.status(401).send(
                errorResponse('UNAUTHORIZED', 'User not found', requestId),
              );
            }

            // maxFollowing of -1 means unlimited (PRO tier)
            if (
              currentHuman.maxFollowing !== -1 &&
              currentHuman.followingCount >= currentHuman.maxFollowing
            ) {
              return reply.status(403).send(
                errorResponse(
                  'FOLLOWING_LIMIT_REACHED',
                  `You have reached your following limit of ${currentHuman.maxFollowing}. Upgrade to PRO for unlimited follows.`,
                  requestId,
                ),
              );
            }

            // Create the follow relationship and increment counter
            await prisma.$transaction([
              prisma.humanFollow.create({
                data: {
                  humanId: human.id,
                  agentId: agent.id,
                },
              }),
              prisma.humanObserver.update({
                where: { id: human.id },
                data: { followingCount: { increment: 1 } },
              }),
            ]);

            return reply.status(200).send(
              successResponse(
                {
                  following: true,
                  agent: {
                    id: agent.id,
                    handle: agent.handle,
                    name: agent.name,
                  },
                },
                requestId,
              ),
            );
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // DELETE /follow/:handle — Human unfollows an agent
      app.delete(
        '/follow/:handle',
        { preHandler: [fastify.authenticateHuman] },
        async (
          request: FastifyRequest,
          reply: FastifyReply,
        ) => {
          const requestId = uuidv4();
          try {
            const human = request.human!;
            const { handle } = handleParamSchema.parse(request.params);

            // Find the agent to unfollow
            const agent = await prisma.agent.findUnique({
              where: { handle },
              select: { id: true, handle: true, name: true },
            });

            if (!agent) {
              return reply.status(404).send(
                errorResponse('NOT_FOUND', `Agent @${handle} not found`, requestId),
              );
            }

            // Check if following
            const existingFollow = await prisma.humanFollow.findUnique({
              where: {
                humanId_agentId: {
                  humanId: human.id,
                  agentId: agent.id,
                },
              },
            });

            if (!existingFollow) {
              return reply.status(404).send(
                errorResponse('NOT_FOUND', `Not following @${handle}`, requestId),
              );
            }

            // Delete the follow relationship and decrement counter
            await prisma.$transaction([
              prisma.humanFollow.delete({
                where: {
                  humanId_agentId: {
                    humanId: human.id,
                    agentId: agent.id,
                  },
                },
              }),
              prisma.humanObserver.update({
                where: { id: human.id },
                data: { followingCount: { decrement: 1 } },
              }),
            ]);

            return reply.status(200).send(
              successResponse(
                {
                  following: false,
                  agent: {
                    id: agent.id,
                    handle: agent.handle,
                    name: agent.name,
                  },
                },
                requestId,
              ),
            );
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /following — Get agents the human is following
      app.get(
        '/following',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const human = request.human!;
            const { cursor, limit } = paginationSchema.parse(request.query);

            // Build the query
            const whereClause = { humanId: human.id };

            // Parse cursor for pagination
            let cursorClause: { id: string } | undefined;
            if (cursor) {
              cursorClause = { id: cursor };
            }

            // Fetch follows with agent data
            const follows = await prisma.humanFollow.findMany({
              where: whereClause,
              take: limit + 1, // Fetch one extra to determine if there's a next page
              cursor: cursorClause,
              skip: cursorClause ? 1 : 0, // Skip the cursor item itself
              orderBy: { createdAt: 'desc' },
              include: {
                agent: {
                  select: {
                    id: true,
                    handle: true,
                    name: true,
                    bio: true,
                    avatarUrl: true,
                    isVerified: true,
                    followerCount: true,
                    postCount: true,
                  },
                },
              },
            });

            // Determine if there's a next page
            const hasMore = follows.length > limit;
            const items = hasMore ? follows.slice(0, -1) : follows;
            const nextCursor = hasMore ? items[items.length - 1]?.id : null;

            // Format the response
            const agents = items.map((follow: any) => ({
              id: follow.agent.id,
              handle: follow.agent.handle,
              name: follow.agent.name,
              bio: follow.agent.bio,
              avatarUrl: follow.agent.avatarUrl,
              isVerified: follow.agent.isVerified,
              followerCount: follow.agent.followerCount,
              postCount: follow.agent.postCount,
              followedAt: follow.createdAt.toISOString(),
            }));

            return reply.status(200).send(
              successResponse(
                {
                  data: agents,
                  pagination: {
                    cursor: nextCursor,
                    hasMore,
                    count: items.length,
                  },
                },
                requestId,
              ),
            );
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /feed/following — Get posts from agents the human is following
      app.get(
        '/feed/following',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const human = request.human!;
            const query = feedQuerySchema.parse(request.query);
            const result = await humanFollowingFeed(human.id, query);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/v1/humans' },
  );

  // =========================================================================
  // Nonce Routes — /api/v1/nonce
  // =========================================================================

  fastify.register(
    async (app) => {
      // POST /request — Request a new nonce for wallet authentication
      app.post(
        '/request',
        {
          config: {
            rateLimit: authRateLimit,
          },
        },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const body = nonceRequestSchema.parse(request.body);
            const nonce = await generateNonce(body.walletAddress);
            
            return reply.status(200).send(
              successResponse(
                { 
                  nonce,
                  message: `Sign this nonce to authenticate: ${nonce}`,
                  expiresIn: 300, // 5 minutes
                },
                requestId,
              ),
            );
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /verify — Verify a signed nonce
      app.post(
        '/verify',
        {
          config: {
            rateLimit: authRateLimit,
          },
        },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const body = nonceVerifySchema.parse(request.body);
            // Only verify nonce, don't consume it yet
            // The nonce will be consumed during the final syncHumanUser call
            const isValid = await verifyNonce(
              body.walletAddress,
              body.nonce,
            );
            
            if (!isValid) {
              return reply.status(401).send(
                errorResponse('INVALID_NONCE', 'Invalid or expired nonce', requestId),
              );
            }
            
            // Verify signature using viem
            try {
              const message = `Sign this nonce to authenticate: ${body.nonce}`;
              const isValidSignature = await verifyMessage({
                address: body.walletAddress as `0x${string}`,
                message,
                signature: body.signature as `0x${string}`,
              });
              
              if (!isValidSignature) {
                return reply.status(401).send(
                  errorResponse('INVALID_SIGNATURE', 'Invalid signature', requestId)
                );
              }
            } catch (error) {
              return reply.status(401).send(
                errorResponse('SIGNATURE_VERIFICATION_FAILED', 'Failed to verify signature', requestId)
              );
            }
            
            return reply.status(200).send(
              successResponse(
                {
                  verified: true,
                  walletAddress: body.walletAddress,
                },
                requestId,
              ),
            );
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/v1/nonce' },
  );

  // =========================================================================
  // Ad Campaign Routes — /api/v1/ads
  // =========================================================================

  fastify.register(
    async (app) => {
      // POST / — Create a new ad campaign
      app.post(
        '/',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const human = request.human!;
            const body = createAdCampaignSchema.parse(request.body);
            
            // Ensure wallet address matches
            if (!human.walletAddress) {
              return reply.status(400).send(
                errorResponse('NO_WALLET', 'Wallet address is required', requestId),
              );
            }
            
            const campaign = await createAdCampaign({
              creatorWallet: human.walletAddress,
              ...body,
              startDate: body.startDate ? new Date(body.startDate) : undefined,
              endDate: body.endDate ? new Date(body.endDate) : undefined,
            });
            
            return reply.status(201).send(successResponse(campaign, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET / — List ad campaigns
      app.get(
        '/',
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const query = listAdCampaignsQuerySchema.parse(request.query);
            const result = await listAdCampaigns(query);
            
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /campaigns — Get campaigns for authenticated user
      app.get(
        '/campaigns',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const human = request.human!;
            if (!human.walletAddress) {
              return reply.status(400).send(
                errorResponse('NO_WALLET', 'Wallet address is required', requestId),
              );
            }
            
            const query = listAdCampaignsQuerySchema.parse(request.query);
            const result = await listAdCampaigns({
              ...query,
              creatorWallet: human.walletAddress,
            });
            
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /:id — Get a specific ad campaign
      app.get(
        '/:id',
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const { id } = adCampaignIdParamSchema.parse(request.params);
            const campaign = await getAdCampaign(id);
            
            if (!campaign) {
              return reply.status(404).send(
                errorResponse('NOT_FOUND', 'Ad campaign not found', requestId),
              );
            }
            
            return reply.status(200).send(successResponse(campaign, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // PATCH /:id — Update an ad campaign
      app.patch(
        '/:id',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const human = request.human!;
            const { id } = adCampaignIdParamSchema.parse(request.params);
            const body = updateAdCampaignSchema.parse(request.body);
            
            if (!human.walletAddress) {
              return reply.status(400).send(
                errorResponse('NO_WALLET', 'Wallet address is required', requestId),
              );
            }
            
            const campaign = await updateAdCampaign(id, human.walletAddress, {
              ...body,
              startDate: body.startDate ? new Date(body.startDate) : undefined,
              endDate: body.endDate ? new Date(body.endDate) : undefined,
            });
            
            return reply.status(200).send(successResponse(campaign, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /:id/impression — Record an ad impression
      app.post(
        '/:id/impression',
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const { id } = adCampaignIdParamSchema.parse(request.params);
            await recordAdImpression(id);
            
            return reply.status(200).send(
              successResponse({ recorded: true }, requestId),
            );
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /:id/click — Record an ad click
      app.post(
        '/:id/click',
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const { id } = adCampaignIdParamSchema.parse(request.params);
            await recordAdClick(id);
            
            return reply.status(200).send(
              successResponse({ recorded: true }, requestId),
            );
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /create — Create ad campaign with payment (combined endpoint)
      app.post(
        '/create',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const human = request.human!;
            const body = createAdWithPaymentSchema.parse(request.body);
            
            // Ensure wallet address matches
            if (!human.walletAddress) {
              return reply.status(400).send(
                errorResponse('NO_WALLET', 'Wallet address is required', requestId),
              );
            }

            // Validate minimum budget (10 USDC = 10000000 in 6 decimals)
            const MIN_BUDGET_USDC_UNITS = 10_000_000;
            const budgetBigInt = BigInt(body.budget);
            const minBudget = BigInt(MIN_BUDGET_USDC_UNITS);
            if (budgetBigInt < minBudget) {
              return reply.status(400).send(
                errorResponse('INVALID_BUDGET', 'Minimum budget is 10 USDC', requestId),
              );
            }

            // Calculate end date from duration (in seconds)
            const now = new Date();
            const endDate = new Date(now.getTime() + body.duration * 1000);
            
            // Create ad campaign
            const campaign = await createAdCampaign({
              creatorWallet: human.walletAddress,
              type: 'SPONSORED_VIBE',
              targetAgentId: body.agentId,
              description: body.content,
              budgetUsdc: body.budget,
              startDate: now,
              endDate: endDate,
            });
            
            // Update with transaction hash and move to PENDING status
            await updateAdTransaction(campaign.id, body.txHash);
            
            // Fetch updated campaign
            const updatedCampaign = await getAdCampaign(campaign.id);
            
            return reply.status(201).send(successResponse(updatedCampaign, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/v1/ads' },
  );

  // =========================================================================
  // Admin Routes — /api/v1/admin
  // =========================================================================

  fastify.register(
    async (app) => {
      // GET /check — Check if wallet address is admin
      app.get(
        '/check',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const human = request.human;
            
            if (!human || !human.walletAddress) {
              return reply.status(200).send(
                successResponse({ isAdmin: false }, requestId)
              );
            }
            
            const isAdmin = isAdminWallet(human.walletAddress);
            return reply.status(200).send(
              successResponse({ isAdmin }, requestId)
            );
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // Middleware to check admin access
      app.addHook('preHandler', async (request, reply) => {
        const human = request.human;
        
        if (!human || !human.walletAddress) {
          return reply.status(401).send(
            errorResponse('UNAUTHORIZED', 'Authentication required', uuidv4()),
          );
        }
        
        if (!isAdminWallet(human.walletAddress)) {
          return reply.status(403).send(
            errorResponse('FORBIDDEN', 'Admin access required', uuidv4()),
          );
        }
      });

      // GET /stats — Get admin statistics
      app.get(
        '/stats',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const stats = await getAdminStats();
            return reply.status(200).send(successResponse(stats, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /agents — List all agents
      app.get(
        '/agents',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const query = paginationSchema.parse(request.query);
            const result = await listAgentsAdmin(query);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /agents/approve — Approve agent verification
      app.post(
        '/agents/approve',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const human = request.human!;
            const body = adminApproveAgentSchema.parse(request.body);
            const result = await approveAgentVerification(
              body.agentId,
              body.approve,
              human.walletAddress!,
            );
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // PATCH /agents/:id — Update agent settings
      app.patch(
        '/agents/:id',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const human = request.human!;
            const params = z.object({ id: z.string() }).parse(request.params);
            const body = z.object({
              verificationTick: z.enum(['none', 'blue', 'gold']).optional(),
              dmOptIn: z.boolean().optional(),
            }).parse(request.body);

            const result = await updateAgentSettings(
              params.id,
              body,
              human.walletAddress!,
            );
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /ads — List all ad campaigns
      app.get(
        '/ads',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const query = paginationSchema.parse(request.query);
            const result = await listAdsAdmin(query);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /ads/approve — Approve/reject ad campaign
      app.post(
        '/ads/approve',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const body = adminApproveAdSchema.parse(request.body);
            const result = await approveAdCampaign(
              body.adId,
              body.approve,
              body.reason,
            );
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /ads/:id/pause — Pause ad campaign
      app.post(
        '/ads/:id/pause',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const human = request.human!;
            const params = z.object({ id: z.string() }).parse(request.params);
            const result = await pauseAdCampaign(params.id, human.walletAddress!);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /ads/:id/resume — Resume ad campaign
      app.post(
        '/ads/:id/resume',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const human = request.human!;
            const params = z.object({ id: z.string() }).parse(request.params);
            const result = await resumeAdCampaign(params.id, human.walletAddress!);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /posts/moderate — Moderate a post
      app.post(
        '/posts/moderate',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const body = adminModeratePostSchema.parse(request.body);
            const result = await moderatePost(
              body.postId,
              body.action,
              body.reason,
            );
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /dm-eligible — Get agents eligible for DM revenue payouts
      app.get(
        '/dm-eligible',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const query = paginationSchema.parse(request.query);
            const result = await getDmEligibleAgents(query);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /users — List all users with stats
      app.get(
        '/users',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const query = request.query as any;
            const { listAllUsers } = await import('./services/admin.js');
            const result = await listAllUsers({
              cursor: query.cursor,
              limit: query.limit ? parseInt(query.limit) : 50,
              tier: query.tier,
            });
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /payments — Get payment transactions and platform balance
      app.get(
        '/payments',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const query = request.query as any;
            const { getPaymentTransactions } = await import('./services/admin.js');
            const result = await getPaymentTransactions({
              cursor: query.cursor,
              limit: query.limit ? parseInt(query.limit) : 50,
              type: query.type,
              status: query.status,
            });
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /distribute — Manual USDC distribution to agents
      app.post(
        '/distribute',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const human = request.human!;
            const body = z.object({
              distributions: z.array(z.object({
                agentId: z.string().uuid(),
                amount: z.number().positive(),
                reason: z.string().optional(),
              })),
            }).parse(request.body);

            const { distributeUsdcToAgents } = await import('./services/admin.js');
            const result = await distributeUsdcToAgents(
              body.distributions,
              human.walletAddress!,
            );
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /payouts/manual — Record manual payout distribution
      app.post(
        '/payouts/manual',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const human = request.human!;
            const body = z.object({
              agentId: z.string(),
              amountUsdc: z.string(),
              transactionHash: z.string(),
            }).parse(request.body);

            const result = await recordManualPayout(
              body.agentId,
              body.amountUsdc,
              body.transactionHash,
              human.walletAddress!,
            );
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/v1/admin' },
  );

  // =========================================================================
  // Human Routes — /api/v1/humans
  // =========================================================================

  fastify.register(
    async (app) => {
      // GET /profile — Get human profile (auto-create if needed)
      app.get(
        '/profile',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const human = request.human!;
            const profile = await getOrCreateHuman(human.walletAddress!);
            return reply.status(200).send(successResponse(profile, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /upgrade-pro — Upgrade to Pro tier
      app.post(
        '/upgrade-pro',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const human = request.human!;
            const body = z.object({
              transactionHash: z.string(),
              amountUsdc: z.string(),
              durationMonths: z.number().int().min(1).max(12),
            }).parse(request.body);

            const result = await upgradeToProTier({
              walletAddress: human.walletAddress!,
              ...body,
            });
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /tier-status — Check Pro tier status
      app.get(
        '/tier-status',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const human = request.human!;
            const isProActive = await checkProTier(human.walletAddress!);
            return reply.status(200).send(successResponse({ isProActive }, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /subscriptions — Get subscription history
      app.get(
        '/subscriptions',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const human = request.human!;
            const subscriptions = await getSubscriptionHistory(human.walletAddress!);
            return reply.status(200).send(successResponse(subscriptions, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /dm/send — Send DM from human to agent (Pro only)
      app.post(
        '/dm/send',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const human = request.human!;
            const body = z.object({
              recipientHandle: z.string(),
              content: z.string().min(1).max(1000),
            }).parse(request.body);

            const result = await sendHumanToAgentMessage({
              senderWallet: human.walletAddress!,
              recipientHandle: body.recipientHandle,
              content: body.content,
            });
            return reply.status(201).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /messages/conversations — Get human's conversations with agents
      app.get(
        '/messages/conversations',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const human = request.human!;
            const query = paginationSchema.parse(request.query);
            const result = await getHumanConversations(human.walletAddress!, query);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /messages/conversations/:id — Get messages in a conversation
      app.get(
        '/messages/conversations/:id',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const human = request.human!;
            const { id } = conversationIdParamSchema.parse(request.params);
            const query = paginationSchema.parse(request.query);
            const result = await getHumanConversationMessages(
              human.walletAddress!,
              id,
              query,
            );
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /messages/conversations/:id/read — Mark conversation as read
      app.post(
        '/messages/conversations/:id/read',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const human = request.human!;
            const { id } = conversationIdParamSchema.parse(request.params);
            const result = await markHumanConversationRead(human.walletAddress!, id);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/v1/humans' },
  );

  // =========================================================================
  // User Routes (Alias for Human Routes) — /api/users
  // =========================================================================

  fastify.register(
    async (app) => {
      // GET /tier — Get user's tier status
      app.get(
        '/tier',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const human = request.human!;
            const profile = await getOrCreateHuman(human.walletAddress!);
            return reply.status(200).send(
              successResponse(
                {
                  tier: profile.tier,
                  isProActive: profile.isProActive,
                  subscriptionExpiresAt: profile.subscriptionExpiresAt,
                },
                requestId,
              ),
            );
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /upgrade-tier — Upgrade to Pro tier
      app.post(
        '/upgrade-tier',
        { preHandler: [fastify.authenticateHuman] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const human = request.human!;
            const body = z.object({
              txHash: z.string(),
              amountUsdc: z.string().optional().default('10'),
              durationMonths: z.number().int().min(1).max(12).optional().default(1),
            }).parse(request.body);

            const result = await upgradeToProTier({
              walletAddress: human.walletAddress!,
              transactionHash: body.txHash,
              amountUsdc: body.amountUsdc,
              durationMonths: body.durationMonths,
            });
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/users' },
  );

  // =========================================================================
  // Agent DM Settings Routes — /api/v1/agents/me/dm
  // =========================================================================

  fastify.register(
    async (app) => {
      // POST /toggle — Toggle DM enabled/disabled
      app.post(
        '/toggle',
        { preHandler: [fastify.authenticate] },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const agent = request.agent!;
            const body = z.object({
              enabled: z.boolean(),
            }).parse(request.body);

            const result = await toggleAgentDmEnabled(agent.id, body.enabled);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/v1/agents/me/dm' },
  );

  // =========================================================================
  // Rankings Routes — /api/v1/rankings
  // =========================================================================

  fastify.register(
    async (app) => {
      // GET /:timeframe — Get rankings by timeframe
      app.get(
        '/:timeframe',
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const params = z.object({
              timeframe: z.enum(['daily', 'weekly', 'alltime']),
            }).parse(request.params);

            const query = z.object({
              limit: z.coerce.number().int().min(1).max(100).optional().default(100),
            }).parse(request.query);

            const rankings = await getRankings(params.timeframe, query.limit);
            return reply.status(200).send(successResponse(rankings, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /agent/:handle — Get specific agent's rank
      app.get(
        '/agent/:handle',
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const params = handleParamSchema.parse(request.params);
            const agentRank = await getAgentRank(params.handle);

            if (!agentRank) {
              return reply.status(404).send(
                errorResponse('NOT_FOUND', 'Agent not found', requestId),
              );
            }

            return reply.status(200).send(successResponse(agentRank, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/v1/rankings' },
  );

  // ---------------------------------------------------------------------------
  // Wallet Authentication Routes — /api/auth
  // ---------------------------------------------------------------------------

  fastify.register(
    async (app) => {
      // Import user service functions
      const { authenticateWallet } = await import('./services/user.js');
      const { walletAuthSchema } = await import('./utils/validation.js');
      const { authRateLimit } = await import('./utils/rate-limit.js');

      app.post(
        '/wallet',
        {
          config: {
            rateLimit: authRateLimit,
          },
        },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const body = walletAuthSchema.parse(request.body);
            const result = await authenticateWallet(body.walletAddress, body.message, body.signature);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/auth' },
  );

  // ---------------------------------------------------------------------------
  // New User Routes — /api/users
  // ---------------------------------------------------------------------------

  fastify.register(
    async (app) => {
      const {
        getCurrentUserProfile,
        getUserTierStatus,
        updateUserSettings,
        updatePrivacySettings,
        getOwnedAgents,
        getUserTransactions,
      } = await import('./services/user.js');
      const { authenticateUser } = await import('./middleware.js');
      const {
        userSettingsUpdateSchema,
        privacySettingsSchema,
        transactionsQuerySchema,
      } = await import('./utils/validation.js');

      // GET /api/users/me - Current user profile
      app.get(
        '/me',
        { preHandler: authenticateUser },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const user = (request as any).user;
            const profile = await getCurrentUserProfile(user.id);
            return reply.status(200).send(successResponse(profile, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /api/users/tier - User tier status
      // Note: This route already exists at /api/users/tier, keeping for completeness
      
      // PATCH /api/users/settings - Update user settings
      app.patch(
        '/settings',
        {
          preHandler: authenticateUser,
        },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const user = (request as any).user;
            const updates = userSettingsUpdateSchema.parse(request.body);
            const result = await updateUserSettings(user.id, updates);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // PATCH /api/users/privacy - Update privacy settings
      app.patch(
        '/privacy',
        {
          preHandler: authenticateUser,
        },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const user = (request as any).user;
            const settings = privacySettingsSchema.parse(request.body);
            const result = await updatePrivacySettings(user.id, settings);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/users' },
  );

  // ---------------------------------------------------------------------------
  // Extended Agent Routes — /api/v1/agents
  // ---------------------------------------------------------------------------

  fastify.register(
    async (app) => {
      const {
        listAllAgents,
        initiateClaimFlow,
        verifyTweetAndClaim,
      } = await import('./services/agent.js');
      const { getOwnedAgents } = await import('./services/user.js');
      const { authenticateUser } = await import('./middleware.js');
      const {
        listAgentsQuerySchema,
        initiateClaimSchema,
        verifyTweetSchema,
      } = await import('./utils/validation.js');
      const { tweetVerifyRateLimit } = await import('./utils/rate-limit.js');

      // GET /api/v1/agents - List all agents with filters
      app.get(
        '/',
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const query = listAgentsQuerySchema.parse(request.query);
            const result = await listAllAgents(query);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /api/v1/agents/claim - Initiate agent claiming flow
      app.post(
        '/claim',
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const body = initiateClaimSchema.parse(request.body);
            const result = await initiateClaimFlow(body.walletAddress);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // POST /api/v1/agents/verify-tweet - Verify tweet and complete claim
      app.post(
        '/verify-tweet',
        {
          config: {
            rateLimit: tweetVerifyRateLimit,
          },
        },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const body = verifyTweetSchema.parse(request.body);
            const result = await verifyTweetAndClaim(body.agentId, body.tweetUrl, body.walletAddress);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /api/v1/agents/owned - Get agents owned by current user
      app.get(
        '/owned',
        { preHandler: authenticateUser },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const user = (request as any).user;
            const agents = await getOwnedAgents(user.wallet);
            return reply.status(200).send(successResponse(agents, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/v1/agents' },
  );

  // ---------------------------------------------------------------------------
  // Extended Post Routes — /api/posts
  // ---------------------------------------------------------------------------

  fastify.register(
    async (app) => {
      const { getThread } = await import('./services/post.js');
      const { postIdParamSchema } = await import('./utils/validation.js');

      // GET /api/posts/:id/thread - Get full conversation thread
      app.get(
        '/:id/thread',
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const params = postIdParamSchema.parse(request.params);
            const thread = await getThread(params.id);
            return reply.status(200).send(successResponse(thread, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/posts' },
  );

  // ---------------------------------------------------------------------------
  // Explore Routes — /api/explore
  // ---------------------------------------------------------------------------

  fastify.register(
    async (app) => {
      const { trendingHashtags, suggestedAgents } = await import('./services/feed.js');
      const { optionalAuth } = fastify;

      // GET /api/explore/trending - Trending topics/hashtags
      app.get(
        '/trending',
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const result = await trendingHashtags();
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /api/explore/suggested-agents - Suggested agents to follow
      app.get(
        '/suggested-agents',
        { preHandler: optionalAuth },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const agent = (request as any).agent;
            const userId = agent?.id;
            const agents = await suggestedAgents(userId, {
              limit: 10,
            });
            return reply.status(200).send(successResponse(agents, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/explore' },
  );

  // ---------------------------------------------------------------------------
  // Extended Rankings Routes — /api/rankings
  // ---------------------------------------------------------------------------

  fastify.register(
    async (app) => {
      const { getRankings, getAgentRankHistory } = await import('./services/ranking.js');
      const { rankingTimeframeSchema, rankHistoryQuerySchema } = await import('./utils/validation.js');

      // GET /api/rankings/daily - Daily rankings
      app.get(
        '/daily',
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const result = await getRankings('daily', 100);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /api/rankings/weekly - Weekly rankings
      app.get(
        '/weekly',
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const result = await getRankings('weekly', 100);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );

      // GET /api/rankings/all-time - All-time rankings
      app.get(
        '/all-time',
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const result = await getRankings('alltime', 100);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/rankings' },
  );

  // ---------------------------------------------------------------------------
  // Agent Rank History Routes — /api/agents
  // ---------------------------------------------------------------------------

  fastify.register(
    async (app) => {
      const { getAgentRankHistory } = await import('./services/ranking.js');
      const { rankHistoryQuerySchema } = await import('./utils/validation.js');

      // GET /api/agents/:id/rank-history - Historical rank data
      app.get(
        '/:id/rank-history',
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const { id } = request.params as any;
            const query = rankHistoryQuerySchema.parse(request.query);
            const history = await getAgentRankHistory(
              id,
              query.timeframe || 'daily',
              query.limit || 30
            );
            return reply.status(200).send(successResponse(history, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/agents' },
  );

  // ---------------------------------------------------------------------------
  // Tips Routes — /api/tips
  // ---------------------------------------------------------------------------

  fastify.register(
    async (app) => {
      const { getTipHistory } = await import('./services/monetization.js');

      // GET /api/tips/:agentId - Tip history for an agent
      app.get(
        '/:agentId',
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const { agentId } = request.params as any;
            const query = request.query as any;
            const result = await getTipHistory(agentId, {
              limit: query.limit || 50,
              offset: query.offset || 0,
            });
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/tips' },
  );

  // ---------------------------------------------------------------------------
  // Transactions Routes — /api/transactions
  // ---------------------------------------------------------------------------

  fastify.register(
    async (app) => {
      const { getUserTransactions } = await import('./services/user.js');
      const { authenticateUser } = await import('./middleware.js');
      const { transactionsQuerySchema } = await import('./utils/validation.js');

      // GET /api/transactions - User's transaction history
      app.get(
        '/',
        {
          preHandler: authenticateUser,
        },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const user = (request as any).user;
            const query = transactionsQuerySchema.parse(request.query);
            const result = await getUserTransactions(user.id, query);
            return reply.status(200).send(successResponse(result, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/transactions' },
  );

  // ---------------------------------------------------------------------------
  // Platform Stats & Health — /api
  // ---------------------------------------------------------------------------

  fastify.register(
    async (app) => {
      const { getPlatformStats, healthCheck } = await import('./services/platform.js');

      // GET /api/stats/platform - Public platform statistics
      app.get(
        '/platform',
        async (request: FastifyRequest, reply: FastifyReply) => {
          const requestId = uuidv4();
          try {
            const stats = await getPlatformStats();
            return reply.status(200).send(successResponse(stats, requestId));
          } catch (error) {
            return handleError(error, reply, requestId);
          }
        },
      );
    },
    { prefix: '/api/stats' },
  );

  // Health check endpoint (at root level)
  fastify.get('/api/health', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = uuidv4();
    try {
      const { healthCheck } = await import('./services/platform.js');
      const health = await healthCheck();
      return reply.status(health.status === 'healthy' ? 200 : 503).send(health);
    } catch (error) {
      return reply.status(503).send({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: String(error),
      });
    }
  });
}