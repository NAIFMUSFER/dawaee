import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function securityWorkflow(): string {
  return readFileSync(resolve(process.cwd(), '.github/workflows/codeql.yml'), 'utf8');
}

function jobBlock(workflow: string, jobName: string): string {
  const marker = `\n  ${jobName}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`Workflow job ${jobName} is missing`);

  const rest = workflow.slice(start + marker.length);
  const nextJob = rest.search(/^  [A-Za-z0-9_-]+:\s*$/m);
  return workflow.slice(start, nextJob < 0 ? undefined : start + marker.length + nextJob);
}

describe('security workflow release gate', () => {
  it('keeps the required CodeQL check fail-closed behind secret and container scanning', () => {
    const block = jobBlock(securityWorkflow(), 'codeql');

    expect(block).toMatch(/\n    needs:\s*secret-and-container-scan\b/);
    expect(block).toMatch(/\n    if:\s*\$\{\{\s*always\(\)\s*\}\}/);
    expect(block).toMatch(/needs\.secret-and-container-scan\.result\s*!=\s*['"]success['"]/);
    expect(block).toMatch(/exit\s+1\b/);
  });
});
