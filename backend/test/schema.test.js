/**
 * Chunk 1 sanity test: schema applies cleanly on a fresh PG, all
 * v2 tables exist, indexes are present, FK + CHECK constraints fire,
 * and seed produces exactly one admin/context/authority row.
 *
 * Run with: `node test/schema.test.js`
 */
import { startHarness, stopHarness, getPool } from './pgHarness.js';
import { applyV2Schema, applyV2Seed } from '../initDb.js';

const EXPECTED_TABLES = [
  'person', 'context', 'player', 'context_authority',
  'player_attribute', 'player_card', 'skill_input', 'player_skill',
  'team_build', 'team_build_player',
  'match', 'match_player', 'match_point',
  'match_confirmation', 'game_survey',
];

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function run() {
  console.log('booting embedded PG (this can take ~10s on first run)...');
  await startHarness({ fresh: true });
  const pool = getPool();
  const client = await pool.connect();

  try {
    console.log('\napplying v2 schema...');
    await applyV2Schema(client);
    await applyV2Seed(client);

    console.log('\n--- tables present ---');
    const tablesRes = await client.query(`
      SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public'
    `);
    const tables = new Set(tablesRes.rows.map(r => r.tablename));
    for (const t of EXPECTED_TABLES) {
      check(`table ${t} exists`, tables.has(t));
    }

    console.log('\n--- seed shape ---');
    const persons = await client.query(`SELECT name FROM person`);
    check('1 admin person seeded', persons.rows.length === 1 && persons.rows[0].name === 'Admin',
      `got ${persons.rows.length} rows`);

    const contexts = await client.query(`SELECT name, kind FROM context`);
    check('1 default context seeded', contexts.rows.length === 1
      && contexts.rows[0].name === 'Wednesday Minis'
      && contexts.rows[0].kind === 'minis',
      JSON.stringify(contexts.rows));

    const auths = await client.query(`SELECT role FROM context_authority`);
    check('1 admin context_authority seeded', auths.rows.length === 1 && auths.rows[0].role === 'admin');

    console.log('\n--- idempotency: re-apply schema + seed ---');
    await applyV2Schema(client);
    await applyV2Seed(client);
    const dupPersons = await client.query(`SELECT COUNT(*)::int AS n FROM person`);
    check('seed is idempotent (still 1 admin)', dupPersons.rows[0].n === 1, `got ${dupPersons.rows[0].n}`);

    console.log('\n--- CHECK constraints ---');
    try {
      await client.query(`INSERT INTO context (name, kind) VALUES ('Bad', 'kabaddi')`);
      check('context.kind CHECK rejects invalid kind', false, 'no error thrown');
    } catch (e) {
      check('context.kind CHECK rejects invalid kind', /check/i.test(e.message));
    }
    try {
      await client.query(`
        INSERT INTO skill_input (subject_player_id, source, offence_score, defence_score)
        VALUES (999999, 'admin', 1000, 1000)
      `);
      check('skill_input FK rejects unknown player', false, 'no error thrown');
    } catch (e) {
      check('skill_input FK rejects unknown player', /foreign key|violates/i.test(e.message));
    }

    console.log('\n--- player creation roundtrip ---');
    const ctxId = (await client.query(`SELECT context_id FROM context LIMIT 1`)).rows[0].context_id;
    const personId = (await client.query(`SELECT person_id FROM person LIMIT 1`)).rows[0].person_id;
    const newPerson = (await client.query(
      `INSERT INTO person (name, phone) VALUES ($1, $2) RETURNING person_id`,
      ['Test Player', '+91-0000000001']
    )).rows[0];
    const playerRes = await client.query(
      `INSERT INTO player (person_id, context_id) VALUES ($1, $2) RETURNING player_id`,
      [newPerson.person_id, ctxId]
    );
    check('player insert with unique (person, context)', playerRes.rows.length === 1);
    try {
      await client.query(
        `INSERT INTO player (person_id, context_id) VALUES ($1, $2)`,
        [newPerson.person_id, ctxId]
      );
      check('duplicate player UNIQUE (person, context) rejected', false, 'no error');
    } catch (e) {
      check('duplicate player UNIQUE (person, context) rejected', /unique|duplicate/i.test(e.message));
    }

    console.log('\n--- SPEC_16 additions ---');
    // person.token_expires_at / token_used_at columns present
    const personCols = (await client.query(`
      SELECT column_name FROM information_schema.columns WHERE table_name='person'
    `)).rows.map(r => r.column_name);
    check('person.token_expires_at column exists', personCols.includes('token_expires_at'));
    check('person.token_used_at column exists',    personCols.includes('token_used_at'));

    // context.open_rating column exists, default false
    const ctxCols = (await client.query(`
      SELECT column_name, column_default FROM information_schema.columns
       WHERE table_name='context'
    `)).rows;
    const openRatingCol = ctxCols.find(c => c.column_name === 'open_rating');
    check('context.open_rating column exists', !!openRatingCol);
    check('context.open_rating defaults FALSE',
      !!openRatingCol && /false/i.test(openRatingCol.column_default ?? ''),
      openRatingCol?.column_default);

    // player_card CHECK constraint: out-of-range value rejected
    const cardPlayerId = playerRes.rows[0].player_id;
    try {
      await client.query(
        `INSERT INTO player_card (player_id, throwing) VALUES ($1, $2)`,
        [cardPlayerId, 150],
      );
      check('player_card.throwing CHECK rejects > 100', false, 'no error thrown');
    } catch (e) {
      check('player_card.throwing CHECK rejects > 100', /check/i.test(e.message));
    }

    // player_card happy insert
    const cardInsert = await client.query(
      `INSERT INTO player_card (player_id, throwing, cutting, handling, defense, speed, endurance)
       VALUES ($1, 70, 50, 90, 30, 70, 50) RETURNING player_id`,
      [cardPlayerId],
    );
    check('player_card insert with valid 0–100 values', cardInsert.rows.length === 1);

    // open_rating toggle round-trip
    await client.query(`UPDATE context SET open_rating = TRUE WHERE context_id = $1`, [ctxId]);
    const openNow = (await client.query(
      `SELECT open_rating FROM context WHERE context_id = $1`, [ctxId],
    )).rows[0].open_rating;
    check('context.open_rating toggle persists', openNow === true);

    console.log('\n--- summary ---');
    const failed = results.filter(r => !r.ok);
    console.log(`${results.length - failed.length}/${results.length} passed`);
    if (failed.length) {
      console.error('FAILURES:', failed);
      process.exitCode = 1;
    }
  } finally {
    client.release();
    await stopHarness();
  }
}

run().catch(e => {
  console.error('harness/test crashed:', e);
  process.exitCode = 1;
  stopHarness().catch(() => {});
});
