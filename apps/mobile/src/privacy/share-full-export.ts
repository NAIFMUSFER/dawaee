import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import { shareTemporaryExportFile } from './export-file';

/** The full API response is kept intact. Filenames never include patient or
 * account identifiers, and native plaintext files exist only during sharing. */
export async function shareFullExport(payload: unknown, title: string, isCurrent: () => boolean): Promise<boolean> {
  if (!isCurrent()) return false;
  const contents = JSON.stringify(payload, null, 2);
  const fileName = `tadawee-data-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.json`;
  if (Platform.OS !== 'web') return shareTemporaryExportFile({
    fileSystem: { Paths: { cache: FileSystem.Paths.cache.uri }, File: FileSystem.File },
    sharing: Sharing, contents, fileName, dialogTitle: title, isCurrent,
  });
  if (typeof document === 'undefined' || document.visibilityState === 'hidden' || !isCurrent()) return false;
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const link = document.createElement('a');
  try {
    link.href = url;
    link.download = fileName;
    link.style.display = 'none';
    document.body.append(link);
    if (!isCurrent()) return false;
    link.click();
    return true;
  } finally {
    link.remove();
    // Let the browser consume the click before releasing its opaque blob URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
