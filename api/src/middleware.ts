import { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from './database.js';
import { config } from './config.js';
import jwt from 'jsonwebtoken';

const BEARER_PREFIX = 'Bearer ';
const BEARER_PREFIX_LENGTH = BEARER_PREFIX.length;

/**
 * Middleware to check if user is an admin
 * Requires JWT authentication to be run first
 */
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Check if user is authenticated via JWT
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
    reply.code(401).send({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
      },
    });
    return;
  }

  const token = authHeader.slice(BEARER_PREFIX_LENGTH).trim();
  
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET) as any;
    
    // Check if wallet matches admin wallet
    const adminWallet = process.env.ADMIN_WALLET_ADDRESS?.toLowerCase();
    const userWallet = decoded.wallet?.toLowerCase();
    
    if (!adminWallet || !userWallet || userWallet !== adminWallet) {
      reply.code(403).send({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Admin access required',
        },
      });
      return;
    }
    
    // Attach user info to request
    (request as any).user = {
      id: decoded.sub,
      wallet: decoded.wallet,
      isAdmin: true,
    };
  } catch (error) {
    reply.code(401).send({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid or expired token',
      },
    });
    return;
  }
}

/**
 * Middleware to check if user has Pro tier
 * Requires JWT authentication to be run first
 */
export async function requireProTier(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Check if user is authenticated via JWT
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.code(401).send({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
      },
    });
    return;
  }

  const token = authHeader.slice(BEARER_PREFIX_LENGTH).trim();
  
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET) as any;
    
    // Get user from database to check tier status
    const user = await prisma.human.findUnique({
      where: { id: decoded.sub },
    });
    
    if (!user) {
      reply.code(401).send({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'User not found',
        },
      });
      return;
    }
    
    // Check if user has Pro tier and it's not expired
    const isPro = user.tier === 'pro';
    const isExpired = user.subscriptionExpiresAt
      ? new Date() > user.subscriptionExpiresAt
      : true;
    
    if (!isPro || isExpired) {
      reply.code(403).send({
        success: false,
        error: {
          code: 'PRO_TIER_REQUIRED',
          message: 'Pro tier subscription required for this feature',
          upgradeUrl: '/upgrade',
        },
      });
      return;
    }
    
    // Attach user info to request
    (request as any).user = {
      id: user.id,
      wallet: user.walletAddress,
      tier: user.tier,
      subscriptionExpiresAt: user.subscriptionExpiresAt,
    };
  } catch (error) {
    reply.code(401).send({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid or expired token',
      },
    });
    return;
  }
}

/**
 * Middleware to authenticate user via JWT
 * Attaches user to request object
 */
export async function authenticateUser(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.code(401).send({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
      },
    });
    return;
  }

  const token = authHeader.slice(BEARER_PREFIX_LENGTH).trim();
  
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET) as any;
    
    // Get user from database
    const user = await prisma.human.findUnique({
      where: { id: decoded.sub },
    });
    
    if (!user) {
      reply.code(401).send({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'User not found',
        },
      });
      return;
    }
    
    // Attach user info to request
    (request as any).user = {
      id: user.id,
      wallet: user.walletAddress,
      tier: user.tier,
      subscriptionExpiresAt: user.subscriptionExpiresAt,
    };
  } catch (error) {
    reply.code(401).send({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid or expired token',
      },
    });
    return;
  }
}

/**
 * Middleware to check if user owns the agent
 * Requires JWT authentication to be run first
 */
export async function requireAgentOwner(agentId: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // Get user from request (should be set by authenticateUser)
    const user = (request as any).user;
    
    if (!user) {
      reply.code(401).send({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        },
      });
      return;
    }
    
    // Get agent to check ownership
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: {
        id: true,
        ownerWallet: true,
      },
    });
    
    if (!agent) {
      reply.code(404).send({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Agent not found',
        },
      });
      return;
    }
    
    // Check if user owns the agent
    if (agent.ownerWallet?.toLowerCase() !== user.wallet?.toLowerCase()) {
      reply.code(403).send({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'You do not own this agent',
        },
      });
      return;
    }
  };
}

/**
 * Middleware to check if user owns the agent by handle
 * Requires JWT authentication to be run first
 */
export async function requireAgentOwnerByHandle(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Get user from request (should be set by authenticateUser)
  const user = (request as any).user;
  
  if (!user) {
    reply.code(401).send({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
      },
    });
    return;
  }
  
  // Get agent handle from params
  const params = request.params as any;
  const handle = params.handle || params.id;
  
  if (!handle) {
    reply.code(400).send({
      success: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'Agent handle or ID required',
      },
    });
    return;
  }
  
  // Get agent to check ownership
  const agent = await prisma.agent.findFirst({
    where: {
      OR: [
        { handle: handle },
        { id: handle },
      ],
    },
    select: {
      id: true,
      handle: true,
      ownerWallet: true,
    },
  });
  
  if (!agent) {
    reply.code(404).send({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Agent not found',
      },
    });
    return;
  }
  
  // Check if user owns the agent
  if (agent.ownerWallet?.toLowerCase() !== user.wallet?.toLowerCase()) {
    reply.code(403).send({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: 'You do not own this agent',
      },
    });
    return;
  }
  
  // Attach agent to request for use in route handler
  (request as any).agent = agent;
}
