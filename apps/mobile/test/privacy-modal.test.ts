import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

describe('native modal content follows the same app/area privacy gate', () => {
  it('removes the native modal and all sensitive children while covered, retaining the caller draft for unlock', () => {
    let contentBlocked = false;
    const source = readFileSync(resolve('apps/mobile/src/security/PrivacyModal.tsx'), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true,
    } }).outputText;
    const exports: any = {};
    vm.runInNewContext(code, { exports, require: (name: string) => {
      if (name === 'react') return { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props, children }) };
      if (name === 'react-native') return { Modal: 'Modal' };
      if (name === './AppLockContext') return { useAppLock: () => ({ contentBlocked }) };
      throw new Error(name);
    } });
    const props = { visible: true, animationType: 'slide', children: 'PRIVATE-DRAFT' };
    expect(exports.PrivacyModal(props).children).toEqual(['PRIVATE-DRAFT']);
    contentBlocked = true;
    const hidden = exports.PrivacyModal(props);
    expect(hidden.props).toMatchObject({ visible: false, animationType: 'none' });
    expect(hidden.children).toEqual([null]);
    contentBlocked = false;
    expect(exports.PrivacyModal(props).children).toEqual(['PRIVATE-DRAFT']);
    expect(exports.PrivacyModal({ ...props, visible: false }).props.visible).toBe(false);
  });

  it('routes every native Modal through the shared boundary and includes area locks', () => {
    const visit = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const path = resolve(dir, entry.name);
      return entry.isDirectory() ? visit(path) : path.endsWith('.tsx') ? [path] : [];
    });
    for (const file of [...visit(resolve('apps/mobile/app')), ...visit(resolve('apps/mobile/src'))]) {
      if (file.endsWith('/security/PrivacyModal.tsx')) continue;
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/import\s*\{[^}]*\bModal\b[^}]*\}\s*from ['"]react-native['"]/);
    }
    const gate = readFileSync(resolve('apps/mobile/src/security/AppLockGate.tsx'), 'utf8');
    expect(gate).toContain('const contentHiddenFromAccessibility = phase !== \'unlocked\' || areaLocked;');
    expect(gate).toContain('contentBlocked: contentHiddenFromAccessibility');
  });
});
