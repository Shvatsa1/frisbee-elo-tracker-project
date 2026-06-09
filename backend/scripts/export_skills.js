/**
 * Write a context's skills spreadsheet to an .xlsx file on disk.
 *
 * Usage (from backend/, DATABASE_URL pointing at the DB you want to export):
 *     node scripts/export_skills.js --context "Wednesday Minis"
 *     node scripts/export_skills.js --context-id 1 --out ../exports/minis.xlsx
 *
 * Flags:
 *     --context "<name>"   resolve context by name (default: "Wednesday Minis")
 *     --context-id <id>    resolve context by id (overrides --context)
 *     --out <path>         output file (default: exports/<context>_<stamp>.xlsx)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../db.js';
import { buildSkillsWorkbook } from '../exportSkills.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { context: 'Wednesday Minis', contextId: null, out: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--context') args.context = argv[++i];
    else if (a === '--context-id') args.contextId = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else throw new Error(`unknown arg: ${a}`);
  }
  return args;
}

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

async function main() {
  const args = parseArgs(process.argv);
  const client = await pool.connect();
  try {
    let ctx;
    if (args.contextId != null) {
      ctx = (await client.query(
        `SELECT context_id, name FROM context WHERE context_id = $1`, [args.contextId],
      )).rows[0];
    } else {
      ctx = (await client.query(
        `SELECT context_id, name FROM context WHERE name = $1 ORDER BY context_id ASC LIMIT 1`,
        [args.context],
      )).rows[0];
    }
    if (!ctx) throw new Error(`context not found (${args.contextId ?? args.context})`);

    const wb = await buildSkillsWorkbook(ctx.context_id, client, ctx.name);

    const safeName = ctx.name.replace(/[^a-z0-9]+/gi, '_');
    const outPath = args.out
      ? (path.isAbsolute(args.out) ? args.out : path.join(process.cwd(), args.out))
      : path.join(__dirname, '..', 'exports', `${safeName}_${stamp()}.xlsx`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await wb.xlsx.writeFile(outPath);

    const n = wb.worksheets[0].rowCount - 1;
    console.log(`[export] wrote ${n} players for "${ctx.name}" → ${outPath}`);
  } catch (err) {
    console.error('[export] FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
