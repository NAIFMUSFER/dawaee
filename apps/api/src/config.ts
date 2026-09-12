import { z } from 'zod';

/**
 * Environment configuration. Parsed once at boot and validated hard: a missing
 * secret must stop the process, never fall back to a default that would ship
 * an insecure build to production.
 */
/**
 * Booleans from the environment.
 *
 * `z.coerce.boolean()` is JavaScript's `Boolean()`, and `Boolean('false')` is
 * `true` — so every non-empty string, including the word "false", becomes true.
 * That is the opposite of what an operator writing `TRUST_PROXY=false` means,
 * and it fails in the most dangerous direction: a debug or trust flag someone
 * deliberately turned off stays on.
 */
const envBoolean = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((raw) => {
      if (raw === undefined) return defaultValue;
      const v = raw.trim().toLowerCase();
      if (v === '') return defaultValue;
      if (['1', 'true', 'yes', 'on'].includes(v)) return true;
      if (['0', 'false', 'no', 'off'].includes(v)) return false;
      return defaultValue;
    });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z.enum(['true', 'false', 'no-verify']).default('false'),
  /**
   * The operator's database CA, inline PEM or a file path (not both).
   *
   * Supabase documents that verify-full requires their CA certificate from the
   * project dashboard, so an endpoint that does not chain to a publicly trusted
   * root needs this set. No certificate is embedded in this repository: a CA
   * bundle committed to source is a trust anchor nobody rotates.
   */
  DATABASE_CA_CERT: z.string().optional(),
  DATABASE_CA_CERT_FILE: z.string().optional(),
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
  OTP_DEBUG_ECHO: envBoolean(false),
  /**
   * Password sign-in.
   *
   * On by default because it is the only route into the application. The two
   * code-delivery channels both require a Saudi commercial registration — an
   * SMS Sender ID, or a Meta-verified business for a WhatsApp authentication
   * template — so neither exists here. Turn this off only once a verified
   * second factor is actually available.
   */
  PASSWORD_LOGIN_ENABLED: envBoolean(true),

  CORS_ORIGINS: z.string().default(''),
  /**
   * Trust Cloudflare's edge-authenticated client address and replace any
   * caller-supplied X-Forwarded-For chain before Fastify derives req.ip.
   *
   * This is deliberately OFF by default because CF-Connecting-IP is just a
   * request header on a deployment that is not guaranteed to sit behind
   * Cloudflare. Render guarantees that public web-service traffic passes through
   * Cloudflare and that the edge supplies this value, so render.yaml turns it on
   * explicitly. When enabled, TRUST_PROXY_HOPS must remain exactly 1 because the
   * application collapses the chain to one trusted address first.
   */
  TRUST_CF_CONNECTING_IP: envBoolean(false),
  /**
   * How many proxies sit in front of this app — NOT a boolean.
   *
   * It used to be `envBoolean(true)`, and Fastify's `trustProxy: true` means
   * "trust the entire X-Forwarded-For chain and take the LEFTMOST entry as the
   * client". The leftmost entry is whatever the client typed. Measured against
   * the running server: 6 registrations from one address were rate-limited as
   * intended, and 14 from the same address with a different `X-Forwarded-For`
   * on each were all allowed — `blocked=0`. Every IP-keyed limit in the app was
   * a single header away from being nothing, which is also what made
   * registration enumeration unbounded rather than 6-per-10-minutes.
   *
   * Render production later proved that trusting its raw forwarded chain with a
   * fixed hop count could resolve the application client address to a private
   * infrastructure range. The Render deployment therefore binds the trusted
   * Cloudflare client address into a one-entry forwarded chain before Fastify
   * applies this hop count. Other deployments keep the original hop-count model.
   *
   * Set it to the real number of trusted hops for deployments that do not use
   * TRUST_CF_CONNECTING_IP. `0` disables `X-Forwarded-For` entirely. Never make
   * it large "to be safe" — each extra hop is one more caller-controlled entry
   * treated as trusted.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),
  /** Salt for hashing IPs in the audit log — we never store a raw address. */
  IP_HASH_SALT: z.string().min(8).default('dawaee-dev-salt'),

  // --- providers (all optional; each falls back to a logging mock) ---
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
    if (cfg.PUSH_PROVIDER !== 'expo') {
      throw new Error('PUSH_PROVIDER must be "expo" in production');
    }
    if (cfg.STORAGE_PROVIDER === 'local') {
      throw new Error('STORAGE_PROVIDER=local is not permitted in production; use s3 or r2');
    }
    if (cfg.TRUST_CF_CONNECTING_IP && cfg.TRUST_PROXY_HOPS !== 1) {
      throw new Error('TRUST_CF_CONNECTING_IP requires TRUST_PROXY_HOPS=1');
    }
    // Fails the boot rather than the audit. `no-verify` accepts any
    // certificate from anyone, which leaves an active attacker between Render
    // and Supabase reading and rewriting every query in a database of
    // medication records — and holding the owner password the connection
    // string carries.
    if (cfg.DATABASE_SSL !== 'true') {
      throw new Error(
        `DATABASE_SSL must be "true" in production (got "${cfg.DATABASE_SSL}"); ` +
        'certificate verification cannot be disabled for a production database',
      );
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
