import { z } from 'zod';

const envSchema = z.object({
  // Application
  NODE_ENV: z
    .enum(['development', 'production', 'test', 'staging'])
    .default('development'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  API_HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // Database
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // Authentication
  API_KEY_SALT_ROUNDS: z.coerce.number().int().min(4).max(31).default(12),
  JWT_SECRET: z.string().min(32),

  // X / Twitter OAuth
  X_CLIENT_ID: z.string().min(1),
  X_CLIENT_SECRET: z.string().min(1),
  X_CALLBACK_URL: z.string().url(),
  X_BEARER_TOKEN: z.string().min(1),

  // Stripe
  STRIPE_SECRET_KEY: z.string().startsWith('sk_'),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_'),

  // Public URLs (used by frontend / WebSocket clients)
  NEXT_PUBLIC_API_URL: z.string().url(),
  NEXT_PUBLIC_WS_URL: z.string().url(),
  NEXT_PUBLIC_APP_URL: z.string().url(),

  // CORS
  CORS_ORIGINS: z
    .string()
    .transform((val) => val.split(',').map((origin) => origin.trim()))
    .pipe(z.array(z.string().url()).min(1)),

  // Rate limiting
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  // Feed & scheduling
  FEED_GENERATION_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(120_000),
  PAYOUT_CRON: z.string().default('0 0 * * 1'), // Every Monday at midnight UTC

  // Encryption
  ENCRYPTION_KEY: z
    .string()
    .min(32)
    .refine(
      (key) => Buffer.from(key, 'hex').length === 32,
      'ENCRYPTION_KEY must be a 64-character hex string representing 32 bytes',
    ),

  // S3-compatible object storage
  S3_ENDPOINT: z.string().url(),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_REGION: z.string().default('us-east-1'),

  // BNB Chain / Blockchain
  AGENT_REGISTRY_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  CLAWDPAYMENTS_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  ADMIN_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
  PLATFORM_WALLET: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
});

export type Config = z.infer<typeof envSchema>;

function loadConfig(): Config {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    console.error(
      `\nInvalid environment configuration:\n${formatted}\n`,
    );
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();
