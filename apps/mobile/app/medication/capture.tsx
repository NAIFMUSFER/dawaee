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
import {
  clearMedicationDrafts,
  setMedicationConfirmDraft,
  type MedicationConfirmDraft,
} from '@/storage/medication-draft';
import type { MessageKey } from '@dawaee/shared';

type CaptureMode = 'photo' | 'upload' | 'barcode' | 'prescription';

const MODES: ReadonlySet<string> = new Set(['photo', 'upload', 'barcode', 'prescription']);
const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);

function resolveImageContentType(blobType: string, pickerMimeType?: string | null): string | null {
  const normalizedBlob = blobType.trim().toLowerCase();
  if (normalizedBlob && ALLOWED_CONTENT_TYPES.has(normalizedBlob)) return normalizedBlob;

  const normalizedPicker = pickerMimeType?.trim().toLowerCase() ?? '';
  if (normalizedPicker) return ALLOWED_CONTENT_TYPES.has(normalizedPicker) ? normalizedPicker : null;

  // Android camera results can omit MIME metadata. ImagePicker's camera output
  // is an image, and JPEG is its interoperable fallback when neither source
  // reports a conflicting type.
  return normalizedBlob ? null : 'image/jpeg';
}

interface OcrField { value: string | number; confidence: number }
interface MedicationLabelResponse {
  kind: 'medication_label';
  language: string;
  detected: Record<string, OcrField | undefined>;
  rawText: string;
}
interface PrescriptionLine {
  medicationName?: OcrField;
  dosage?: OcrField;
  frequency?: OcrField;
  duration?: OcrField;
  rawLine: string;
}
interface PrescriptionResponse {
  kind: 'prescription';
  language: string;
  lines: PrescriptionLine[];
  rawText: string;
}
type OcrResponse = MedicationLabelResponse | PrescriptionResponse;
interface UploadTicketResponse {
  objectKey: string;
  upload: { uploadUrl: string; method: 'PUT' | 'POST'; headers: Record<string, string>; expiresAt: string };
}

function field(source: OcrField | undefined): { value: string; confidence: number } | null {
  if (!source) return null;
  const value = typeof source.value === 'number' ? String(source.value) : source.value.trim();
  if (!value) return null;
  return { value, confidence: source.confidence };
}

function fromLabel(response: MedicationLabelResponse): MedicationConfirmDraft['detected'] {
  const keys = ['name', 'brandName', 'genericName', 'form', 'strengthValue', 'strengthUnit', 'manufacturer', 'barcode', 'expiryDate', 'instructions'] as const;
  const detected: MedicationConfirmDraft['detected'] = {};
  for (const key of keys) {
    const parsed = field(response.detected[key]);
    if (parsed) detected[key] = parsed;
  }
  return detected;
}

function fromPrescription(response: PrescriptionResponse): MedicationConfirmDraft['detected'] {
  const first = response.lines[0];
  if (!first) return {};
  const detected: MedicationConfirmDraft['detected'] = {};
  const name = field(first.medicationName);
  if (name) detected.name = name;
  const parts = [field(first.dosage), field(first.frequency), field(first.duration)]
    .filter((part): part is { value: string; confidence: number } => part !== null);
  if (parts.length > 0) {
    detected.instructions = {
      value: parts.map((part) => part.value).join(' · '),
      confidence: Math.min(...parts.map((part) => part.confidence)),
    };
  }
  return detected;
}

type Stage = 'preview' | 'working' | 'consent';

export default function CaptureScreen() {
  const { user, activeProfile } = useApp();
  return <CaptureProfileScreen key={profileScopeKey(user?.id, activeProfile)} />;
}

function CaptureProfileScreen() {
  const params = useLocalSearchParams<{ mode?: string }>();
  const mode: CaptureMode = MODES.has(params.mode ?? '') ? (params.mode as CaptureMode) : 'photo';
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

  // Android may destroy MainActivity while the system camera/gallery owns the
  // screen. Expo persists the picker result specifically for this case. Recover
  // it on remount instead of making a successful photo look like an app crash.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    let alive = true;
    void ImagePicker.getPendingResultAsync().then((pending) => {
      if (!alive || !pending || 'code' in pending || pending.canceled) return;
      const asset = pending.assets?.[0];
      if (!asset) return;
      setPhotoUri(asset.uri);
      setPhotoMimeType(asset.mimeType ?? null);
      setStage('preview');
    }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const failWith = useCallback((err: unknown) => {
    if (err instanceof NetworkError) {
      setOffline(true);
      setError(t('notifications.offlineBanner'));
      return;
    }
    if (err instanceof ApiError) {
      const key = `error.${err.code}` as MessageKey;
      const message = t(key);
      setError(message === key ? t('capture.failed') : message);
      return;
    }
    setError(t('capture.failed'));
  }, [setOffline, t]);

  const analyze = useCallback(async (key: string) => {
    if (!activeProfile) return;
    const isCurrent = captureAction();
    if (!isCurrent()) return;
    const patientProfileId = activeProfile.id;
    setBusyLabel(t('capture.analyzing'));
    setStage('working');
    try {
      const response = await api.post<OcrResponse>('/v1/ocr/analyze', {
        imageKey: key,
        patientProfileId,
        kind: mode === 'prescription' ? 'prescription' : 'medication_label',
      });
      if (!isCurrent()) return;
      const payload: MedicationConfirmDraft = response.kind === 'prescription'
        ? {
            patientProfileId,
            imageKey: key,
            kind: 'prescription',
            detected: fromPrescription(response),
            remainingLines: Math.max(0, response.lines.length - 1),
          }
        : {
            patientProfileId,
            imageKey: key,
            kind: 'medication_label',
            detected: fromLabel(response),
            remainingLines: 0,
          };
      setMedicationConfirmDraft(payload);
      router.replace('/medication/confirm');
    } catch (err) {
      if (!isCurrent()) return;
      if (err instanceof ApiError && err.code === 'consent_required') {
        setStage('consent');
        return;
      }
      failWith(err);
      setStage('preview');
    } finally {
      if (isCurrent()) setBusyLabel(null);
    }
  }, [activeProfile, captureAction, failWith, mode, t]);

  const uploadAndAnalyze = useCallback(async (uri: string, pickerMimeType?: string | null) => {
    if (!activeProfile) return;
    const isCurrent = captureAction();
    if (!isCurrent()) return;
    const patientProfileId = activeProfile.id;
    setError(null);
    setBusyLabel(t('capture.uploading'));
    setStage('working');
    try {
      const blob = await (await fetch(uri)).blob();
      if (!isCurrent()) return;
      const contentType = resolveImageContentType(blob.type, pickerMimeType);
      if (!contentType) throw new ApiError('upload_rejected', 400, 'Unsupported image type');
      const ticket = await api.post<UploadTicketResponse>('/v1/uploads/request', {
        purpose: mode === 'prescription' ? 'prescription_image' : 'medication_image',
        contentType,
        byteSize: blob.size,
        patientProfileId,
      });
      if (!isCurrent()) return;
      const put = await fetch(ticket.upload.uploadUrl, {
        method: ticket.upload.method,
        headers: ticket.upload.headers,
        body: blob,
      });
      if (!isCurrent()) return;
      if (!put.ok) throw new ApiError('upload_rejected', put.status, 'upload failed');
      await api.post('/v1/uploads/finalize', { objectKey: ticket.objectKey });
      if (!isCurrent()) return;
      setImageKey(ticket.objectKey);
      await analyze(ticket.objectKey);
    } catch (err) {
      if (!isCurrent()) return;
      failWith(err);
      setStage('preview');
      setBusyLabel(null);
    }
  }, [activeProfile, analyze, captureAction, failWith, mode, t]);

  const takePhoto = useCallback(async () => {
    const isCurrent = captureAction();
    if (!isCurrent()) return;
    setError(null);
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!isCurrent()) return;
      if (!permission.granted) {
        setError(t('capture.permissionBody'));
        return;
      }
      const result = await ImagePicker.launchCameraAsync({ quality: 0.7, mediaTypes: ['images'] });
      if (!isCurrent() || result.canceled) return;
      const asset = result.assets?.[0];
      if (!asset) return;
      setPhotoUri(asset.uri);
      setPhotoMimeType(asset.mimeType ?? null);
      setStage('preview');
    } catch {
      if (isCurrent()) setError(t('capture.failed'));
    }
  }, [captureAction, t]);

  const pickImage = useCallback(async () => {
    const isCurrent = captureAction();
    if (!isCurrent()) return;
    setError(null);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!isCurrent()) return;
      if (!permission.granted) {
        setError(t('capture.permissionBody'));
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.7, mediaTypes: ['images'] });
      if (!isCurrent() || result.canceled) return;
      const asset = result.assets?.[0];
      if (!asset) return;
      setPhotoUri(asset.uri);
      setPhotoMimeType(asset.mimeType ?? null);
      await uploadAndAnalyze(asset.uri, asset.mimeType);
    } catch {
      if (isCurrent()) setError(t('capture.failed'));
    }
  }, [captureAction, t, uploadAndAnalyze]);

  const grantConsent = useCallback(async () => {
    if (!activeProfile) return;
    const isCurrent = captureAction();
    if (!isCurrent()) return;
    setBusyLabel(t('capture.analyzing'));
    try {
      await api.put('/v1/me/consents', {
        type: 'ocr_image_processing',
        granted: true,
        version: '1.0',
        patientProfileId: activeProfile.id,
      });
      if (!isCurrent()) return;
      if (imageKey) await analyze(imageKey);
    } catch (err) {
      if (!isCurrent()) return;
      failWith(err);
      setStage('preview');
    } finally {
      if (isCurrent()) setBusyLabel(null);
    }
  }, [activeProfile, analyze, captureAction, failWith, imageKey, t]);

  const goManual = useCallback(() => {
    clearMedicationDrafts();
    router.replace('/medication/quick-create');
  }, []);

  const cancelCapture = useCallback(() => {
    clearMedicationDrafts();
    router.back();
  }, []);

  const instructionKey: MessageKey = mode === 'barcode'
    ? 'capture.instructionBarcode'
    : mode === 'prescription'
      ? 'capture.instructionPrescription'
      : 'capture.instructionLabel';
  const titleKey: MessageKey = mode === 'barcode'
    ? 'medication.scanBarcode'
    : mode === 'prescription'
      ? 'medication.scanPrescription'
      : mode === 'upload'
        ? 'medication.uploadImage'
        : 'medication.takePhoto';

  const manualEntry = <Button label={t('medication.manualEntry')} tone="secondary" onPress={goManual} />;

  if (stage === 'working') {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <Screen>
          <Txt variant="h2" weight="bold" accessibilityRole="header">{t(titleKey)}</Txt>
          <Loading label={busyLabel ?? t('common.loading')} />
        </Screen>
      </SafeAreaView>
    );
  }

  if (stage === 'consent') {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <Screen>
          <Txt variant="h2" weight="bold" accessibilityRole="header">{t('consent.ocrTitle')}</Txt>
          <Card><Txt variant="body">{t('consent.ocrBody')}</Txt></Card>
          <Button label={t('consent.grant')} size="large" onPress={() => void grantConsent()} />
          <Button label={t('consent.decline')} tone="secondary" onPress={goManual} />
          <Button label={t('common.cancel')} tone="ghost" onPress={cancelCapture} />
        </Screen>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <Txt variant="h2" weight="bold" accessibilityRole="header">{t(titleKey)}</Txt>
        <Txt variant="body" color={theme.colors.ink500}>{t(instructionKey)}</Txt>
        {error ? <Banner tone="danger" title={error} body={t('capture.unavailableBody')} /> : null}
        {mode === 'upload' ? (
          <Button label={t('capture.chooseFile')} size="large" onPress={() => void pickImage()} />
        ) : photoUri ? (
          <>
            <Button
              label={t('capture.use')}
              size="large"
              onPress={() => void uploadAndAnalyze(photoUri, photoMimeType)}
            />
            <Button
              label={t('capture.retake')}
              tone="secondary"
              onPress={() => { setPhotoUri(null); setPhotoMimeType(null); void takePhoto(); }}
            />
          </>
        ) : (
          <Button label={t('capture.shutter')} size="large" onPress={() => void takePhoto()} testID="capture-shutter" />
       