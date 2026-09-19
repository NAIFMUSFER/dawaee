import { api, ApiError } from '@/api/client';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);
interface UploadTicket { objectKey: string; upload: { uploadUrl: string; method: 'PUT' | 'POST'; headers: Record<string, string> } }

/** Upload and finalize a private photo independently of optional OCR. A stale
 * account/profile must never continue a lease or attach its result elsewhere. */
export async function uploadMedicationImage(input: {
  uri: string; mimeType?: string | null; patientProfileId: string;
  purpose?: 'medication_image' | 'prescription_image'; isCurrent: () => boolean;
}): Promise<string | null> {
  if (!input.isCurrent()) return null;
  const blob = await (await fetch(input.uri)).blob();
  if (!input.isCurrent()) return null;
  const blobType = blob.type.trim().toLowerCase();
  const pickerType = input.mimeType?.trim().toLowerCase() ?? '';
  const contentType = blobType && IMAGE_TYPES.has(blobType) ? blobType : pickerType || blobType || 'image/jpeg';
  if (!IMAGE_TYPES.has(contentType)) throw new ApiError('upload_rejected', 400, 'Unsupported image type');
  const ticket = await api.post<UploadTicket>('/v1/uploads/request', {
    purpose: input.purpose ?? 'medication_image', contentType, byteSize: blob.size,
    patientProfileId: input.patientProfileId,
  });
  if (!input.isCurrent()) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  let uploaded: Response;
  try {
    uploaded = await fetch(ticket.upload.uploadUrl, {
      method: ticket.upload.method, headers: ticket.upload.headers, body: blob, signal: controller.signal,
    });
  } catch {
    throw new ApiError('upload_failed', 503, 'Image upload did not complete');
  } finally { clearTimeout(timeout); }
  if (!input.isCurrent()) return null;
  if (!uploaded.ok) throw new ApiError('upload_failed', uploaded.status, 'Image upload did not complete');
  await api.post('/v1/uploads/finalize', { objectKey: ticket.objectKey });
  return input.isCurrent() ? ticket.objectKey : null;
}
