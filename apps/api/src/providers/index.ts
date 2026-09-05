import type { Config } from '../config.js';
import { ExpoPushProvider, MockPushProvider } from './push.js';
import {
  AzureDocumentIntelligenceOcrProvider, GoogleVisionOcrProvider, MockOcrProvider,
} from './ocr.js';
import { LocalStorageProvider, S3StorageProvider, UnconfiguredStorageProvider } from './storage.js';
import type { OcrProvider, PushProvider, StorageProvider } from './types.js';

/**
 * Outbound integrations.
 *
 * There is exactly one messaging channel — push — and that is a deliberate,
 * externally forced choice rather than an unfinished one. Reaching a Saudi
 * phone by SMS requires an alphanumeric Sender ID registered against a
 * commercial registration, and no long or short codes are available; reaching
 * one by WhatsApp requires a Meta-verified business and an approved
 * AUTHENTICATION template. Neither can be turned on by configuration, so
 * neither is offered as configuration. When a commercial registration exists,
 * the channel goes back in as a new provider against the same interfaces —
 * the notification pipeline is already channel-shaped.
 */
export interface Providers {
  push: PushProvider;
  ocr: OcrProvider;
  storage: StorageProvider;
}

/**
 * Wires the configured provider for each integration, falling back to the
 * recording mock when no credentials are present. The chosen names are
 * reported by /health so an operator can see at a glance whether a deployment
 * is actually able to reach anyone.
 */
export function buildProviders(cfg: Config): Providers {
  const push: PushProvider = cfg.PUSH_PROVIDER === 'expo' ? new ExpoPushProvider(cfg) : new MockPushProvider();

  const ocr: OcrProvider =
    cfg.OCR_PROVIDER === 'google_vision' ? new GoogleVisionOcrProvider(cfg)
      : cfg.OCR_PROVIDER === 'azure_document_intelligence' ? new AzureDocumentIntelligenceOcrProvider(cfg)
        : new MockOcrProvider();

  // A bucket that was asked for but not given credentials must not take the
  // whole service down with it — the deployment comes up with image uploads
  // refused and says so on /health/ready.
  const storage: StorageProvider =
    cfg.STORAGE_PROVIDER === 'local'
      ? new LocalStorageProvider(cfg)
      : cfg.STORAGE_BUCKET && cfg.STORAGE_ACCESS_KEY_ID && cfg.STORAGE_SECRET_ACCESS_KEY
        ? new S3StorageProvider(cfg)
        : new UnconfiguredStorageProvider();

  return { push, ocr, storage };
}

export * from './types.js';
export { MockPushProvider } from './push.js';
export { MockOcrProvider, parseMedicationText, parsePrescriptionText, detectLanguage } from './ocr.js';
export { LocalStorageProvider, UnconfiguredStorageProvider, ALLOWED_IMAGE_TYPES, sniffImageType, buildObjectKey } from './storage.js';
