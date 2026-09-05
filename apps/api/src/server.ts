import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { ERROR_CODES } from '@dawaee/shared';
import { loadConfig } from './config.js';
import { createLogger } from './lib/logger.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { attachRequestContext } from './middleware/context.js';
import { buildProviders, type Providers } from './providers/index.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerWebAppRoutes } from './routes/web-app.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerProfileRoutes } from './routes/profiles.js';
import { registerMedicationRoutes } from './routes/medications.js';
import { registerDoseRoutes } from './routes/doses.js';
import { registerStockRoutes } from './routes/stock.js';
import { registerCaregiverRoutes } from './routes/caregivers.js';
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

  const app: FastifyInstance = Fastify({
    loggerInstance: createLogger(),
    trustProxy: cfg.TRUST_PROXY,
    genReqId: () => randomUUID(),
    bodyLimit: 2 * 1024 * 1024,
    // Reject a request whose body arrives too slowly — a cheap slowloris guard.
    requestTimeout: 30_000,
  });

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
    // Rate limit per authenticated user where possible, falling back to IP, so
    // one abusive account cannot lock out a shared network (a hospital, a home).
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

  registerErrorHandler(app);

  registerHealthRoutes(app, providers);
  await app.register(async (scope) => {
    registerAuthRoutes(scope);
    registerProfileRoutes(scope);
    registerMedicationRoutes(scope);
    registerDoseRoutes(scope);
    registerStockRoutes(scope);
    registerCaregiverRoutes(scope);
    registerEmergencyRoutes(scope);
    registerNoteRoutes(scope);
    registerUploadRoutes(scope, providers);
    registerReportRoutes(scope);
    registerAdminRoutes(scope);
  });

  await registerWebAppRoutes(app);


  return { app, providers };
}
