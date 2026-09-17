import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const capture = readFileSync(join(ROOT, 'apps/mobile/app/medication/capture.tsx'), 'utf8');

describe('medication photo capture on Android', () => {
  it('uses the system camera path instead of mounting the crash-prone embedded CameraView', () => {
    expect(capture).toContain("import * as ImagePicker from 'expo-image-picker'");
    expect(capture).toContain('ImagePicker.launchCameraAsync');
    expect(capture).not.toContain('CameraView');
    expect(capture).not.toContain("loadOptionalModule('expo-camera')");
  });

  it('recovers a picker result when Android destroys MainActivity', () => {
    expect(capture).toContain("Platform.OS !== 'android'");
    expect(capture).toContain('ImagePicker.getPendingResultAsync()');
    expect(capture).toContain('setPhotoUri(asset.uri)');
    expect(capture).toContain('setPhotoMimeType(asset.mimeType ?? null)');
  });
});
