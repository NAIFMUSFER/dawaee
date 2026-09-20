export interface ExportFileSystemModule {
  Paths: { cache: string };
  File: new (base: string, name: string) => {
    uri: string;
    write: (contents: string) => void;
    delete: () => void;
  };
}

export interface ExportSharingModule {
  isAvailableAsync: () => Promise<boolean>;
  shareAsync: (
    url: string,
    options?: { mimeType?: string; dialogTitle?: string; UTI?: string },
  ) => Promise<void>;
}

/**
 * Share one sensitive export without turning it into durable app storage.
 *
 * A PDPL export contains the patient's full record. It exists only long enough
 * for the native share sheet to consume it, so it belongs in the OS cache, not
 * the app document directory. The cleanup lives in `finally`: cancellation,
 * provider failure, and a successful share all converge on deleting the local
 * plaintext copy.
 */
export async function shareTemporaryExportFile(input: {
  fileSystem: ExportFileSystemModule | null;
  sharing: ExportSharingModule | null;
  fileName: string;
  contents: string;
  dialogTitle: string;
  isCurrent: () => boolean;
}): Promise<boolean> {
  const { fileSystem, sharing, fileName, contents, dialogTitle, isCurrent } = input;
  if (!isCurrent()) return false;
  if (!fileSystem?.Paths?.cache || !fileSystem.File || !sharing) return false;
  if (!(await sharing.isAvailableAsync())) return false;
  if (!isCurrent()) return false;

  const file = new fileSystem.File(fileSystem.Paths.cache, fileName);
  try {
    file.write(contents);
    if (!isCurrent()) return false;
    await sharing.shareAsync(file.uri, {
      mimeType: 'application/json',
      dialogTitle,
    });
    return true;
  } finally {
    // Cleanup is best effort because a failed delete must not replace the real
    // share error. The regression suite verifies this branch executes after
    // both success and failure.
    try { file.delete(); } catch { /* best effort */ }
  }
}
