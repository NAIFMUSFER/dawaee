import { expect, it } from 'vitest';
import { markdownCodeCell } from '../../../scripts/final-audit/markdown-cell.mjs';

it('keeps a source string containing a fence, slash, pipe and HTML inside one literal table cell', () => {
  const cell = markdownCodeCell('/v1/\\|`\n</code><script>alert(1)</script>&#124;');
  expect(cell).not.toContain('<script>');
  expect(cell).not.toContain('|');
  expect(cell).not.toContain('`');
  expect(cell).not.toContain('\n');
  expect(cell).not.toContain('\\');
  expect(cell.match(/<code>/g)).toHaveLength(1);
  expect(cell.match(/<\/code>/g)).toHaveLength(1);
  expect(cell).toContain('&amp;#124;');
  expect(markdownCodeCell('/v1/dose/action')).toBe('<code>/v1/dose/action</code>');
});
