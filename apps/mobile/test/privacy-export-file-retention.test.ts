import { describe, expect, it } from 'vitest';
import {
  shareTemporaryExportFile,
  type ExportFileSystemModule,
  type ExportSharingModule,
} from '../src/privacy/export-file.js';

function fileSystemHarness(events: string[]) {
  const cache = { kind: 'cache' };
  const fileSystem: ExportFileSystemModule = {
    Paths: { cache },
    File: class {
      uri = 'file:///cache/dawaee-export.json';
      constructor(base: unknown, name: string) {
        expect(base).toBe(cache);
        events.push(`construct:${name}`);
      }
      write(contents: string) { events.push(`write:${contents}`); }
      delete() { events.push('delete'); }
    },
  };
  return fileSystem;
}

describe('privacy export temporary-file retention boundary', () => {
  it('writes to cache and deletes the plaintext export after a successful share', async () => {
    const events: string[] = [];
    const fileSystem = fileSystemHarness(events);
    const sharing: ExportSharingModule = {
      isAvailableAsync: async () => true,
      shareAsync: async (url, options) => {
        events.push(`share:${url}:${options?.mimeType}`);
      },
    };

    await expect(shareTemporaryExportFile({
      fileSystem,
      sharing,
      fileName: 'dawaee-export-profile.json',
      contents: '{"medical":"private"}',
      dialogTitle: 'Export',
    })).resolves.toBe(true);

    expect(events).toEqual([
      'construct:dawaee-export-profile.json',
      'write:{"medical":"private"}',
      'share:file:///cache/dawaee-export.json:application/json',
      'delete',
    ]);
  });

  it('deletes the plaintext export even when the native share operation fails', async () => {
    const events: string[] = [];
    const fileSystem = fileSystemHarness(events);
    const sharing: ExportSharingModule = {
      isAvailableAsync: async () => true,
      shareAsync: async () => {
        events.push('share-failed');
        throw new Error('synthetic share failure');
      },
    };

    await expect(shareTemporaryExportFile({
      fileSystem,
      sharing,
      fileName: 'dawaee-export-profile.json',
      contents: '{"medical":"private"}',
      dialogTitle: 'Export',
    })).rejects.toThrow('synthetic share failure');

    expect(events.at(-1)).toBe('delete');
  });

  it('does not create a plaintext file when native file sharing is unavailable', async () => {
    const events: string[] = [];
    const fileSystem = fileSystemHarness(events);
    const sharing: ExportSharingModule = {
      isAvailableAsync: async () => false,
      shareAsync: async () => { throw new Error('must not run'); },
    };

    await expect(shareTemporaryExportFile({
      fileSystem,
      sharing,
      fileName: 'dawaee-export-profile.json',
      contents: '{"medical":"private"}',
      dialogTitle: 'Export',
    })).resolves.toBe(false);
    expect(events).toEqual([]);
  });
});
