/** Actual Today/request-scope modules; controlled host hooks and transport.
 * This checks UI action wiring/request intent, not native rendering or API/RLS.
 */
const assert = require('node:assert/strict');
const { createHarness, NetworkError } = require('./profile-screen-harness.cjs');
const owner = { id: 'DEPENDENT', displayName: 'Dependent', isSelf: false, role: 'owner', permissions: null };
const helper = { id: 'PATIENT', displayName: 'Patient', isSelf: false, role: 'caregiver', permissions: ['view_medications', 'view_schedule'] };
const observer = {
  id: 'OBSERVER', displayName: 'Observer patient', isSelf: false, role: 'caregiver',
  permissions: ['view_schedule', 'view_adherence', 'receive_notifications'],
};
const actions = ['onTaken', 'onUndo', 'onSnooze', 'onSkip'];

async function load(file, hook, profile, empty = false) {
  const routes = [];
  const h = createHarness(file, hook, profile, { 'expo-router': { router: { push: r => routes.push(r) } } });
  if (!empty) h.answer(h.batch(), profile.id);
  else {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    for (const r of h.batch()) {
      assert.equal(r.route, '/v1/today');
      r.completed = true;
      r.resolve({ profileId: profile.id, localDate: date, timezone: 'Asia/Riyadh', serverTime: new Date().toISOString(), today: [], next: null, prefetch: [], prefetchDays: 7 });
    }
  }
  await h.flush();
  return { h, routes };
}

function scenarios(file, hook) {
  const cases = [];
  const add = (name, profile, empty, body) => cases.push({ name, run: async () => {
    const { h, routes } = await load(file, hook, profile, empty);
    try { await body(h, routes); } finally { h.unmount(); }
  } });
  for (const action of actions) add(`an owned dependent exposes ${action} despite isSelf=false and permissions=null`, owner, false, async h => {
    const card = h.find('DoseCard', p => p.prominent);
    assert.ok(card, 'the due dose positive control must be rendered');
    assert.equal(typeof card[action], 'function');
    assert.equal(h.notifications.length, 0, 'viewing a dependent must not create local reminders');
  });
  add('an owned dependent empty state offers add medication and routes to the existing form', owner, true, async (h, routes) => {
    assert.ok(h.find('EmptyState'));
    const button = h.find('Button', p => p.label === 'medication.add');
    assert.ok(button, 'owner add action must be available');
    button.onPress();
    assert.deepEqual(routes, ['/medication/add']);
    assert.equal(h.notifications.length, 0);
  });
  add('owned dependent Taken dispatches that exact dose, retaining profile scope on reload', owner, false, async h => {
    const taken = h.find('DoseCard', p => p.prominent)?.onTaken;
    assert.equal(typeof taken, 'function');
    taken(); await h.flush();
    const posts = h.batch().filter(r => r.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].route, '/v1/dose/action');
    assert.equal(posts[0].payload.doseId, 'dose-DEPENDENT');
    assert.equal(posts[0].payload.action, 'taken');
    assert.equal(posts[0].payload.deviceId, 'synthetic-device');
    assert.ok(posts[0].payload.clientEventId);
    h.answer(posts, owner.id); await h.flush();
    const reload = h.batch();
    assert.equal(reload.length, 1);
    assert.equal(reload[0].payload.profileId, owner.id);
    h.answer(reload, owner.id); await h.flush();
    assert.equal(h.notifications.length, 0);
  });
  add('owned dependent Taken queues the exact dependent dose on network failure', owner, false, async h => {
    const taken = h.find('DoseCard', p => p.prominent)?.onTaken;
    assert.equal(typeof taken, 'function');
    taken(); await h.flush();
    h.fail(h.batch(), new NetworkError('synthetic offline')); await h.flush();
    assert.equal(h.queued.length, 1);
    assert.equal(h.queued[0].doseOccurrenceId, 'dose-DEPENDENT');
    assert.equal(h.queued[0].type, 'taken');
    assert.equal(h.app.offline, true);
    assert.equal(h.notifications.length, 0);
  });
  add('read-only caregiver still has no dose action callbacks', helper, false, async h => {
    const card = h.find('DoseCard', p => p.prominent);
    assert.ok(card);
    for (const action of actions) assert.equal(card[action], undefined);
    assert.equal(h.notifications.length, 0);
  });
  add('read-only caregiver empty state still has no add-medication action', helper, true, async h => {
    assert.ok(h.find('EmptyState'));
    assert.equal(h.find('Button', p => p.label === 'medication.add'), null);
  });
  add('caregiver with confirm_dose keeps explicit confirmation actions without local reminders', { ...helper, permissions: [...helper.permissions, 'confirm_dose'] }, false, async h => {
    const card = h.find('DoseCard', p => p.prominent);
    assert.ok(card);
    for (const action of actions) assert.equal(typeof card[action], 'function');
    assert.equal(h.notifications.length, 0);
  });
  add('caregiver with add_medication keeps the granted add action', { ...helper, permissions: [...helper.permissions, 'add_medication'] }, true, async h => {
    assert.ok(h.find('Button', p => p.label === 'medication.add'));
  });
  cases.push({ name: 'observer without medication visibility never requests Today and sees a restricted state', run: async () => {
    const h = createHarness(file, hook, observer);
    await h.flush();
    try {
      const pending = h.batch();
      assert.equal(
        pending.length,
        0,
        'view_schedule without view_medications must not call /v1/today because that response includes medication identity',
      );
      assert.equal(h.cachedReads.length, 0, 'a caregiver without medication visibility must not read a medication-bearing Today cache');
      assert.ok(
        h.find('Banner', p => p.tone === 'warning'),
        'the screen must explain that Today is restricted instead of rendering a false no-medications state',
      );
      assert.equal(
        h.find('EmptyState', p => p.title === 'today.noMedications'),
        null,
        'authorization restriction must not be indistinguishable from a genuinely empty medication list',
      );
    } finally { h.unmount(); }
  } });
  add('self-profile owner keeps confirmation controls and its own reminder scheduling', { ...owner, id: 'SELF', isSelf: true }, false, async h => {
    const card = h.find('DoseCard', p => p.prominent);
    assert.ok(card);
    for (const action of actions) assert.equal(typeof card[action], 'function');
    assert.equal(h.notifications.length, 1);
    assert.equal(h.notifications[0][0].id, 'dose-SELF');
  });
  return cases;
}
module.exports = { scenarios };
