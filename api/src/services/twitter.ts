import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TwitterTweet {
  id: string;
  text: string;
  author_id: string;
  created_at: string;
}

interface TwitterUser {
  id: string;
  username: string;
  name: string;
  profile_image_url?: string;
  verified?: boolean;
}

interface TwitterAPIResponse<T> {
  data: T;
  includes?: {
    users?: TwitterUser[];
  };
  errors?: Array<{
    message: string;
    type: string;
  }>;
}

// ---------------------------------------------------------------------------
// Twitter API Client
// ---------------------------------------------------------------------------

class TwitterAPI {
  private readonly bearerToken: string;
  private readonly baseURL = 'https://api.twitter.com/2';

  constructor(bearerToken: string) {
    this.bearerToken = bearerToken;
  }

  /**
   * Make an authenticated request to the Twitter API
   */
  private async request<T>(
    endpoint: string,
    options?: RequestInit,
  ): Promise<T> {
    const url = `${this.baseURL}${endpoint}`;
    
    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.bearerToken}`,
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!response.ok) {
      let errorMessage = response.statusText;
      try {
        const errorData = await response.json();
        if (errorData && typeof errorData === 'object') {
          errorMessage = (errorData as { detail?: string; message?: string }).detail 
            || (errorData as { detail?: string; message?: string }).message 
            || errorMessage;
        }
      } catch {
        // JSON parse failed, use statusText
      }
      throw new Error(`Twitter API error (${response.status}): ${errorMessage}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Get a tweet by ID
   */
  async getTweet(tweetId: string): Promise<TwitterTweet | null> {
    try {
      const response = await this.request<TwitterAPIResponse<TwitterTweet>>(
        `/tweets/${tweetId}?tweet.fields=created_at,author_id`,
      );

      return response.data;
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get a user by username
   */
  async getUserByUsername(username: string): Promise<TwitterUser | null> {
    try {
      const response = await this.request<TwitterAPIResponse<TwitterUser>>(
        `/users/by/username/${username}?user.fields=profile_image_url,verified`,
      );

      return response.data;
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Extract tweet ID from various Twitter URL formats
   */
  static extractTweetId(tweetUrl: string): string | null {
    // Support various Twitter URL formats:
    // - https://twitter.com/username/status/1234567890
    // - https://x.com/username/status/1234567890
    // - https://mobile.twitter.com/username/status/1234567890
    const patterns = [
      /(?:twitter\.com|x\.com)\/[\w]+\/status\/(\d+)/i,
      /(?:mobile\.twitter\.com)\/[\w]+\/status\/(\d+)/i,
    ];

    for (const pattern of patterns) {
      const match = tweetUrl.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }

    return null;
  }

  /**
   * Verify that a tweet contains the verification code
   */
  async verifyTweetContainsCode(
    tweetUrl: string,
    verificationCode: string,
  ): Promise<{
    verified: boolean;
    tweet?: TwitterTweet;
    error?: string;
  }> {
    // Extract tweet ID from URL
    const tweetId = TwitterAPI.extractTweetId(tweetUrl);
    if (!tweetId) {
      return {
        verified: false,
        error: 'Invalid Twitter URL. Please provide a valid tweet link.',
      };
    }

    try {
      // Fetch the tweet
      const tweet = await this.getTweet(tweetId);
      if (!tweet) {
        return {
          verified: false,
          error: 'Tweet not found. Please check the URL and try again.',
        };
      }

      // Check if tweet contains the verification code
      const tweetText = tweet.text.toLowerCase();
      const codeToFind = verificationCode.toLowerCase();
      
      if (!tweetText.includes(codeToFind)) {
        return {
          verified: false,
          tweet,
          error: `Tweet does not contain the verification code "${verificationCode}". Please tweet the code and try again.`,
        };
      }

      return {
        verified: true,
        tweet,
      };
    } catch (error) {
      if (error instanceof Error) {
        return {
          verified: false,
          error: `Twitter API error: ${error.message}`,
        };
      }
      return {
        verified: false,
        error: 'Failed to verify tweet. Please try again.',
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton Instance
// ---------------------------------------------------------------------------

let twitterAPI: TwitterAPI | null = null;

/**
 * Get the Twitter API client instance
 */
export function getTwitterAPI(): TwitterAPI {
  if (!twitterAPI) {
    twitterAPI = new TwitterAPI(config.X_BEARER_TOKEN);
  }
  return twitterAPI;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { TwitterAPI };
export type { TwitterTweet, TwitterUser };
