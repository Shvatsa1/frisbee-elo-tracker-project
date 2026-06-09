/**
 * One-shot local bootstrap: stand up a PERSISTENT local Postgres in
 * backend/.localdb (never the live VM), then run the full Wednesday-minis
 * chain end to end:
 *
 *   init schema + seed  →  port v1 players  →  import filled ratings  →
 *   export a populated skills workbook  →  print the top of the leaderboard.
 *
 * The data persists in backend/.localdb between runs, so `npm start` against
 * the same DATABASE_URL (printed at the end) serves this data to the app.
 * Re-running this script is idempotent (port + import both upsert).
 *
 * Run from backend/:
 *   node scripts/seed_local.js --xlsx ../exports/Wednesday_Minis_rating_template.xlsx
 *
 * NOTE: this uses the embedded-postgres binary (same one the tests use) so it
 * needs no Docker / system Postgres. It boots PG, does the work, then stops PG;
 * the cluster files remain in .localdb. To serve the app, start PG again — see
 * scripts/local_db.js.
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { startLocalDb, stopLocalDb, LOCALDB_URL } from './local_db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {
    xlsx: path.join(__dirname, '..', '..', 'exports', 'Wednesday_Minis_rating_template.xlsx'),
    csv: null,
    context: 'Wednesday Minis',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--xlsx') args.xlsx = argv[++i];
    else if (a === '--csv') args.csv = argv[++i];
    else if (a === '--context') args.context = argv[++i];
    else throw new Error(`unknown arg: ${a}`);
  }
  return args;
}

function latestCsv() {
  const dir = path.join(__dirname, '..', 'migrations', 'v1_data');
  const files = fs.readdirSync(dir).filter(f => /^v1_players_.*\.csv$/.test(f)).sort();
  if (!files.length) throw new Error(`no v1_players_*.csv in ${dir}`);
  return path.join(dir, files[files.length - 1]);
}

async function main() {
  const args = parseArgs(process.argv);
  const csvPath = args.csv ? path.resolve(args.csv) : latestCsv();

  console.log('[seed] booting persistent local Postgres (.localdb)...');
  await startLocalDb();           // sets process.env.DATABASE_URL = LOCALDB_URL

  // Import these AFTER DATABASE_URL is set so the lazy pool points at .localdb.
  const { pool } = await import('../db.js');
  const { applyV2Schema, applyV2Seed } = await import('../initDb.js');
  const { readPlayersCsv, splitRows, portPlayers } = await import('../migrations/port_v1_players.js');
  const { readRatingsXlsx, importRatings } = await import('./import_ratings.js');
  const { buildSkillsWorkbook } = await import('../exportSkills.js');

  const client = await pool.connect();
  try {
    console.log('[seed] applying v2 schema + seed...');
    await applyV2Schema(client);
    await applyV2Seed(client);

    console.log(`[seed] porting v1 players from ${path.basename(csvPath)}...`);
    const { kept } = splitRows(readPlayersCsv(csvPath), false);
    const ported = await portPlayers(client, kept, args.context);
    console.log(`[seed]   context_id=${ported.contextId}: ${ported.inserted} new, ${ported.updated} updated`);

    console.log(`[seed] importing ratings from ${path.basename(args.xlsx)} (rescaling 0–2500 → 0–100)...`);
    const rated = await readRatingsXlsx(args.xlsx);
    // The committed sheet is on the legacy 0–2500 scale; convert to 0–100.
    const imp = await importRatings(client, rated, args.context, { fromScale: 2500 });
    console.log(`[seed]   ${imp.rated} rated, ${imp.skipped} skipped, ${imp.missing.length} missing`);
    if (imp.missing.length) console.warn(`[seed]   missing: ${imp.missing.join(', ')}`);

    // Populated export for eyeballing / sharing.
    const wb = await buildSkillsWorkbook(ported.contextId, client, args.context);
    const outDir = path.join(__dirname, '..', '..', 'exports');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'Wednesday_Minis_skills_populated.xlsx');
    await wb.xlsx.writeFile(outPath);
    console.log(`[seed] wrote populated workbook → ${outPath}`);

    // Leaderboard sanity print.
    const top = (await client.query(
      `SELECT pr.name, ps.offence_skill, ps.defence_skill, ps.headline_scalar
       FROM player_skill ps
       JOIN player pl ON pl.player_id = ps.player_id
       JOIN person pr ON pr.person_id = pl.person_id
       WHERE pl.context_id = $1
       ORDER BY ps.headline_scalar DESC LIMIT 8`, [ported.contextId])).rows;
    console.log('\n[seed] top of leaderboard (headline desc):');
    top.forEach((r, i) => console.log(
      `   ${String(i + 1).padStart(2)}. ${r.name.padEnd(20)} off=${r.offence_skill}  def=${r.defence_skill}  headline=${r.headline_scalar}`));
  } finally {
    client.release();
    await pool.end().catch(() => {});
    await stopLocalDb();
  }

  console.log(`\n[seed] done. Data persisted in backend/.localdb`);
  console.log(`[seed] To serve the app against it:`);
  console.log(`         1) node scripts/local_db.js        # keeps PG running`);
  console.log(`         2) DATABASE_URL="${LOCALDB_URL}" npm start   # in another terminal`);
}

main().catch(e => { console.error('[seed] FAILED:', e); process.exit(1); });
