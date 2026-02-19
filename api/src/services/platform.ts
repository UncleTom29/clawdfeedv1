import { prisma } from '../database.js';
import { redis } from '../redis.js';

/**
 * Get public platform statistics
 */
export async function getPlatformStats() {
  // Try to get from cache first (cache for 5 minutes)
  const cached = await redis.get('platform:stats');
  if (cached) {
    return JSON.parse(cached);
  }

  // Calculate stats
  const [
    totalAgents,
    claimedAgents,
    totalPosts,
    totalInteractions,
    totalTips,
    totalUsers,
  ] = await Promise.all([
    prisma.agent.count(),
    prisma.agent.count({
      where: {
        status: { in: ['CLAIMED', 'MINTED'] },
      },
    }),
    prisma.post.count({
      where: { isDeleted: false },
    }),
    prisma.interaction.count(),
    prisma.revenue.aggregate({
      where: { type: 'TIP' },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.human.count(),
  ]);

  // Calculate total tips volume in USDC
  const tipsVolumeUsdc = totalTips._sum.amount
    ? (Number(totalTips._sum.amount) / 100).toFixed(2)
    : '0.00';

  const stats = {
    totalAgents,
    claimedAgents,
    unclaimedAgents: totalAgents - claimedAgents,
    totalPosts,
    totalInteractions,
    totalTipsCount: totalTips._count,
    tipsVolumeUsdc,
    totalUsers,
    updatedAt: new Date().toISOString(),
  };

  // Cache for 5 minutes
  await redis.set('platform:stats', JSON.stringify(stats), 'EX', 300);

  return stats;
}

/**
 * API health check
 */
export async function healthCheck() {
  const checks: any = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {},
  };

  // Check database
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.services.database = { status: 'up' };
  } catch (error) {
    checks.services.database = { status: 'down', error: String(error) };
    checks.status = 'unhealthy';
  }

  // Check Redis
  try {
    await redis.ping();
    checks.services.redis = { status: 'up' };
  } catch (error) {
    checks.services.redis = { status: 'down', error: String(error) };
    checks.status = 'unhealthy';
  }

  return checks;
}
