import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createHarness } = require('./profile-screen-harness.cjs');

// This checks the actual navigator declaration and the filesystem route
// inventory. It is not an Expo renderer or a replacement for direct-URL trials.
function navigator(demo = false) {
  const Stack = Object.assign((props: unknown) => ({ type: 'Stack', props }), {
    Screen: 'RouteScreen', Protected: 'Protected',
  });
  return createHarness(resolve('apps/mobile/src/navigation/AppNavigator.tsx'), undefined, {}, {
    'expo-router': { Stack },
    '@/api/client': { DEMO_MODE: demo },
    '@dawaee/shared': { PALETTE: { background: '#fff' } },
  });
}

function screenNames(value: any): string[] {
  if (!value || typeof value !== 'object') return [];
  if (value.type === 'RouteScreen') return [value.props.name];
  return Object.values(value).flatMap(screenNames);
}

describe('root authenticated route inventory', () => {
  it('protects every private route while keeping entry, auth, invitations and shared emergency cards reachable', () => {
    const h = navigator();
    const publicRoutes = ['index', '(auth)', 'invite/index', 'invite/[token]', 'caregiver/accept', 'e/index'];
    const files = readdirSync(resolve('apps/mobile/app'), { recursive: true, encoding: 'utf8' })
      .filter(file => file.endsWith('.tsx') && !file.split('/').at(-1)!.startsWith('+') && !file.endsWith('_layout.tsx'));
    const rootNames = [...new Set(files.map(file => file.startsWith('(tabs)/') ? '(tabs)'
      : file.startsWith('(auth)/') ? '(auth)' : file.replace(/\.tsx$/, '')))];
    const protectedNames = screenNames(h.find('Protected').children);
    expect(protectedNames.sort()).toEqual(rootNames.filter(name => !publicRoutes.includes(name)).sort());
    expect(new Set(protectedNames).size).toBe(protectedNames.length);
    expect(screenNames(h.tree)[0]).toBe('index');
    h.unmount();
  });

  it('removes private destinations when the authenticated app state is lost, regardless of a stale user object', () => {
    const h = navigator();
    h.app.signedIn = true; h.render();
    expect(h.find('Protected').guard).toBe(true);
    h.app.signedIn = false; h.render();
    expect(h.app.user).not.toBeNull();
    expect(h.find('Protected').guard).toBe(false);
    h.unmount();
  });

  it('keeps the existing explicit, serverless demo available without credentials', () => {
    const h = navigator(true);
    h.app.signedIn = false; h.render();
    expect(h.find('Protected').guard).toBe(true);
    h.unmount();
  });
});
