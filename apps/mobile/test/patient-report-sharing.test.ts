import { beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ print: vi.fn(), share: vi.fn(), remove: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-print', () => ({ printToFileAsync: io.print }));
vi.mock('expo-sharing', () => ({ isAvailableAsync: async () => true, shareAsync: io.share }));
vi.mock('expo-file-system', () => ({ File: class { delete() { io.remove(); } } }));
const { sharePatientReport } = await import('../src/privacy/share-patient-report.js');
beforeEach(() => { vi.clearAllMocks(); io.print.mockResolvedValue({ uri: 'file:///cache/report.pdf' }); io.share.mockResolvedValue(undefined); });
describe('patient PDF sharing', () => {
  it('shares a PDF and removes the temporary file', async () => {
    expect(await sharePatientReport('<p>record</p>', 'Report', () => true)).toBe(true);
    expect(io.share).toHaveBeenCalledWith('file:///cache/report.pdf', expect.objectContaining({ mimeType: 'application/pdf' }));
    expect(io.remove).toHaveBeenCalledOnce();
  });
  it('removes the file without sharing after a profile switch during PDF generation', async () => {
    let current = true;
    io.print.mockImplementationOnce(async () => { current = false; return { uri: 'file:///cache/report.pdf' }; });
    expect(await sharePatientReport('<p>record</p>', 'Report', () => current)).toBe(false);
    expect(io.share).not.toHaveBeenCalled(); expect(io.remove).toHaveBeenCalledOnce();
  });
  it('cleans up when the share sheet fails', async () => {
    io.share.mockRejectedValueOnce(new Error('share failed'));
    await expect(sharePatientReport('<p>record</p>', 'Report', () => true)).rejects.toThrow('share failed');
    expect(io.remove).toHaveBeenCalledOnce();
  });
});
