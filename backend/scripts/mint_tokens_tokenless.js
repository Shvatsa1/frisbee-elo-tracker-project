/**
 * mint_tokens_tokenless.js — mint magic links ONLY for players in a context who
 * have no rating_token yet (rating_token IS NULL). Unlike issue_tokens.js (which
 * rotates EVERY non-admin player's token, killing already-distributed links),
 * this is surgical: it never touches anyone who already holds a token, so links
 * previously sent (e.g. to Sourabh / Chaitanya) keep working.
 *
 * Use when you've added new players and want links for just them.
 *
 * Usage (from backend/, or inside the container):
 *   node scripts/mint_tokens_tokenless.js --context 1 \
 *     --ttl-hours 8760 --base-url https://ultielo.taildd7ac1.ts.net
 *   # options: --dry-run, --out links.txt
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pool } from '../db.js';

function parseArgs(argv) {
  const args = { context: 1, ttlHours: 8760, baseUrl: 'http://localhost:5173', dryRun: false, out: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--context') args.context = parseInt(argv[++i], 10);
    else if (a === '--ttl-hours') args.ttlHours = parseFloat(argv[++i]);
    else if (a === '--base-url') args.baseUrl = argv[++i].replace(/\/+$/, '');
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--out') args.out = argv[++i];
    else throw new Error(`unknown arg: ${a}`);
  }
  return args;
}

function newToken() { return crypto.randomBytes(24).toString('hex'); }

async function main() {
  const args = parseArgs(process.argv);
  const ttlMs = Math.round(args.ttlHours * 3600 * 1000);
  const expiresAt = new Date(Date.now() + ttlMs);

  const people = (await pool.query(`
    SELECT DISTINCT pr.person_id, pr.name
      FROM player pl JOIN person pr ON pr.person_id = pl.person_id
     WHERE pl.context_id = $1 AND pr.rating_token IS NULL
     ORDER BY pr.name ASC`, [args.context])).rows;

  console.log(`[mint] context ${args.context}: ${people.length} tokenless players, ttl ${args.ttlHours}h`);
  if (args.dryRun) {
    for (const p of people) console.log(`  - ${p.name} (person_id=${p.person_id})`);
    console.log('[mint] DRY RUN — no writes.');
    return;
  }

  const lines = [];
  for (const p of people) {
    const token = newToken();
    await pool.query(
      `UPDATE person SET rating_token=$1, token_expires_at=$2, token_used_at=NULL WHERE person_id=$3`,
      [token, expiresAt, p.person_id]);
    const line = `${p.name}: ${args.baseUrl}/r/${token}`;
    lines.push(line);
    console.log(line);
  }

  if (args.out) {
    const outPath = path.isAbsolute(args.out) ? args.out : path.join(process.cwd(), args.out);
    fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf-8');
    console.log(`\n[mint] wrote ${outPath}`);
  }
  console.log(`\n[mint] expires at ${expiresAt.toISOString()}`);
}

main().catch(e => { console.error('[mint] FAILED:', e.message); process.exitCode = 1; })
  .finally(() => pool.end().catch(() => {}));
