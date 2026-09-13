import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static security assertions for the React Native / Expo runtime.
 *
 * Keep the scan deliberately scoped to runtime source (`app/` and `src/`). The
 * previous close-out scan walked the whole monorepo and then asserted that the
 * repository contained at most 120 files. That bound stopped testing security
 * as soon as the audit branch grew; every rule failed on the same file-count
 * guard before a single security pattern was evaluated. Security gates must
 * scale with the product, not with an old repository size.
 */

const MOBILE = resolve(import.meta.dirname, '..');
const RUNTIME_ROOTS = [resolve(MOBILE, 'app'), resolve(MOBILE, 'src')];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

interface SourceFile {
  path: string;
  source: string;
  executable: string;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, '');
}

function collectSourceFiles(): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!SOURCE_EXTENSIONS.has(extname(entry.name))) continue;
      const source = readFileSync(absolute, 'utf8');
      files.push({
        path: relative(MOBILE, absolute).replaceAll('\\', '/'),
        source,
        executable: stripComments(source),
      });
    }
  };
  for (const root of RUNTIME_ROOTS) walk(root);
  return files;
}

const files = collectSourceFiles();

function matches(pattern: RegExp, useExecutable = true): string[] {
  const findings: string[] = [];
  for (const file of files) {
    const text = useExecutable ? file.executable : file.source;
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.push(file.path);
  }
  return findings;
}

describe('React Native platform security — static source assertions', () => {
  it('scans the complete mobile runtime without a brittle repository-size ceiling', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((file) => file.path === 'api/client.ts')).toBe(true);
    expect(files.some((file) => file.path === 'api/token-store.ts')).toBe(true);
  });

  it('does not contain hardcoded private keys or provider credentials in runtime source', () => {
    const credentialPatterns = [
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
      /\bAKIA[0-9A-Z]{16}\b/,
      /\bghp_[A-Za-z0-9]{30,}\b/,
      /\bsk-(?:live|proj)-[A-Za-z0-9_-]{20,}\b/,
      /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
    ];
    for (const pattern of credentialPatterns) expect(matches(pattern)).toEqual([]);
  });

  it('does not use insecure production HTTP endpoints', () => {
    const findings: string[] = [];
    const http = /http:\/\/[^'"`\s)]+/g;
    for (const file of files) {
      for (const hit of file.executable.matchAll(http)) {
        const url = hit[0];
        if (/^http:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/|$)/.test(url)) continue;
        findings.push(`${file.path}: ${url}`);
      }
    }
    expect(findings).toEqual([]);
  });

  it('does not log authentication tokens, passwords or Authorization headers', () => {
    const findings: string[] = [];
    for (const file of files) {
      const lines = file.executable.split('\n');
      lines.forEach((line, index) => {
        if (!/console\.(?:log|info|debug|warn|error)\s*\(/.test(line)) return;
        if (!/(?:accessToken|refreshToken|password|authorization|bearer)/i.test(line)) return;
        findings.push(`${file.path}:${index + 1}`);
      });
    }
    expect(findings).toEqual([]);
  });

  it('does not execute dynamic code with eval or Function constructors', () => {
    expect(matches(/\beval\s*\(/)).toEqual([]);
    expect(matches(/\bnew\s+Function\s*\(/)).toEqual([]);
  });

  it('never writes authentication tokens back to AsyncStorage', () => {
    const tokenStore = readFileSync(resolve(MOBILE, 'src/api/token-store.ts'), 'utf8');
    const client = readFileSync(resolve(MOBILE, 'src/api/client.ts'), 'utf8');
    const executable = stripComments(`${tokenStore}\n${client}`);

    expect(executable).not.toMatch(/AsyncStorage\.(?:setItem|multiSet|mergeItem)\([^\n]*(?:accessToken|refreshToken|LEGACY_ACCESS_KEY|LEGACY_REFRESH_KEY)/);
    expect(tokenStore).toContain("import * as SecureStore from 'expo-secure-store'");
    expect(tokenStore).toContain("const SECURE_KEY = 'dawaee.session.v1'");
    expect(tokenStore).toContain('store.setItemAsync(SECURE_KEY');
  });

  it('keeps legacy AsyncStorage token access migration-only and delete-capable', () => {
    const tokenStore = readFileSync(resolve(MOBILE, 'src/api/token-store.ts'), 'utf8');
    expect(tokenStore).toContain('AsyncStorage.multiRemove([LEGACY_ACCESS_KEY, LEGACY_REFRESH_KEY])');
    expect(tokenStore).toContain('AsyncStorage.getItem(LEGACY_ACCESS_KEY)');
    expect(tokenStore).toContain('AsyncStorage.getItem(LEGACY_REFRESH_KEY)');
    expect(tokenStore).not.toContain('AsyncStorage.setItem(LEGACY_ACCESS_KEY');
    expect(tokenStore).not.toContain('AsyncStorage.setItem(LEGACY_REFRESH_KEY');
  });

  it('does not disable TLS or certificate validation in runtime source', () => {
    expect(matches(/rejectUnauthorized\s*:\s*false/)).toEqual([]);
    expect(matches(/NODE_TLS_REJECT_UNAUTHORIZED/)).toEqual([]);
    expect(matches(/allowsArbitraryLoads\s*[:=]\s*true/i)).toEqual([]);
    expect(matches(/usesCleartextTraffic\s*[:=]\s*true/i)).toEqual([]);
  });

  it('keeps session tokens out of browser persistence', () => {
    const tokenStore = readFileSync(resolve(MOBILE, 'src/api/token-store.ts'), 'utf8');
    const executable = stripComments(tokenStore);
    expect(executable).not.toMatch(/(?:localStorage|sessionStorage)\.(?:setItem|set)\s*\(/);
    expect(executable).toContain("if (Platform.OS === 'web') return");
  });

  it('uses a device-only secure-store accessibility class when available', () => {
    const tokenStore = readFileSync(resolve(MOBILE, 'src/api/token-store.ts'), 'utf8');
    expect(tokenStore).toContain('AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY');
    expect(tokenStore).toContain('keychainAccessible: level');
  });
});
