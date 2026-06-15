/**
 * Slot-math + roster sanity: SPEC_17 minimum slice.
 *
 * Scenario: capacity 3 event, 4 people register in order, 1 withdraws,
 * promoteEvent fills the freed slot from the waitlist.
 */
import { startHarness, stopHarness, getPool } from './pgHarness.js';
import { applyV2Schema, applyV2Seed } from '../initDb.js';
import {
  newShareToken,
  registerForEvent,
  withdrawFromEvent,
  promoteEvent,
  getPublicEvent,
  getAdminRoster,
} from '../eventService.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function run() {
  console.log('booting embedded PG...');
  await startHarness({ fresh: true });
  const pool = getPool();
  const client = await pool.connect();
  try {
    await applyV2Schema(client);
    await applyV2Seed(client);

    const ctxId = (await client.query(`SELECT context_id FROM context LIMIT 1`)).rows[0].context_id;
    const adminId = (await client.query(
      `SELECT person_id FROM person WHERE rating_token='system:bootstrap-admin'`,
    )).rows[0].person_id;

    // Seed 4 real people in order — signup time will follow this order.
    const names = ['Alice', 'Bob', 'Carol', 'Dave'];
    const ids = [];
    for (const name of names) {
      const p = (await client.query(
        `INSERT INTO person (name) VALUES ($1) RETURNING person_id`, [name],
      )).rows[0];
      ids.push(p.person_id);
      await client.query(
        `INSERT INTO player (person_id, context_id) VALUES ($1, $2)`,
        [p.person_id, ctxId],
      );
    }

    // Create an event (capacity 3).
    const share_token = newShareToken();
    const ev = (await client.query(
      `INSERT INTO event (context_id, title, event_date, capacity, share_token, created_by)
            VALUES ($1, 'Test Minis', CURRENT_DATE + 2, 3, $2, $3)
            RETURNING *`,
      [ctxId, share_token, adminId],
    )).rows[0];
    check('event created with capacity 3', ev.capacity === 3);
    check('share_token is hex', /^[0-9a-f]{48}$/.test(share_token));

    // Register Alice, Bob, Carol → all main; Dave → waitlist.
    const r1 = await registerForEvent(ev.event_id, ids[0]);
    // Force a small monotonic gap so signed_up_at ordering is deterministic.
    await new Promise(r => setTimeout(r, 15));
    const r2 = await registerForEvent(ev.event_id, ids[1]);
    await new Promise(r => setTimeout(r, 15));
    const r3 = await registerForEvent(ev.event_id, ids[2]);
    await new Promise(r => setTimeout(r, 15));
    const r4 = await registerForEvent(ev.event_id, ids[3]);

    check('Alice → main',    r1.registration.status === 'main',     r1.registration.status);
    check('Bob → main',      r2.registration.status === 'main',     r2.registration.status);
    check('Carol → main',    r3.registration.status === 'main',     r3.registration.status);
    check('Dave → waitlist', r4.registration.status === 'waitlist', r4.registration.status);

    // Idempotency: Bob re-registers → no change, no new row.
    const r2dup = await registerForEvent(ev.event_id, ids[1]);
    check('idempotent re-register returns existing',
      r2dup.registration.id === r2.registration.id);
    const rowCount = (await client.query(
      `SELECT COUNT(*)::int AS c FROM event_registration WHERE event_id=$1`,
      [ev.event_id],
    )).rows[0].c;
    check('still 4 registration rows after re-register', rowCount === 4);

    // Roster view (admin).
    const roster = await getAdminRoster(ev.event_id);
    check('roster main has 3 in signup order',
      roster.main.map(r => r.name).join(',') === 'Alice,Bob,Carol',
      roster.main.map(r => r.name).join(','));
    check('roster waitlist has Dave first',
      roster.waitlist[0]?.name === 'Dave');

    // Public view as Dave (waitlist): position should be 1.
    const pubAsDave = await getPublicEvent(share_token, ids[3]);
    check('Dave sees waitlist position 1',
      pubAsDave?.me?.status === 'waitlist' && pubAsDave?.me?.position === 1,
      JSON.stringify(pubAsDave?.me));
    check('public counts: main=3, waitlist=1',
      pubAsDave.main_count === 3 && pubAsDave.waitlist_count === 1);

    // Alice withdraws.
    const w = await withdrawFromEvent(ev.event_id, ids[0]);
    check('Alice withdraw → status withdrawn',
      w.registration.status === 'withdrawn');

    const afterWithdraw = await getAdminRoster(ev.event_id);
    check('main shrinks to 2 (no inline promotion)',
      afterWithdraw.main.length === 2,
      `main=${afterWithdraw.main.length}`);
    check('Dave still on waitlist before sweep',
      afterWithdraw.waitlist[0]?.name === 'Dave');

    // Promote sweep.
    const promo = await promoteEvent(ev.event_id);
    check('sweep promoted exactly 1', promo.promoted.length === 1,
      `promoted=${promo.promoted.length}`);

    const final = await getAdminRoster(ev.event_id);
    check('main is now Bob, Carol, Dave (in original signup order)',
      final.main.map(r => r.name).join(',') === 'Bob,Carol,Dave',
      final.main.map(r => r.name).join(','));
    check('waitlist now empty', final.waitlist.length === 0);
    check('withdrawn list has Alice', final.withdrawn[0]?.name === 'Alice');

    // Alice re-registers → goes to back-of-line (would be waitlist; capacity full).
    const reAlice = await registerForEvent(ev.event_id, ids[0]);
    check('Alice re-register → waitlist (back of line)',
      reAlice.registration.status === 'waitlist',
      reAlice.registration.status);
    const finalRoster = await getAdminRoster(ev.event_id);
    check('only 4 rows still — Alice re-used her existing row',
      finalRoster.main.length + finalRoster.waitlist.length + finalRoster.withdrawn.length === 4);

    // Closed event rejects new registrations.
    await client.query(`UPDATE event SET status='closed' WHERE event_id=$1`, [ev.event_id]);
    // create a fresh person to try
    const eve = (await client.query(`INSERT INTO person (name) VALUES ('Eve') RETURNING person_id`)).rows[0];
    await client.query(`INSERT INTO player (person_id, context_id) VALUES ($1, $2)`, [eve.person_id, ctxId]);
    const blocked = await registerForEvent(ev.event_id, eve.person_id);
    check('closed event rejects registration', !blocked.ok && blocked.status === 409);

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    if (failed.length) {
      console.error('FAILED:', failed.map(f => f.name).join(' | '));
      process.exitCode = 1;
    }
  } finally {
    client.release();
    await stopHarness();
  }
}

run().catch(e => { console.error(e); process.exit(1); });
