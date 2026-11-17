import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const requireMobile = createRequire(new URL('../package.json', import.meta.url));
const decode = requireMobile('decode-uri-component') as (input: string) => string;
const queryString = requireMobile('query-string');

describe('patched navigation URI decoder', () => {
  it('keeps the callable CommonJS interface used by query-string', () => {
    expect(typeof decode).toBe('function');
    expect(decode('%D9%86%D8%A7%D9%8A%D9%81')).toBe('نايف');
    expect(queryString.parse('name=%D9%86%D8%A7%D9%8A%D9%81&note=two+words'))
      .toMatchObject({ name: 'نايف', note: 'two words' });
  });

  it('tolerates malformed user links without throwing', () => {
    for (const input of ['%', '%zz', '%C0%AF', 'abc%2', '%E2%82%AC']) {
      expect(() => decode(input)).not.toThrow();
    }
    expect(decode('%zz')).toBe('%zz');
    expect(decode('%E2%82%AC')).toBe('€');
  });

  it('bounds decoding time for many distinct malformed percent runs', () => {
    const program = `
      const decode = require('decode-uri-component');
      let input = '';
      for (let i = 0; i < 32000; i++) {
        input += '%' + (i >> 8).toString(16).padStart(2, '0')
          + '%' + (i & 255).toString(16).padStart(2, '0') + '%zz';
      }
      if (typeof decode(input) !== 'string') process.exit(1);
    `;
    expect(() => execFileSync(process.execPath, ['-e', program], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 5000, stdio: 'pipe',
    })).not.toThrow();
  });
});
