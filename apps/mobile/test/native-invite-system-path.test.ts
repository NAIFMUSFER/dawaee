import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import * as native from '../src/navigation/native-invite';
const { createHarness, deferred } = createRequire(import.meta.url)('./profile-screen-harness.cjs');

const origin = 'https://dawaee-api.onrender.com';
const tokenA = 'A'.repeat(43), tokenB = 'B'.repeat(43);
afterEach(() => { const current = native.getNativeInviteSelection(); if (current) native.clearNativeInviteSelection(current); });

describe('native system invitation links', () => {
  it('hands a newer warm invite to storage and acceptance while ignoring a delayed older handoff', async () => {
    native.redirectInviteSystemPath(`${origin}/invite#${tokenA}`, origin, ['dawaee']);
    const pending = deferred(); const writes: string[] = [];
    const h = createHarness(resolve('apps/mobile/app/invite/index.tsx'), undefined, {}, {
      '@/navigation/native-invite': native,
      '@/storage/pending-invite': { stashPendingInvite: async (token: string) => {
        writes.push(token); if (token === tokenA) await pending.promise;
      } },
      'react-native': { Platform: { OS: 'ios' }, Linking: {
        getInitialURL: () => { throw new Error('must use the current system URL'); },
      } },
    });
    try {
      await h.flush(); expect(writes).toEqual([tokenA]);
      native.redirectInviteSystemPath(`${origin}/invite#${tokenB}`, origin, ['dawaee']);
      await h.flush(); pending.resolve(); await h.flush();
      expect(writes).toEqual([tokenA, tokenB]);
      expect(h.routes).toEqual(['/caregiver/accept']);
    } finally { h.unmount(); }
    expect(native.getNativeInviteSelection()).toBeNull();
  });
  it('uses the actual current system URL for cold and warm input without putting the bearer in the destination', () => {
    const code = ts.transpileModule(readFileSync(resolve('apps/mobile/app/+native-intent.tsx'), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const exports: any = {};
    vm.runInNewContext(code, { exports, require: (name: string) => {
      if (name === 'expo-constants') return { expoConfig: { scheme: 'dawaee' } };
      if (name === '@/api/client') return { api: { baseUrl: origin } };
      if (name === '@/navigation/native-invite') return native;
      throw new Error(name);
    } });
    expect(exports.redirectSystemPath({ initial: true, path: `${origin}/invite#/invite/${tokenA}` })).toBe('/invite');
    expect(native.getNativeInviteSelection()?.token).toBe(tokenA);
    const earlier = native.getNativeInviteSelection()!;
    expect(exports.redirectSystemPath({ initial: false, path: `dawaee://invite#${tokenB}` })).toBe('/invite');
    expect(native.getNativeInviteSelection()?.token).toBe(tokenB);
    native.clearNativeInviteSelection(earlier);
    expect(native.getNativeInviteSelection()?.token).toBe(tokenB);
  });

  it('notifies an already-mounted entry when a different invitation arrives', () => {
    let changes = 0; const stop = native.subscribeNativeInvite(() => changes++);
    native.redirectInviteSystemPath(`${origin}/invite#${tokenA}`, origin, ['dawaee']);
    native.redirectInviteSystemPath(`${origin}/invite#${tokenB}`, origin, ['dawaee']);
    expect(changes).toBe(2); expect(native.getNativeInviteSelection()?.token).toBe(tokenB);
    stop(); native.redirectInviteSystemPath(`${origin}/invite#${tokenA}`, origin, ['dawaee']);
    expect(changes).toBe(2);
  });

  it.each(['short', '%ZZ', `bad/${tokenA}`, `${tokenA}?secret`, ''])('rejects malformed invite fragment %s without storing it', fragment => {
    expect(native.redirectInviteSystemPath(`${origin}/invite#${fragment}`, origin, ['dawaee'])).toBeNull();
    expect(native.getNativeInviteSelection()).toBeNull();
  });

  it.each([
    `https://other.example/invite#${tokenA}`, `${origin}/e#${tokenA}`,
    `${origin}/invite/legacy-token`, `${origin}/invite?token=${tokenA}`,
    `dawaee-audit://invite#${tokenA}`, 'dawaee://settings/notifications',
  ])('leaves unrelated origins, schemes and routes alone: %s', path => {
    expect(native.redirectInviteSystemPath(path, origin, ['dawaee'])).toBe(path);
    expect(native.getNativeInviteSelection()).toBeNull();
  });
});
