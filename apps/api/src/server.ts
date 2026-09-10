import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { ERROR_CODES } from '@dawaee/shared';
import { loadConfig } from './config.js';
import { createLogger } from './lib/logger.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { attachRequestContext } from './middleware/context.js';
import { promoteProfileIdHeader } from './middleware/profile-routing.js';
import { promoteMedicationIdHeader, rewritePrivateResourceUrl } from './middleware/private-resource-routing.js';
import { buildProviders, type Providers } from './providers/index.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerWebAppRoutes } from './routes/web-app.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerProfileRoutes } from './routes/profiles.js';
import { registerMedicationRoutes } from './routes/medications.js';
import { registerDoseRoutes } from './routes/doses.js';
import { registerDosePrivateRoutes } from './routes/dose-private.js';
import { registerStockRoutes } from './routes/stock.js';
import { registerCaregiverRoutes } from './routes/caregivers.js';
import { registerCaregiverPrivateRoutes } from './routes/caregiver-private.js';
import { registerEmergencyRoutes } from './routes/emergency.js';
import { registerNoteRoutes } from './routes/notes.js';
import { registerUploadRoutes } from './routes/uploads.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerAdminRoutes } from './routes/admin.js';

export interface BuiltServer {
  app: FastifyInstance;
  providers: Providers;
}

export async function buildServer(overrides?: { providers?: Providers }): Promise<BuiltServer> {
  const cfg = loadConfig();
  const providers = overrides?.providers ?? buildProviders(cfg);

  const options: FastifyServerOptions = {
    loggerInstance: createLogger(),
    // Render's request log sees the original public URL. Fixed-path requests
    // carry stable resource identifiers in headers and are rewritten only here,
    // inside the application process, before Fastify matches the established
    // handlers. Old clients can keep using the legacy URL routes during rollout.
    rewriteUrl: (req) => rewritePrivateResourceUrl(req.url ?? '/', req.headers),
    // A hop count, never `true` — see TRUST_PROXY_HOPS in config.ts. With `true`
    // Fastify takes the LEFTMOST X-Forwarded-For entry, which is written by the
    // client, so every IP-keyed rate limit becomes advisory: measured, 14 of 14
    // registrations from one address were allowed simply by varying the header.
    //
    // Expressed as a predicate rather than the number, because Fastify's types
    // do not admit a number even though proxy-addr does. proxy-addr walks the
    // chain from the RIGHT and asks this for each address; trusting the first
    // `TRUST_PROXY_HOPS` of them is exactly what the numeric form means, and the
    // resulting client address is the one the nearest untrusted hop reported —
    // infrastructure, not request content.
    trustProxy: (_address: string, hop: number) => hop < cfg.TRUST_PROXY_HOPS,
    genReqId: () => randomUUID(),
    bodyLimit: 2 * 1024 * 1024,
    // Reject a request whose body arrives too slowly — a cheap slowloris guard.
    requestTimeout: 30_000,
  };
  const app: FastifyInstance = Fastify(options);

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    // The API is JSON-only; these headers matter for the emergency scan page
    // and any browser that reaches an endpoint directly.
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: cfg.isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
  });

  await app.register(cors, {
    origin: cfg.corsOrigins.length ? cfg.corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    /**
     * The key is the client address. It is not the user id, and the `req.auth`
     * branch below is documentation of an intent that does not currently fire.
     *
     * This plugin runs on `onRequest` by default, and authentication runs in a
     * `preHandler` — so `req.auth` is always undefined here and every limit in
     * the app, on authenticated routes included, is keyed by address. Two
     * consequences worth being explicit about rather than discovering later:
     * users behind one NAT (a clinic, a household) share a bucket, which is the
     * outcome the original per-user intent was meant to avoid; and a limit can
     * never be tightened around a single misbehaving account.
     *
     * Left on `onRequest` deliberately. Moving it to `preHandler` would make
     * `req.auth` real, but authentication rejects a bad token before a
     * preHandler-mounted limiter would run — so a flood of requests carrying
     * garbage tokens would stop being rate limited at all. Limiting everything
     * that arrives is worth more than keying the subset that authenticates.
     *
     * What makes the address trustworthy is TRUST_PROXY_HOPS; with Fastify's
     * `trustProxy: true` this key was whatever the client typed.
     */
    keyGenerator: (req) => req.auth?.userId ?? req.ip,
    // `statusCode` is not decoration. The object this returns is thrown, and
    // without a status on it the error handler saw an unrecognised object and
    // answered 500 "an unexpected error occurred" — so every rate-limited
    // caller, including a client that should have backed off after too many
    // sign-in attempts, was told the server had broken instead.
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: { code: ERROR_CODES.RATE_LIMITED, message: 'Too many requests. Please slow down.' },
    }),
  });

  app.addHook('onRequest', async (req) => {
    attachRequestContext(req);
  });

  // Render records the request path before application logging can redact it.
  // New clients therefore carry stable patient and medication identifiers in
  // dedicated headers. Promote that metadata back into the established route
  // query contract before handlers run, so authorization and RLS code remain
  // unchanged. Legacy query-only clients continue to work during rollout.
  app.addHook('preValidation', async (req) => {
    promoteProfileIdHeader(req);
    promoteMedicationIdHeader(req);
  });

  registerErrorHandler(app);

  registerHealthRoutes(app, providers);
  await app.register(async (scope) => {
    registerAuthRoutes(scope);
    registerProfileRoutes(scope);
    registerMedicationRoutes(scope);
    registerDoseRoutes(scope);
    registerDosePrivateRoutes(scope);
    registerStockRoutes(scope);
    registerCaregiverRoutes(scope);
    registerCaregiverPrivateRoutes(scope);
    registerEmergencyRoutes(scope);
    registerNoteRoutes(scope);
    registerUploadRoutes(scope, providers);
    registerReportRoutes(scope);
    registerAdminRoutes(scope);
  });

  await registerWebAppRoutes(app);


  return { app, providers };
}
