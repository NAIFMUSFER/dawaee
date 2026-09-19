import type { Config } from '../config.js';
import { ExpoPushProvider, MockPushProvider } from './push.js';
import {
  AzureDocumentIntelligenceOcrProvider, GoogleVisionOcrProvider, MockOcrProvider,
} from './ocr.js';
import { LocalStorageProvider, S3StorageProvider, UnconfiguredStorageProvider } from './storage.js';
import type {
  MedicationOcrResult, OcrProvider, PrescriptionOcrResult, PushProvider, StorageProvider,
} from './types.js';

/** Push, OCR and storage. Account email has a separate authentication-only queue. */
export interface Providers {
  push: PushProvider;
  ocr: OcrProvider;
  storage: StorageProvider;
}

/**
 * A production deployment without a real OCR provider must fail closed.
 *
 * `MockOcrProvider` deliberately returns realistic medication and prescription
 * fixtures so development can exercise the review flow. Returning those same
 * fixtures in production would turn a configuration omission into plausible,
 * incorrect clinical suggestions as soon as object storage is enabled. Keep
 * the process and manual-entry path available, but make analysis itself refuse
 * the request through the route's existing PROVIDER_UNAVAILABLE handling.
 */
class UnconfiguredOcrProvider implements OcrProvider {
  readonly name = 'unconfigured';

  async readMedicationLabel(_image: Buffer, _contentType: string): Promise<MedicationOcrResult> {
    throw new Error('OCR provider is not configured');
  }

  async readPrescription(_image: Buffer, _contentType: string): Promise<PrescriptionOcrResult> {
    throw new Error('OCR provider is not configured');
  }
}

/**
 * Wires the configured provider for each integration. Development and tests may
 * use deterministic recording mocks; production uses an explicit unavailable
 * provider instead of returning synthetic OCR data. The chosen names are
 * reported by /health so an operator can see at a glance whether a deployment
 * is actually able to perform each integration.
 */
export function buildProviders(cfg: Config): Providers {
  const push: PushProvider = cfg.PUSH_PROVIDER === 'expo' ? new ExpoPushProvider(cfg) : new MockPushProvider();

  const ocr: OcrProvider =
    cfg.OCR_PROVIDER === 'google_vision' ? new GoogleVisionOcrProvider(cfg)
      : cfg.OCR_PROVIDER === 'azure_document_intelligence' ? new AzureDocumentIntelligenceOcrProvider(cfg)
        : cfg.isProduction ? new UnconfiguredOcrProvider() : new MockOcrProvider();

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
