import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSymptomNoteSchema } from '@dawaee/shared';

const screen = readFileSync(resolve(import.meta.dirname, '../app/reports/notes.tsx'), 'utf8');

describe('standalone symptom-note composer length contract', () => {
  it('does not truncate text that the public API explicitly accepts', () => {
    const accepted = 'ن'.repeat(2000);
    expect(createSymptomNoteSchema.safeParse({ profileId: '11111111-2222-4333-8444-555555555555', tags: [], text: accepted }).success).toBe(true);
    expect(screen).toContain('maxLength={2000}');
    expect(screen).not.toContain('maxLength={1000}');
  });
});
