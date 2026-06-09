/**
 * Chunk 2 sanity test: the blend engine.
 *  - Cold start: only admin → skill equals admin row.
 *  - Self alone: blend equals self row, but self decays once admin arrives.
 *  - Peer aggregation: trimmed-mean drops a single outlier.
 *  - Result recency: an old result row is down-weighted vs a fresh one.
 *  - Renormalization: weights always sum to 1.0 across present sources.
 *  - End-to-end: write skill_inputs through the DB and verify player_skill
 *    cache row matches the pure function.
 */
import { startHarness, stopHarness, getPool } from './pgHarness.js';
import { applyV2Schema, applyV2Seed } from '../initDb.js';
import {
  computeSkillFromInputs,
  recomputePlayerSkill,
  rawSourceWeights,
  renormalize,
  trimmedMean,
  recencyWeight,
} from '../skillService.js';
import {
  TIERS,
  TIER_SCORE,
  tierToScore,
  clamp0100,
  cardToOffenceDefence,
  validateCard,
  CARD_ATTRIBUTES,
} from '../cardService.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) < eps; }

// Pure-function tests ------------------------------------------------------
function testPure() {
  console.log('\n--- pure: trimmedMean ---');
  check('mean of 3', approx(trimmedMean([1, 2, 3]), 2));
  check('trims outlier in 4', approx(trimmedMean([1, 5, 5, 100]), 5));
  check('null on empty', trimmedMean([]) === null);

  console.log('\n--- pure: recencyWeight ---');
  const today = new Date('2026-06-04T00:00:00Z');
  check('w=1 today',   approx(recencyWeight(today, today), 1));
  check('w=0.5 at 60d',
    approx(recencyWeight(new Date('2026-04-05T00:00:00Z'), today), 0.5, 1e-3));

  console.log('\n--- pure: rawSourceWeights ---');
  const onlyAdmin = rawSourceWeights({ hasSelf: false, hasAdmin: true, nPeers: 0, nResults: 0 });
  check('only-admin: self=0', onlyAdmin.self === 0);
  check('only-admin: admin>0', onlyAdmin.admin > 0);
  check('only-admin: peer=0', onlyAdmin.peer === 0);

  const withResults = rawSourceWeights({ hasSelf: true, hasAdmin: true, nPeers: 0, nResults: 5 });
  check('self decays once results present',
    withResults.self < onlyAdmin.admin, // both at base, self should be 0.05
    `self=${withResults.self}`);
  check('result weight rises with n_results',
    withResults.result > rawSourceWeights({ hasSelf: false, hasAdmin: false, nPeers: 0, nResults: 1 }).result);

  console.log('\n--- pure: renormalize ---');
  const norm = renormalize({ self: 0.05, admin: 0.2, peer: 0.3, result: 0.4 });
  const sum = Object.values(norm).reduce((a, b) => a + b, 0);
  check('weights sum to 1.0', approx(sum, 1));

  console.log('\n--- pure: computeSkillFromInputs (0–100 rating scale) ---');
  const adminOnly = computeSkillFromInputs([
    { source: 'admin', offence_score: 60, defence_score: 50, created_at: '2026-06-01' },
  ]);
  check('admin-only blend === admin row (offence)', approx(adminOnly.offence_skill, 60));
  check('admin-only blend === admin row (defence)', approx(adminOnly.defence_skill, 50));
  check('headline = 0.5*off + 0.5*def', approx(adminOnly.headline_scalar, 55));

  const noInputs = computeSkillFromInputs([]);
  check('no inputs → default 50', noInputs.headline_scalar === 50);

  const peers = computeSkillFromInputs([
    { source: 'peer', offence_score: 5,  defence_score: 5,  created_at: '2026-06-01' }, // outlier low
    { source: 'peer', offence_score: 60, defence_score: 60, created_at: '2026-06-01' },
    { source: 'peer', offence_score: 65, defence_score: 65, created_at: '2026-06-01' },
    { source: 'peer', offence_score: 70, defence_score: 70, created_at: '2026-06-01' },
    { source: 'peer', offence_score: 95, defence_score: 95, created_at: '2026-06-01' }, // outlier high
  ]);
  check('5 peers: trimmed mean drops the 5 and the 95',
    approx(peers.offence_skill, 65) && approx(peers.defence_skill, 65));
  check('5 peers: n_peers stored correctly', peers.n_peers === 5);

  // Decoupling: a result row must NOT move the human rating.
  const adminPlusResult = computeSkillFromInputs([
    { source: 'admin',  offence_score: 60, defence_score: 50, created_at: '2026-06-01' },
    { source: 'result', offence_score: 90, defence_score: 90, created_at: '2026-06-02' },
  ]);
  check('result does not change the rating (decoupled from Elo)',
    approx(adminPlusResult.headline_scalar, 55),
    `headline=${adminPlusResult.headline_scalar}`);
  check('result carries zero blend weight', adminPlusResult.weights.result === 0);
}

// SPEC_16 §2/§3: card-service pure tests --------------------------------
function testCard() {
  console.log('\n--- pure: tier→midpoint (SPEC_16 §2) ---');
  check('TIERS order has 5 entries (worst→best)',
    TIERS.length === 5 && TIERS[0] === 'New' && TIERS[4] === 'Elite');
  check('TIER_SCORE matches 90/70/50/30/10',
    TIER_SCORE.Elite === 90 && TIER_SCORE.Strong === 70
    && TIER_SCORE.Solid === 50 && TIER_SCORE.Developing === 30
    && TIER_SCORE.New === 10);
  check('tierToScore round-trip on every tier',
    TIERS.every(t => tierToScore(t) === TIER_SCORE[t]));
  check('tierToScore(unknown) → null', tierToScore('Legendary') === null);
  check('tierToScore(null) → null',    tierToScore(null) === null);

  console.log('\n--- pure: clamp0100 ---');
  check('clamp0100(50) === 50', clamp0100(50) === 50);
  check('clamp0100(-5) === 0', clamp0100(-5) === 0);
  check('clamp0100(150) === 100', clamp0100(150) === 100);
  check('clamp0100(NaN) === null', clamp0100(NaN) === null);

  console.log('\n--- pure: cardToOffenceDefence (SPEC_16 §3) ---');
  const empty = cardToOffenceDefence({});
  check('empty card → mid-scale (50/50)',
    empty.offence === 50 && empty.defence === 50);

  // All-Elite card → both halves should be 90 (every component is 90)
  const elite = cardToOffenceDefence({
    throwing: 90, cutting: 90, handling: 90,
    defense: 90, speed: 90, endurance: 90,
  });
  check('all-Elite card → offence ≈ 90', approx(elite.offence, 90));
  check('all-Elite card → defence ≈ 90', approx(elite.defence, 90));

  // Offensive monster: max O attrs, min D attrs → offence high, defence low
  const ofMonster = cardToOffenceDefence({
    throwing: 90, cutting: 90, handling: 90,
    defense: 10, speed: 50, endurance: 10,
  });
  check('offensive-monster: offence > 70', ofMonster.offence > 70,
    `offence=${ofMonster.offence}`);
  check('offensive-monster: defence < 30', ofMonster.defence < 30,
    `defence=${ofMonster.defence}`);

  // Defensive specialist: opposite
  const dSpec = cardToOffenceDefence({
    throwing: 10, cutting: 10, handling: 10,
    defense: 90, speed: 50, endurance: 90,
  });
  check('defensive-specialist: defence > offence',
    dSpec.defence > dSpec.offence);

  // Partial card: only throwing set → offence reflects it, defence falls
  // back via mid-scale endurance/defense missing path
  const partial = cardToOffenceDefence({ throwing: 90 });
  check('partial card: offence reflects the one set attr',
    approx(partial.offence, 90));
  check('partial card: defence falls back to 50',
    partial.defence === 50);

  // Output always in 0–100
  const extreme = cardToOffenceDefence({
    throwing: 100, cutting: 100, handling: 100,
    defense: 0, speed: 0, endurance: 0,
  });
  check('output stays in 0–100 (offence)',
    extreme.offence >= 0 && extreme.offence <= 100);
  check('output stays in 0–100 (defence)',
    extreme.defence >= 0 && extreme.defence <= 100);

  console.log('\n--- pure: validateCard ---');
  const v1 = validateCard({ throwing: 'Strong', cutting: 70, handling: 'Elite' });
  check('validate: tier names converted to numbers',
    v1.ok && v1.card.throwing === 70 && v1.card.cutting === 70
    && v1.card.handling === 90);
  check('validate: missing fields → null',
    v1.ok && v1.card.defense === null && v1.card.speed === null);
  const vBad = validateCard({ throwing: 'GodTier' });
  check('validate: bad tier name → ok=false',
    vBad.ok === false && /tier/i.test(vBad.error ?? ''));
  const vOver = validateCard({ throwing: 150 });
  check('validate: out-of-range numbers are clamped (still ok)',
    vOver.ok === true && vOver.card.throwing === 100);
  const vNan = validateCard({ throwing: 'not-a-number' });
  check('validate: garbage string → ok=false',
    vNan.ok === false);
  check('CARD_ATTRIBUTES has 6 fields', CARD_ATTRIBUTES.length === 6);
}

// DB-backed test ----------------------------------------------------------
async function testDb() {
  console.log('\n--- db: end-to-end recomputePlayerSkill ---');
  const pool = getPool();
  const client = await pool.connect();
  try {
    await applyV2Schema(client);
    await applyV2Seed(client);

    // Create a person + player in the seed context
    const ctxId = (await client.query(`SELECT context_id FROM context LIMIT 1`)).rows[0].context_id;
    const personId = (await client.query(
      `INSERT INTO person (name) VALUES ('Anya') RETURNING person_id`,
    )).rows[0].person_id;
    const playerId = (await client.query(
      `INSERT INTO player (person_id, context_id) VALUES ($1, $2) RETURNING player_id`,
      [personId, ctxId],
    )).rows[0].player_id;

    // Admin-only seed (0–100 rating scale)
    await client.query(
      `INSERT INTO skill_input (subject_player_id, source, offence_score, defence_score)
       VALUES ($1, 'admin', 65, 55)`,
      [playerId],
    );
    let blend = await recomputePlayerSkill(playerId, client);
    check('db: admin-only → exact admin scores',
      approx(blend.offence_skill, 65) && approx(blend.defence_skill, 55));

    const cached = (await client.query(
      `SELECT * FROM player_skill WHERE player_id = $1`, [playerId],
    )).rows[0];
    check('db: player_skill cache row created',
      cached && approx(cached.headline_scalar, 60));
    check('db: weights JSONB persisted', cached.weights && typeof cached.weights === 'object');
    check('db: weights sum to 1.0',
      approx(Object.values(cached.weights).reduce((a, b) => a + b, 0), 1));

    // Add a self rating — should NOT dominate the admin
    await client.query(
      `INSERT INTO skill_input (subject_player_id, source, offence_score, defence_score)
       VALUES ($1, 'self', 90, 90)`,
      [playerId],
    );
    blend = await recomputePlayerSkill(playerId, client);
    check('db: self with admin present is heavily diluted (offence < midpoint)',
      blend.offence_skill < (65 + 90) / 2,
      `got ${blend.offence_skill.toFixed(1)}`);

    // Add a result row — decoupled: rating must be UNCHANGED, weight 0.
    const beforeResult = blend.headline_scalar;
    await client.query(
      `INSERT INTO skill_input (subject_player_id, source, offence_score, defence_score, created_at)
       VALUES ($1, 'result', 95, 95, CURRENT_TIMESTAMP)`,
      [playerId],
    );
    blend = await recomputePlayerSkill(playerId, client);
    check('db: result does not move the rating (Elo-decoupled)',
      approx(blend.headline_scalar, beforeResult),
      `before=${beforeResult.toFixed(1)} after=${blend.headline_scalar.toFixed(1)}`);
    check('db: result weight is 0', blend.weights.result === 0);

    // Idempotency: recomputing without new inputs returns same blend
    const blend2 = await recomputePlayerSkill(playerId, client);
    check('db: recompute is deterministic',
      approx(blend.headline_scalar, blend2.headline_scalar));
  } finally {
    client.release();
  }
}

async function run() {
  console.log('booting embedded PG...');
  await startHarness({ fresh: true });
  try {
    testPure();
    testCard();
    await testDb();

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    if (failed.length) {
      console.error('FAILURES:', failed);
      process.exitCode = 1;
    }
  } finally {
    await stopHarness();
  }
}

run().catch(e => {
  console.error('test crashed:', e);
  process.exitCode = 1;
  stopHarness().catch(() => {});
});
