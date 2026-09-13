import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function renderBlueprint(): string {
  return readFileSync(resolve(process.cwd(), 'render.yaml'), 'utf8');
}

function serviceBlock(blueprint: string, serviceName: string): string {
  const marker = `name: ${serviceName}`;
  const start = blueprint.indexOf(marker);
  if (start < 0) throw new Error(`Render service ${serviceName} is missing`);

  const nextService = blueprint.indexOf('\n  - type:', start + marker.length);
  return blueprint.slice(start, nextService < 0 ? undefined : nextService);
}

describe('production Render release control', () => {
  it.each(['dawaee-api', 'dawaee-worker'])(
    'keeps %s on controlled manual deployment',
    (serviceName) => {
      const block = serviceBlock(renderBlueprint(), serviceName);

      expect(block).toMatch(/autoDeployTrigger:\s*off\b/);
      expect(block).not.toMatch(/autoDeployTrigger:\s*(?:commit|checksPass)\b/);
    },
  );

  it('keeps the running API on a liveness health check during worker-first cutover', () => {
    const api = serviceBlock(renderBlueprint(), 'dawaee-api');

    expect(api).toMatch(/healthCheckPath:\s*\/health\b/);
    expect(api).not.toMatch(/healthCheckPath:\s*\/health\/ready\b/);
  });
});
