/**
 * Provider contracts.
 *
 * Every outbound integration is defined as an interface with a real
 * implementation and a mock. The mock is not a stub that pretends to succeed:
 * it records what would have been sent so tests can assert on it, and it is
 * what runs until real credentials are configured. Nothing in the codebase
 * claims a message was delivered when no provider was reachable.
 */

export interface SendResult {
  ok: boolean;
  providerMessageId?: string;
  errorCode?: string;
  errorDetail?: string;
  /** True when retrying could plausibly succeed (network, 5xx, throttling). */
  retryable?: boolean;
}

export interface PushMessage {
  token: string;
  title: string;
  body: string;
  data: Record<string, string>;
  /** Maps to Android channel / iOS interruption level for medication alerts. */
  priority: 'default' | 'high';
  categoryId?: string;
  sound?: string;
  badge?: number;
}

export interface PushSendResult extends SendResult {
  /** Tokens the provider reported as permanently dead, for cleanup. */
  invalidTokens?: string[];
}

export interface PushProvider {
  readonly name: string;
  send(messages: PushMessage[]): Promise<PushSendResult[]>;
}

export interface OcrField<T = string> {
  value: T;
  /** 0–1. The UI shows anything below 0.75 as needing careful review. */
  confidence: number;
}

export interface MedicationOcrResult {
  provider: string;
  rawText: string;
  fields: {
    name?: OcrField;
    brandName?: OcrField;
    genericName?: OcrField;
    strengthValue?: OcrField<number>;
    strengthUnit?: OcrField;
    form?: OcrField;
    manufacturer?: OcrField;
    barcode?: OcrField;
    expiryDate?: OcrField;
    instructions?: OcrField;
  };
  /** Detected script, so the confirmation screen can render RTL correctly. */
  language: 'ar' | 'en' | 'mixed' | 'unknown';
}

export interface PrescriptionOcrLine {
  medicationName?: OcrField;
  dosage?: OcrField;
  frequency?: OcrField;
  duration?: OcrField;
  rawLine: string;
}

export interface PrescriptionOcrResult {
  provider: string;
  rawText: string;
  prescriber?: OcrField;
  facility?: OcrField;
  issuedDate?: OcrField;
  lines: PrescriptionOcrLine[];
  language: 'ar' | 'en' | 'mixed' | 'unknown';
}

export interface OcrProvider {
  readonly name: string;
  readMedicationLabel(image: Buffer, contentType: string): Promise<MedicationOcrResult>;
  readPrescription(image: Buffer, contentType: string): Promise<PrescriptionOcrResult>;
}

export interface UploadTicket {
  objectKey: string;
  uploadUrl: string;
  method: 'PUT' | 'POST';
  headers: Record<string, string>;
  expiresAt: string;
}

export interface StorageProvider {
  readonly name: string;
  createUploadTicket(input: {
    objectKey: string;
    contentType: string;
    byteSize: number;
  }): Promise<UploadTicket>;
  createReadUrl(objectKey: string, ttlSeconds: number): Promise<string>;
  /**
   * `expectedBytes` is the size recorded when the server issued the upload
   * lease. Providers compare it to the object actually stored before those
   * bytes may enter OCR. It is optional for non-OCR maintenance callers that
   * have no upload-lease row available.
   */
  getObject(objectKey: string, expectedBytes?: number): Promise<Buffer>;
  deleteObject(objectKey: string): Promise<void>;
}