#!/usr/bin/env node
/**
 * The dependency gate.
 *
 * `npm audit` alone cannot be the gate for this repository, for two reasons
 * that pull in opposite directions.
 *
 * Failing on everything does not work: the mobile app carries a moderate
 * advisory reachable only through Expo's own dependency tree, with no fixed
 * version published upstream. A gate that fails on it fails on every commit,
 * and a gate that fails on every commit is turned off within a week — which is
 * how repositories end up with `npm audit || true` and no gate at all.
 *
 * Failing on nothing does not work either, for the obvious reason.
 *
 * So the gate is: a documented baseline of advisories that have been looked at
 * and accepted, and a hard failure on anything outside it at or above the
 * threshold. An accepted advisory carries who accepted it, why, and what would
 * end the exception — a package name on a permanent allowlist is not an
 * accepted risk, it is an unexamined one.
 *
 * Two further rules make the baseline self-cleaning:
 *
 *  - A baseline entry that no longer matches ANY advisory is reported as
 *    stale and fails the run. An exception outliving the vulnerability is how
 *    a list stops describing reality.
 *  - A baseline entry past its review date fails the run. The exception is not
 *    revoked automatically — that would break the build for a reason unrelated
 *    to security — but it has to be re-read and re-dated by a person.
 *
 * Usage:
 *   node scripts/audit-gate.mjs --workspace root
 *   node scripts/audit-gate.mjs --workspace mobile
 */

import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical'];

const WORKSPACES = {
  root: {
    cwd: ROOT,
    // Audit the complete install because root dev dependencies execute on CI
    // and Render during build. A critical build-tool advisory is a supply-chain
    // risk even when no request can import it at runtime. A second runtime-only
    // audit below (`runtimeArgs`) distinguishes those findings instead of
    // deleting them from the evidence with --omit=dev.
    args: ['audit', '--json'],
    runtimeArgs: ['audit', '--json', '--omit=dev'],
    failRuntimeAt: 'high',
    failBuildAt: 'critical',
    label: 'root (API + worker dependencies)',
  },
  mobile: {
    cwd: resolve(ROOT, 'apps/mobile'),
    // `--omit=dev` is deliberately NOT used here, and it would change nothing
    // if it were: measured, mobile reports the same advisory tree either way,
    // because `expo` is a runtime dependency and the entire CLI and bundler
    // hang beneath it. The build/runtime split that matters is computed from
    // the dependency graph instead — see BUILD_TOOLCHAIN.
    args: ['audit', '--json'],
    runtimeArgs: null,
    failRuntimeAt: 'high',
    failBuildAt: 'critical',
    label: 'mobile (Expo application)',
  },
};

/**
 * Advisories that have been reviewed and accepted, with the reason and the
 * condition that ends the exception.
 *
 * `reviewBy` is the date this entry must be looked at again. Passing it fails
 * the gate: the exception is not silently revoked — that would break a build
 * for a reason unrelated to security — but it has to be re-read and re-dated
 * by a person.
 *
 * Each entry is classified against the current dependency graph. Build-only and
 * runtime-reachable exceptions are held to separate thresholds and must state why
 * the current upstream-compatible version is being retained.
 */
const BASELINE = [
  {
    workspace: 'mobile',
    module: 'uuid',
    severity: 'moderate',
    advisories: ['GHSA-w5hq-g745-h8pq'],
    accepted: '2026-09-06',
    reviewBy: '2026-12-06',
    reason:
      'Reached through xcode -> uuid in the Expo iOS project-generation toolchain. It is not '
      + 'bundled into the patient runtime; below the build threshold and retained only as a reviewed exception.',
    endsWhen: 'Expo SDK upgrade.',
  },
  {
    workspace: 'mobile',
    module: 'decode-uri-component',
    severity: 'moderate',
    advisories: ['GHSA-vcc3-ghjq-m6fr'],
    accepted: '2026-09-06',
    reviewBy: '2026-12-06',
    reason:
      'The one advisory root that IS runtime-reachable: expo-router / @react-navigation -> '
      + 'query-string -> decode-uri-component. Denial of service via a malformed percent-encoded '
      + 'string. The only attacker-controlled input that reaches it is a deep link the user opens; '
      + 'the worst outcome is the app becoming unresponsive and being restarted, with no data '
      + 'exposure. Fixed only by expo-router@57, a major upgrade. Carried from P14 as PROPOSED '
      + 'ACCEPTED RISK / BLOCKED BY UPSTREAM.',
    endsWhen:
      'expo-router or @react-navigation resolves query-string to a version depending on '
      + 'decode-uri-component >= 0.2.3, or the advisory is withdrawn.',
  },
];

function severityAtLeast(severity, threshold) {
  return SEVERITY_ORDER.indexOf(severity) >= SEVERITY_ORDER.indexOf(threshold);
}

function runAudit(ws, args = ws.args) {
  try {
    return execFileSync('npm', args, { cwd: ws.cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    // `npm audit` exits non-zero whenever it finds anything at or above its
    // default level. That is the normal case here, and the JSON is on stdout.
    const stdout = err?.stdout;
    if (typeof stdout === 'string' && stdout.trim().startsWith('{')) return stdout;
    // Anything else — no network, a corrupt lockfile, npm itself failing — is
    // NOT a clean result. Reporting it as "no vulnerabilities found" is exactly
    // the failure this gate exists to prevent.
    throw new Error(
      `npm audit could not run in ${ws.label}: ${err?.message ?? 'unknown error'}. `
      + 'A gate cannot pass on an audit that did not execute.',
    );
  }
}

/**
 * The packages that actually carry an advisory.
 *
 * `npm audit` reports a vulnerability against every ANCESTOR of the affected
 * package as well as against the package itself, so one leaf advisory appears
 * many times. Reading the aggregate count as the finding count turns a
 * dependency report into theatre — in both directions, since it also buries
 * the entries that matter.
 *
 * A root is a package whose `via` holds an advisory object rather than the
 * name of another package.
 */
function advisoryRoots(report) {
  const roots = [];
  for (const [name, v] of Object.entries(report.vulnerabilities ?? {})) {
    const own = (v.via ?? []).filter((entry) => typeof entry === 'object' && entry.url);
    if (own.length === 0) continue;
    roots.push({
      module: name,
      severity: v.severity,
      advisories: own.map((o) => String(o.url).split('/').pop()),
      fixAvailable: v.fixAvailable,
      buildTime: null,
    });
  }
  return roots;
}

/**
 * Packages that exist only to build the mobile app, never to run it.
 *
 * npm's dev/production split does not model React Native's bundling boundary.
 * `expo` is a runtime dependency; `@expo/cli` and the Metro bundler are its
 * dependencies; so npm classifies the whole build toolchain as production. It
 * is not. Metro and the prebuild helpers run on a developer's machine or a
 * build server, none of them is bundled into the binary a patient installs.
 *
 * Root is different: npm can model its boundary directly because its build
 * dependencies are dev dependencies. The root check therefore compares a full
 * audit with a second --omit=dev audit; this graph walk is only for mobile.
 */
const BUILD_TOOLCHAIN = new Set([
  '@expo/cli', '@expo/metro-config', '@expo/image-utils', '@expo/prebuild-config',
  '@expo/config-plugins', '@expo/package-manager', '@expo/dev-server', '@expo/plist',
  '@expo/bunyan', '@expo/rudder-sdk-node', 'xcode',
  'metro', 'metro-config', 'metro-transform-worker', 'babel-preset-expo',
  '@react-native/community-cli-plugin', '@react-native/metro-config',
  'expo-modules-autolinking',
]);

/**
 * True when EVERY path from this package up to the application passes through
 * build tooling. A single path that reaches the app directly makes it runtime.
 */
function isBuildTimeOnly(name, vulnerabilities, seen = new Set()) {
  if (BUILD_TOOLCHAIN.has(name)) return true;
  if (seen.has(name)) return true;
  seen.add(name);
  const effects = vulnerabilities[name]?.effects ?? [];
  if (effects.length === 0) return false;
  return effects.every((e) => isBuildTimeOnly(e, vulnerabilities, new Set(seen)));
}

function describeFix(fix) {
  if (fix === true) return ' (a fix is available)';
  if (fix && fix.name) {
    return ` (fixed by ${fix.name}@${fix.version}${fix.isSemVerMajor ? ', a MAJOR upgrade' : ''})`;
  }
  return ' (no fix published)';
}

function check(workspaceName) {
  const ws = WORKSPACES[workspaceName];
  if (!ws) throw new Error(`unknown workspace: ${workspaceName}`);

  const report = JSON.parse(runAudit(ws));
  const roots = advisoryRoots(report);

  if (workspaceName === 'root') {
    // Presence in --omit=dev proves that at least one runtime dependency path
    // reaches this advisory root. Absence means the finding exists only in the
    // build install, so it is held to the build threshold rather than erased.
    const runtimeReport = JSON.parse(runAudit(ws, ws.runtimeArgs));
    const runtimeModules = new Set(advisoryRoots(runtimeReport).map((r) => r.module));
    for (const r of roots) r.buildTime = !runtimeModules.has(r.module);
  } else {
    for (const r of roots) r.buildTime = isBuildTimeOnly(r.module, report.vulnerabilities);
  }

  const baseline = BASELINE.filter((b) => b.workspace === workspaceName);
  const today = new Date().toISOString().slice(0, 10);

  const problems = [];
  const acceptedModules = new Set();
  const usedBaseline = new Set();

  for (const r of roots) {
    const threshold = r.buildTime ? ws.failBuildAt : ws.failRuntimeAt;
    const match = baseline.find(
      (b) => b.module === r.module && r.advisories.some((a) => b.advisories.includes(a)),
    );

    if (match) {
      usedBaseline.add(match.module);
      acceptedModules.add(r.module);
      if (today > match.reviewBy) {
        problems.push(
          `EXCEPTION EXPIRED   ${r.module} — accepted ${match.accepted}, review was due ${match.reviewBy}. `
          + 'Re-read it and re-date it, or remove the dependency.',
        );
      }
      if (SEVERITY_ORDER.indexOf(r.severity) > SEVERITY_ORDER.indexOf(match.severity)) {
        problems.push(
          `SEVERITY INCREASED  ${r.module} — accepted as ${match.severity}, now ${r.severity}. `
          + 'The exception does not cover this.',
        );
      }
      const unlisted = r.advisories.filter((a) => !match.advisories.includes(a));
      if (unlisted.length) {
        problems.push(
          `NEW ADVISORY        ${r.module} — ${unlisted.join(', ')} is outside the exception, `
          + `which covers ${match.advisories.join(', ')}.`,
        );
      }
      continue;
    }

    if (severityAtLeast(r.severity, threshold)) {
      problems.push(
        `UNACCEPTED ${r.severity.toUpperCase().padEnd(8)} ${r.buildTime ? '[build]  ' : '[RUNTIME]'} `
        + `${r.module} — ${r.advisories.join(', ')}${describeFix(r.fixAvailable)}`,
      );
    }
  }

  for (const b of baseline) {
    if (!usedBaseline.has(b.module)) {
      problems.push(
        `STALE EXCEPTION     ${b.module} (${b.advisories.join(', ')}) no longer matches any advisory. `
        + 'Remove it — an exception that outlives its vulnerability stops describing reality.',
      );
    }
  }

  const runtime = roots.filter((r) => !r.buildTime);
  const build = roots.filter((r) => r.buildTime);
  console.log(`\n=== ${ws.label} ===`);
  console.log(
    `advisory roots: ${roots.length} (${runtime.length} runtime-reachable, ${build.length} build-toolchain)`
    + `; npm reported ${Object.keys(report.vulnerabilities ?? {}).length} entries`,
  );
  console.log(`thresholds: runtime >= ${ws.failRuntimeAt}, build toolchain >= ${ws.failBuildAt}`);
  for (const r of roots.sort((a, b) => Number(a.buildTime) - Number(b.buildTime))) {
    console.log(
      `  ${r.buildTime ? 'build  ' : 'RUNTIME'} ${r.severity.padEnd(9)} `
      + `${(acceptedModules.has(r.module) ? 'accepted' : 'open').padEnd(9)} ${r.module}`,
    );
  }
  if (problems.length === 0) {
    console.log('  -> no unaccepted findings at or above the thresholds');
    return true;
  }
  console.log('');
  for (const p of problems) console.log(`  ${p}`);
  return false;
}

const arg = process.argv.indexOf('--workspace');
const target = arg >= 0 ? process.argv[arg + 1] : null;
const targets = target && target !== 'all' ? [target] : Object.keys(WORKSPACES);

let ok = true;
for (const t of targets) {
  try {
    if (!check(t)) ok = false;
  } catch (err) {
    console.log(`\n=== ${t} ===\n  ${err.message}`);
    ok = false;
  }
}

if (!ok) {
  console.log('\nDependency gate FAILED. See docs/CI-SECURITY-GATES.md for how exceptions work.');
  process.exit(1);
}
console.log('\nDependency gate passed.');