import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const INLINE = join(ROOT, 'scripts/inline-web.py');

const vulnerableFixture = [
  "function first(o){const v=n=>o({url:window.location.href,nativeEvent:n});return window.addEventListener('message',v,!1)}",
  "function second(s){const o=[];const v=n=>s({url:window.location.href,nativeEvent:n});return o.push({listener:s,nativeListener:v}),window.addEventListener('message',v,!1)}",
  'function enc(o,t,n){return o.searchParams.set(t,encodeURIComponent(n))}',
  'function dec(o,n,t){o[n]=decodeURIComponent(t)}',
  "async function videoMeta(o){return new Promise(s=>{const n=document.createElement('video');n.preload='metadata',n.onloadedmetadata=()=>{s({width:n.videoWidth,height:n.videoHeight,duration:n.duration})},n.onerror=()=>s({width:0,height:0,duration:0}),n.src=o})}",
  'globalThis.__fixture={first,second,enc,dec,videoMeta};',
].join('\n');

function makeDist(entry = vulnerableFixture) {
  const root = mkdtempSync(join(tmpdir(), 'dawaee-web-hardening-'));
  const dist = join(root, 'dist');
  const entryDir = join(dist, '_expo/static/js/web');
  const out = join(root, 'out/index.html');
  mkdirSync(entryDir, { recursive: true });
  writeFileSync(
    join(dist, 'index.html'),
    '<!doctype html><style id="expo-reset">html,body{margin:0}</style>',
  );
  writeFileSync(join(entryDir, 'entry-fixture.js'), entry);
  writeFileSync(join(entryDir, 'lazy-fixture.js'), 'globalThis.__lazyFixture=true;');
  return { root, dist, out };
}

function runInline(dist: string, out: string) {
  return spawnSync('python3', [INLINE, dist, out], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20_000,
  });
}

function scriptBody(html: string): string {
  const marker = '<script>';
  const start = html.indexOf(marker);
  const end = html.indexOf('</script>', start + marker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return html.slice(start + marker.length, end);
}

// Identifier spelling and quote choice are minifier output, not SDK semantics.
// Keep the exact original fixture and also execute alpha-equivalent variants.
const renamedFixture = vulnerableFixture.replace(/\b[ovnst]\b/g, (name) =>
  ({ o: 'target', v: 'handler', n: 'event', s: 'callback', t: 'key' } as Record<string, string>)[name] ?? name);
const dollarFixture = vulnerableFixture.replace(/\b[ovnst]\b/g, (name) =>
  ({ o: '$target', v: 'h_1', n: '$event', s: 'c_2', t: '$key' } as Record<string, string>)[name] ?? name);
const equivalentFixtures: Array<[string, string]> = [
  ['original', vulnerableFixture],
  ['renamed identifiers', renamedFixture],
  ['double-quoted event name', vulnerableFixture.replaceAll("'message'", '"message"')],
  ['renamed identifiers and double quotes', renamedFixture.replaceAll("'message'", '"message"')],
  ['dollar and underscore identifiers', dollarFixture],
];

describe('web production-bundle hardening', () => {
  it.each([
    { label: 'resolves image selection', selected: { type: 'image/png', name: 'medicine.png', size: 12 }, error: undefined },
    { label: 'rejects unsupported video selection without hanging', selected: { type: 'video/mp4', name: 'video.mp4', size: 12 }, error: 'TADAWEE supports medicine photos only' },
  ])('$label in the actual bundled Expo picker', async ({ selected, error }) => {
    const html = readFileSync(join(ROOT, 'apps/api/public/index.html'), 'utf8');
    const module = html.split('\n').find(line => line.includes('launchImageLibraryAsync:') && line.includes('new FileReader'));
    expect(module).toBeDefined();
    const events: Record<string, () => Promise<void>> = {};
    let removedInputs = 0;
    const context: Record<string, unknown> = {
      URL: { createObjectURL: () => 'blob:https://dawaee.test/photo' },
      MouseEvent: class {},
      Image: class {
        naturalWidth = 640; naturalHeight = 480; onload = () => {};
        set src(_value: string) { this.onload(); }
      },
      document: {
        body: { appendChild: () => {}, removeChild: () => { removedInputs++; } },
        createElement: (tag: string) => {
          expect(tag).toBe('input');
          return { style: {}, files: [selected], setAttribute: () => {},
            addEventListener: (name: string, callback: () => Promise<void>) => { events[name] = callback; },
            dispatchEvent: () => {},
          };
        },
      },
    };
    // Execute the real SDK module with browser boundaries mocked, not a
    // replacement implementation of the picker under test.
    vm.runInNewContext(`var __picker; function __d(factory) {
      var exports = {};
      var deps = [{Platform:{isDOMAvailable:true},PermissionStatus:{GRANTED:'granted'}},
        {CameraType:{front:'front',back:'back'}},{parseMediaTypes: function(x){return x}}];
      factory({}, function(id){return deps[id]}, null, null, {}, exports, [0,1,2]);
      __picker = exports.default;
    }\n${module}`, context);
    const picker = context.__picker as { launchImageLibraryAsync: (options: object) => Promise<{ canceled: boolean; assets: Array<{ width: number; height: number; fileName: string }> }> };
    const result = picker.launchImageLibraryAsync({ mediaTypes: ['images'] });
    // Observe the caller's promise, not only the async event listener. The SDK
    // catches readFile failures and adopts their rejection via resolve(...).
    const assertion = error
      ? expect(result).rejects.toThrow(error)
      : expect(result).resolves.toMatchObject({ canceled: false, assets: [{ width: 640, height: 480, fileName: 'medicine.png' }] });
    await events.change();
    await assertion;
    expect(removedInputs).toBe(1);
  }, 5_000);
  it('rejects unsupported video selection without creating a DOM element', async () => {
    const fixture = makeDist();
    try {
      const result = runInline(fixture.dist, fixture.out);
      expect(result.status, result.stderr).toBe(0);
      const seen: string[] = [];
      const context: Record<string, unknown> = {
        document: { createElement: () => ({
          videoWidth: 32, onloadedmetadata: () => {},
          set src(value: string) { seen.push(value); this.onloadedmetadata(); },
        }) },
      };
      vm.runInNewContext(scriptBody(readFileSync(fixture.out, 'utf8')), context);
      const api = context.__fixture as { videoMeta: (url: unknown) => Promise<unknown> };
      let coercions = 0;
      const changingValue = { toString() { return ++coercions === 1 ? 'blob:https://dawaee.test/id' : 'javascript:alert(1)'; } };
      for (const url of [changingValue, null, undefined, 42, ['blob:https://dawaee.test/id'], 'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'https://evil.invalid/media', '//evil.invalid', ' blob:test']) {
        await expect(api.videoMeta(url)).rejects.toThrow('TADAWEE supports medicine photos only');
      }
      expect(seen).toEqual([]);
      expect(coercions).toBe(0);
      await expect(api.videoMeta('blob:https://dawaee.test/local-id')).rejects.toThrow('TADAWEE supports medicine photos only');
      expect(seen).toEqual([]);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });
  for (const [name, entry] of equivalentFixtures) {
    it(`blocks cross-origin Linking signals and preserves URLSearchParams values: ${name}`, () => {
      const fixture = makeDist(entry);
      try {
        const result = runInline(fixture.dist, fixture.out);
        expect(result.status, result.stderr).toBe(0);

        const html = readFileSync(fixture.out, 'utf8');
        const body = scriptBody(html);
        expect(body).not.toContain('encodeURIComponent(n)');
        expect(body).not.toContain('decodeURIComponent(t)');
        expect(body.match(/\.origin!==window\.location\.origin/g)?.length).toBe(2);

        const listeners: Array<(event: { origin: string }) => void> = [];
        const context: Record<string, unknown> = {
          URL,
          window: {
            location: {
              href: 'https://dawaee.test/today',
              origin: 'https://dawaee.test',
            },
            addEventListener: (
              name: string,
              listener: (event: { origin: string }) => void,
            ) => {
              expect(name).toBe('message');
              listeners.push(listener);
            },
          },
        };
        vm.runInNewContext(body, context);
        const fixtureApi = context.__fixture as {
          first: (listener: (event: unknown) => void) => void;
          second: (listener: (event: unknown) => void) => void;
          enc: (url: URL, key: string, value: string) => void;
          dec: (target: Record<string, string>, key: string, value: string) => void;
        };

        const firstSeen: unknown[] = [];
        const secondSeen: unknown[] = [];
        fixtureApi.first((event) => firstSeen.push(event));
        fixtureApi.second((event) => secondSeen.push(event));
        expect(listeners).toHaveLength(2);

        for (const origin of ['https://evil.invalid', 'null', '',
          'https://dawaee.test.evil.invalid', 'http://dawaee.test', 'https://dawaee.test:444']) {
          for (const listener of listeners) listener({ origin });
        }
        expect(firstSeen).toHaveLength(0);
        expect(secondSeen).toHaveLength(0);

        for (const listener of listeners) listener({ origin: 'https://dawaee.test' });
        expect(firstSeen).toHaveLength(1);
        expect(secondSeen).toHaveLength(1);

        const url = new URL('https://dawaee.test/');
        fixtureApi.enc(url, 'q', '100% /');
        expect(url.searchParams.get('q')).toBe('100% /');
        expect(url.href).toContain('q=100%25+%2F');

        for (const value of ['%2F', '%', '100% /', 'دوائي + & = #', '%252F']) {
          const decoded: Record<string, string> = {};
          fixtureApi.enc(url, 'q', value);
          expect(url.searchParams.get('q')).toBe(value);
          fixtureApi.dec(decoded, 'q', value);
          expect(decoded.q).toBe(value);
        }
        // Hash and lazy-chunk contracts must survive all spelling variations.
        expect(readFileSync(`${fixture.out}.script-sha256`, 'utf8').trim())
          .toBe(createHash('sha256').update(body, 'utf8').digest('base64'));
        expect(readFileSync(join(dirname(fixture.out), '_expo/static/js/web/lazy-fixture.js'), 'utf8'))
          .toBe('globalThis.__lazyFixture=true;');
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });

  }

  it('emits a sidecar hash for the exact inline script body', () => {
    const fixture = makeDist();
    try {
      const result = runInline(fixture.dist, fixture.out);
      expect(result.status, result.stderr).toBe(0);
      const body = scriptBody(readFileSync(fixture.out, 'utf8'));
      const expected = createHash('sha256').update(body, 'utf8').digest('base64');
      expect(readFileSync(`${fixture.out}.script-sha256`, 'utf8').trim()).toBe(expected);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('fails closed if an Expo upgrade changes an expected hardening snippet', () => {
    const fixture = makeDist(
      vulnerableFixture.replace(
        'o.searchParams.set(t,encodeURIComponent(n))',
        'o.searchParams.set(t,n)',
      ),
    );
    try {
      const result = runInline(fixture.dist, fixture.out);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('web hardening drift');
      expect(result.stderr).toContain('Expo Linking query encoding');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

// Only alpha-renaming/quote choice may vary: missing/duplicate snippets and
// changed callback/registration identities must still stop the real bundler.
describe('web hardening retains fail-closed structure checks', () => {
  const lines = vulnerableFixture.split('\n');
  for (const index of [0, 1, 2, 3, 4]) {
    for (const mutation of ['missing', 'duplicate'] as const) {
      it(`rejects ${mutation} snippet ${index}`, () => {
        const entry = mutation === 'missing'
          ? lines.filter((_, i) => i !== index).join('\n')
          : `${vulnerableFixture}\n${lines[index]}`;
        const fixture = makeDist(entry);
        try {
          const result = runInline(fixture.dist, fixture.out);
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain('web hardening drift');
          expect(existsSync(fixture.out)).toBe(false);
          expect(existsSync(`${fixture.out}.script-sha256`)).toBe(false);
        } finally { rmSync(fixture.root, { recursive: true, force: true }); }
      });
    }
  }
  const invalidIdentities: Array<[string, string]> = [
    ['different forwarded event', vulnerableFixture.replace('nativeEvent:n', 'nativeEvent:other')],
    ['different registered handler', vulnerableFixture.replace("('message',v,!1)", "('message',other,!1)")],
    ['different saved listener', vulnerableFixture.replace('listener:s,nativeListener:v', 'listener:other,nativeListener:v')],
    ['different saved handler', vulnerableFixture.replace('listener:s,nativeListener:v', 'listener:s,nativeListener:other')],
    ['different event type', vulnerableFixture.replace("'message'", "'load'")],
  ];
  for (const [name, entry] of invalidIdentities) {
    it(`rejects ${name}`, () => {
      const fixture = makeDist(entry);
      try {
        const result = runInline(fixture.dist, fixture.out);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('web hardening drift');
        expect(existsSync(fixture.out)).toBe(false);
      } finally { rmSync(fixture.root, { recursive: true, force: true }); }
    });
  }
});
