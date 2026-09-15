import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

function coldCacheBranch(file: string): string {
  const sourceText = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let match: ts.IfStatement | null = null;

  function visit(node: ts.Node): void {
    if (
      !match
      && ts.isIfStatement(node)
      && node.expression.getText(sf).replace(/\s+/g, ' ') === 'cached && !data'
    ) {
      match = node;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  if (!match) throw new Error('could not find the Today cold-cache branch');
  return match.thenStatement.getText(sf);
}

describe('offline cold-start local reminder recovery', () => {
  const todayScreen = fileURLToPath(new URL('../app/(tabs)/today.tsx', import.meta.url));

  it('restores self-profile reminders from the merged secure cache when the network is unavailable', () => {
    const branch = coldCacheBranch(todayScreen);

    // Android revokes and deletes future exact alarms when exact-alarm access is
    // removed. A later offline cold start can still render this encrypted cache,
    // so it must also reconstruct local reminders from the same queued-state-
    // adjusted view rather than leaving the user silently without reminders.
    expect(branch).toContain('activeProfile.isSelf');
    expect(branch).toContain('remindersAreCurrent()');
    expect(branch).toContain('rescheduleLocalNotifications(');
    expect(branch).toContain('views,');
    expect(branch).toContain('preferences.voiceRemindersEnabled');
    expect(branch).toContain('preferences.showMedicationInNotifications');
    expect(branch).toContain('setExactAlarmsUnavailable(schedule.exactAlarmsUnavailable)');
  });

  it('keeps offline cache recovery scoped to the owned self profile', () => {
    const branch = coldCacheBranch(todayScreen);
    const selfGuard = branch.indexOf('activeProfile.isSelf');
    const scheduleCall = branch.indexOf('rescheduleLocalNotifications(');

    expect(selfGuard).toBeGreaterThanOrEqual(0);
    expect(scheduleCall).toBeGreaterThan(selfGuard);
  });
});
