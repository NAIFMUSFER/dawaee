import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = new URL('../../../db/migrations/', import.meta.url);

describe('database migration identity', () => {
  it('uses each four-digit migration number exactly once', () => {
    const files = fs.readdirSync(MIGRATIONS)
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort();

    const byNumber = new Map<string, string[]>();
    for (const file of files) {
      const number = file.slice(0, 4);
      const group = byNumber.get(number) ?? [];
      group.push(file);
      byNumber.set(number, group);
    }

    const duplicates = [...byNumber.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([number, names]) => ({ number, files: names }));

    expect(duplicates, `duplicate migration numbers: ${JSON.stringify(duplicates)}`).toEqual([]);
  });
});
