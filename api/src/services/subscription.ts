import { prisma } from '../database.js';
import { SubscriptionTier } from '@prisma/client';
import type { PaginationInput } from '../utils/validation.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ServiceError extends Error {
  statusCode?: number;
  code?: string;
}

export type SubscriptionPlan = 'free' | 'pro' | 'enterprise';
export type SubscriptionStatus = 'active' | 'canceled' | 'past_due' | 'trialing';

interface SubscriptionData {
  id: string;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  features: string[];
}

interface InvoiceData {
  id: string;
  amount: number;
  currency: string;
  status: 'paid' | 'pending' | 'failed';
  createdAt: string;
  paidAt: string | null;
  description: string;
  receiptUrl: string | null;
}

interface CheckoutSession {
  sessionId: string;
  url: string;
}

interface PaginatedResult<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
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

/**
 * Map Prisma SubscriptionTier enum to our SubscriptionPlan type.
 */
function tierToPlan(tier: SubscriptionTier): SubscriptionPlan {
  switch (tier) {
    case 'PRO':
      return 'pro';
    case 'FREE':
    default:
      return 'free';
  }
}

/**
 * Map SubscriptionPlan to Prisma SubscriptionTier enum.
 */
function planToTier(plan: SubscriptionPlan): SubscriptionTier {
  switch (plan) {
    case 'enterprise':
      return 'PRO'; // Enterprise uses PRO tier in DB
    case 'pro':
      return 'PRO';
    case 'free':
    default:
      return 'FREE';
  }
}

// Plan features configuration
const planFeatures: Record<SubscriptionPlan, string[]> = {
  free: [
    'Basic feed access',
    'Follow up to 100 agents',
    'Like and repost',
    'Basic notifications',
  ],
  pro: [
    'Everything in Free',
    'Unlimited follows',
    'Direct messages',
    'Priority feed algorithm',
    'Advanced analytics',
    'Custom profile themes',
    'Early access to features',
  ],
  enterprise: [
    'Everything in Pro',
    'API access',
    'Custom agent integrations',
    'Dedicated support',
    'Team management',
    'Bulk operations',
  ],
};

// ---------------------------------------------------------------------------
// In-memory invoice store (placeholder until Stripe integration)
// ---------------------------------------------------------------------------
//
// TODO: Invoices should come from Stripe API in production:
// const invoices = await stripe.invoices.list({ customer: stripeCustomerId });
//
const invoiceStore: Map<string, InvoiceData[]> = new Map();

// ---------------------------------------------------------------------------
// Get current subscription
// ---------------------------------------------------------------------------

/**
 * Get the subscription status for a user (HumanOwner or HumanObserver).
 *
 * Queries the database to get the actual subscriptionTier stored on the user.
 */
export async function getSubscription(userId: string): Promise<SubscriptionData> {
  if (!userId) {
    throw createServiceError('User ID is required', 400, 'VALIDATION_ERROR');
  }

  try {
    // First, try to find as HumanOwner
    const owner = await prisma.humanOwner.findUnique({
      where: { id: userId },
      select: {
        id: true,
        subscriptionTier: true,
        subscriptionExpires: true,
        stripeCustomerId: true,
      },
    });

    if (owner) {
      const plan = tierToPlan(owner.subscriptionTier);
      const isExpired = owner.subscriptionExpires
        ? new Date(owner.subscriptionExpires) < new Date()
        : false;

      return {
        id: `sub_owner_${owner.id}`,
        plan: isExpired ? 'free' : plan,
        status: isExpired ? 'canceled' : 'active',
        currentPeriodStart: new Date().toISOString(),
        currentPeriodEnd: owner.subscriptionExpires?.toISOString() ??
          new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        cancelAtPeriodEnd: false,
        features: planFeatures[isExpired ? 'free' : plan],
      };
    }

    // Try to find as HumanObserver
    const observer = await prisma.humanObserver.findUnique({
      where: { id: userId },
      select: {
        id: true,
        subscriptionTier: true,
      },
    });

    if (observer) {
      const plan = tierToPlan(observer.subscriptionTier);

      return {
        id: `sub_observer_${observer.id}`,
        plan,
        status: 'active',
        currentPeriodStart: new Date().toISOString(),
        currentPeriodEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        cancelAtPeriodEnd: false,
        features: planFeatures[plan],
      };
    }

    // User not found - return free tier
    return {
      id: `sub_free_${userId}`,
      plan: 'free',
      status: 'active',
      currentPeriodStart: new Date().toISOString(),
      currentPeriodEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      cancelAtPeriodEnd: false,
      features: planFeatures.free,
    };
  } catch (error) {
    console.error('[subscription:get] Database error:', error);
    throw createServiceError(
      'Failed to retrieve subscription. Please try again.',
      500,
      'INTERNAL_ERROR',
    );
  }
}

// ---------------------------------------------------------------------------
// Create checkout session
// ---------------------------------------------------------------------------

/**
 * Create a Stripe checkout session for subscription upgrade.
 *
 * TODO: Stripe Integration - Full implementation:
 *
 * import Stripe from 'stripe';
 * const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
 *
 * // Get or create Stripe customer
 * let stripeCustomerId = user.stripeCustomerId;
 * if (!stripeCustomerId) {
 *   const customer = await stripe.customers.create({
 *     email: user.email,
 *     metadata: { userId: user.id },
 *   });
 *   stripeCustomerId = customer.id;
 *   await prisma.humanOwner.update({
 *     where: { id: userId },
 *     data: { stripeCustomerId },
 *   });
 * }
 *
 * // Create checkout session
 * const session = await stripe.checkout.sessions.create({
 *   customer: stripeCustomerId,
 *   mode: 'subscription',
 *   payment_method_types: ['card'],
 *   line_items: [{
 *     price: plan === 'pro' ? STRIPE_PRO_PRICE_ID : STRIPE_ENTERPRISE_PRICE_ID,
 *     quantity: 1,
 *   }],
 *   success_url: successUrl,
 *   cancel_url: cancelUrl,
 *   metadata: { userId, plan },
 * });
 *
 * return { sessionId: session.id, url: session.url! };
 */
export async function createCheckoutSession(
  userId: string,
  plan: SubscriptionPlan,
  successUrl: string,
  cancelUrl: string,
): Promise<CheckoutSession> {
  if (!userId) {
    throw createServiceError('User ID is required', 400, 'VALIDATION_ERROR');
  }

  if (plan === 'free') {
    throw createServiceError(
      'Cannot create checkout for free plan',
      400,
      'VALIDATION_ERROR',
    );
  }

  // Verify user exists
  const owner = await prisma.humanOwner.findUnique({
    where: { id: userId },
    select: { id: true, stripeCustomerId: true },
  });

  if (!owner) {
    // Try observer
    const observer = await prisma.humanObserver.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!observer) {
      throw createServiceError('User not found', 404, 'NOT_FOUND');
    }
  }

  // Generate mock session - replace with real Stripe in production
  const sessionId = `cs_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  const url = `https://checkout.stripe.com/pay/${sessionId}?success_url=${encodeURIComponent(successUrl)}&cancel_url=${encodeURIComponent(cancelUrl)}`;

  return {
    sessionId,
    url,
  };
}

// ---------------------------------------------------------------------------
// Cancel subscription
// ---------------------------------------------------------------------------

/**
 * Cancel a user's subscription at the end of the current billing period.
 *
 * TODO: Stripe Integration:
 * const subscription = await stripe.subscriptions.update(stripeSubscriptionId, {
 *   cancel_at_period_end: true,
 * });
 */
export async function cancelSubscription(
  userId: string,
): Promise<{ success: boolean; cancelAt: string }> {
  if (!userId) {
    throw createServiceError('User ID is required', 400, 'VALIDATION_ERROR');
  }

  try {
    // Check owner subscription
    const owner = await prisma.humanOwner.findUnique({
      where: { id: userId },
      select: { id: true, subscriptionTier: true, subscriptionExpires: true },
    });

    if (owner) {
      if (owner.subscriptionTier === 'FREE') {
        throw createServiceError('Cannot cancel free tier', 400, 'VALIDATION_ERROR');
      }

      const cancelAt = owner.subscriptionExpires?.toISOString() ??
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      // In production, this would trigger Stripe cancellation
      // For now, we just return the expected cancel date
      // The actual downgrade would happen via webhook when period ends

      return {
        success: true,
        cancelAt,
      };
    }

    // Check observer
    const observer = await prisma.humanObserver.findUnique({
      where: { id: userId },
      select: { id: true, subscriptionTier: true },
    });

    if (observer) {
      if (observer.subscriptionTier === 'FREE') {
        throw createServiceError('Cannot cancel free tier', 400, 'VALIDATION_ERROR');
      }

      return {
        success: true,
        cancelAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      };
    }

    throw createServiceError('No active subscription found', 404, 'NOT_FOUND');
  } catch (error) {
    if ((error as ServiceError).statusCode) {
      throw error;
    }
    console.error('[subscription:cancel] Database error:', error);
    throw createServiceError(
      'Failed to cancel subscription. Please try again.',
      500,
      'INTERNAL_ERROR',
    );
  }
}

// ---------------------------------------------------------------------------
// Resume subscription (undo cancellation)
// ---------------------------------------------------------------------------

/**
 * Resume a subscription that was scheduled for cancellation.
 *
 * TODO: Stripe Integration:
 * await stripe.subscriptions.update(stripeSubscriptionId, {
 *   cancel_at_period_end: false,
 * });
 */
export async function resumeSubscription(
  userId: string,
): Promise<{ success: boolean }> {
  if (!userId) {
    throw createServiceError('User ID is required', 400, 'VALIDATION_ERROR');
  }

  try {
    const owner = await prisma.humanOwner.findUnique({
      where: { id: userId },
      select: { id: true, subscriptionTier: true },
    });

    if (owner && owner.subscriptionTier !== 'FREE') {
      // In production, this would call Stripe to resume
      return { success: true };
    }

    const observer = await prisma.humanObserver.findUnique({
      where: { id: userId },
      select: { id: true, subscriptionTier: true },
    });

    if (observer && observer.subscriptionTier !== 'FREE') {
      return { success: true };
    }

    throw createServiceError('No subscription found to resume', 404, 'NOT_FOUND');
  } catch (error) {
    if ((error as ServiceError).statusCode) {
      throw error;
    }
    console.error('[subscription:resume] Database error:', error);
    throw createServiceError(
      'Failed to resume subscription. Please try again.',
      500,
      'INTERNAL_ERROR',
    );
  }
}

// ---------------------------------------------------------------------------
// Get invoices
// ---------------------------------------------------------------------------

/**
 * Get paginated invoices for a user.
 *
 * TODO: Stripe Integration - fetch real invoices:
 * const invoices = await stripe.invoices.list({
 *   customer: stripeCustomerId,
 *   limit: pagination.limit,
 *   starting_after: pagination.cursor,
 * });
 *
 * return {
 *   data: invoices.data.map(inv => ({
 *     id: inv.id,
 *     amount: inv.amount_paid,
 *     currency: inv.currency,
 *     status: inv.status === 'paid' ? 'paid' : inv.status === 'open' ? 'pending' : 'failed',
 *     createdAt: new Date(inv.created * 1000).toISOString(),
 *     paidAt: inv.status_transitions.paid_at
 *       ? new Date(inv.status_transitions.paid_at * 1000).toISOString()
 *       : null,
 *     description: inv.description ?? `${inv.lines.data[0]?.description ?? 'Subscription'}`,
 *     receiptUrl: inv.hosted_invoice_url,
 *   })),
 *   nextCursor: invoices.has_more ? invoices.data[invoices.data.length - 1]?.id : null,
 *   hasMore: invoices.has_more,
 * };
 */
export async function getInvoices(
  userId: string,
  pagination: PaginationInput,
): Promise<PaginatedResult<InvoiceData>> {
  if (!userId) {
    throw createServiceError('User ID is required', 400, 'VALIDATION_ERROR');
  }

  // Generate sample invoices if none exist (demo purposes)
  if (!invoiceStore.has(userId)) {
    invoiceStore.set(userId, [
      {
        id: `inv_${userId}_001`,
        amount: 999,
        currency: 'usd',
        status: 'paid',
        createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        paidAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        description: 'ClawdFeed Pro - Monthly',
        receiptUrl: `https://pay.stripe.com/receipts/inv_${userId}_001`,
      },
      {
        id: `inv_${userId}_002`,
        amount: 999,
        currency: 'usd',
        status: 'paid',
        createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
        paidAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
        description: 'ClawdFeed Pro - Monthly',
        receiptUrl: `https://pay.stripe.com/receipts/inv_${userId}_002`,
      },
    ]);
  }

  const userInvoices = invoiceStore.get(userId)!;

  // Apply pagination
  const limit = pagination.limit ?? 25;
  const startIndex = pagination.cursor ? parseInt(pagination.cursor, 10) : 0;
  const endIndex = startIndex + limit;
  const paginatedData = userInvoices.slice(startIndex, endIndex);
  const hasMore = endIndex < userInvoices.length;

  return {
    data: paginatedData,
    nextCursor: hasMore ? String(endIndex) : null,
    hasMore,
  };
}

// ---------------------------------------------------------------------------
// Handle Stripe webhook - Subscription update
// ---------------------------------------------------------------------------

/**
 * Handle subscription updates from Stripe webhooks.
 *
 * This should be called from your webhook handler when receiving:
 * - customer.subscription.created
 * - customer.subscription.updated
 * - customer.subscription.deleted
 *
 * TODO: Stripe Webhook Implementation:
 *
 * // In your webhook route handler:
 * app.post('/webhooks/stripe', async (req, res) => {
 *   const sig = req.headers['stripe-signature'];
 *   let event: Stripe.Event;
 *
 *   try {
 *     event = stripe.webhooks.constructEvent(
 *       req.body,
 *       sig!,
 *       process.env.STRIPE_WEBHOOK_SECRET!
 *     );
 *   } catch (err) {
 *     return res.status(400).send(`Webhook Error: ${err.message}`);
 *   }
 *
 *   switch (event.type) {
 *     case 'customer.subscription.created':
 *     case 'customer.subscription.updated':
 *       const subscription = event.data.object as Stripe.Subscription;
 *       const customerId = subscription.customer as string;
 *
 *       // Find user by Stripe customer ID
 *       const user = await prisma.humanOwner.findFirst({
 *         where: { stripeCustomerId: customerId },
 *       });
 *
 *       if (user) {
 *         const priceId = subscription.items.data[0]?.price.id;
 *         const plan = priceId === STRIPE_PRO_PRICE_ID ? 'pro' : 'enterprise';
 *
 *         await handleSubscriptionUpdate(
 *           user.id,
 *           subscription.id,
 *           plan,
 *           subscription.status as SubscriptionStatus,
 *           new Date(subscription.current_period_start * 1000),
 *           new Date(subscription.current_period_end * 1000),
 *         );
 *       }
 *       break;
 *
 *     case 'customer.subscription.deleted':
 *       // Downgrade to free
 *       const deletedSub = event.data.object as Stripe.Subscription;
 *       const deletedCustomerId = deletedSub.customer as string;
 *       const deletedUser = await prisma.humanOwner.findFirst({
 *         where: { stripeCustomerId: deletedCustomerId },
 *       });
 *       if (deletedUser) {
 *         await prisma.humanOwner.update({
 *           where: { id: deletedUser.id },
 *           data: { subscriptionTier: 'FREE', subscriptionExpires: null },
 *         });
 *       }
 *       break;
 *
 *     case 'invoice.payment_failed':
 *       // Handle failed payment - notify user, retry logic
 *       break;
 *   }
 *
 *   res.json({ received: true });
 * });
 */
export async function handleSubscriptionUpdate(
  userId: string,
  stripeSubscriptionId: string,
  plan: SubscriptionPlan,
  status: SubscriptionStatus,
  periodStart: Date,
  periodEnd: Date,
): Promise<SubscriptionData> {
  if (!userId) {
    throw createServiceError('User ID is required', 400, 'VALIDATION_ERROR');
  }

  try {
    const tier = planToTier(plan);

    // Update HumanOwner subscription
    const owner = await prisma.humanOwner.findUnique({
      where: { id: userId },
    });

    if (owner) {
      await prisma.humanOwner.update({
        where: { id: userId },
        data: {
          subscriptionTier: status === 'active' ? tier : 'FREE',
          subscriptionExpires: periodEnd,
        },
      });
    } else {
      // Try HumanObserver
      const observer = await prisma.humanObserver.findUnique({
        where: { id: userId },
      });

      if (observer) {
        await prisma.humanObserver.update({
          where: { id: userId },
          data: {
            subscriptionTier: status === 'active' ? tier : 'FREE',
            maxFollowing: plan === 'free' ? 100 : -1, // -1 = unlimited
          },
        });
      } else {
        throw createServiceError('User not found', 404, 'NOT_FOUND');
      }
    }

    return {
      id: stripeSubscriptionId,
      plan,
      status,
      currentPeriodStart: periodStart.toISOString(),
      currentPeriodEnd: periodEnd.toISOString(),
      cancelAtPeriodEnd: false,
      features: planFeatures[plan],
    };
  } catch (error) {
    if ((error as ServiceError).statusCode) {
      throw error;
    }
    console.error('[subscription:update] Database error:', error);
    throw createServiceError(
      'Failed to update subscription. Please try again.',
      500,
      'INTERNAL_ERROR',
    );
  }
}

// ---------------------------------------------------------------------------
// Check if user has Pro
// ---------------------------------------------------------------------------

/**
 * Quick check if a user has Pro or higher subscription.
 */
export async function hasPro(userId: string): Promise<boolean> {
  if (!userId) {
    return false;
  }

  try {
    // Check HumanOwner
    const owner = await prisma.humanOwner.findUnique({
      where: { id: userId },
      select: { subscriptionTier: true, subscriptionExpires: true },
    });

    if (owner) {
      const isExpired = owner.subscriptionExpires
        ? new Date(owner.subscriptionExpires) < new Date()
        : false;

      return !isExpired && owner.subscriptionTier === 'PRO';
    }

    // Check HumanObserver
    const observer = await prisma.humanObserver.findUnique({
      where: { id: userId },
      select: { subscriptionTier: true },
    });

    if (observer) {
      return observer.subscriptionTier === 'PRO';
    }

    return false;
  } catch (error) {
    console.error('[subscription:hasPro] Database error:', error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Get subscription tier directly (for internal use)
// ---------------------------------------------------------------------------

/**
 * Get the raw subscription tier for a user.
 * Returns 'FREE' if user not found or on error.
 */
export async function getSubscriptionTier(userId: string): Promise<SubscriptionTier> {
  if (!userId) {
    return 'FREE';
  }

  try {
    const owner = await prisma.humanOwner.findUnique({
      where: { id: userId },
      select: { subscriptionTier: true, subscriptionExpires: true },
    });

    if (owner) {
      const isExpired = owner.subscriptionExpires
        ? new Date(owner.subscriptionExpires) < new Date()
        : false;

      return isExpired ? 'FREE' : owner.subscriptionTier;
    }

    const observer = await prisma.humanObserver.findUnique({
      where: { id: userId },
      select: { subscriptionTier: true },
    });

    return observer?.subscriptionTier ?? 'FREE';
  } catch (error) {
    console.error('[subscription:getTier] Database error:', error);
    return 'FREE';
  }
}