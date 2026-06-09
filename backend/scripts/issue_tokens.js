/**
 * issue_tokens — SPEC_16 §"Files to change".
 *
 * Mint a fresh, single-use, time-limited `rating_token` for every player in
 * a context and print a WhatsApp-ready list of magic links. Use this once
 * per session (or whenever you want to re-issue links).
 *
 * Token contract enforced by the server (see authority.js / redeemToken):
 *   - Each token is good for ONE redemption: server marks
 *     `person.token_used_at = NOW()` on first POST /api/session.
 *   - `person.token_expires_at` is wall-clock TTL (default 48h).
 *
 * Idempotency:
 *   - Re-running this script REPLACES every player's token with a fresh
 *     random one and re-arms expiry / clears used-at. Old links die.
 *
 * Usage (from backend/):
 *   node scripts/issue_tokens.js \
 *     --context 1 \
 *     --ttl-hours 48 \
 *     --base-url https://your-host.tail-scale.ts.net
 *
 *   # alternatives:
 *   #   --context-name "Wednesday Minis"
 *   #   --include-admin     (also issue a token for the Admin person)
 *   #   --dry-run           (print plan but don't write)
 *   #   --out links.txt     (also save the list to a file)
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pool } from '../db.js';

function parseArgs(argv) {
  const args = {
    context: null,
    contextName: null,
    ttlHours: 48,
    baseUrl: 'http://localhost:5173',
    includeAdmin: false,
    dryRun: false,
    out: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--context') args.context = parseInt(argv[++i], 10);
    else if (a === '--context-name') args.contextName = argv[++i];
    else if (a === '--ttl-hours') args.ttlHours = parseFloat(argv[++i]);
    else if (a === '--base-url') args.baseUrl = argv[++i].replace(/\/+$/, '');
    else if (a === '--include-admin') args.includeAdmin = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--help' || a === '-h') {
      printHelp(); process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a} (try --help)`);
    }
  }
  if (!args.context && !args.contextName) {
    throw new Error('--context <id> or --context-name "<name>" required');
  }
  if (!Number.isFinite(args.ttlHours) || args.ttlHours <= 0) {
    throw new Error('--ttl-hours must be a positive number');
  }
  return args;
}

function printHelp() {
  console.log(`
issue_tokens — mint single-use TTL magic links for every player in a context.

Usage:
  node scripts/issue_tokens.js --context <id> [options]
  node scripts/issue_tokens.js --context-name "Wednesday Minis" [options]

Options:
  --context <id>            Context to issue tokens for (numeric id).
  --context-name <name>     Resolve context by name (alternative to --context).
  --ttl-hours <n>           Token expiry in hours (default 48).
  --base-url <url>          Prefix for the printed magic links.
                            (default http://localhost:5173)
  --include-admin           Also issue a token for the Admin seed person
                            (off by default — admin uses the X-Person-Id path).
  --dry-run                 Don't write anything; just print the plan.
  --out <path>              Append "<Name>: <link>" lines to a file too.
  -h, --help                Show this help.

Output: one "<Name>: <base-url>/r/<token>" line per player on stdout.
`);
}

export function newToken() {
  // 24 random bytes = 48 hex chars. Plenty of entropy for a 48h single-use
  // link; not the bottleneck of the threat model (HTTP sniff > brute force).
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Importable core: mint a fresh token for every player in `contextId` and
 * write `person.rating_token / token_expires_at / token_used_at=NULL`.
 * Returns the array of `{ person_id, name, token }` rows.
 *
 * Exported so tests can exercise it without spawning the CLI.
 */
export async function mintTokensForContext(client, contextId, {
  ttlHours = 48,
  includeAdmin = false,
} = {}) {
  const ttlMs = Math.round(ttlHours * 3600 * 1000);
  const expiresAt = new Date(Date.now() + ttlMs);
  const people = (await client.query(`
    SELECT DISTINCT pr.person_id, pr.name, pr.rating_token AS prev_token
      FROM player pl
      JOIN person pr ON pr.person_id = pl.person_id
     WHERE pl.context_id = $1
       AND (
         $2 = TRUE
         OR pr.rating_token IS NULL
         OR pr.rating_token <> 'system:bootstrap-admin'
       )
     ORDER BY pr.name ASC
  `, [contextId, includeAdmin])).rows;

  const out = [];
  for (const p of people) {
    const token = newToken();
    await client.query(
      `UPDATE person
          SET rating_token     = $1,
              token_expires_at = $2,
              token_used_at    = NULL
        WHERE person_id        = $3`,
      [token, expiresAt, p.person_id],
    );
    out.push({ person_id: p.person_id, name: p.name, token });
  }
  return { recipients: out, expires_at: expiresAt };
}

async function resolveContextId(args) {
  if (args.context) {
    const { rows } = await pool.query(
      `SELECT context_id, name FROM context WHERE context_id = $1`,
      [args.context],
    );
    if (rows.length === 0) throw new Error(`context_id ${args.context} not found`);
    return rows[0];
  }
  const { rows } = await pool.query(
    `SELECT context_id, name FROM context WHERE name = $1 LIMIT 1`,
    [args.contextName],
  );
  if (rows.length === 0) throw new Error(`context name ${JSON.stringify(args.contextName)} not found`);
  return rows[0];
}

async function listRecipients(contextId, includeAdmin) {
  const { rows } = await pool.query(`
    SELECT DISTINCT pr.person_id, pr.name, pr.rating_token AS prev_token
      FROM player pl
      JOIN person pr ON pr.person_id = pl.person_id
     WHERE pl.context_id = $1
       AND (
         $2 = TRUE
         OR pr.rating_token IS NULL
         OR pr.rating_token <> 'system:bootstrap-admin'
       )
     ORDER BY pr.name ASC
  `, [contextId, includeAdmin]);
  return rows;
}

async function main() {
  const args = parseArgs(process.argv);
  const ctx = await resolveContextId(args);

  if (args.dryRun) {
    const peek = (await pool.query(`
      SELECT DISTINCT pr.person_id, pr.name
        FROM player pl JOIN person pr ON pr.person_id = pl.person_id
       WHERE pl.context_id = $1
         AND ($2 = TRUE OR pr.rating_token IS NULL
              OR pr.rating_token <> 'system:bootstrap-admin')
       ORDER BY pr.name ASC
    `, [ctx.context_id, args.includeAdmin])).rows;
    console.log(`[issue_tokens] (DRY RUN) would issue ${peek.length} tokens in "${ctx.name}".`);
    for (const p of peek) console.log(`  - ${p.name} (person_id=${p.person_id})`);
    return;
  }

  const client = await pool.connect();
  let result;
  try {
    result = await mintTokensForContext(client, ctx.context_id, {
      ttlHours: args.ttlHours,
      includeAdmin: args.includeAdmin,
    });
  } finally {
    client.release();
  }

  if (result.recipients.length === 0) {
    console.error(`[issue_tokens] no players in context "${ctx.name}" (id=${ctx.context_id}).`);
    process.exitCode = 1;
    return;
  }

  console.log(`[issue_tokens] context: "${ctx.name}" (id=${ctx.context_id})`);
  console.log(`[issue_tokens] recipients: ${result.recipients.length}`);
  console.log(`[issue_tokens] ttl: ${args.ttlHours}h`);
  console.log('');
  const lines = [];
  for (const r of result.recipients) {
    const url = `${args.baseUrl}/r/${r.token}`;
    const line = `${r.name}: ${url}`;
    lines.push(line);
    console.log(line);
  }

  if (args.out) {
    const outPath = path.isAbsolute(args.out) ? args.out : path.join(process.cwd(), args.out);
    fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf-8');
    console.log(`\n[issue_tokens] wrote ${outPath}`);
  }

  console.log(`\n[issue_tokens] expires at ${result.expires_at.toISOString()}`);
  console.log(`[issue_tokens] re-run this script to re-issue (old tokens die).`);
}

// Only run main() when invoked directly (not when imported by tests).
const isDirectInvocation =
  import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isDirectInvocation) {
  main()
    .catch(e => { console.error('[issue_tokens] FAILED:', e.message); process.exitCode = 1; })
    .finally(() => pool.end().catch(() => {}));
}
