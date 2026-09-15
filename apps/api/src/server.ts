import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { ERROR_CODES } from '@dawaee/shared';
import { loadConfig } from './config.js';
import { createLogger } from './lib/logger.js';
import { bindTrustedCloudflareClientIp } from './lib/client-ip.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { attachRequestContext } from './middleware/context.js';
import { promoteObjectKeyHeader, promoteProfileIdHeader } from './middleware/profile-routing.js';
import { promoteMedicationIdHeader, rewritePrivateResourceUrl } from './middleware/private-resource-routing.js';
import { buildProviders, type Providers } from './providers/index.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerWebAppRoutes } from './routes/web-app.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerFirebasePhoneRoutes } from './routes/firebase-phone.js';
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

export interface BuiltServer { app: FastifyInstance; providers: Providers }

export async function buildServer(overrides?: { providers?: Providers }): Promise<BuiltServer> {
  const cfg = loadConfig();
  const providers = overrides?.providers ?? buildProviders(cfg);
  const options: FastifyServerOptions = {
    loggerInstance: createLogger(),
    rewriteUrl: (req) => {
      bindTrustedCloudflareClientIp(req.headers, cfg.TRUST_CF_CONNECTING_IP);
      return rewritePrivateResourceUrl(req.url ?? '/', req.headers);
    },
    trustProxy: (_address: string, hop: number) => hop < cfg.TRUST_PROXY_HOPS,
    genReqId: () => randomUUID(),
    bodyLimit: 2 * 1024 * 1024,
    requestTimeout: 30_000,
  };
  const app: FastifyInstance = Fastify(options);

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
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
    keyGenerator: (req) => req.auth?.userId ?? req.ip,
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: { code: ERROR_CODES.RATE_LIMITED, message: 'Too many requests. Please slow down.' },
    }),
  });

  app.addHook('onRequest', async (req) => { attachRequestContext(req); });
  app.addHook('preValidation', async (req) => {
    promoteProfileIdHeader(req);
    promoteMedicationIdHeader(req);
    promoteObjectKeyHeader(req);
  });
  registerErrorHandler(app);

  registerHealthRoutes(app, providers);
  await app.register(async (scope) => {
    registerAuthRoutes(scope);
    registerFirebasePhoneRoutes(scope);
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
