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

function resolveDirect(moduleName: string) {
  return config.resolver.resolveRequest(
    {
      originModulePath: origin,
      resolveRequest: () => {
        throw new Error(`direct source alias ${moduleName} fell through to package/node_modules resolution`);
      },
    },
    moduleName,
    'android',
  );
}

describe('Metro release source resolution', () => {
  it('pins @dawaee/shared to TypeScript source before hierarchical package resolution', () => {
    const result = resolveDirect('@dawaee/shared');
    expect(result.type).toBe('sourceFile');
    expect(result.filePath?.replaceAll('\\', '/')).toMatch(/\/packages\/shared\/src\/index\.ts$/);
  });

  it('pins @dawaee/core to TypeScript source before hierarchical package resolution', () => {
    const result = resolveDirect('@dawaee/core');
    expect(result.type).toBe('sourceFile');
    expect(result.filePath?.replaceAll('\\', '/')).toMatch(/\/packages\/core\/src\/index\.ts$/);
  });

  it('resolves the @/ alias used by app screens to the mobile source tree', () => {
    const result = resolveDirect('@/components/ui');
    expect(result.type).toBe('sourceFile');
    expect(result.filePath?.replaceAll('\\', '/')).toMatch(/\/apps\/mobile\/src\/components\/ui\.tsx$/);
  });

  it('resolves @/ aliases with a .js specifier to their TypeScript sibling', () => {
    const result = resolveDirect('@/notifications/actions.js');
    expect(result.type).toBe('sourceFile');
    expect(result.filePath?.replaceAll('\\', '/')).toMatch(/\/apps\/mobile\/src\/notifications\/actions\.ts$/);
  });
});
