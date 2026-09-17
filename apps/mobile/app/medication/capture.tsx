import React, { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner, Button, Card, Loading, Screen, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { profileScopeKey, useRequestScope } from '@/hooks/useRequestScope';
import { api, ApiError, NetworkError } from '@/api/client';
import { clearMedicationDrafts, setMedicationConfirmDraft, type MedicationConfirmDraft } from '@/storage/medication-draft';
import type { MessageKey } from '@dawaee/shared';

type CaptureMode = 'photo' | 'upload' | 'barcode' | 'prescription';
type Stage = 'preview' | 'working' | 'consent';
interface OcrField { value: string | number; confidence: number; confidenceSource?: 'heuristic' | 'provider' }
interface LabelResponse { kind: 'medication_label'; detected: Record<string, OcrField | undefined> }
interface PrescriptionLine { medicationName?: OcrField; dosage?: OcrField; frequency?: OcrField; duration?: OcrField }
interface PrescriptionResponse { kind: 'prescription'; lines: PrescriptionLine[] }
type OcrResponse = (LabelResponse | PrescriptionResponse) & { rawText?: string };
interface UploadTicket { objectKey: string; upload: { uploadUrl: string; method: 'PUT' | 'POST'; headers: Record<string, string> } }

const MODES = new Set<string>(['photo', 'upload', 'barcode', 'prescription']);
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);

function imageType(blobType: string, pickerType?: string | null): string | null {
  const blob = blobType.trim().toLowerCase();
  if (blob && IMAGE_TYPES.has(blob)) return blob;
  const picker = pickerType?.trim().toLowerCase() ?? '';
  if (picker) return IMAGE_TYPES.has(picker) ? picker : null;
  return blob ? null : 'image/jpeg';
}

function field(source?: OcrField): { value: string; confidence: number; confidenceSource?: 'heuristic' | 'provider' } | null {
  if (!source) return null;
  const value = typeof source.value === 'number' ? String(source.value) : source.value.trim();
  return value ? { value, confidence: source.confidence, confidenceSource: source.confidenceSource } : null;
}

function detected(response: OcrResponse): MedicationConfirmDraft['detected'] {
  const out: MedicationConfirmDraft['detected'] = {};
  if (response.kind === 'medication_label') {
    for (const key of ['name', 'brandName', 'genericName', 'form', 'strengthValue', 'strengthUnit', 'manufacturer', 'barcode', 'expiryDate', 'instructions'] as const) {
      const value = field(response.detected[key]);
      if (value) out[key] = value;
    }
    return out;
  }
  const first = response.lines[0];
  if (!first) return out;
  const name = field(first.medicationName);
  if (name) out.name = name;
  const parts = [field(first.dosage), field(first.frequency), field(first.duration)].filter((v): v is { value: string; confidence: number; confidenceSource?: 'heuristic' | 'provider' } => v !== null);
  if (parts.length) out.instructions = { value: parts.map((v) => v.value).join(' · '), confidence: Math.min(...parts.map((v) => v.confidence)), confidenceSource: 'heuristic' };
  return out;
}

export default function CaptureScreen() {
  const { user, activeProfile } = useApp();
  return <CaptureProfileScreen key={profileScopeKey(user?.id, activeProfile)} />;
}

function CaptureProfileScreen() {
  const params = useLocalSearchParams<{ mode?: string }>();
  const mode: CaptureMode = MODES.has(params.mode ?? '') ? params.mode as CaptureMode : 'photo';
  const { t } = useI18n();
  const theme = useTheme();
  const { activeProfile, setOffline } = useApp();
  const { capture: captureAction } = useRequestScope();
  const [stage, setStage] = useState<Stage>('preview');
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [photoMimeType, setPhotoMimeType] = useState<string | null>(null);
  const [imageKey, setImageKey] = useState<string | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    let alive = true;
    void ImagePicker.getPendingResultAsync().then((pending) => {
      if (!alive || !pending || 'code' in pending || pending.canceled) return;
      const asset = pending.assets?.[0];
      if (!asset) return;
      setPhotoUri(asset.uri);
      setPhotoMimeType(asset.mimeType ?? null);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const failWith = useCallback((err: unknown) => {
    if (err instanceof NetworkError) {
      setOffline(true);
      setError(t('notifications.offlineBanner'));
    } else if (err instanceof ApiError) {
      const key = `error.${err.code}` as MessageKey;
      const message = t(key);
      setError(message === key ? t('capture.failed') : message);
    } else setError(t('capture.failed'));
  }, [setOffline, t]);

  const analyze = useCallback(async (key: string) => {
    if (!activeProfile) return;
    const current = captureAction();
    if (!current()) return;
    const patientProfileId = activeProfile.id;
    setBusyLabel(t('capture.analyzing'));
    setStage('working');
    try {
      // Provider deadline is 25s, plus bounded private-storage and API work.
      // A 15s generic API timeout used to abandon valid OCR work prematurely.
      const response = await api.post<OcrResponse>('/v1/ocr/analyze', { imageKey: key, patientProfileId, kind: mode === 'prescription' ? 'prescription' : 'medication_label' }, undefined, { timeoutMs: 45_000 });
      if (!current()) return;
      setMedicationConfirmDraft({
        patientProfileId,
        imageKey: key,
        kind: response.kind,
        detected: detected(response),
        remainingLines: response.kind === 'prescription' ? Math.max(0, response.lines.length - 1) : 0,
        ...(typeof response.rawText === 'string' && response.rawText ? { rawText: response.rawText } : {}),
      });
      router.replace('/medication/confirm');
    } catch (err) {
      if (!current()) return;
      if (err instanceof ApiError && err.code === 'consent_required') setStage('consent');
      else { failWith(err); setStage('preview'); }
    } finally { if (current()) setBusyLabel(null); }
  }, [activeProfile, captureAction, failWith, mode, t]);

  const uploadAndAnalyze = useCallback(async (uri: string, pickerType?: string | null) => {
    if (!activeProfile) return;
    const current = captureAction();
    if (!current()) return;
    setError(null);
    setBusyLabel(t('capture.uploading'));
    setStage('working');
    try {
      const blob = await (await fetch(uri)).blob();
      if (!current()) return;
      const contentType = imageType(blob.type, pickerType);
      if (!contentType) throw new ApiError('upload_rejected', 400, 'Unsupported image type');
      const ticket = await api.post<UploadTicket>('/v1/uploads/request', {
        purpose: mode === 'prescription' ? 'prescription_image' : 'medication_image',
        contentType,
        byteSize: blob.size,
        patientProfileId: activeProfile.id,
      });
      if (!current()) return;
      const controller = new AbortController();
      const uploadTimeout = setTimeout(() => controller.abort(), 45_000);
      let uploaded: Response;
      try {
        uploaded = await fetch(ticket.upload.uploadUrl, { method: ticket.upload.method, headers: ticket.upload.headers, body: blob, signal: controller.signal });
      } catch {
        throw new ApiError('upload_failed', 503, 'Image upload did not complete');
      } finally { clearTimeout(uploadTimeout); }
      if (!current()) return;
      if (!uploaded.ok) throw new ApiError('upload_failed', uploaded.status, 'Image upload did not complete');
      await api.post('/v1/uploads/finalize', { objectKey: ticket.objectKey });
      if (!current()) return;
      setImageKey(ticket.objectKey);
      await analyze(ticket.objectKey);
    } catch (err) {
      if (!current()) return;
      failWith(err);
      setStage('preview');
      setBusyLabel(null);
    }
  }, [activeProfile, analyze, captureAction, failWith, mode, t]);

  const takePhoto = useCallback(async () => {
    const current = captureAction();
    if (!current()) return;
    setError(null);
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!current()) return;
      if (!permission.granted) { setError(t('capture.permissionBody')); return; }
      const result = await ImagePicker.launchCameraAsync({ quality: 0.7, mediaTypes: ['images'] });
      if (!current() || result.canceled) return;
      const asset = result.assets?.[0];
      if (!asset) return;
      setPhotoUri(asset.uri);
      setPhotoMimeType(asset.mimeType ?? null);
    } catch { if (current()) setError(t('capture.failed')); }
  }, [captureAction, t]);

  const pickImage = useCallback(async () => {
    const current = captureAction();
    if (!current()) return;
    setError(null);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!current()) return;
      if (!permission.granted) { setError(t('capture.permissionBody')); return; }
      const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.7, mediaTypes: ['images'] });
      if (!current() || result.canceled) return;
      const asset = result.assets?.[0];
      if (!asset) return;
      setPhotoUri(asset.uri);
      setPhotoMimeType(asset.mimeType ?? null);
      await uploadAndAnalyze(asset.uri, asset.mimeType);
    } catch { if (current()) setError(t('capture.failed')); }
  }, [captureAction, t, uploadAndAnalyze]);

  const grantConsent = useCallback(async () => {
    if (!activeProfile) return;
    const current = captureAction();
    if (!current()) return;
    setBusyLabel(t('capture.analyzing'));
    try {
      await api.put('/v1/me/consents', { type: 'ocr_image_processing', granted: true, version: '1.0', patientProfileId: activeProfile.id });
      if (current() && imageKey) await analyze(imageKey);
    } catch (err) { if (current()) { failWith(err); setStage('preview'); } }
    finally { if (current()) setBusyLabel(null); }
  }, [activeProfile, analyze, captureAction, failWith, imageKey, t]);

  const goManual = useCallback(() => { clearMedicationDrafts(); router.replace('/medication/quick-create'); }, []);
  const cancelCapture = useCallback(() => { clearMedicationDrafts(); router.back(); }, []);
  const instructionKey: MessageKey = mode === 'barcode' ? 'capture.instructionBarcode' : mode === 'prescription' ? 'capture.instructionPrescription' : 'capture.instructionLabel';
  const titleKey: MessageKey = mode === 'barcode' ? 'medication.scanBarcode' : mode === 'prescription' ? 'medication.scanPrescription' : mode === 'upload' ? 'medication.uploadImage' : 'medication.takePhoto';

  if (stage === 'working') return <SafeAreaView style={{ flex: 1 }}><Screen><Txt variant="h2" weight="bold">{t(titleKey)}</Txt><Loading label={busyLabel ?? t('common.loading')} /></Screen></SafeAreaView>;
  if (stage === 'consent') return <SafeAreaView style={{ flex: 1 }}><Screen><Txt variant="h2" weight="bold">{t('consent.ocrTitle')}</Txt><Card><Txt variant="body">{t('consent.ocrBody')}</Txt></Card><Button label={t('consent.grant')} size="large" onPress={() => void grantConsent()} /><Button label={t('consent.decline')} tone="secondary" onPress={goManual} /><Button label={t('common.cancel')} tone="ghost" onPress={cancelCapture} /></Screen></SafeAreaView>;

  return <SafeAreaView style={{ flex: 1 }}><Screen>
    <Txt variant="h2" weight="bold">{t(titleKey)}</Txt>
    <Txt variant="body" color={theme.colors.ink500}>{t(instructionKey)}</Txt>
    {error ? <Banner tone="danger" title={error} body={t('capture.unavailableBody')} /> : null}
    {mode === 'upload'
      ? <Button label={t('capture.chooseFile')} size="large" onPress={() => void pickImage()} />
      : photoUri
        ? <><Button label={t('capture.use')} size="large" onPress={() => void uploadAndAnalyze(photoUri, photoMimeType)} /><Button label={t('capture.retake')} tone="secondary" onPress={() => { setPhotoUri(null); setPhotoMimeType(null); void takePhoto(); }} /></>
        : <Button label={t('capture.shutter')} size="large" onPress={() => void takePhoto()} testID="capture-shutter" />}
    <Button label={t('medication.manualEntry')} tone="secondary" onPress={goManual} />
    <Button label={t('common.cancel')} tone="ghost" onPress={cancelCapture} />
  </Screen></SafeAreaView>;
}
