import { z } from 'zod';

/**
 * Environment configuration. Parsed once at boot and validated hard: a missing
 * secret must stop the process, never fall back to a default that would ship
 * an insecure build to production.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z.enum(['true', 'false', 'no-verify']).default('false'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  // Managed providers hand out one connection string, and it belongs to the
  // database owner. The owner is exactly the identity that must never serve a
  // request: every RLS policy in migration 0008 is written `TO dawaee_app`, so
  // connecting as the owner would either bypass the policies or (with FORCE
  // ROW LEVEL SECURITY, which is what we set) match none of them and read
  // nothing. These two settings swap the credentials in DATABASE_URL for the
  // least-privileged role before the pool is opened.
  DATABASE_ROLE: z.string().min(1).optional(),
  DATABASE_ROLE_PASSWORD: z.string().min(1).optional(),

  // 32+ bytes of entropy, base64 or hex. Rotating this invalidates all tokens.
  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().default('dawaee'),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(60),

  OTP_TTL_MINUTES: z.coerce.number().int().min(1).max(30).default(5),
  OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  /** Development convenience: echo the OTP in the response. Refused in production. */
  OTP_DEBUG_ECHO: z.coerce.boolean().default(false),

  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: z.coerce.boolean().default(true),
  /** Salt for hashing IPs in the audit log — we never store a raw address. */
  IP_HASH_SALT: z.string().min(8).default('dawaee-dev-salt'),

  // --- providers (all optional; each falls back to a logging mock) ---
  SMS_PROVIDER: z.enum(['mock', 'twilio', 'unifonic']).default('mock'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(),
  UNIFONIC_APP_SID: z.string().optional(),
  UNIFONIC_SENDER_ID: z.string().optional(),

  WHATSAPP_PROVIDER: z.enum(['mock', 'meta_cloud']).default('mock'),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_API_VERSION: z.string().default('v21.0'),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),

  PUSH_PROVIDER: z.enum(['mock', 'expo']).default('mock'),
  EXPO_ACCESS_TOKEN: z.string().optional(),

  OCR_PROVIDER: z.enum(['mock', 'google_vision', 'azure_document_intelligence']).default('mock'),
  GOOGLE_VISION_API_KEY: z.string().optional(),
  AZURE_DI_ENDPOINT: z.string().optional(),
  AZURE_DI_KEY: z.string().optional(),

  STORAGE_PROVIDER: z.enum(['local', 's3', 'r2']).default('local'),
  STORAGE_BUCKET: z.string().optional(),
  STORAGE_ENDPOINT: z.string().optional(),
  STORAGE_ACCESS_KEY_ID: z.string().optional(),
  STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
  STORAGE_REGION: z.string().default('auto'),
  STORAGE_LOCAL_DIR: z.string().default('./.storage'),
  UPLOAD_MAX_BYTES: z.coerce.number().int().default(15 * 1024 * 1024),

  PUBLIC_APP_URL: z.string().default('https://dawaee.app'),
});

export type Config = z.infer<typeof schema> & {
  corsOrigins: string[];
  isProduction: boolean;
};

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  const isProduction = cfg.NODE_ENV === 'production';

  // Guardrails that only matter in production, checked at boot rather than
  // discovered by a user.
  if (isProduction) {
    if (cfg.OTP_DEBUG_ECHO) throw new Error('OTP_DEBUG_ECHO must be false in production');
    if (cfg.IP_HASH_SALT === 'dawaee-dev-salt') throw new Error('IP_HASH_SALT must be set in production');
    if (cfg.JWT_SECRET.length < 48) throw new Error('JWT_SECRET must be at least 48 characters in production');
    if (cfg.WHATSAPP_PROVIDER === 'meta_cloud' && !cfg.WHATSAPP_ACCESS_TOKEN) {
      throw new Error('WHATSAPP_ACCESS_TOKEN is required when WHATSAPP_PROVIDER=meta_cloud');
    }
    if (cfg.STORAGE_PROVIDER === 'local') {
      throw new Error('STORAGE_PROVIDER=local is not permitted in production; use s3 or r2');
    }
  }

  cached = {
    ...cfg,
    isProduction,
    corsOrigins: cfg.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  };
  return cached;
}

/** Test helper — never call from application code. */
export function resetConfigCache(): void {
  cached = null;
}
