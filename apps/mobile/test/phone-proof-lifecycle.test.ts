import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';

function setup() {
  const app = { name: '[DEFAULT]', options: {} };
  const auth = { currentUser: null };
  let listener: ((user: unknown) => void) | undefined;
  const io = {
    initializeApp: vi.fn(), deleteApp: vi.fn(), signOut: vi.fn().mockResolvedValue(undefined),
    getIdToken: vi.fn().mockResolvedValue('synthetic-proof'),
    signInWithPhoneNumber: vi.fn(), unsubscribe: vi.fn(),
    emit: (user: unknown) => listener?.(user),
  };
  const imports: Record<string, unknown> = {
    'react-native': { Platform: { OS: 'ios' } },
    'expo-constants': { default: { expoConfig: { ios: { bundleIdentifier: 'app.dawaee.mobile' }, extra: { iosPhoneVerificationEnabled: true } } } },
    '@react-native-firebase/app': { getApp: () => app, initializeApp: io.initializeApp, deleteApp: io.deleteApp },
    '@react-native-firebase/auth': { ...io, getAuth: (value: unknown) => { expect(value).toBe(app); return auth; },
      onAuthStateChanged: (_auth: unknown, fn: typeof listener) => { listener = fn; return io.unsubscribe; } },
  };
  const source = readFileSync(new URL('../src/security/phone-proof.native.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exported: any = {};
  new Function('require', 'exports', code)((id: string) => imports[id], exported);
  return { io, start: exported.startPhoneProof };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe('iOS phone proof lifecycle', () => {
  it('uses configured Auth, delivers one proof for listener + manual completion, then signs out', async () => {
    const { io, start } = setup();
    const user = { phoneNumber: '+966500000001' };
    io.signInWithPhoneNumber.mockResolvedValue({ confirm: async () => ({ user }) });
    const onProof = vi.fn().mockResolvedValue(undefined);
    const challenge = await start(user.phoneNumber, onProof);
    io.emit({ phoneNumber: '+966500000002' });
    expect(io.getIdToken).not.toHaveBeenCalled();
    io.emit(user);
    await challenge.confirm('123456'); await flush();
    expect(io.initializeApp).not.toHaveBeenCalled();
    expect(onProof).toHaveBeenCalledOnce();
    expect(onProof).toHaveBeenCalledWith('synthetic-proof');
    expect(io.unsubscribe).toHaveBeenCalledOnce();
    expect(io.signOut).toHaveBeenCalledOnce();
    expect(io.deleteApp).not.toHaveBeenCalled();
  });

  it('drains a cancelled native confirmation before a new iOS attempt and never delivers its proof', async () => {
    const { io, start } = setup();
    let finish!: (value: unknown) => void;
    const pending = new Promise(resolve => { finish = resolve; });
    io.signInWithPhoneNumber.mockResolvedValue({ confirm: () => pending });
    const onProof = vi.fn();
    const first = await start('+966500000001', onProof);
    const confirming = first.confirm('123456');
    first.cancel();
    const second = start('+966500000002', vi.fn());
    await flush();
    expect(io.signInWithPhoneNumber).toHaveBeenCalledOnce();
    finish({ user: { phoneNumber: '+966500000001' } });
    await confirming;
    const next = await second;
    expect(onProof).not.toHaveBeenCalled();
    expect(io.signOut).toHaveBeenCalledOnce();
    expect(io.signInWithPhoneNumber).toHaveBeenCalledTimes(2);
    next.cancel(); await flush();
  });
});
