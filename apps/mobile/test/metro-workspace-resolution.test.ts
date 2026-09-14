import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const config = require('../metro.config.js') as {
  resolver: {
    resolveRequest: (
      context: { originModulePath: string; resolveRequest: () => never },
      moduleName: string,
      platform: string,
    ) => { type: string; filePath?: string };
  };
};

const origin = fileURLToPath(new URL('../app/(auth)/_layout.tsx', import.meta.url));

function resolveWorkspacePackage(moduleName: '@dawaee/shared' | '@dawaee/core') {
  return config.resolver.resolveRequest(
    {
      originModulePath: origin,
      resolveRequest: () => {
        throw new Error(`workspace package ${moduleName} fell through to package.json/main resolution`);
      },
    },
    moduleName,
    'android',
  );
}

describe('Metro workspace package resolution', () => {
  it('pins @dawaee/shared to TypeScript source before hierarchical package resolution', () => {
    const result = resolveWorkspacePackage('@dawaee/shared');
    expect(result.type).toBe('sourceFile');
    expect(result.filePath?.replaceAll('\\', '/')).toMatch(/\/packages\/shared\/src\/index\.ts$/);
  });

  it('pins @dawaee/core to TypeScript source before hierarchical package resolution', () => {
    const result = resolveWorkspacePackage('@dawaee/core');
    expect(result.type).toBe('sourceFile');
    expect(result.filePath?.replaceAll('\\', '/')).toMatch(/\/packages\/core\/src\/index\.ts$/);
  });
});
