/**
 * End-to-end test for the admin-rating re-import path:
 *   filled rating .xlsx  →  importRatings()  →  skill_input + player_attribute
 *                        →  recomputed player_skill  →  populated export
 *
 * Uses the real filled workbook at exports/Wednesday_Minis_rating_template.xlsx
 * (the sheet the admin actually filled). Booted on the embedded-PG harness.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { startHarness, stopHarness, getPool } from './pgHarness.js';
import { readPlayersCsv, splitRows, portPlayers } from '../migrations/port_v1_players.js';
import { readRatingsXlsx, importRatings } from '../scripts/import_ratings.js';
import { fetchRoster } from '../exportSkills.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

function findLatestCsv() {
  const dir = path.join(__dirname, '..', 'migrations', 'v1_data');
  const files = fs.readdirSync(dir).filter(f => /^v1_players_.*\.csv$/.test(f)).sort();
  if (!files.length) throw new Error(`no v1_players_*.csv in ${dir}`);
  return path.join(dir, files[files.length - 1]);
}

async function run() {
  console.log('booting embedded PG...');
  await startHarness({ fresh: true });
  const pool = getPool();
  const client = await pool.connect();
  try {
    // Seed the roster (port v1 players) so the import has targets.
    const rows = readPlayersCsv(findLatestCsv());
    const { kept } = splitRows(rows, false);
    const ported = await portPlayers(client, kept, 'Wednesday Minis');
    check('roster seeded', ported.inserted === kept.length, `inserted ${ported.inserted}`);

    // --- parse the filled workbook ---
    console.log('\n--- read filled xlsx ---');
    const xlsxPath = path.join(__dirname, '..', '..', 'exports', 'Wednesday_Minis_rating_template.xlsx');
    const rated = await readRatingsXlsx(xlsxPath);
    check('parsed rated rows', rated.length === 44, `${rated.length} rows`);
    const karan = rated.find(r => r.name === 'Karan Arora');
    check('parses a high rating (Karan 1600/1500)',
      karan && karan.offence === 1600 && karan.defence === 1500,
      karan ? `off=${karan.offence} def=${karan.defence}` : 'missing');
    check('parses position + od pref',
      karan && karan.position === 'hybrid' && karan.od_preference === 'defence',
      karan ? `pos=${karan.position} od=${karan.od_preference}` : 'missing');

    // --- import (legacy 0–2500 sheet → converted to 0–100 via fromScale) ---
    console.log('\n--- importRatings (fromScale 2500 → 0–100) ---');
    const imp = await importRatings(client, rated, 'Wednesday Minis', { fromScale: 2500 });
    check('all rated, none missing', imp.rated === 44 && imp.missing.length === 0,
      `rated ${imp.rated}, missing ${imp.missing.length}`);

    const adminRows = (await client.query(
      `SELECT COUNT(*)::int n FROM skill_input WHERE source = 'admin'`)).rows[0].n;
    check('one admin skill_input per rated player', adminRows === 44, `${adminRows} rows`);

    // Karan 1600/1500 on the old scale → 64/60 on 0–100; headline 62.
    const karanSkill = (await client.query(
      `SELECT ps.offence_skill, ps.defence_skill, ps.headline_scalar
       FROM player_skill ps
       JOIN player pl ON pl.player_id = ps.player_id
       JOIN person pr ON pr.person_id = pl.person_id
       WHERE pr.name = 'Karan Arora'`)).rows[0];
    check('Karan rescaled to 0–100 (64/60, headline 62)',
      karanSkill && Math.abs(karanSkill.offence_skill - 64) < 0.01
        && Math.abs(karanSkill.defence_skill - 60) < 0.01
        && Math.abs(karanSkill.headline_scalar - 62) < 0.01,
      karanSkill ? JSON.stringify(karanSkill) : 'missing');

    const karanAttr = (await client.query(
      `SELECT pa.position, pa.od_preference FROM player_attribute pa
       JOIN player pl ON pl.player_id = pa.player_id
       JOIN person pr ON pr.person_id = pl.person_id
       WHERE pr.name = 'Karan Arora'`)).rows[0];
    check('Karan attributes stored',
      karanAttr && karanAttr.position === 'hybrid' && karanAttr.od_preference === 'defence');

    // --- idempotency: re-import refreshes, does not stack ---
    console.log('\n--- re-import (idempotent) ---');
    await importRatings(client, rated, 'Wednesday Minis', { fromScale: 2500 });
    const adminRows2 = (await client.query(
      `SELECT COUNT(*)::int n FROM skill_input WHERE source = 'admin'`)).rows[0].n;
    check('admin rows still 44 after re-import (no stacking)', adminRows2 === 44, `${adminRows2} rows`);

    // --- export now shows populated skills, sorted ---
    console.log('\n--- populated export ---');
    const roster = await fetchRoster(ported.contextId, client);
    check('every player rated (no nulls)',
      roster.every(r => r.offence_skill != null), 'some null');
    const top = roster[0];
    check('highest headline sorts to top',
      Number(top.offence_skill) >= Number(roster[roster.length - 1].offence_skill ?? 0),
      `top=${top.name}`);

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    if (failed.length) { console.error('FAILURES:', failed); process.exitCode = 1; }
  } finally {
    client.release();
    await stopHarness();
  }
}

run().catch(e => {
  console.error('test crashed:', e);
  process.exitCode = 1;
  stopHarness().catch(() => {});
});
