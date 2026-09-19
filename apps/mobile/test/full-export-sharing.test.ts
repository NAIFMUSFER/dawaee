import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ platform: { OS: 'ios' }, write: vi.fn(), remove: vi.fn(), share: vi.fn() }));
vi.mock('react-native', () => ({ Platform: io.platform }));
vi.mock('expo-sharing', () => ({ isAvailableAsync: async () => true, shareAsync: io.share }));
vi.mock('expo-file-system', () => ({ Paths: { cache: { uri: 'file:///cache' } }, File: class {
  uri: string;
  constructor(_base: unknown, name: string) { this.uri = `file:///cache/${name}`; }
  write(value: string) { io.write(value); }
  delete() { io.remove(); }
} }));
const { shareFullExport } = await import('../src/privacy/share-full-export.js');
const payload = { profileId: 'synthetic-private-id', data: {
  doseEvents: [{ event_type: 'snoozed' }], auditLog: [{ action: 'changed' }],
  refills: [{ quantity_added: 5 }], stockTransactions: [{ delta: -1 }], futureSection: [{ record: 'kept' }],
} };
beforeEach(() => { vi.clearAllMocks(); io.platform.OS = 'ios'; });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('complete patient export output', () => {
  it('preserves every API section and field in the native JSON file and deletes the temporary copy', async () => {
    expect(await shareFullExport(payload, 'Full copy', () => true)).toBe(true);
    expect(JSON.parse(io.write.mock.calls[0]![0])).toEqual(payload);
    expect(io.share).toHaveBeenCalledWith(expect.stringMatching(/^file:\/\/\/cache\/tadawee-data-[a-z0-9-]+\.json$/),
      expect.objectContaining({ mimeType: 'application/json' }));
    expect(io.share.mock.calls[0]![0]).not.toContain(payload.profileId);
    expect(io.remove).toHaveBeenCalledOnce();
  });
  it('downloads the complete JSON in the browser using an opaque blob URL and releases it', async () => {
    io.platform.OS = 'web'; vi.useFakeTimers();
    const link = { href: '', download: '', style: { display: '' }, click: vi.fn(), remove: vi.fn() };
    const create = vi.fn(() => 'blob:opaque-local-reference');
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
    vi.stubGlobal('document', { visibilityState: 'visible', createElement: () => link, body: { append: vi.fn() } });
    expect(await shareFullExport(payload, 'Full copy', () => true)).toBe(true);
    expect(JSON.parse(await (create.mock.calls[0] as unknown as [Blob])[0].text())).toEqual(payload);
    expect(link.download).toMatch(/^tadawee-data-[a-z0-9-]+\.json$/);
    expect(link.href).toBe('blob:opaque-local-reference');
    expect(link.click).toHaveBeenCalledOnce(); expect(link.remove).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync(); expect(revoke).toHaveBeenCalledWith(link.href);
    expect(io.write).not.toHaveBeenCalled();
  });
  it('does not create a browser blob or native file when locked or hidden', async () => {
    expect(await shareFullExport(payload, 'Full copy', () => false)).toBe(false);
    io.platform.OS = 'web';
    const create = vi.fn(); vi.stubGlobal('URL', { createObjectURL: create });
    vi.stubGlobal('document', { visibilityState: 'hidden' });
    expect(await shareFullExport(payload, 'Full copy', () => true)).toBe(false);
    expect(create).not.toHaveBeenCalled(); expect(io.write).not.toHaveBeenCalled();
  });
});
