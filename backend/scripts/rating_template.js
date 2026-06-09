/**
 * Emit a blank admin-rating template as .xlsx — one row per player, columns
 * for the fields each player will be assessed on. Built straight from the v1
 * CSV, so it needs NO database (useful for previewing the roster + fields
 * before the local stack is up).
 *
 * Assessment fields (what the admin fills in on Wednesday):
 *   - Offence   (0–100, 50 = average)
 *   - Defence   (0–100, 50 = average)
 * Context fields (reference / optional to set):
 *   - Position        (handler / cutter / hybrid)
 *   - O/D Preference  (offence / defence / both)
 *   - Prev Elo        (carried from v1, read-only reference)
 *
 * Usage (from backend/):
 *   node scripts/rating_template.js --csv migrations/v1_data/v1_players_XXXX.csv
 *   node scripts/rating_template.js --csv ... --include-test --out ../exports/template.xlsx
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';
import { readPlayersCsv, splitRows } from '../migrations/port_v1_players.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { csv: null, includeTest: false, out: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--csv') args.csv = argv[++i];
    else if (a === '--include-test') args.includeTest = true;
    else if (a === '--out') args.out = argv[++i];
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!args.csv) throw new Error('--csv <path> is required');
  return args;
}

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

async function main() {
  const args = parseArgs(process.argv);
  const csvPath = path.isAbsolute(args.csv) ? args.csv : path.join(process.cwd(), args.csv);
  const rows = readPlayersCsv(csvPath);
  const { kept } = splitRows(rows, args.includeTest);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'UltiElo';
  wb.created = new Date();
  const ws = wb.addWorksheet('Wednesday Minis — rating', { views: [{ state: 'frozen', ySplit: 1 }] });

  ws.columns = [
    { header: 'Player',          key: 'name',     width: 24 },
    { header: 'Offence (0-100)', key: 'offence', width: 16 },
    { header: 'Defence (0-100)', key: 'defence', width: 16 },
    { header: 'Position (handler/cutter/hybrid)', key: 'position', width: 30 },
    { header: 'O/D Pref (offence/defence/both)',  key: 'odpref',   width: 30 },
    { header: 'Prev Elo (ref)', key: 'prev_elo',  width: 13 },
  ];

  const header = ws.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle', wrapText: true };

  // Sort alphabetically so the admin can find names fast.
  const sorted = [...kept].sort((a, b) => a.player_name.localeCompare(b.player_name));
  for (const r of sorted) {
    ws.addRow({
      name: r.player_name,
      offence: null,            // ← admin fills
      defence: null,            // ← admin fills
      position: null,           // ← optional
      odpref: null,             // ← optional
      prev_elo: Math.round(r.current_elo),
    });
  }

  // Light shading on the two columns the admin must fill, so they stand out.
  ['offence', 'defence'].forEach(key => {
    const col = ws.getColumn(key);
    col.eachCell((cell, rowNo) => {
      if (rowNo === 1) return;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
    });
  });
  ws.autoFilter = { from: 'A1', to: { row: 1, column: 6 } };

  const outPath = args.out
    ? (path.isAbsolute(args.out) ? args.out : path.join(process.cwd(), args.out))
    : path.join(__dirname, '..', 'exports', `rating_template_${stamp()}.xlsx`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await wb.xlsx.writeFile(outPath);
  console.log(`[template] ${sorted.length} players → ${outPath}`);
}

main().catch(e => { console.error('[template] FAILED:', e.message); process.exit(1); });
