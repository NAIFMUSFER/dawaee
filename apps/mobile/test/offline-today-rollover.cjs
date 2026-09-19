/** Actual Today TSX and request hook, using the existing host-controlled screen
 * harness. Native UI, storage and network are simulated; no device E2E claim. */
const assert = require('node:assert/strict');
const { createHarness } = require('./profile-screen-harness.cjs');

function cachedDose(id, localDate, scheduledAt, status = 'upcoming') {
  return { id, scheduledAt, scheduledLocalTime: '08:00', scheduledLocalDate: localDate,
    medicationName: `SYNTHETIC-${id}`, doseQuantity: 1, doseUnit: 'tablet',
    foodInstruction: 'no_preference', status };
}
function cards(tree) {
  if (!tree || typeof tree !== 'object') return [];
  const type = typeof tree.type === 'function' ? tree.type.name : tree.type;
  const own = type === 'DoseCard' ? [tree.props] : [];
  return own.concat(Object.values(tree).flatMap(cards));
}
function scenarios(screenFile, hookFile) {
  const cases = [];
  const add = (name, doses, check, opts = {}) => cases.push({ name, run: async () => {
    const NativeDate = global.Date;
    const instant = opts.now || '2026-09-09T21:30:00.000Z'; // 00:30 on Sep 10 in Riyadh.
    class FixedDate extends NativeDate {
      constructor(...args) { if (args.length) super(...args); else super(instant); }
      static now() { return NativeDate.parse(instant); }
    }
    let h;
    try {
      global.Date = FixedDate;
      const timezone = opts.timezone || 'Asia/Riyadh';
      h = createHarness(screenFile, hookFile, { role: 'owner', isSelf: true, timezone });
      h.cacheReader = async (id) => {
        assert.equal(id, 'A');
        return { profileId: id, timezone, cachedAt: '2026-09-09T00:00:00.000Z', doses };
      };
      const initial = h.batch();
      assert.equal(initial.length, 1, 'the actual Today request must start');
      assert.equal(initial[0].route, '/v1/today');
      h.fail(initial);
      await h.flush();
      assert.equal(h.app.offline, true);
      assert.equal(h.find('Loading'), null);
      assert.deepEqual(h.cachedReads, ['A']);
      await check(h);
    } finally {
      h?.unmount();
      global.Date = NativeDate;
    }
  } });
  const yesterday = cachedDose('YESTERDAY', '2026-09-09', '2026-09-09T05:00:00.000Z');
  const today = cachedDose('TODAY', '2026-09-10', '2026-09-10T05:00:00.000Z');
  const later = cachedDose('LATER', '2026-09-10', '2026-09-10T06:00:00.000Z');
  const tomorrow = cachedDose('TOMORROW', '2026-09-11', '2026-09-11T05:00:00.000Z');
  const hero = h => h.find('DoseCard', p => p.prominent);
  // These rollover fixtures are after local midnight but before their dose
  // times. The grouped Today screen must show them without early actions.
  const upcoming = (h, ids) => {
    assert.equal(hero(h), null, 'a future cached dose became actionable');
    const pending = cards(h.tree).filter(p => p.dose.status === 'upcoming');
    assert.deepEqual(pending.map(p => p.dose.id), ids);
    for (const card of pending) {
      for (const action of ['onTaken', 'onSkip', 'onSnooze', 'onUndo']) {
        assert.equal(card[action], undefined, `${card.dose.id} offers ${action} before its scheduled time`);
      }
    }
  };
  add('control: a future current-day cached dose stays visible without early confirmation', [today], async h => {
    upcoming(h, ['TODAY']);
    const item = cards(h.tree)[0].dose;
    assert.equal(item.scheduledTimezone, 'Asia/Riyadh');
    assert.doesNotThrow(() => new Intl.DateTimeFormat('ar-SA', { timeZone: item.scheduledTimezone }).format(new Date(item.scheduledAt)));
  });
  add('an unresolved prior-day cached dose cannot hide the current-day schedule', [yesterday, today], async h => {
    upcoming(h, ['TODAY']);
    assert.doesNotMatch(h.text(), /SYNTHETIC-YESTERDAY/);
  });
  add('overlapping today/prefetch cache entries render only one list row per occurrence', [today, { ...today }], async h => {
    const listed = cards(h.tree);
    assert.equal(listed.length, 1, 'same occurrence is rendered twice in the daily list');
    assert.equal(listed[0].dose.id, 'TODAY');
  });
  add('cached ordering cannot promote a later dose ahead of the earliest current-day dose', [later, today], async h => {
    upcoming(h, ['TODAY', 'LATER']);
  });
  add('future prefetch entries cannot hide the current local day schedule', [tomorrow, today], async h => {
    upcoming(h, ['TODAY']);
    assert.doesNotMatch(h.text(), /SYNTHETIC-TOMORROW/);
  });
  add('control: resolved cached doses remain resolved and do not become the hero', [
    { ...today, id: 'TAKEN', status: 'taken' }, { ...today, id: 'SKIPPED', status: 'skipped' }, later,
  ], async h => {
    upcoming(h, ['LATER']);
    assert.equal(cards(h.tree).find(p => !p.prominent && p.dose.id === 'TAKEN').dose.status, 'taken');
    assert.equal(cards(h.tree).find(p => !p.prominent && p.dose.id === 'SKIPPED').dose.status, 'skipped');
  });
  add('day selection follows an east-of-UTC profile, not the UTC calendar date', [
    cachedDose('EAST-OLD', '2026-09-09', '2026-09-08T18:00:00.000Z'),
    cachedDose('EAST-TODAY', '2026-09-10', '2026-09-09T18:00:00.000Z'),
  ], async h => {
    upcoming(h, ['EAST-TODAY']);
    assert.equal(cards(h.tree).length, 1);
  }, { timezone: 'Pacific/Kiritimati', now: '2026-09-09T12:30:00.000Z' });
  add('day selection follows a west-of-UTC profile after the UTC date has changed', [
    cachedDose('WEST-OLD', '2026-09-08', '2026-09-09T04:00:00.000Z'),
    cachedDose('WEST-TODAY', '2026-09-09', '2026-09-10T04:00:00.000Z'),
  ], async h => {
    upcoming(h, ['WEST-TODAY']);
    assert.equal(cards(h.tree).length, 1);
  }, { timezone: 'Pacific/Honolulu', now: '2026-09-10T01:30:00.000Z' });
  add('the recovered current-day action submits its own occurrence and queues it on network failure', [yesterday, today], async h => {
    assert.ok(hero(h), 'no current-day confirmation control');
    hero(h).onTaken();
    const request = h.batch();
    assert.equal(request.length, 1);
    assert.equal(request[0].method, 'POST');
    assert.equal(request[0].route, '/v1/dose/action');
    assert.equal(request[0].payload.doseId, 'TODAY');
    assert.equal(request[0].payload.action, 'taken');
    assert.ok(request[0].payload.clientEventId);
    h.fail(request); await h.flush();
    assert.equal(h.queued.length, 1);
    assert.equal(h.queued[0].doseOccurrenceId, 'TODAY');
    assert.equal(h.queued[0].type, 'taken');
    assert.equal(cards(h.tree).find(p => !p.prominent && p.dose.id === 'TODAY').dose.status, 'taken');
  }, { now: '2026-09-10T05:00:00.000Z' });
  add('control: future-only cache does not offer premature confirmation today', [tomorrow], async h => {
    assert.equal(hero(h), null);
    assert.equal(cards(h.tree).length, 0);
  });
  return cases;
}
module.exports = { scenarios };
if (require.main === module) {
  // This runner executes source. CLI input must never select which file or
  // hook gets evaluated; use only the checked-in screen relative to this file.
  if (process.argv.length !== 2) {
    console.error('This runner accepts no file or hook arguments.');
    process.exitCode = 64;
  } else {
    (async () => {
      let failed = 0;
      const screen = require('node:path').join(__dirname, '../app/(tabs)/today.tsx');
      const cases = scenarios(screen);
      for (const scenario of cases) {
        try { await scenario.run(); console.log(`PASS ${scenario.name}`); }
        catch (error) { failed++; console.log(`FAIL ${scenario.name}\n  ${error.message}`); }
      }
      console.log(JSON.stringify({ total: cases.length, passed: cases.length - failed, failed }));
      process.exitCode = failed ? 1 : 0;
    })();
  }
}
