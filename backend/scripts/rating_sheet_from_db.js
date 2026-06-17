/**
 * rating_sheet_from_db.js — emit the ONE master admin-rating workbook for a
 * context, built from the LIVE DB so it always reflects the full current roster.
 *
 * This is the single source admins edit: every player in the context appears
 * exactly once. Players already admin-rated have their Offence/Defence/Position/
 * O/D pre-filled (so you see current state); never-rated players have blank,
 * highlighted Offence/Defence cells to fill in. Reference columns (Elo, Games,
 * Status) are read-only context.
 *
 * Round-trips with import_ratings.js: that importer matches by Player name within
 * the context, replaces prior `admin` rows (idempotent), and SKIPS blank rows —
 * so importing a partially-filled master never wipes existing ratings.
 *
 * Header names are kept compatible with import_ratings.js (Player / Offence /
 * Defence / Position / O/D).
 *
 * Usage (inside the backend container, or locally with DATABASE_URL set):
 *   node scripts/rating_sheet_from_db.js --context 1 --out /tmp/master.xlsx
 */
import path from 'path';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';
import { pool } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { context: 1, out: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--context') args.context = parseInt(argv[++i], 10);
    else if (a === '--out') args.out = argv[++i];
    else throw new Error(`unknown arg: ${a}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  const rows = (await pool.query(`
    SELECT pl.player_id, pr.name,
           ai.offence_score AS admin_off, ai.defence_score AS admin_def,
           pa.position, pa.od_preference,
           COALESCE(psc.current_elo, 1000) AS elo,
           COALESCE(psc.total_games, 0)    AS games
      FROM player pl
      JOIN person pr ON pr.person_id = pl.person_id
      LEFT JOIN LATERAL (
        SELECT offence_score, defence_score
          FROM skill_input
         WHERE subject_player_id = pl.player_id AND source = 'admin'
         ORDER BY created_at DESC LIMIT 1
      ) ai ON TRUE
      LEFT JOIN player_attribute         pa  ON pa.player_id  = pl.player_id
      LEFT JOIN player_statistics_cache  psc ON psc.player_id = pl.player_id
     WHERE pl.context_id = $1
     ORDER BY pr.name ASC`, [args.context])).rows;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'UltiElo';
  wb.created = new Date();
  const ws = wb.addWorksheet('Admin ratings (master)', { views: [{ state: 'frozen', ySplit: 1 }] });

  ws.columns = [
    { header: 'Player',          key: 'name',     width: 24 },
    { header: 'Offence (0-100)', key: 'offence',  width: 16 },
    { header: 'Defence (0-100)', key: 'defence',  width: 16 },
    { header: 'Position (handler/cutter/hybrid)', key: 'position', width: 30 },
    { header: 'O/D Pref (offence/defence/both)',  key: 'odpref',   width: 30 },
    { header: 'Elo (ref)',       key: 'elo',      width: 11 },
    { header: 'Games (ref)',     key: 'games',    width: 11 },
    { header: 'Status',          key: 'status',   width: 12 },
  ];
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle', wrapText: true };

  let newCount = 0;
  for (const r of rows) {
    const rated = r.admin_off !== null && r.admin_off !== undefined;
    if (!rated) newCount++;
    const row = ws.addRow({
      name: r.name,
      offence: rated ? Number(r.admin_off) : null,
      defence: rated ? Number(r.admin_def) : null,
      position: r.position || null,
      odpref: r.od_preference || null,
      elo: Math.round(Number(r.elo)),
      games: Number(r.games),
      status: rated ? 'rated' : 'NEW — rate',
    });
    // Highlight the two fill-in cells for unrated players; tint Status too.
    if (!rated) {
      ['B', 'C'].forEach(col => {
        row.getCell(col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE08A' } };
      });
      row.getCell('H').font = { bold: true, color: { argb: 'FFB35900' } };
    }
  }
  ws.autoFilter = { from: 'A1', to: { row: 1, column: 8 } };

  const outPath = args.out
    ? (path.isAbsolute(args.out) ? args.out : path.join(process.cwd(), args.out))
    : path.join(__dirname, '..', 'exports', 'Wednesday_Minis_ratings_master.xlsx');
  await wb.xlsx.writeFile(outPath);
  console.log(`[master] ${rows.length} players (${newCount} unrated) → ${outPath}`);
}

main().catch(e => { console.error('[master] FAILED:', e.message); process.exit(1); })
  .finally(() => pool.end().catch(() => {}));
