/**
 * End-to-end test for the Wednesday-minis deliverable:
 *   real v1 CSV  →  portPlayers()  →  buildSkillsWorkbook()  →  .xlsx
 *
 * Exercises the actual pulled data (migrations/v1_data/v1_players_*.csv), the
 * migration logic, idempotency, and the spreadsheet shape. Booted on the
 * embedded-PG harness like the other suites.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { startHarness, stopHarness, getPool } from './pgHarness.js';
import { readPlayersCsv, splitRows, portPlayers } from '../migrations/port_v1_players.js';
import { buildSkillsWorkbook, fetchRoster } from '../exportSkills.js';
import { recomputePlayerSkill } from '../skillService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

function findLatestCsv() {
  const dir = path.join(__dirname, '..', 'migrations', 'v1_data');
  const files = fs.readdirSync(dir)
    .filter(f => /^v1_players_.*\.csv$/.test(f))
    .sort();
  if (!files.length) throw new Error(`no v1_players_*.csv in ${dir}`);
  return path.join(dir, files[files.length - 1]);
}

async function run() {
  console.log('booting embedded PG...');
  await startHarness({ fresh: true });
  const pool = getPool();
  const client = await pool.connect();
  try {
    // --- CSV parsing ---
    console.log('\n--- csv parse ---');
    const csvPath = findLatestCsv();
    const rows = readPlayersCsv(csvPath);
    check('csv has rows', rows.length > 0, `${rows.length} rows`);
    const partha = rows.find(r => r.player_name === 'Dr. Partha Patil');
    check('parses name with dots/spaces', !!partha);
    const shantanu = rows.find(r => r.player_name === 'Shantanu Vatsa');
    check('parses Shantanu Vatsa', !!shantanu);
    const surya = rows.find(r => r.player_name === 'Suryanshu Chauhan');
    check('parses fractional elo', surya && Math.abs(surya.current_elo - 1055.415) < 0.01,
      surya ? `elo=${surya.current_elo}` : 'missing');

    // --- test-name split ---
    console.log('\n--- demo-name filter ---');
    const { kept, skipped } = splitRows(rows, false);
    check('8 demo names skipped', skipped.length === 8, `skipped ${skipped.length}`);
    check('kept = total - 8', kept.length === rows.length - 8, `kept ${kept.length}`);
    check('Alice excluded', !kept.some(r => r.player_name === 'Alice'));
    check('Shantanu kept', kept.some(r => r.player_name === 'Shantanu Vatsa'));

    // --- port (insert) ---
    console.log('\n--- portPlayers insert ---');
    const r1 = await portPlayers(client, kept, 'Wednesday Minis');
    check('all kept inserted', r1.inserted === kept.length, `inserted ${r1.inserted}`);
    check('none updated on first run', r1.updated === 0);
    const playerCount = (await client.query(
      `SELECT COUNT(*)::int n FROM player WHERE context_id = $1`, [r1.contextId],
    )).rows[0].n;
    check('player rows match kept', playerCount === kept.length, `db has ${playerCount}`);
    const statKept = (await client.query(
      `SELECT current_elo, total_games, wins, losses FROM player_statistics_cache psc
       JOIN player pl ON pl.player_id = psc.player_id
       JOIN person pr ON pr.person_id = pl.person_id
       WHERE pr.name = 'Suryanshu Chauhan'`,
    )).rows[0];
    check('Suryanshu stats carried (elo ~1055.4, 3g, 3-0)',
      statKept && Math.abs(statKept.current_elo - 1055.415) < 0.01 && statKept.total_games === 3
        && statKept.wins === 3 && statKept.losses === 0,
      statKept ? JSON.stringify(statKept) : 'missing');

    // --- idempotency ---
    console.log('\n--- portPlayers re-run (idempotent) ---');
    const r2 = await portPlayers(client, kept, 'Wednesday Minis');
    check('re-run inserts nothing', r2.inserted === 0, `inserted ${r2.inserted}`);
    check('re-run updates all', r2.updated === kept.length, `updated ${r2.updated}`);
    const playerCount2 = (await client.query(
      `SELECT COUNT(*)::int n FROM player WHERE context_id = $1`, [r2.contextId],
    )).rows[0].n;
    check('no duplicate players after re-run', playerCount2 === kept.length, `db has ${playerCount2}`);

    // --- admin rating one player → skill column populates ---
    console.log('\n--- one admin rating populates skill ---');
    const shanPlayer = (await client.query(
      `SELECT pl.player_id FROM player pl JOIN person pr ON pr.person_id = pl.person_id
       WHERE pr.name = 'Shantanu Vatsa' AND pl.context_id = $1`, [r1.contextId],
    )).rows[0];
    await client.query(
      `INSERT INTO skill_input (subject_player_id, source, offence_score, defence_score)
       VALUES ($1, 'admin', 90, 80)`, [shanPlayer.player_id],
    );
    await recomputePlayerSkill(shanPlayer.player_id, client);

    // --- workbook ---
    console.log('\n--- buildSkillsWorkbook ---');
    const roster = await fetchRoster(r1.contextId, client);
    check('roster row per player', roster.length === kept.length, `roster ${roster.length}`);
    const ratedTop = roster[0];
    check('rated player sorts to top (headline desc NULLS LAST)',
      ratedTop.name === 'Shantanu Vatsa' && Math.abs(Number(ratedTop.offence_skill) - 90) < 0.01,
      `top=${ratedTop.name}`);
    const unrated = roster.find(r => r.name === 'Tarishi Jain');
    check('un-rated player has blank skill (not 1000)',
      unrated && unrated.offence_skill == null,
      unrated ? `offence=${unrated.offence_skill}` : 'missing');

    const wb = await buildSkillsWorkbook(r1.contextId, client, 'Wednesday Minis');
    const ws = wb.worksheets[0];
    check('sheet has header + all players', ws.rowCount === kept.length + 1, `rowCount ${ws.rowCount}`);
    check('first column header is Player', ws.getRow(1).getCell(1).value === 'Player');
    check('headline column present',
      ws.getRow(1).values.includes('Headline'));

    // Write a real file and confirm it is a non-empty .xlsx (PK zip magic).
    const outDir = path.join(__dirname, '..', 'exports');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, '_test_minis.xlsx');
    await wb.xlsx.writeFile(outPath);
    const buf = fs.readFileSync(outPath);
    check('xlsx file written, zip magic PK', buf.length > 1000 && buf[0] === 0x50 && buf[1] === 0x4b,
      `${buf.length} bytes`);
    fs.unlinkSync(outPath);

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
