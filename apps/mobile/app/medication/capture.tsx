import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
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

interface CapturedPhoto { uri: string }
interface CameraHandle { takePictureAsync(options: { quality: number }): Promise<CapturedPhoto | undefined>; }
interface CameraViewProps {
  style?: StyleProp<ViewStyle>;
  facing?: 'back' | 'front';
  ref?: React.MutableRefObject<CameraHandle | null>;
}
interface CameraModule {
  CameraView: React.FunctionComponent<CameraViewProps>;
  requestCameraPermissionsAsync?: () => Promise<{ granted: boolean }>;
  getCameraPermissionsAsync?: () => Promise<{ granted: boolean }>;
}
interface PickedAsset { uri: string; mimeType?: string | null }
interface ImagePickerModule {
  launchImageLibraryAsync(options: { quality: number; mediaTypes: string[] }): Promise<{ canceled: boolean; assets?: PickedAsset[] | null }>;
  requestMediaLibraryPermissionsAsync(): Promise<{ granted: boolean }>;
}

function loadOptionalModule(name: string): unknown {
  if (Platform.OS === 'web') return null;
  try {
    const resolve = require as unknown as (id: string) => unknown;
    return resolve(name);
  } catch {
    return null;
  }
}

function loadCamera(): CameraModule | null {
  const mod = loadOptionalModule('expo-camera');
  if (mod && typeof mod === 'object' && 'CameraView' in mod) return mod as CameraModule;
  return null;
}

function loadImagePicker(): ImagePickerModule | null {
  const mod = loadOptionalModule('expo-image-picker');
  if (mod && typeof mod === 'object' && 'launchImageLibraryAsync' in mod) return mod as ImagePickerModule;
  return null;
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

type Stage = 'camera' | 'preview' | 'working' | 'consent' | 'unavailable';

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

  const cameraRef = useRef<CameraHandle | null>(null);
  const [camera] = useState<CameraModule | null>(() => (mode === 'upload' ? null : loadCamera()));
  const [picker] = useState<ImagePickerModule | null>(() => (mode === 'upload' ? loadImagePicker() : null));
  const [stage, setStage] = useState<Stage>(mode === 'upload' ? 'preview' : 'camera');
  const [permissionGranted, setPermissionGranted] = useState<boolean | null>(null);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [imageKey, setImageKey] = useState<string | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const supported = mode === 'upload' ? picker !== null : camera !== null;

  useEffect(() => {
    if (!supported) {
      setStage('unavailable');
      return;
    }
    if (mode === 'upload') return;
    void (async () => {
      const current = await camera?.getCameraPermissionsAsync?.();
      setPermissionGranted(current?.granted ?? false);
    })();
  }, [camera, mode, supported]);

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

  const requestPermission = useCallback(async () => {
    const result = await camera?.requestCameraPermissionsAsync?.();
    setPermissionGranted(result?.granted ?? false);
  }, [camera]);

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
      // Health data stays process-local. Query strings are platform-visible on
      // web and can be copied into browser history, referrers and request logs.
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

  const uploadAndAnalyze = useCallback(async (uri: string) => {
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
      const contentType = ALLOWED_CONTENT_TYPES.has(blob.type) ? blob.type : 'image/jpeg';
      const ticket = await api.post<UploadTicketResponse>('/v1/uploads/request', {
        purpose: mode === 'prescription' ? 'prescription_image' : 'medication_image',
        contentType,
        byteSize: blob.size,
        patientProfileId,
      });
      if (!isCurrent()) return;
      const put = await fetch(ticket.upload.uploadUrl, { method: ticket.upload.method, headers: ticket.upload.headers, body: blob });
      if (!isCurrent()) return;
      if (!put.ok) throw new ApiError('upload_rejected', put.status, 'upload failed');
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
    setError(null);
    try {
      const photo = await cameraRef.current?.takePictureAsync({ quality: 0.7 });
      if (!photo?.uri) {
        setError(t('capture.failed'));
        return;
      }
      setPhotoUri(photo.uri);
      setStage('preview');
    } catch {
      setError(t('capture.failed'));
    }
  }, [t]);

  const pickImage = useCallback(async () => {
    if (!picker) return;
    const isCurrent = captureAction();
    if (!isCurrent()) return;
    setError(null);
    try {
      const permission = await picker.requestMediaLibraryPermissionsAsync();
      if (!isCurrent()) return;
      if (!permission.granted) {
        setError(t('capture.permissionBody'));
        return;
      }
      const result = await picker.launchImageLibraryAsync({ quality: 0.7, mediaTypes: ['images'] });
      if (!isCurrent()) return;
      const asset = result.assets?.[0];
      if (result.canceled || !asset) return;
      setPhotoUri(asset.uri);
      await uploadAndAnalyze(asset.uri);
    } catch {
      if (!isCurrent()) return;
      setError(t('capture.failed'));
    }
  }, [captureAction, picker, t, uploadAndAnalyze]);

  const grantConsent = useCallback(async () => {
    const isCurrent = captureAction();
    if (!isCurrent()) return;
    setBusyLabel(t('capture.analyzing'));
    try {
      await api.put('/v1/me/consents', { type: 'ocr_image_processing', granted: true, version: '1.0' });
      if (!isCurrent()) return;
      if (imageKey) await analyze(imageKey);
    } catch (err) {
      if (!isCurrent()) return;
      failWith(err);
      setStage('preview');
    } finally {
      if (isCurrent()) setBusyLabel(null);
    }
  }, [analyze, captureAction, failWith, imageKey, t]);

  const goManual = useCallback(() => {
    clearMedicationDrafts();
    router.replace('/medication/quick-create');
  }, []);

  const cancelCapture = useCallback(() => {
    clearMedicationDrafts();
    router.back();
  }, []);

  const instructionKey: MessageKey = mode === 'barcode' ? 'capture.instructionBarcode' : mode === 'prescription' ? 'capture.instructionPrescription' : 'capture.instructionLabel';
  const titleKey: MessageKey = mode === 'barcode' ? 'medication.scanBarcode' : mode === 'prescription' ? 'medication.scanPrescription' : mode === 'upload' ? 'medication.uploadImage' : 'medication.takePhoto';

  const manualEntry = (
    <Button label={t('medication.manualEntry')} tone="secondary" onPress={goManual} />
  );

  if (stage === 'working') {
    return <SafeAreaView style={{ flex: 1 }}><Screen><Txt variant="h2" weight="bold" accessibilityRole="header">{t(titleKey)}</Txt><Loading label={busyLabel ?? t('common.loading')} /></Screen></SafeAreaView>;
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

  if (stage === 'unavailable') {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <Screen>
          <Txt variant="h2" weight="bold" accessibilityRole="header">{t(titleKey)}</Txt>
          <Banner tone="info" title={t('capture.unavailableTitle')} body={t('capture.unavailableBody')} />
          {manualEntry}
          <Button label={t('common.back')} tone="ghost" onPress={cancelCapture} />
        </Screen>
      </SafeAreaView>
    );
  }

  if (stage === 'camera' && camera) {
    if (permissionGranted === null) return <SafeAreaView style={{ flex: 1 }}><Loading /></SafeAreaView>;
    if (!permissionGranted) {
      return (
        <SafeAreaView style={{ flex: 1 }}>
          <Screen>
            <Txt variant="h2" weight="bold" accessibilityRole="header">{t('capture.permissionTitle')}</Txt>
            <Txt variant="body" color={theme.colors.ink500}>{t('capture.permissionBody')}</Txt>
            <Button label={t('capture.allowCamera')} size="large" onPress={() => void requestPermission()} />
            {manualEntry}
            <Button label={t('common.back')} tone="ghost" onPress={cancelCapture} />
          </Screen>
        </SafeAreaView>
      );
    }
    const cameraProps: CameraViewProps = { style: { flex: 1, borderRadius: theme.radius.lg, overflow: 'hidden' }, facing: 'back', ref: cameraRef };
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <View style={{ flex: 1, padding: theme.spacing.lg, gap: theme.spacing.md }}>
          <Txt variant="h3" weight="bold" accessibilityRole="header">{t(titleKey)}</Txt>
          <Txt variant="body" color={theme.colors.ink500}>{t(instructionKey)}</Txt>
          <View style={{ flex: 1, borderRadius: theme.radius.lg, overflow: 'hidden', backgroundColor: theme.colors.ink900 }}>{React.createElement(camera.CameraView, cameraProps)}</View>
          {error ? <Banner tone="danger" title={error} /> : null}
          <Button label={t('capture.shutter')} size="large" onPress={() => void takePhoto()} testID="capture-shutter" />
          <Button label={t('common.cancel')} tone="ghost" onPress={cancelCapture} />
        </View>
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
        ) : (
          <>
            <Button label={t('capture.use')} size="large" disabled={!photoUri} onPress={() => { if (photoUri) void uploadAndAnalyze(photoUri); }} />
            <Button label={t('capture.retake')} tone="secondary" onPress={() => { setPhotoUri(null); setStage('camera'); }} />
          </>
        )}
        {manualEntry}
        <Button label={t('common.cancel')} tone="ghost" onPress={cancelCapture} />
      </Screen>
    </SafeAreaView>
  );
}