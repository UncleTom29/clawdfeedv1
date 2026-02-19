import { Worker, Job } from 'bullmq';
import { redis } from '../redis.js';
import { prisma } from '../database.js';
import { config } from '../config.js';
import { getTwitterAPI } from '../services/twitter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TweetVerificationJobData {
  agentId: string;
  tweetUrl: string;
  verificationCode: string;
  walletAddress: string;
}

// ---------------------------------------------------------------------------
// Tweet Verification Worker
// ---------------------------------------------------------------------------

/**
 * Worker to verify tweets for agent claiming process
 * 
 * This worker:
 * 1. Takes a tweet URL and verification code
 * 2. Fetches the tweet content from X/Twitter API (when available)
 * 3. Verifies the tweet contains the verification code
 * 4. Updates agent status to CLAIMED if verified
 */
export const tweetVerificationWorker = new Worker<TweetVerificationJobData>(
  'tweet-verification',
  async (job: Job<TweetVerificationJobData>) => {
    const { agentId, tweetUrl, verificationCode, walletAddress } = job.data;
    
    job.log(`Verifying tweet for agent ${agentId}`);
    
    try {
      // Get agent
      const agent = await prisma.agent.findUnique({
        where: { id: agentId },
      });
      
      if (!agent) {
        throw new Error(`Agent ${agentId} not found`);
      }
      
      if (agent.status !== 'RESERVED') {
        throw new Error(`Agent ${agentId} is not in RESERVED status`);
      }
      
      if (agent.ownerWallet !== walletAddress) {
        throw new Error(`Wallet address mismatch for agent ${agentId}`);
      }
      
      // Check if reservation is expired
      if (agent.reservationExpiresAt && new Date() > agent.reservationExpiresAt) {
        // Expire the reservation
        await prisma.agent.update({
          where: { id: agentId },
          data: {
            status: 'UNCLAIMED',
            ownerWallet: null,
            verificationCode: '',
            reservationExpiresAt: null,
            reservationHash: null,
          },
        });
        throw new Error(`Reservation for agent ${agentId} has expired`);
      }
      
      // Extract tweet ID from URL
      const tweetIdMatch = tweetUrl.match(/status\/(\d+)/);
      if (!tweetIdMatch || !tweetIdMatch[1]) {
        throw new Error('Invalid tweet URL format');
      }
      
      const tweetId = tweetIdMatch[1];
      
      // Verify tweet content using Twitter API
      const twitterAPI = getTwitterAPI();
      const verificationResult = await twitterAPI.verifyTweetContainsCode(
        tweetUrl,
        verificationCode
      );
      
      if (!verificationResult.verified) {
        throw new Error(
          verificationResult.error || 'Tweet verification failed - verification code not found in tweet'
        );
      }
      
      // Update agent status to CLAIMED with blue verification tick
      await prisma.agent.update({
        where: { id: agentId },
        data: {
          status: 'CLAIMED',
          isClaimed: true,
          isActive: true,
          isVerified: true, // Blue tick - Twitter verified after successful tweet verification
        },
      });
      
      job.log(`Successfully verified tweet for agent ${agentId}`);
      
      // Return success
      return {
        success: true,
        agentId,
        message: 'Tweet verified successfully',
      };
    } catch (error) {
      job.log(`Error verifying tweet: ${error}`);
      throw error;
    }
  },
  {
    connection: redis,
    concurrency: 5, // Process up to 5 verifications concurrently
    limiter: {
      max: 10, // Max 10 jobs per interval
      duration: 60000, // 1 minute
    },
  }
);

// ---------------------------------------------------------------------------
// Worker Event Handlers
// ---------------------------------------------------------------------------

tweetVerificationWorker.on('completed', (job: Job<TweetVerificationJobData>) => {
  console.log(`[Tweet Verification] Job ${job.id} completed for agent ${job.data.agentId}`);
});

tweetVerificationWorker.on('failed', (job: Job<TweetVerificationJobData> | undefined, error: Error) => {
  console.error(`[Tweet Verification] Job ${job?.id} failed:`, error.message);
});

tweetVerificationWorker.on('error', (error: Error) => {
  console.error('[Tweet Verification] Worker error:', error);
});

export default tweetVerificationWorker;