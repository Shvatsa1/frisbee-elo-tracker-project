/**
 * Sanity test: scripts/issue_tokens.js core (mintTokensForContext).
 *
 * Boots embedded PG, seeds a couple of people + a context + players, then:
 *   - mints tokens for every player in the context
 *   - asserts rating_token / token_expires_at populated, token_used_at NULL
 *   - re-mint replaces tokens (idempotency / rotation)
 *   - --include-admin gate
 */
import { startHarness, stopHarness, getPool } from './pgHarness.js';
import { applyV2Schema, applyV2Seed } from '../initDb.js';
import { mintTokensForContext, newToken } from '../scripts/issue_tokens.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function run() {
  console.log('booting embedded PG...');
  await startHarness({ fresh: true });
  const pool = getPool();
  const client = await pool.connect();
  try {
    await applyV2Schema(client);
    await applyV2Seed(client);

    const ctxId = (await client.query(`SELECT context_id FROM context LIMIT 1`)).rows[0].context_id;

    // Add 3 real players (admin is the seed person; verify it stays out of
    // the default mint).
    const names = ['Aaditya', 'Bhavna', 'Chinmayi'];
    for (const name of names) {
      const p = (await client.query(
        `INSERT INTO person (name) VALUES ($1) RETURNING person_id`, [name],
      )).rows[0];
      await client.query(
        `INSERT INTO player (person_id, context_id) VALUES ($1, $2)`,
        [p.person_id, ctxId],
      );
    }

    console.log('\n--- newToken: unique, hex, length 48 ---');
    const t1 = newToken(); const t2 = newToken();
    check('newToken returns 48-char hex', /^[0-9a-f]{48}$/.test(t1));
    check('newToken values are distinct', t1 !== t2);

    console.log('\n--- mintTokensForContext (default: exclude Admin) ---');
    // Admin is a person but has NO player row in the seed context (seed_only
    // inserts context_authority, not player). So they shouldn't appear in
    // the recipient list regardless of the include-admin flag.
    // Add the admin as a player too, to actually exercise the gate.
    const adminPerson = (await client.query(
      `SELECT person_id FROM person WHERE rating_token = 'system:bootstrap-admin'`,
    )).rows[0].person_id;
    await client.query(
      `INSERT INTO player (person_id, context_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [adminPerson, ctxId],
    );

    const mint = await mintTokensForContext(client, ctxId, { ttlHours: 6 });
    check('mint returns recipients for 3 real players (admin excluded by default)',
      mint.recipients.length === 3,
      `got ${mint.recipients.length}`);

    // Verify DB rows
    const rows = (await client.query(
      `SELECT name, rating_token, token_expires_at, token_used_at
         FROM person WHERE rating_token != 'system:bootstrap-admin' OR rating_token IS NULL`,
    )).rows;
    const playerRows = rows.filter(r => names.includes(r.name));
    check('every player got a token',
      playerRows.every(r => /^[0-9a-f]{48}$/.test(r.rating_token)));
    check('every token has an expiry in the future',
      playerRows.every(r => r.token_expires_at && new Date(r.token_expires_at) > new Date()));
    check('no token is consumed yet (token_used_at = NULL)',
      playerRows.every(r => r.token_used_at === null));

    console.log('\n--- re-mint: tokens are rotated ---');
    const beforeTokens = playerRows.map(r => r.rating_token).sort();
    const remint = await mintTokensForContext(client, ctxId, { ttlHours: 6 });
    check('re-mint still 3 recipients', remint.recipients.length === 3);
    const afterRows = (await client.query(
      `SELECT name, rating_token FROM person WHERE name = ANY($1::text[])`,
      [names],
    )).rows;
    const afterTokens = afterRows.map(r => r.rating_token).sort();
    check('re-mint replaced every token',
      beforeTokens.every((t, i) => t !== afterTokens[i]),
      `before=${beforeTokens.length} after=${afterTokens.length}`);

    console.log('\n--- mintTokensForContext --include-admin: includes Admin too ---');
    const withAdmin = await mintTokensForContext(client, ctxId, {
      ttlHours: 6, includeAdmin: true,
    });
    check('with --include-admin: 4 recipients',
      withAdmin.recipients.length === 4,
      `got ${withAdmin.recipients.length}`);
    check('admin person now has a fresh token',
      withAdmin.recipients.some(r => r.person_id === adminPerson));

    // Token consumption marker is preserved across re-mints (re-mint sets to NULL).
    console.log('\n--- after mint, token_used_at re-armed to NULL ---');
    // Pretend a token was used:
    const first = withAdmin.recipients[0];
    await client.query(
      `UPDATE person SET token_used_at = CURRENT_TIMESTAMP WHERE person_id = $1`,
      [first.person_id],
    );
    await mintTokensForContext(client, ctxId, { ttlHours: 6, includeAdmin: true });
    const armed = (await client.query(
      `SELECT token_used_at FROM person WHERE person_id = $1`,
      [first.person_id],
    )).rows[0].token_used_at;
    check('re-mint clears token_used_at (re-arms the single-use bit)',
      armed === null);
  } finally {
    client.release();
    await stopHarness();
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.error('FAILURES:', failed);
    process.exitCode = 1;
  }
}

run().catch(e => {
  console.error('test crashed:', e);
  process.exitCode = 1;
  stopHarness().catch(() => {});
});
