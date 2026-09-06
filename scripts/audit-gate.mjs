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
    // Runtime only. A build-time advisory in a dev dependency cannot be reached
    // by a request from the internet, and treating it as equal to one in the
    // running service is what makes a gate too noisy to keep.
    args: ['audit', '--json', '--omit=dev'],
    failRuntimeAt: 'high',
    failBuildAt: 'critical',
    label: 'root (API + worker runtime dependencies)',
  },
  mobile: {
    cwd: resolve(ROOT, 'apps/mobile'),
    // `--omit=dev` is deliberately NOT used here, and it would change nothing
    // if it were: measured, mobile reports the same 33 entries either way,
    // because `expo` is a runtime dependency and the entire CLI and bundler
    // hang beneath it. The build/runtime split that matters is computed from
    // the dependency graph instead — see BUILD_TOOLCHAIN.
    args: ['audit', '--json'],
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
 * for a reason unrelated to security — it is escalated to a person.
 *
 * Every entry here is build-toolchain, and every one is fixed only by a MAJOR
 * Expo or React Native upgrade. That upgrade is a product decision with its own
 * testing, not something a security gate should force on a Tuesday.
 */
const BASELINE = [
  {
    workspace: 'mobile',
    module: 'tar',
    severity: 'critical',
    advisories: [
      'GHSA-34x7-hfp2-rc4v', 'GHSA-8qq5-rm4j-mr97', 'GHSA-83g3-92jg-28cx', 'GHSA-qffp-2rhf-9h96',
      'GHSA-9ppj-qmqm-q256', 'GHSA-r6q2-hw4h-h46w', 'GHSA-vmf3-w455-68vh', 'GHSA-w8wr-v893-vjvp',
      'GHSA-23hp-3jrh-7fpw', 'GHSA-8x88-c5mf-7j5w', 'GHSA-gvwx-54wh-qm9j', 'GHSA-r292-9mhp-454m',
    ],
    accepted: '2026-09-06',
    reviewBy: '2026-12-06',
    reason:
      'Reached only as expo -> @expo/cli -> cacache -> tar. It extracts archives on the machine '
      + 'that BUILDS the app; it is not bundled into the binary a patient installs, so the '
      + 'arbitrary-file-write is a build-server risk, not a patient risk. Fixed only by expo@57, '
      + 'a major upgrade across the whole SDK.',
    endsWhen: 'The Expo SDK is upgraded to a version whose tree resolves a patched tar, or the app stops depending on @expo/cli.',
  },
  {
    workspace: 'mobile',
    module: 'postcss',
    severity: 'high',
    advisories: ['GHSA-qx2v-qp2m-jg93', 'GHSA-6g55-p6wh-862q', 'GHSA-fxqj-rqcc-2cmp', 'GHSA-r28c-9q8g-f849'],
    accepted: '2026-09-06',
    reviewBy: '2026-12-06',
    reason:
      'Reached only through @expo/metro-config. It processes CSS during bundling; this app ships '
      + 'no CSS and postcss does not run on a device. Fixed only by a major React Native upgrade.',
    endsWhen: 'React Native / Expo upgrade, or Metro drops the postcss dependency.',
  },
  {
    workspace: 'mobile',
    module: 'image-size',
    severity: 'high',
    advisories: ['GHSA-w3rx-r6r6-pgpr', 'GHSA-5p2g-fcmc-qvqq'],
    accepted: '2026-09-06',
    reviewBy: '2026-12-06',
    reason:
      'Reached only through metro. It reads image dimensions at bundle time from assets committed '
      + 'to this repository, never from user input at runtime. Fixed only by react-native@0.86, a major upgrade.',
    endsWhen: 'React Native upgrade.',
  },
  {
    workspace: 'mobile',
    module: '@xmldom/xmldom',
    severity: 'high',
    advisories: [
      'GHSA-wh4c-j3r5-mjhp', 'GHSA-2v35-w6hq-6mfw', 'GHSA-f6ww-3ggp-fr8h',
      'GHSA-x6wf-f3px-wcqx', 'GHSA-j759-j44w-7fr8', 'GHSA-6gmq-8vp8-gcm6',
    ],
    accepted: '2026-09-06',
    reviewBy: '2026-12-06',
    reason:
      'Reached only through @expo/plist -> @expo/config-plugins. It parses Info.plist and '
      + 'AndroidManifest during prebuild, from files in this repository. Fixed only by expo@57.',
    endsWhen: 'Expo SDK upgrade.',
  },
  {
    workspace: 'mobile',
    module: 'uuid',
    severity: 'moderate',
    advisories: ['GHSA-w5hq-g745-h8pq'],
    accepted: '2026-09-06',
    reviewBy: '2026-12-06',
    reason:
      'Reached only through @expo/rudder-sdk-node and xcode — Expo CLI telemetry and the iOS '
      + 'project generator. Below the build-toolchain threshold; listed so the review is deliberate.',
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

function runAudit(ws) {
  try {
    return execFileSync('npm', ws.args, { cwd: ws.cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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
 * many times. Measured on this tree: six real advisory roots were reported as
 * thirty-three entries, with `expo` and `react-native` both listed HIGH purely
 * because something far beneath them was. Reading the aggregate count as the
 * finding count turns a dependency report into theatre — in both directions,
 * since it also buries the one entry that matters.
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
 * Packages that exist only to build the app, never to run it.
 *
 * npm's dev/production split does not model React Native's bundling boundary.
 * `expo` is a runtime dependency; `@expo/cli` and the Metro bundler are its
 * dependencies; so npm classifies the whole build toolchain as production. It
 * is not. `tar`, `postcss` and Metro run on a developer's machine or a build
 * server, none of them is bundled into the binary a patient installs, and an
 * arbitrary-file-write in `tar` reached through `@expo/cli` is a build-server
 * risk rather than a patient risk.
 *
 * Holding both to one threshold is what makes a gate noisy enough to be
 * switched off. They are separated here and held to different thresholds —
 * separated, not ignored.
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
  for (const r of roots) r.buildTime = isBuildTimeOnly(r.module, report.vulnerabilities);

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
