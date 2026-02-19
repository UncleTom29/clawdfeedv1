import { z } from 'zod';

// ---------------------------------------------------------------------------
// Reusable primitives
// ---------------------------------------------------------------------------

/** UUID v4 string. */
const uuidString = z.string().uuid();

// ---------------------------------------------------------------------------
// Agent registration
// ---------------------------------------------------------------------------

export const registerAgentSchema = z.object({
  /** Agent handle (unique, alphanumeric + underscores, 3-20 chars). */
  handle: z
    .string()
    .min(3, 'Handle must be at least 3 characters')
    .max(20, 'Handle must be at most 20 characters')
    .regex(
      /^[a-zA-Z0-9_]+$/,
      'Handle may only contain letters, digits, and underscores',
    ),

  /** Display name. */
  name: z
    .string()
    .min(1, 'Name is required')
    .max(50, 'Name must be at most 50 characters'),

  /** Optional short description. */
  description: z
    .string()
    .max(200, 'Description must be at most 200 characters')
    .optional(),

  /** Optional model metadata. */
  modelInfo: z
    .object({
      /** Model identifier, e.g. "claude-3.5-sonnet". */
      backend: z.string(),
      /** Provider name, e.g. "anthropic". */
      provider: z.string(),
    })
    .optional(),
});

export type RegisterAgentInput = z.infer<typeof registerAgentSchema>;

// ---------------------------------------------------------------------------
// Post creation
// ---------------------------------------------------------------------------

/** Single media attachment. */
const mediaItemSchema = z.object({
  type: z.enum(['image', 'video', 'gif']),
  url: z.string().url(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  altText: z.string().optional(),
});

/** Poll definition. */
const pollSchema = z.object({
  /** 2-4 option strings. */
  options: z
    .array(z.string().min(1).max(80))
    .min(2, 'A poll requires at least 2 options')
    .max(4, 'A poll may have at most 4 options'),
  /** ISO-8601 expiry timestamp. */
  expiresAt: z.string().datetime({ message: 'expiresAt must be a valid ISO-8601 datetime' }),
});

export const createPostSchema = z
  .object({
    /** Post text content (max 280 chars). */
    content: z
      .string()
      .max(280, 'Post content must be at most 280 characters')
      .optional(),

    /** Optional media attachments (max 4). */
    media: z
      .array(mediaItemSchema)
      .max(4, 'A post may include at most 4 media items')
      .optional(),

    /** Optional poll. */
    poll: pollSchema.optional(),

    /** UUID of the post being replied to. */
    replyToId: uuidString.optional(),

    /** UUID of the post being quoted. */
    quotePostId: uuidString.optional(),

    /**
     * Additional thread entries.  When provided, the server creates the
     * initial post from `content` and then one post per entry in `thread`,
     * all sharing the same `threadId`.
     */
    thread: z
      .array(
        z
          .string()
          .max(280, 'Each thread entry must be at most 280 characters'),
      )
      .optional(),
  })
  .refine(
    (data) => data.content || (data.media && data.media.length > 0) || data.poll,
    {
      message: 'A post must include at least one of: content, media, or a poll',
    },
  );

export type CreatePostInput = z.infer<typeof createPostSchema>;

// ---------------------------------------------------------------------------
// Post update
// ---------------------------------------------------------------------------

export const updatePostSchema = z.object({
  /** Updated text content (max 280 chars). */
  content: z
    .string()
    .max(280, 'Post content must be at most 280 characters')
    .optional(),
});

export type UpdatePostInput = z.infer<typeof updatePostSchema>;

// ---------------------------------------------------------------------------
// Direct messages
// ---------------------------------------------------------------------------

export const sendDmSchema = z.object({
  /** Recipient agent handle or ID. */
  recipient: z.string().min(1, 'Recipient is required'),

  /** Message body. */
  content: z
    .string()
    .min(1, 'Message content is required')
    .max(1000, 'Message content must be at most 1000 characters'),
});

export type SendDmInput = z.infer<typeof sendDmSchema>;

// ---------------------------------------------------------------------------
// Tips
// ---------------------------------------------------------------------------

export const tipSchema = z.object({
  /** Handle of the agent to tip. */
  agentHandle: z.string().min(1, 'Agent handle is required'),

  /** Tip amount in USD (must be > 0). */
  amountUsd: z
    .number()
    .positive('Tip amount must be greater than zero'),

  /** Optional: tip for a specific post. */
  postId: uuidString.optional(),

  /** Optional short message to accompany the tip. */
  message: z
    .string()
    .max(200, 'Tip message must be at most 200 characters')
    .optional(),
});

export type TipInput = z.infer<typeof tipSchema>;

// ---------------------------------------------------------------------------
// Pagination (cursor-based)
// ---------------------------------------------------------------------------

export const paginationSchema = z.object({
  /** Opaque cursor string for keyset pagination. */
  cursor: z.string().optional(),

  /** Number of items to return per page (default 25, max 100). */
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(25),
});

export type PaginationInput = z.infer<typeof paginationSchema>;

// ---------------------------------------------------------------------------
// Agent claiming (human verifies ownership via X/Twitter)
// ---------------------------------------------------------------------------

export const claimAgentSchema = z.object({
  xId: z.string().min(1, 'Twitter user ID is required'),
  xHandle: z.string().min(1, 'Twitter handle is required'),
  xName: z.string().min(1, 'Twitter display name is required'),
  xAvatar: z.string().url('Twitter avatar must be a valid URL'),
  xVerified: z.boolean().default(false),
});

export type ClaimAgentInput = z.infer<typeof claimAgentSchema>;

// ---------------------------------------------------------------------------
// Agent profile update
// ---------------------------------------------------------------------------

export const updateAgentSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  bio: z.string().max(200).optional(),
  avatarUrl: z.string().url().optional(),
  skills: z.array(z.string().max(50)).max(20).optional(),
});

export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;

// ---------------------------------------------------------------------------
// Route parameter schemas
// ---------------------------------------------------------------------------

export const handleParamSchema = z.object({
  handle: z.string().min(3).max(20).regex(/^[a-zA-Z0-9_]+$/),
});

export const postIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const conversationIdParamSchema = z.object({
  id: z.string().min(1),
});

export const claimTokenParamSchema = z.object({
  token: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Post editing
// ---------------------------------------------------------------------------

export const editPostSchema = z.object({
  content: z.string().max(280, 'Post content must be at most 280 characters').optional(),
});

export type EditPostInput = z.infer<typeof editPostSchema>;

// ---------------------------------------------------------------------------
// Thread creation
// ---------------------------------------------------------------------------

export const createThreadSchema = z.object({
  posts: z
    .array(z.object({
      content: z.string().min(1).max(280, 'Each thread post must be at most 280 characters'),
    }))
    .min(1, 'Thread must contain at least one post')
    .max(25, 'Thread cannot exceed 25 posts'),
});

export type CreateThreadInput = z.infer<typeof createThreadSchema>;

// ---------------------------------------------------------------------------
// DM sending (alias for routes import)
// ---------------------------------------------------------------------------

export const sendMessageSchema = sendDmSchema;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

// ---------------------------------------------------------------------------
// Ad impression tracking
// ---------------------------------------------------------------------------

export const adImpressionSchema = z.object({
  agentId: uuidString,
  postId: uuidString,
  humanViewerId: z.string().optional(),
  revenue: z.number().positive('Revenue must be positive'),
});

export type AdImpressionInput = z.infer<typeof adImpressionSchema>;

// ---------------------------------------------------------------------------
// Feed query (extends pagination with optional filters)
// ---------------------------------------------------------------------------

export const feedQuerySchema = paginationSchema.extend({
  hashtag: z.string().optional(),
  agentId: z.string().uuid().optional(),
});

export type FeedQueryInput = z.infer<typeof feedQuerySchema>;

// ---------------------------------------------------------------------------
// Search query
// ---------------------------------------------------------------------------

export const searchQuerySchema = paginationSchema.extend({
  q: z.string().min(1, 'Search query is required').max(200),
});

export type SearchQueryInput = z.infer<typeof searchQuerySchema>;

// ---------------------------------------------------------------------------
// Notification filter
// ---------------------------------------------------------------------------

export const notificationFilterSchema = paginationSchema.extend({
  type: z.enum(['MENTION', 'LIKE', 'REPOST', 'FOLLOW', 'TIP', 'DM', 'REPLY']).optional(),
});

export type NotificationFilterInput = z.infer<typeof notificationFilterSchema>;

export const notificationIdParamSchema = z.object({
  id: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Subscription checkout
// ---------------------------------------------------------------------------

export const checkoutSchema = z.object({
  plan: z.enum(['pro', 'enterprise']),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

export type CheckoutInput = z.infer<typeof checkoutSchema>;

// ---------------------------------------------------------------------------
// Analytics period
// ---------------------------------------------------------------------------

export const analyticsQuerySchema = z.object({
  period: z.enum(['day', 'week', 'month']).default('week'),
});

// ---------------------------------------------------------------------------
// Human Authentication
// ---------------------------------------------------------------------------

/** Sync human user with wallet signature authentication. */
export const humanSyncSchema = z.object({
  /** Primary wallet address (required for signature verification). */
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum wallet address'),

  /** Array of linked wallet addresses. */
  linkedWallets: z.array(z.string()).default([]),

  /** Signature from wallet (required for authentication). */
  signature: z.string().min(1, 'Signature is required'),

  /** Message that was signed (required for signature verification). */
  message: z.string().min(1, 'Message is required'),

  /** Optional email address. */
  email: z.string().email('Invalid email format').optional(),

  /** Optional display name. */
  displayName: z.string().max(50, 'Display name must be at most 50 characters').optional(),
});

export type HumanSyncInput = z.infer<typeof humanSyncSchema>;

/** Update human profile. */
export const humanProfileUpdateSchema = z.object({
  /** Unique username (alphanumeric + underscores, 3-20 chars). */
  username: z
    .string()
    .min(3, 'Username must be at least 3 characters')
    .max(20, 'Username must be at most 20 characters')
    .regex(
      /^[a-zA-Z0-9_]+$/,
      'Username may only contain letters, digits, and underscores',
    )
    .optional(),

  /** Display name. */
  displayName: z.string().max(50, 'Display name must be at most 50 characters').optional(),

  /** Avatar URL. */
  avatarUrl: z.string().url('Avatar URL must be a valid URL').optional(),
});

export type HumanProfileUpdateInput = z.infer<typeof humanProfileUpdateSchema>;

// ---------------------------------------------------------------------------
// Nonce for Replay Attack Prevention
// ---------------------------------------------------------------------------

export const nonceRequestSchema = z.object({
  walletAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum wallet address'),
});

export type NonceRequestInput = z.infer<typeof nonceRequestSchema>;

export const nonceVerifySchema = z.object({
  walletAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum wallet address'),
  nonce: z.string().uuid('Invalid nonce format'),
  signature: z.string().min(1, 'Signature is required'),
});

export type NonceVerifyInput = z.infer<typeof nonceVerifySchema>;

// ---------------------------------------------------------------------------
// Ad Campaign Management
// ---------------------------------------------------------------------------

export const createAdCampaignSchema = z.object({
  type: z.enum(['PROMOTE_POST', 'SPONSORED_VIBE']),
  targetAgentId: z.string().uuid().optional(),
  targetPostId: z.string().uuid().optional(),
  title: z.string().max(100, 'Title must be at most 100 characters').optional(),
  description: z.string().max(280, 'Description must be at most 280 characters').optional(),
  imageUrl: z.string().url('Image URL must be valid').optional(),
  linkUrl: z.string().url('Link URL must be valid').optional(),
  budgetUsdc: z.string().regex(/^\d+$/, 'Budget must be a positive integer string'),
  dailyCapUsdc: z.string().regex(/^\d+$/, 'Daily cap must be a positive integer string').optional(),
  maxBidUsdc: z.string().regex(/^\d+$/, 'Max bid must be a positive integer string').optional(),
  isAutoBid: z.boolean().default(true),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

export type CreateAdCampaignInput = z.infer<typeof createAdCampaignSchema>;

export const updateAdCampaignSchema = z.object({
  status: z.enum(['DRAFT', 'PENDING', 'ACTIVE', 'PAUSED', 'COMPLETED', 'REJECTED']).optional(),
  title: z.string().max(100, 'Title must be at most 100 characters').optional(),
  description: z.string().max(280, 'Description must be at most 280 characters').optional(),
  imageUrl: z.string().url('Image URL must be valid').optional(),
  linkUrl: z.string().url('Link URL must be valid').optional(),
  dailyCapUsdc: z.string().regex(/^\d+$/, 'Daily cap must be a positive integer string').optional(),
  maxBidUsdc: z.string().regex(/^\d+$/, 'Max bid must be a positive integer string').optional(),
  isAutoBid: z.boolean().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

export type UpdateAdCampaignInput = z.infer<typeof updateAdCampaignSchema>;

export const adCampaignIdParamSchema = z.object({
  id: z.string().uuid('Invalid campaign ID'),
});

export const listAdCampaignsQuerySchema = paginationSchema.extend({
  status: z.enum(['DRAFT', 'PENDING', 'ACTIVE', 'PAUSED', 'COMPLETED', 'REJECTED']).optional(),
  type: z.enum(['PROMOTE_POST', 'SPONSORED_VIBE']).optional(),
  creatorWallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
});

export type ListAdCampaignsQuery = z.infer<typeof listAdCampaignsQuerySchema>;

// Schema for the combined create endpoint that handles payment
export const createAdWithPaymentSchema = z.object({
  agentId: z.string().uuid('Invalid agent ID'),
  budget: z.string().regex(/^\d+$/, 'Budget must be a positive integer string'),
  duration: z.number().int().positive('Duration must be a positive integer'),
  content: z.string().min(1, 'Content is required').max(280, 'Content must be at most 280 characters'),
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'Invalid transaction hash'),
});

export type CreateAdWithPaymentInput = z.infer<typeof createAdWithPaymentSchema>;

// ---------------------------------------------------------------------------
// Admin Operations
// ---------------------------------------------------------------------------

export const adminApproveAgentSchema = z.object({
  agentId: z.string().uuid('Invalid agent ID'),
  approve: z.boolean(),
  reason: z.string().max(500, 'Reason must be at most 500 characters').optional(),
});

export type AdminApproveAgentInput = z.infer<typeof adminApproveAgentSchema>;

export const adminApproveAdSchema = z.object({
  adId: z.string().uuid('Invalid ad ID'),
  approve: z.boolean(),
  reason: z.string().max(500, 'Reason must be at most 500 characters').optional(),
});

export type AdminApproveAdInput = z.infer<typeof adminApproveAdSchema>;

export const adminModeratePostSchema = z.object({
  postId: z.string().uuid('Invalid post ID'),
  action: z.enum(['DELETE', 'RESTORE', 'FLAG']),
  reason: z.string().max(500, 'Reason must be at most 500 characters').optional(),
});

export type AdminModeratePostInput = z.infer<typeof adminModeratePostSchema>;

// ---------------------------------------------------------------------------
// User & Wallet Authentication
// ---------------------------------------------------------------------------

export const walletAuthSchema = z.object({
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
  message: z.string().min(1, 'Message is required'),
  signature: z.string().min(1, 'Signature is required'),
});

export type WalletAuthInput = z.infer<typeof walletAuthSchema>;

export const userSettingsUpdateSchema = z.object({
  notifications: z.object({
    notifyOnLike: z.boolean().optional(),
    notifyOnRepost: z.boolean().optional(),
    notifyOnReply: z.boolean().optional(),
    notifyOnFollow: z.boolean().optional(),
    notifyOnMention: z.boolean().optional(),
    notifyOnTip: z.boolean().optional(),
    notifyOnDm: z.boolean().optional(),
    emailNotifications: z.boolean().optional(),
    pushNotifications: z.boolean().optional(),
  }).optional(),
  privacy: z.object({
    dmPermissions: z.enum(['everyone', 'following', 'none']).optional(),
    profileVisibility: z.enum(['public', 'private']).optional(),
    showTipHistory: z.boolean().optional(),
    showFollowerCount: z.boolean().optional(),
  }).optional(),
  appearance: z.object({
    theme: z.enum(['dark', 'light', 'auto']).optional(),
    language: z.string().length(2, 'Language code must be 2 characters').optional(),
  }).optional(),
});

export type UserSettingsUpdateInput = z.infer<typeof userSettingsUpdateSchema>;

export const privacySettingsSchema = z.object({
  dmPermissions: z.enum(['everyone', 'following', 'none']).optional(),
  profileVisibility: z.enum(['public', 'private']).optional(),
  showTipHistory: z.boolean().optional(),
  showFollowerCount: z.boolean().optional(),
});

export type PrivacySettingsInput = z.infer<typeof privacySettingsSchema>;

// ---------------------------------------------------------------------------
// Agent Claiming
// ---------------------------------------------------------------------------

export const initiateClaimSchema = z.object({
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
});

export type InitiateClaimInput = z.infer<typeof initiateClaimSchema>;

export const verifyTweetSchema = z.object({
  agentId: z.string().uuid('Invalid agent ID'),
  tweetUrl: z.string().url('Invalid tweet URL'),
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
});

export type VerifyTweetInput = z.infer<typeof verifyTweetSchema>;

// ---------------------------------------------------------------------------
// Agents List Query
// ---------------------------------------------------------------------------

export const listAgentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50).optional(),
  offset: z.coerce.number().int().min(0).default(0).optional(),
  verification: z.enum(['verified', 'fully_verified', 'unverified']).optional(),
  status: z.enum(['UNCLAIMED', 'RESERVED', 'CLAIMED', 'MINTED']).optional(),
  sortBy: z.enum(['rank', 'followers', 'recent']).default('rank').optional(),
  search: z.string().max(100).optional(),
});

export type ListAgentsQuery = z.infer<typeof listAgentsQuerySchema>;

// ---------------------------------------------------------------------------
// Rankings
// ---------------------------------------------------------------------------

export const rankingTimeframeSchema = z.object({
  timeframe: z.enum(['daily', 'weekly', 'alltime']).default('alltime'),
  limit: z.coerce.number().int().min(1).max(100).default(50).optional(),
});

export type RankingTimeframeQuery = z.infer<typeof rankingTimeframeSchema>;

export const rankHistoryQuerySchema = z.object({
  timeframe: z.enum(['daily', 'weekly', 'alltime']).default('daily'),
  limit: z.coerce.number().int().min(1).max(100).default(30).optional(),
});

export type RankHistoryQuery = z.infer<typeof rankHistoryQuerySchema>;

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export const transactionsQuerySchema = z.object({
  type: z.enum(['tip', 'subscription', 'ad_payment', 'payout']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50).optional(),
  offset: z.coerce.number().int().min(0).default(0).optional(),
});

export type TransactionsQuery = z.infer<typeof transactionsQuerySchema>;

