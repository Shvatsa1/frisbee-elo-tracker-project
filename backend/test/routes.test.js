/**
 * Chunk 5 sanity test: end-to-end through every v2 route on a fresh DB.
 *
 *  1. boot embedded PG + seed schema
 *  2. supertest-style HTTP exercise of every route
 *  3. assert DB state at each step (skill blend updates, build persisted,
 *     match confirmation produces result skill_inputs, public reads work
 *     without X-Person-Id)
 */
import { startHarness, stopHarness, getPool } from './pgHarness.js';
import { applyV2Schema, applyV2Seed } from '../initDb.js';
import { createApp } from '../server.js';
import http from 'http';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

// Minimal HTTP client using `fetch` against a dynamic-port server.
function startServer(app) {
  return new Promise(resolve => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}
function stopServer(server) {
  return new Promise(r => server.close(r));
}

async function req(base, method, path, { actor, session, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (actor) headers['X-Person-Id'] = String(actor);
  if (session) headers['X-Session-Id'] = String(session);
  const res = await fetch(`${base}${path}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json, text };
}

async function run() {
  console.log('booting embedded PG + applying schema...');
  await startHarness({ fresh: true });
  const pool = getPool();
  const client = await pool.connect();
  await applyV2Schema(client);
  await applyV2Seed(client);
  client.release();

  const app = createApp();
  const { server, base } = await startServer(app);

  try {
    // Bootstrapping: who is the admin?
    const adminPerson = (await pool.query(
      `SELECT person_id FROM person WHERE name = 'Admin' LIMIT 1`,
    )).rows[0];
    const ctx = (await pool.query(
      `SELECT context_id FROM context LIMIT 1`,
    )).rows[0];
    const admin = adminPerson.person_id;
    const ctxId = ctx.context_id;

    console.log('\n--- public reads work without auth ---');
    const lb0 = await req(base, 'GET', `/api/leaderboard?context_id=${ctxId}`);
    check('GET /api/leaderboard public (empty so far)',
      lb0.status === 200 && Array.isArray(lb0.json), `status=${lb0.status}`);

    const ctxs = await req(base, 'GET', `/api/contexts`);
    check('GET /api/contexts public',
      ctxs.status === 200 && ctxs.json.length === 1);

    console.log('\n--- writes require X-Person-Id ---');
    const noAuth = await req(base, 'POST', '/api/player', {
      body: { name: 'Sai', context_id: ctxId },
    });
    check('POST /api/player without header → 401', noAuth.status === 401);

    console.log('\n--- create 8 players + admin ratings ---');
    const players = [];
    for (let i = 0; i < 8; i++) {
      const r = await req(base, 'POST', '/api/player', {
        actor: admin,
        body: {
          name: `Player ${i + 1}`,
          phone: `+91-99999000${i}`,
          context_id: ctxId,
          attribute: {
            position: i < 3 ? 'handler' : 'cutter',
            od_preference: i % 2 === 0 ? 'offence' : 'defence',
          },
        },
      });
      check(`POST /api/player[${i+1}]`, r.status === 201, JSON.stringify(r.json));
      players.push(r.json.player.player_id);
    }

    // Admin ratings on the 0–100 scale: vary headline so the leaderboard sorts.
    for (let i = 0; i < 8; i++) {
      const off = 40 + i * 5;   // 40..75
      const def = 45 + i * 4;   // 45..73
      const r = await req(base, 'POST', '/api/skill/admin', {
        actor: admin,
        body: { context_id: ctxId, player_id: players[i], offence_score: off, defence_score: def },
      });
      check(`POST /api/skill/admin[${i+1}] -> blend present`,
        r.status === 201 && r.json.blend && r.json.blend.headline_scalar > 0);
    }

    console.log('\n--- leaderboard now lists 8 players, sorted by headline desc ---');
    const lb1 = await req(base, 'GET', `/api/leaderboard?context_id=${ctxId}`);
    check('GET /api/leaderboard has 8 rows', lb1.json.length === 8);
    const hs = lb1.json.map(r => r.headline_scalar);
    const sortedDesc = [...hs].sort((a, b) => b - a);
    check('leaderboard sorted by headline desc',
      JSON.stringify(hs) === JSON.stringify(sortedDesc), JSON.stringify(hs));

    console.log('\n--- POST /api/build for 2 teams of 4 ---');
    const build = await req(base, 'POST', '/api/build', {
      actor: admin,
      body: {
        context_id: ctxId,
        roster: players,
        num_teams: 2,
        team_size: 4,
        constraints: { min_handlers_per_team: 1 },
      },
    });
    check('POST /api/build → 201', build.status === 201, build.json && build.json.error);
    check('POST /api/build returns 2 teams of 4',
      build.json && build.json.teams.length === 2
      && build.json.teams.every(t => t.players.length === 4));
    const buildId = build.json.build_id;

    const persistedBuild = await req(base, 'GET', `/api/build/${buildId}`);
    check('GET /api/build/:id round-trips', persistedBuild.status === 200
      && persistedBuild.json.players.length === 8);

    console.log('\n--- POST /api/match (pending) → /api/match/:id/confirm ---');
    const teamA = build.json.teams[0].players.map(p => p.player_id);
    const teamB = build.json.teams[1].players.map(p => p.player_id);

    const matchRes = await req(base, 'POST', '/api/match', {
      actor: admin,
      body: {
        context_id: ctxId,
        match_date: '2026-06-04',
        location: 'Mahalakshmi Race Course',
        team_a_name: 'Reds', team_b_name: 'Blues',
        team_a_score: 15, team_b_score: 9,
        team_a_players: teamA, team_b_players: teamB,
        build_id: buildId,
      },
    });
    check('POST /api/match (pending) → 201',
      matchRes.status === 201 && matchRes.json.status === 'pending');
    const matchId = matchRes.json.match_id;

    // Confirm
    const confirmRes = await req(base, 'POST', `/api/match/${matchId}/confirm`, { actor: admin });
    check('POST /api/match/:id/confirm → 200',
      confirmRes.status === 200 && confirmRes.json.status === 'confirmed');
    check('confirm produced 8 result skill_inputs', confirmRes.json.updates === 8);

    // Verify DB
    const resultSkills = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM skill_input WHERE source = 'result'`,
    )).rows[0].n;
    check('skill_input(source=result) rows == 8', resultSkills === 8);

    const mp = (await pool.query(
      `SELECT player_id, elo_before, elo_after, elo_change FROM match_player WHERE match_id = $1`,
      [matchId],
    )).rows;
    check('match_player rows have elo_before/after/change filled',
      mp.every(r => r.elo_before !== null && r.elo_after !== null && r.elo_change !== null));

    const winnerChange = mp.find(r => teamA.includes(r.player_id)).elo_change;
    const loserChange  = mp.find(r => teamB.includes(r.player_id)).elo_change;
    check('winner elo_change > 0', winnerChange > 0);
    check('loser  elo_change < 0', loserChange  < 0);

    console.log('\n--- duplicate confirm → 409 ---');
    const dup = await req(base, 'POST', `/api/match/${matchId}/confirm`, { actor: admin });
    check('second confirm → 409', dup.status === 409);

    console.log('\n--- survey submission ---');
    // Find one player in team A; submit a survey.
    const someA = (await pool.query(
      `SELECT mp.player_id, pl.person_id FROM match_player mp
        JOIN player pl ON pl.player_id = mp.player_id
       WHERE mp.match_id = $1 AND mp.team = 'A' LIMIT 1`,
      [matchId],
    )).rows[0];
    const sv = await req(base, 'POST', `/api/match/${matchId}/survey`, {
      actor: someA.person_id,
      body: { player_id: someA.player_id, balance_felt: 4, enjoyment: 5, effort: 5, improve_note: 'fun!' },
    });
    check('POST survey → 201', sv.status === 201);

    // The same person tries to submit for someone else's player → 403
    const someB = (await pool.query(
      `SELECT player_id FROM match_player WHERE match_id = $1 AND team = 'B' LIMIT 1`,
      [matchId],
    )).rows[0];
    const sv2 = await req(base, 'POST', `/api/match/${matchId}/survey`, {
      actor: someA.person_id,
      body: { player_id: someB.player_id, balance_felt: 1, enjoyment: 1, effort: 1 },
    });
    check('survey for someone else\'s player → 403', sv2.status === 403);

    console.log('\n--- peer rating is gated off by default ---');
    const peerGated = await req(base, 'POST', '/api/skill/peer', {
      body: { rating_token: 'fake', subject_player_id: players[0], offence_score: 1000, defence_score: 1000 },
    });
    check('POST /api/skill/peer disabled → 503', peerGated.status === 503);

    console.log('\n--- public profile read ---');
    const profile = await req(base, 'GET', `/api/player/${someA.person_id}`);
    check('GET /api/player/:person_id public',
      profile.status === 200 && profile.json.history.length >= 1);

    // ================================================================
    // SPEC_16 — session-authed player flows
    // ================================================================
    console.log('\n--- SPEC_16: token redemption ---');

    // POST /api/session with no token → 400
    const noTok = await req(base, 'POST', '/api/session', { body: {} });
    check('POST /api/session no token → 400', noTok.status === 400);

    // Unknown token → 401
    const badTok = await req(base, 'POST', '/api/session', { body: { token: 'no-such-thing' } });
    check('POST /api/session bad token → 401', badTok.status === 401);

    // Issue a real token for players[1] (someone other than the rater who's
    // playing themselves later). 24h expiry.
    const subjectPlayerId = players[1];
    const subjectPersonId = (await pool.query(
      `SELECT person_id FROM player WHERE player_id = $1`, [subjectPlayerId],
    )).rows[0].person_id;

    // Rater = players[0]'s person — they ARE in the confirmed match so the
    // strict eligibility check should pass for any other match participant.
    const raterPlayerId = players[0];
    const raterPersonId = (await pool.query(
      `SELECT person_id FROM player WHERE player_id = $1`, [raterPlayerId],
    )).rows[0].person_id;

    const RATER_TOKEN = 'tok-' + raterPersonId + '-abc123';
    await pool.query(
      `UPDATE person SET rating_token = $1, token_expires_at = NOW() + INTERVAL '1 hour',
                          token_used_at = NULL
        WHERE person_id = $2`,
      [RATER_TOKEN, raterPersonId],
    );

    const sess = await req(base, 'POST', '/api/session', { body: { token: RATER_TOKEN } });
    check('POST /api/session valid → 201', sess.status === 201,
      JSON.stringify(sess.json));
    check('session payload has session_id + person_id + context_id',
      sess.json?.session_id && sess.json?.person_id === raterPersonId
      && sess.json?.context_id === ctxId);
    const RATER_SESSION = sess.json.session_id;

    // Reusable (revised 2026-06-11): redeeming the same valid token again
    // succeeds and mints a NEW session (the link is the durable credential;
    // single-use was the plain-HTTP mitigation, replaced by HTTPS).
    const reUse = await req(base, 'POST', '/api/session', { body: { token: RATER_TOKEN } });
    check('reusable: same token re-redeems → 201', reUse.status === 201, JSON.stringify(reUse.json));
    check('reusable: re-redeem mints a fresh session id',
      reUse.json?.session_id && reUse.json.session_id !== RATER_SESSION);

    // Expired token → 401
    const EXPIRED_TOKEN = 'tok-expired-zzz';
    await pool.query(
      `UPDATE person SET rating_token = $1, token_expires_at = NOW() - INTERVAL '1 day',
                          token_used_at = NULL
        WHERE person_id = $2`,
      [EXPIRED_TOKEN, raterPersonId],
    );
    const expSess = await req(base, 'POST', '/api/session', { body: { token: EXPIRED_TOKEN } });
    check('expired token → 401', expSess.status === 401);

    // Restore + re-mint a fresh session for the remaining tests.
    await pool.query(
      `UPDATE person SET rating_token = $1, token_expires_at = NOW() + INTERVAL '1 hour',
                          token_used_at = NULL
        WHERE person_id = $2`,
      [RATER_TOKEN + '-2', raterPersonId],
    );
    const sess2 = await req(base, 'POST', '/api/session', { body: { token: RATER_TOKEN + '-2' } });
    const SID = sess2.json.session_id;

    console.log('\n--- SPEC_16: GET /api/me ---');
    const meNoAuth = await req(base, 'GET', '/api/me');
    check('GET /api/me without session → 401', meNoAuth.status === 401);

    const me = await req(base, 'GET', '/api/me', { session: SID });
    check('GET /api/me with session → 200', me.status === 200);
    check('GET /api/me echoes tier_score 90/70/50/30/10',
      me.json?.tier_score?.Elite === 90 && me.json?.tier_score?.New === 10);
    check('GET /api/me lists 7 teammates (excludes self)',
      Array.isArray(me.json?.teammates) && me.json.teammates.length === 7);
    check('GET /api/me reports open_rating = false by default',
      me.json?.context?.open_rating === false);

    console.log('\n--- SPEC_16: PUT /api/me/profile ---');
    const prof = await req(base, 'PUT', '/api/me/profile', {
      session: SID,
      body: { position: 'cutter', hand: 'left', style: 'aerial', od_preference: 'offence' },
    });
    check('PUT /api/me/profile → 200', prof.status === 200);
    const attr = (await pool.query(
      `SELECT position, hand, style, od_preference FROM player_attribute WHERE player_id = $1`,
      [raterPlayerId],
    )).rows[0];
    check('player_attribute upserted',
      attr.position === 'cutter' && attr.hand === 'left' && attr.style === 'aerial');

    console.log('\n--- SPEC_16: PUT /api/me/card (derives self skill_input) ---');
    const card = await req(base, 'PUT', '/api/me/card', {
      session: SID,
      body: {
        throwing: 'Strong', cutting: 'Elite', handling: 70,
        defense: 'New', speed: 'Solid', endurance: 'Developing',
      },
    });
    check('PUT /api/me/card → 200', card.status === 200, JSON.stringify(card.json));
    check('PUT /api/me/card derived offence > defence (offensive card)',
      card.json?.derived?.offence > card.json?.derived?.defence,
      JSON.stringify(card.json?.derived));

    const cardRow = (await pool.query(
      `SELECT throwing, cutting, handling, defense, speed, endurance
         FROM player_card WHERE player_id = $1`,
      [raterPlayerId],
    )).rows[0];
    check('player_card row persisted (tier names → numeric)',
      cardRow.throwing === 70 && cardRow.cutting === 90 && cardRow.handling === 70
      && cardRow.defense === 10 && cardRow.speed === 50 && cardRow.endurance === 30);

    const selfInputs = (await pool.query(
      `SELECT offence_score, defence_score FROM skill_input
        WHERE subject_player_id = $1 AND source = 'self'`,
      [raterPlayerId],
    )).rows;
    check('exactly one self skill_input row after card save (replace-not-stack)',
      selfInputs.length === 1);

    // Re-save with a different card → still exactly one self row
    await req(base, 'PUT', '/api/me/card', {
      session: SID,
      body: { throwing: 'Solid', cutting: 'Solid', handling: 'Solid',
              defense: 'Solid', speed: 'Solid', endurance: 'Solid' },
    });
    const selfInputs2 = (await pool.query(
      `SELECT offence_score FROM skill_input
        WHERE subject_player_id = $1 AND source = 'self'`,
      [raterPlayerId],
    )).rows;
    check('re-save card: still exactly one self row', selfInputs2.length === 1);

    // Garbage card → 400
    const badCard = await req(base, 'PUT', '/api/me/card', {
      session: SID,
      body: { throwing: 'GodLike' },
    });
    check('bad tier in card → 400', badCard.status === 400);

    console.log('\n--- SPEC_16: POST /api/rate (peer, sparse) ---');
    // Strict mode (open_rating=false): subject must share a confirmed match.
    // Both raterPlayer + subjectPlayer played the confirmed match above, so
    // strict mode should ACCEPT.
    const rateStrictOk = await req(base, 'POST', '/api/rate', {
      session: SID,
      body: { subject_player_id: subjectPlayerId, tier: 'Strong' },
    });
    check('POST /api/rate (strict, shared confirmed match) → 201',
      rateStrictOk.status === 201, JSON.stringify(rateStrictOk.json));
    check('rated score is 70 (Strong midpoint)',
      rateStrictOk.json?.score === 70);

    // Strict mode: a player NOT in any confirmed match → 403.
    // Create a fresh person + player in the same context.
    const lonelyPerson = (await pool.query(
      `INSERT INTO person (name) VALUES ('Lonely') RETURNING person_id`,
    )).rows[0].person_id;
    const lonelyPlayer = (await pool.query(
      `INSERT INTO player (person_id, context_id) VALUES ($1, $2) RETURNING player_id`,
      [lonelyPerson, ctxId],
    )).rows[0].player_id;

    const rateStrictFail = await req(base, 'POST', '/api/rate', {
      session: SID,
      body: { subject_player_id: lonelyPlayer, tier: 'Elite' },
    });
    check('strict mode: no shared confirmed match → 403',
      rateStrictFail.status === 403,
      JSON.stringify(rateStrictFail.json));

    // Flip open_rating ON → same call should succeed.
    await pool.query(`UPDATE context SET open_rating = TRUE WHERE context_id = $1`, [ctxId]);
    const rateOpenOk = await req(base, 'POST', '/api/rate', {
      session: SID,
      body: { subject_player_id: lonelyPlayer, tier: 'Elite' },
    });
    check('open_rating relaxation: now → 201',
      rateOpenOk.status === 201, JSON.stringify(rateOpenOk.json));

    // Re-rate same subject this week → flag set, NEVER stacks.
    const rateAgain = await req(base, 'POST', '/api/rate', {
      session: SID,
      body: { subject_player_id: lonelyPlayer, tier: 'Developing' },
    });
    check('weekly-freeze: re-rate same week → overwrote_this_week=true',
      rateAgain.json?.overwrote_this_week === true);
    const peerRows = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM skill_input
        WHERE subject_player_id = $1 AND rater_person_id = $2 AND source = 'peer'`,
      [lonelyPlayer, raterPersonId],
    )).rows[0].n;
    check('weekly-freeze: still exactly one peer row (never stacks)',
      peerRows === 1);
    const lastPeerScore = (await pool.query(
      `SELECT offence_score FROM skill_input
        WHERE subject_player_id = $1 AND rater_person_id = $2 AND source = 'peer'`,
      [lonelyPlayer, raterPersonId],
    )).rows[0].offence_score;
    check('weekly-freeze: latest score wins (Developing=30)', lastPeerScore === 30);

    // Self-on-self peer rate → 400
    const selfRate = await req(base, 'POST', '/api/rate', {
      session: SID,
      body: { subject_player_id: raterPlayerId, tier: 'Elite' },
    });
    check('cannot peer-rate your own player → 400', selfRate.status === 400);

    // Invalid tier → 400
    const badTier = await req(base, 'POST', '/api/rate', {
      session: SID,
      body: { subject_player_id: subjectPlayerId, tier: 'Mythic' },
    });
    check('invalid tier name → 400', badTier.status === 400);

    // Legacy /api/skill/peer should now (with ENABLE_PEER_RATING=1 + open_rating)
    // accept a vote going through the SAME relaxed eligibility check.
    process.env.ENABLE_PEER_RATING = '1';
    const legacyOk = await req(base, 'POST', '/api/skill/peer', {
      body: {
        rating_token: RATER_TOKEN + '-2', // already consumed for session, but
                                          // /api/skill/peer doesn't consume
                                          // the token — it only resolves the
                                          // rater_person from it.
        subject_player_id: lonelyPlayer,
        offence_score: 80, defence_score: 80,
      },
    });
    check('legacy /api/skill/peer with open_rating → 201',
      legacyOk.status === 201, JSON.stringify(legacyOk.json));

    // Turn the gate off again so subsequent test runs see the default.
    delete process.env.ENABLE_PEER_RATING;

    // Reset open_rating so this test doesn't leak state if reused.
    await pool.query(`UPDATE context SET open_rating = FALSE WHERE context_id = $1`, [ctxId]);

  } finally {
    await stopServer(server);
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
