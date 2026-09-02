// Monorepo-aware Metro config.
//
// The app imports `@dawaee/shared` and `@dawaee/core` straight from their
// TypeScript source so a change in a domain engine is picked up without a
// build step. Those packages are authored for Node's NodeNext resolution,
// which means their relative imports carry an explicit `.js` extension —
// correct for Node, meaningless to Metro, which is looking at `.ts` files.
// The custom resolver below rewrites that one case and leaves everything else
// to Metro's default behaviour.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');
const fs = require('node:fs');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');
const sharedSrc = path.resolve(workspaceRoot, 'packages');
// The app's own `src` is authored the same way, so it gets the same treatment.
const rewriteRoots = [sharedSrc, path.resolve(projectRoot, 'src')];

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;
config.resolver.extraNodeModules = {
  '@dawaee/shared': path.resolve(sharedSrc, 'shared/src'),
  '@dawaee/core': path.resolve(sharedSrc, 'core/src'),
};

const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Only rewrite relative `.js` specifiers that originate inside our own
  // TypeScript sources, and only when the `.ts` sibling actually exists.
  if (moduleName.endsWith('.js') && moduleName.startsWith('.')) {
    const origin = context.originModulePath ?? '';
    if (rewriteRoots.some((root) => origin.startsWith(root))) {
      const base = path.resolve(path.dirname(origin), moduleName.slice(0, -3));
      for (const ext of ['.ts', '.tsx']) {
        if (fs.existsSync(base + ext)) {
          return { type: 'sourceFile', filePath: base + ext };
        }
      }
    }
  }
  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
