import type { Config } from '../config.js';
import { MockSmsProvider, TwilioSmsProvider, UnifonicSmsProvider } from './sms.js';
import { MetaCloudWhatsAppProvider, MockWhatsAppProvider } from './whatsapp.js';
import { ExpoPushProvider, MockPushProvider } from './push.js';
import {
  AzureDocumentIntelligenceOcrProvider, GoogleVisionOcrProvider, MockOcrProvider,
} from './ocr.js';
import { LocalStorageProvider, S3StorageProvider } from './storage.js';
import type { OcrProvider, PushProvider, SmsProvider, StorageProvider, WhatsAppProvider } from './types.js';

export interface Providers {
  sms: SmsProvider;
  whatsapp: WhatsAppProvider;
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
  const sms: SmsProvider =
    cfg.SMS_PROVIDER === 'twilio' ? new TwilioSmsProvider(cfg)
      : cfg.SMS_PROVIDER === 'unifonic' ? new UnifonicSmsProvider(cfg)
        : new MockSmsProvider();

  const whatsapp: WhatsAppProvider =
    cfg.WHATSAPP_PROVIDER === 'meta_cloud' ? new MetaCloudWhatsAppProvider(cfg) : new MockWhatsAppProvider();

  const push: PushProvider = cfg.PUSH_PROVIDER === 'expo' ? new ExpoPushProvider(cfg) : new MockPushProvider();

  const ocr: OcrProvider =
    cfg.OCR_PROVIDER === 'google_vision' ? new GoogleVisionOcrProvider(cfg)
      : cfg.OCR_PROVIDER === 'azure_document_intelligence' ? new AzureDocumentIntelligenceOcrProvider(cfg)
        : new MockOcrProvider();

  const storage: StorageProvider =
    cfg.STORAGE_PROVIDER === 'local' ? new LocalStorageProvider(cfg) : new S3StorageProvider(cfg);

  return { sms, whatsapp, push, ocr, storage };
}

export * from './types.js';
export { MockSmsProvider } from './sms.js';
export { MockWhatsAppProvider, WHATSAPP_TEMPLATES } from './whatsapp.js';
export { MockPushProvider } from './push.js';
export { MockOcrProvider, parseMedicationText, parsePrescriptionText, detectLanguage } from './ocr.js';
export { LocalStorageProvider, ALLOWED_IMAGE_TYPES, sniffImageType, buildObjectKey } from './storage.js';
