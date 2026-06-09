/**
 * Import a filled admin-rating .xlsx back into the v2 DB.
 *
 * Reads the workbook produced by scripts/rating_template.js once the admin has
 * filled the Offence/Defence (and optionally Position / O/D Pref) columns, and
 * for each player:
 *   1. writes an `admin` skill_input row (offence_score, defence_score)
 *   2. upserts player_attribute (position, od_preference)
 *   3. recomputes the cached player_skill blend
 *
 * Idempotent: existing `admin` skill_input rows for the player are deleted and
 * replaced, so re-importing an updated sheet refreshes rather than stacks.
 * Players in the sheet that have no `player` row in the target context are
 * reported and skipped (run the v1 port first so the roster exists).
 *
 * Usage (run from backend/, with DATABASE_URL pointing at your LOCAL pg):
 *   node scripts/import_ratings.js --xlsx ../exports/Wednesday_Minis_rating_template.xlsx
 *   node scripts/import_ratings.js --xlsx ... --context "Wednesday Minis" --dry-run
 *
 * Constraint envelope: ~50 rows. One short transaction; trivially fits in RAM.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';
import { pool } from '../db.js';
import { recomputePlayerSkill } from '../skillService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const POSITIONS = new Set(['handler', 'cutter', 'hybrid']);
const OD_PREFS = new Set(['offence', 'defence', 'both']);

function parseArgs(argv) {
  const args = { xlsx: null, context: 'Wednesday Minis', dryRun: false, fromScale: 100 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--xlsx') args.xlsx = argv[++i];
    else if (a === '--context') args.context = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    // Ratings are stored on 0–100. A legacy sheet on the old 0–2500 Elo scale
    // can be converted in-flight with `--from-scale 2500` (one-time).
    else if (a === '--from-scale') args.fromScale = Number(argv[++i]);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!args.xlsx) throw new Error('--xlsx <path> is required');
  if (!Number.isFinite(args.fromScale) || args.fromScale <= 0) throw new Error('--from-scale must be > 0');
  return args;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'object' && v.result !== undefined ? Number(v.result) : Number(v);
  return Number.isFinite(n) ? n : null;
}

function text(v) {
  if (v === null || v === undefined) return null;
  const s = String(typeof v === 'object' && v.text !== undefined ? v.text : v).trim();
  return s.length ? s : null;
}

/**
 * Read the rating workbook into rows of
 * { name, offence, defence, position, od_preference, rowNo }.
 * Maps the header by name so column order is not load-bearing. Offence/Defence
 * are required per row; rows missing both are skipped as blank.
 */
export async function readRatingsXlsx(xlsxPath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('workbook has no worksheets');

  // Build a header → column-index map from row 1.
  const headerRow = ws.getRow(1);
  const colOf = {};
  headerRow.eachCell((cell, c) => {
    const h = String(cell.value ?? '').toLowerCase();
    if (h.startsWith('player')) colOf.name = c;
    else if (h.startsWith('offence')) colOf.offence = c;
    else if (h.startsWith('defence')) colOf.defence = c;
    else if (h.startsWith('position')) colOf.position = c;
    else if (h.startsWith('o/d')) colOf.odpref = c;
  });
  if (!colOf.name || !colOf.offence || !colOf.defence) {
    throw new Error(`could not find Player/Offence/Defence headers (got ${JSON.stringify(colOf)})`);
  }

  const rows = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const name = text(row.getCell(colOf.name).value);
    if (!name) continue;
    const offence = num(row.getCell(colOf.offence).value);
    const defence = num(row.getCell(colOf.defence).value);
    if (offence === null && defence === null) continue; // unrated, skip
    const positionRaw = colOf.position ? text(row.getCell(colOf.position).value) : null;
    const odRaw = colOf.odpref ? text(row.getCell(colOf.odpref).value) : null;
    const position = positionRaw && POSITIONS.has(positionRaw.toLowerCase())
      ? positionRaw.toLowerCase() : null;
    const od_preference = odRaw && OD_PREFS.has(odRaw.toLowerCase())
      ? odRaw.toLowerCase() : null;
    rows.push({ name, offence, defence, position, od_preference, rowNo: r });
  }
  return rows;
}

/**
 * Import the parsed rows into `contextName`. Returns
 * { rated, skipped, missing[] }. Caller owns nothing — this opens its own
 * transaction. `missing` = sheet names with no player row in the context.
 */
export async function importRatings(client, rows, contextName, opts = {}) {
  // Convert sheet values onto the canonical 0–100 rating scale. fromScale=100
  // (default) is a no-op; fromScale=2500 rescales a legacy Elo-scale sheet.
  const fromScale = Number(opts.fromScale) || 100;
  const factor = 100 / fromScale;
  const toRating = (v) => Math.max(0, Math.min(100, Math.round(v * factor * 10) / 10));

  const ctx = (await client.query(
    `SELECT context_id FROM context WHERE name = $1 ORDER BY context_id ASC LIMIT 1`,
    [contextName],
  )).rows[0];
  if (!ctx) throw new Error(`context "${contextName}" not found — run init-db / port-v1 first`);
  const contextId = ctx.context_id;

  const missing = [];
  let rated = 0, skipped = 0;
  const ratedPlayerIds = [];

  await client.query('BEGIN');
  try {
    for (const r of rows) {
      const player = (await client.query(
        `SELECT pl.player_id FROM player pl
         JOIN person pr ON pr.person_id = pl.person_id
         WHERE pr.name = $1 AND pl.context_id = $2
         ORDER BY pl.player_id ASC LIMIT 1`,
        [r.name, contextId],
      )).rows[0];
      if (!player) { missing.push(r.name); skipped++; continue; }
      const playerId = player.player_id;

      if (r.offence === null || r.defence === null) {
        // Partial row — both scores are needed for an admin skill_input.
        skipped++;
        continue;
      }

      // Replace any prior admin observation so re-imports refresh, not stack.
      await client.query(
        `DELETE FROM skill_input WHERE subject_player_id = $1 AND source = 'admin'`,
        [playerId],
      );
      await client.query(
        `INSERT INTO skill_input (subject_player_id, source, offence_score, defence_score)
         VALUES ($1, 'admin', $2, $3)`,
        [playerId, toRating(r.offence), toRating(r.defence)],
      );

      if (r.position || r.od_preference) {
        await client.query(
          `INSERT INTO player_attribute (player_id, position, od_preference, updated_at)
           VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
           ON CONFLICT (player_id) DO UPDATE SET
             position = COALESCE(EXCLUDED.position, player_attribute.position),
             od_preference = COALESCE(EXCLUDED.od_preference, player_attribute.od_preference),
             updated_at = CURRENT_TIMESTAMP`,
          [playerId, r.position, r.od_preference],
        );
      }

      ratedPlayerIds.push(playerId);
      rated++;
    }

    // Recompute the blend for every player we touched, inside the same tx so
    // the cache is consistent on commit.
    for (const pid of ratedPlayerIds) {
      await recomputePlayerSkill(pid, client);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }

  return { rated, skipped, missing, contextId };
}

async function main() {
  const args = parseArgs(process.argv);
  const xlsxPath = path.isAbsolute(args.xlsx) ? args.xlsx : path.join(process.cwd(), args.xlsx);
  const rows = await readRatingsXlsx(xlsxPath);
  console.log(`[import] source: ${xlsxPath}`);
  console.log(`[import] ${rows.length} rated rows parsed for context "${args.context}"`);

  if (args.dryRun) {
    console.log('[import] --dry-run: no writes. Would import:');
    rows.forEach(r => console.log(
      `         ${r.name}  off=${r.offence} def=${r.defence}` +
      `${r.position ? ' pos=' + r.position : ''}${r.od_preference ? ' od=' + r.od_preference : ''}`));
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    const { rated, skipped, missing, contextId } = await importRatings(
      client, rows, args.context, { fromScale: args.fromScale });
    console.log(`[import] context_id=${contextId} → ${rated} rated, ${skipped} skipped.`);
    if (missing.length) {
      console.warn(`[import] WARNING: ${missing.length} name(s) not in this context (run port-v1 first?):`);
      console.warn(`         ${missing.join(', ')}`);
    }
    console.log('[import] done. player_skill recomputed for all rated players.');
  } catch (err) {
    console.error('[import] FAILED, rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

const isDirectInvocation =
  import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isDirectInvocation) {
  main().catch(e => { console.error(e); process.exit(1); });
}
