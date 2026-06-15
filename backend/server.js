/**
 * UltiElo v2 API server.
 *
 * Routes follow SPEC_15 §4 exactly. Tier-0 authority is enforced via
 * `authority.js` middleware on every write route; reads are public.
 *
 * Acting-person identity is read from the `X-Person-Id` header (Tier-0;
 * upgrade path to capability tokens documented in `authority.js`).
 *
 * Match lifecycle:
 *   POST /api/match            → status='pending', no Elo applied yet.
 *   POST /api/match/:id/confirm → status='confirmed' → runs eloService.processMatch,
 *                                 writes per-player skill_input(source='result'),
 *                                 triggers skillService.recomputePlayerSkill.
 *
 * Peer rating route exists with eligibility checks but should remain
 * gated behind a feature flag in production until HTTPS is in place
 * (spec §"Edge cases & constraints").
 */
import express from 'express';
import cors from 'cors';
import { pool } from './db.js';
import { processMatch, resultSkillFromMatch } from './eloService.js';
import { recomputePlayerSkill } from './skillService.js';
import { buildTeams, combinedBalanceMetric } from './builderService.js';
import { buildSkillsWorkbook } from './exportSkills.js';
import { updatePlayerStatsCache, ensurePlayerStatsCacheTable } from './statsService.js';
import {
  resolveActor,
  requireAuthenticated,
  requireContextAuthority,
  requireGlobalAdmin,
  resolveRater,
  redeemToken,
} from './authority.js';
import {
  validateCard,
  cardToOffenceDefence,
  tierToScore,
  TIER_SCORE,
} from './cardService.js';

// Read the gate on every request (not at module-load) so tests / ops can
// flip it via env without restarting. The legacy `/api/skill/peer` route
// is the only consumer; the SPEC_16 `/api/rate` route is gated by the
// session middleware + per-context `open_rating` flag instead.
const isPeerRatingEnabled = () => process.env.ENABLE_PEER_RATING === '1';

// Shared eligibility helper for peer rating (SPEC_16 §4):
//   - Default: rater + subject must share at least one confirmed match.
//   - Relaxed when context.open_rating = TRUE: rater + subject just need to
//     both be players in the same context.
// Returns { ok: boolean, reason?: string }.
async function isPeerRatingEligible(client, { raterPersonId, subjectPlayerId }) {
  const subj = (await client.query(
    `SELECT pl.player_id, pl.context_id, c.open_rating
       FROM player pl JOIN context c ON c.context_id = pl.context_id
      WHERE pl.player_id = $1`,
    [subjectPlayerId],
  )).rows[0];
  if (!subj) return { ok: false, reason: 'subject player not found' };

  // Rater must have a player row in the subject's context either way.
  const raterInContext = (await client.query(
    `SELECT 1 FROM player WHERE person_id = $1 AND context_id = $2 LIMIT 1`,
    [raterPersonId, subj.context_id],
  )).rows[0];
  if (!raterInContext) {
    return { ok: false, reason: 'rater is not a player in this context' };
  }

  if (subj.open_rating) return { ok: true };

  // Strict mode: require a shared confirmed match.
  const shared = (await client.query(`
    SELECT 1
      FROM player rater_p
      JOIN match_player mpA ON mpA.player_id = rater_p.player_id
      JOIN match m          ON m.match_id    = mpA.match_id AND m.status = 'confirmed'
      JOIN match_player mpB ON mpB.match_id  = m.match_id AND mpB.player_id = $2
     WHERE rater_p.person_id = $1
     LIMIT 1
  `, [raterPersonId, subjectPlayerId])).rows[0];
  return shared
    ? { ok: true }
    : { ok: false, reason: 'no shared confirmed match (set context.open_rating to relax)' };
}

// Weekly-freeze helper (SPEC_16 §4). True ⇒ this (rater, subject) pair has
// ALREADY voted within the current ISO week. The route then overwrites
// rather than stacks, which is the same behaviour as the existing DELETE+
// INSERT pattern — the helper exists so the test can prove no stacking.
async function existingPeerVoteThisWeek(client, raterPersonId, subjectPlayerId) {
  const { rows } = await client.query(`
    SELECT 1 FROM skill_input
     WHERE rater_person_id   = $1
       AND subject_player_id = $2
       AND source = 'peer'
       AND date_trunc('week', created_at) = date_trunc('week', NOW())
     LIMIT 1
  `, [raterPersonId, subjectPlayerId]);
  return rows.length > 0;
}

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // ====================================================================
  // Public reads (no auth) — anyone with the URL.
  // ====================================================================

  // GET /api/contexts — list visible contexts.
  app.get('/api/contexts', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT context_id, name, kind, created_at FROM context ORDER BY created_at DESC`,
      );
      res.json(rows);
    } catch (err) { return fail(res, err); }
  });

  // GET /api/leaderboard?context_id=... — public, per-context.
  app.get('/api/leaderboard', async (req, res) => {
    const context_id = parseInt(req.query.context_id, 10);
    if (!Number.isFinite(context_id)) {
      return res.status(400).json({ error: 'context_id query parameter is required' });
    }
    try {
      const { rows } = await pool.query(`
        SELECT
          pl.player_id,
          pr.person_id, pr.name,
          ps.offence_skill, ps.defence_skill, ps.headline_scalar,
          ps.n_peers, ps.n_results, ps.weights,
          psc.current_elo, psc.total_games, psc.wins, psc.losses,
          psc.win_percentage, psc.streak, psc.last_elo_change
        FROM player pl
        JOIN person pr             ON pr.person_id = pl.person_id
        LEFT JOIN player_skill ps  ON ps.player_id = pl.player_id
        LEFT JOIN player_statistics_cache psc ON psc.player_id = pl.player_id
        WHERE pl.context_id = $1
        ORDER BY ps.headline_scalar DESC NULLS LAST, pr.name ASC
      `, [context_id]);
      res.json(rows);
    } catch (err) { return fail(res, err); }
  });

  // GET /api/export/skills?context_id=... — public, streams an .xlsx of the
  // roster (players as rows, skills as columns). Same data as /api/leaderboard.
  app.get('/api/export/skills', async (req, res) => {
    const context_id = parseInt(req.query.context_id, 10);
    if (!Number.isFinite(context_id)) {
      return res.status(400).json({ error: 'context_id query parameter is required' });
    }
    try {
      const ctx = (await pool.query(
        `SELECT context_id, name FROM context WHERE context_id = $1`, [context_id],
      )).rows[0];
      if (!ctx) return res.status(404).json({ error: 'context not found' });

      const wb = await buildSkillsWorkbook(ctx.context_id, pool, ctx.name);
      const safeName = ctx.name.replace(/[^a-z0-9]+/gi, '_');
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}_skills.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (err) { return fail(res, err); }
  });

  // GET /api/player/:person_id — public player profile (all contexts).
  app.get('/api/player/:person_id', async (req, res) => {
    const person_id = parseInt(req.params.person_id, 10);
    if (!Number.isFinite(person_id)) return res.status(400).json({ error: 'invalid person_id' });
    try {
      const person = (await pool.query(
        `SELECT person_id, name, created_at, photo_url FROM person WHERE person_id = $1`,
        [person_id],
      )).rows[0];
      if (!person) return res.status(404).json({ error: 'person not found' });

      const players = (await pool.query(`
        SELECT pl.player_id, pl.context_id, c.name AS context_name, c.kind AS context_kind,
               ps.offence_skill, ps.defence_skill, ps.headline_scalar,
               ps.n_peers, ps.n_results,
               psc.current_elo, psc.total_games, psc.wins, psc.losses,
               psc.win_percentage, psc.streak, psc.last_elo_change,
               pc.throwing, pc.cutting, pc.handling, pc.defense, pc.speed, pc.endurance,
               pa.position, pa.hand, pa.style, pa.od_preference
        FROM player pl
        JOIN context c             ON c.context_id = pl.context_id
        LEFT JOIN player_skill ps  ON ps.player_id = pl.player_id
        LEFT JOIN player_statistics_cache psc ON psc.player_id = pl.player_id
        LEFT JOIN player_card pc   ON pc.player_id = pl.player_id
        LEFT JOIN player_attribute pa ON pa.player_id = pl.player_id
        WHERE pl.person_id = $1
        ORDER BY pl.created_at ASC
      `, [person_id])).rows;

      const history = (await pool.query(`
        SELECT m.match_id, m.match_date, m.location, m.context_id,
               c.name AS context_name, m.team_a_name, m.team_b_name,
               m.team_a_score, m.team_b_score, m.winning_team, m.status,
               mp.team, mp.elo_before, mp.elo_after, mp.elo_change
        FROM match_player mp
        JOIN match m   ON m.match_id = mp.match_id
        JOIN player pl ON pl.player_id = mp.player_id
        JOIN context c ON c.context_id = m.context_id
        WHERE pl.person_id = $1
        ORDER BY m.match_date DESC, m.created_at DESC
        LIMIT 50
      `, [person_id])).rows;

      res.json({ person, players, history });
    } catch (err) { return fail(res, err); }
  });

  // ====================================================================
  // Writes — gated by authority.js
  // ====================================================================

  // POST /api/context — bootstrap exemption: if there's no
  // context_authority yet anywhere (very first context after fresh
  // initDb), any authenticated person may create it AND themselves
  // become the admin of it. Otherwise → requireGlobalAdmin.
  app.post('/api/context', resolveActor, async (req, res) => {
    const { name, kind } = req.body || {};
    if (!name || !kind) return res.status(400).json({ error: 'name and kind required' });
    if (!['minis', 'practice', 'tournament'].includes(kind)) {
      return res.status(400).json({ error: `kind must be one of minis|practice|tournament` });
    }
    const client = await pool.connect();
    try {
      const authCount = (await client.query(`SELECT COUNT(*)::int AS n FROM context_authority`)).rows[0].n;
      if (authCount > 0) {
        const admin = (await client.query(
          `SELECT 1 FROM context_authority WHERE person_id = $1 AND role = 'admin' LIMIT 1`,
          [req.actor.person_id],
        )).rows;
        if (admin.length === 0) return res.status(403).json({ error: 'admin role required' });
      }
      await client.query('BEGIN');
      const ctx = (await client.query(
        `INSERT INTO context (name, kind) VALUES ($1, $2) RETURNING context_id, name, kind, created_at`,
        [name, kind],
      )).rows[0];
      await client.query(
        `INSERT INTO context_authority (context_id, person_id, role) VALUES ($1, $2, 'admin')
         ON CONFLICT DO NOTHING`,
        [ctx.context_id, req.actor.person_id],
      );
      await client.query('COMMIT');
      res.status(201).json(ctx);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === '23505') return res.status(409).json({ error: 'context with that name+kind already exists' });
      return fail(res, err);
    } finally { client.release(); }
  });

  // POST /api/player — upsert person (by phone/email) + create player in context.
  app.post('/api/player', resolveActor, requireContextAuthority(), async (req, res) => {
    const { name, phone, email, context_id, attribute } = req.body || {};
    if (!name || !context_id) return res.status(400).json({ error: 'name and context_id required' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Person dedupe priority: phone > email > new row
      let person = null;
      if (phone) {
        person = (await client.query(`SELECT * FROM person WHERE phone = $1`, [phone])).rows[0];
      }
      if (!person && email) {
        person = (await client.query(`SELECT * FROM person WHERE email = $1`, [email])).rows[0];
      }
      if (!person) {
        person = (await client.query(
          `INSERT INTO person (name, phone, email) VALUES ($1, $2, $3) RETURNING *`,
          [name, phone ?? null, email ?? null],
        )).rows[0];
      }

      // Upsert player in this context
      const playerRow = (await client.query(`
        INSERT INTO player (person_id, context_id) VALUES ($1, $2)
        ON CONFLICT (person_id, context_id) DO UPDATE SET person_id = EXCLUDED.person_id
        RETURNING player_id, person_id, context_id, created_at
      `, [person.person_id, context_id])).rows[0];

      if (attribute) {
        await client.query(`
          INSERT INTO player_attribute (player_id, position, hand, style, od_preference, updated_at)
          VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
          ON CONFLICT (player_id) DO UPDATE SET
            position = EXCLUDED.position,
            hand     = EXCLUDED.hand,
            style    = EXCLUDED.style,
            od_preference = EXCLUDED.od_preference,
            updated_at    = CURRENT_TIMESTAMP
        `, [playerRow.player_id, attribute.position ?? null, attribute.hand ?? null,
            attribute.style ?? null, attribute.od_preference ?? null]);
      }

      await client.query('COMMIT');
      res.status(201).json({ person, player: playerRow });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return fail(res, err);
    } finally { client.release(); }
  });

  // POST /api/skill/admin — admin writes a rating for a player.
  app.post('/api/skill/admin', resolveActor, requireContextAuthority(), async (req, res) => {
    const { player_id, offence_score, defence_score } = req.body || {};
    if (!player_id || offence_score == null || defence_score == null) {
      return res.status(400).json({ error: 'player_id, offence_score, defence_score required' });
    }
    const client = await pool.connect();
    try {
      // Ensure the player is in the context the actor is authority of.
      const ownership = await client.query(
        `SELECT 1 FROM player WHERE player_id = $1 AND context_id = $2`,
        [player_id, req.context_id],
      );
      if (ownership.rows.length === 0) {
        return res.status(403).json({ error: 'player is not in the supplied context' });
      }
      await client.query(`
        INSERT INTO skill_input (subject_player_id, rater_person_id, source, offence_score, defence_score)
        VALUES ($1, $2, 'admin', $3, $4)
      `, [player_id, req.actor.person_id, offence_score, defence_score]);
      const blend = await recomputePlayerSkill(player_id, client);
      res.status(201).json({ player_id, blend });
    } catch (err) { return fail(res, err); }
    finally { client.release(); }
  });

  // POST /api/skill/self — Tier-0: admin-entered on behalf of player.
  app.post('/api/skill/self', resolveActor, requireContextAuthority(), async (req, res) => {
    const { player_id, offence_score, defence_score } = req.body || {};
    if (!player_id || offence_score == null || defence_score == null) {
      return res.status(400).json({ error: 'player_id, offence_score, defence_score required' });
    }
    const client = await pool.connect();
    try {
      await client.query(`
        INSERT INTO skill_input (subject_player_id, source, offence_score, defence_score)
        VALUES ($1, 'self', $2, $3)
      `, [player_id, offence_score, defence_score]);
      const blend = await recomputePlayerSkill(player_id, client);
      res.status(201).json({ player_id, blend });
    } catch (err) { return fail(res, err); }
    finally { client.release(); }
  });

  // POST /api/skill/peer — LEGACY direct-token entrypoint. Kept for the
  // pre-SPEC_16 callers; new player-facing UI should hit POST /api/rate
  // (session-authed). Still requires ENABLE_PEER_RATING, still goes through
  // the SHARED eligibility check (open_rating relaxation honoured).
  app.post('/api/skill/peer', async (req, res) => {
    if (!isPeerRatingEnabled()) {
      return res.status(503).json({
        error: 'peer rating is disabled until HTTPS is in place (spec §"Edge cases")',
      });
    }
    const { rating_token, subject_player_id, offence_score, defence_score } = req.body || {};
    if (!rating_token || !subject_player_id || offence_score == null || defence_score == null) {
      return res.status(400).json({ error: 'rating_token, subject_player_id, offence_score, defence_score required' });
    }
    const client = await pool.connect();
    try {
      const rater = (await client.query(
        `SELECT person_id FROM person WHERE rating_token = $1`, [rating_token],
      )).rows[0];
      if (!rater) return res.status(401).json({ error: 'invalid rating_token' });

      const elig = await isPeerRatingEligible(client, {
        raterPersonId: rater.person_id, subjectPlayerId: subject_player_id,
      });
      if (!elig.ok) return res.status(403).json({ error: elig.reason });

      await client.query(`
        DELETE FROM skill_input WHERE subject_player_id = $1 AND rater_person_id = $2 AND source = 'peer'
      `, [subject_player_id, rater.person_id]);
      await client.query(`
        INSERT INTO skill_input (subject_player_id, rater_person_id, source, offence_score, defence_score)
        VALUES ($1, $2, 'peer', $3, $4)
      `, [subject_player_id, rater.person_id, offence_score, defence_score]);

      const blend = await recomputePlayerSkill(subject_player_id, client);
      res.status(201).json({ subject_player_id, blend });
    } catch (err) { return fail(res, err); }
    finally { client.release(); }
  });

  // ====================================================================
  // SPEC_16: player-facing session-authed routes
  // ====================================================================

  // POST /api/session — redeem a magic-link rating_token, get a session.
  // Body: { token, context_id? }
  // Response: { session_id, person_id, name, context_id, expires_at_ms }
  app.post('/api/session', async (req, res) => {
    const { token, context_id } = req.body || {};
    try {
      const result = await redeemToken(token, { context_id });
      if (!result.ok) return res.status(result.status).json({ error: result.error });
      const s = result.session;
      res.status(201).json({
        session_id: s.session_id,
        person_id: s.person_id,
        name: s.name,
        context_id: s.context_id,
        expires_at_ms: s.expires_at,
      });
    } catch (err) { return fail(res, err); }
  });

  // GET /api/me — what the player needs to fill in their card and (optionally)
  // rate teammates. Includes the existing attribute + card rows and the
  // roster of OTHER players in their context.
  app.get('/api/me', resolveRater, async (req, res) => {
    const { person_id, context_id } = req.rater;
    if (!context_id) {
      return res.status(404).json({ error: 'no player in any context for this person' });
    }
    try {
      const me = (await pool.query(
        `SELECT pl.player_id, pl.context_id, pr.name, c.open_rating
           FROM player pl
           JOIN person  pr ON pr.person_id  = pl.person_id
           JOIN context c  ON c.context_id  = pl.context_id
          WHERE pl.person_id = $1 AND pl.context_id = $2`,
        [person_id, context_id],
      )).rows[0];
      if (!me) return res.status(404).json({ error: 'player not in this context' });

      const attribute = (await pool.query(
        `SELECT position, hand, style, od_preference FROM player_attribute WHERE player_id = $1`,
        [me.player_id],
      )).rows[0] ?? null;

      const card = (await pool.query(
        `SELECT throwing, cutting, handling, defense, speed, endurance, updated_at
           FROM player_card WHERE player_id = $1`,
        [me.player_id],
      )).rows[0] ?? null;

      const teammates = (await pool.query(
        `SELECT pl.player_id, pr.person_id, pr.name
           FROM player pl JOIN person pr ON pr.person_id = pl.person_id
          WHERE pl.context_id = $1 AND pr.person_id <> $2
          ORDER BY pr.name ASC`,
        [context_id, person_id],
      )).rows;

      res.json({
        person: { person_id, name: req.rater.name },
        player_id: me.player_id,
        context_id,
        context: { open_rating: me.open_rating },
        attribute, card, teammates,
        tier_score: TIER_SCORE, // expose mapping so the client never duplicates it
      });
    } catch (err) { return fail(res, err); }
  });

  // PUT /api/me/profile — upsert player_attribute (self-only fields, SPEC_16).
  app.put('/api/me/profile', resolveRater, async (req, res) => {
    const { person_id, context_id } = req.rater;
    if (!context_id) return res.status(404).json({ error: 'no player in any context' });
    const { position, hand, style, od_preference } = req.body || {};
    const client = await pool.connect();
    try {
      const me = (await client.query(
        `SELECT player_id FROM player WHERE person_id = $1 AND context_id = $2`,
        [person_id, context_id],
      )).rows[0];
      if (!me) return res.status(404).json({ error: 'player not in this context' });

      await client.query(`
        INSERT INTO player_attribute (player_id, position, hand, style, od_preference, updated_at)
        VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        ON CONFLICT (player_id) DO UPDATE SET
          position      = EXCLUDED.position,
          hand          = EXCLUDED.hand,
          style         = EXCLUDED.style,
          od_preference = EXCLUDED.od_preference,
          updated_at    = CURRENT_TIMESTAMP
      `, [me.player_id, position ?? null, hand ?? null, style ?? null, od_preference ?? null]);

      res.status(200).json({ player_id: me.player_id });
    } catch (err) { return fail(res, err); }
    finally { client.release(); }
  });

  // PUT /api/me/card — upsert player_card, derive offence/defence via
  // cardService, write/replace a `self` skill_input, recompute the blend.
  app.put('/api/me/card', resolveRater, async (req, res) => {
    const { person_id, context_id } = req.rater;
    if (!context_id) return res.status(404).json({ error: 'no player in any context' });

    const val = validateCard(req.body?.card ?? req.body);
    if (!val.ok) return res.status(400).json({ error: val.error });
    const card = val.card;

    const client = await pool.connect();
    try {
      const me = (await client.query(
        `SELECT player_id FROM player WHERE person_id = $1 AND context_id = $2`,
        [person_id, context_id],
      )).rows[0];
      if (!me) return res.status(404).json({ error: 'player not in this context' });

      await client.query('BEGIN');

      await client.query(`
        INSERT INTO player_card
          (player_id, throwing, cutting, handling, defense, speed, endurance, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
        ON CONFLICT (player_id) DO UPDATE SET
          throwing   = EXCLUDED.throwing,
          cutting    = EXCLUDED.cutting,
          handling   = EXCLUDED.handling,
          defense    = EXCLUDED.defense,
          speed      = EXCLUDED.speed,
          endurance  = EXCLUDED.endurance,
          updated_at = CURRENT_TIMESTAMP
      `, [me.player_id, card.throwing, card.cutting, card.handling,
          card.defense, card.speed, card.endurance]);

      // Derive a single `self` skill_input from the card (SPEC_16 §3 keeps
      // the blend engine untouched by feeding the card through here).
      const { offence, defence } = cardToOffenceDefence(card);

      // One canonical self row per player — replace any prior self.
      await client.query(`
        DELETE FROM skill_input
         WHERE subject_player_id = $1 AND source = 'self'
      `, [me.player_id]);
      await client.query(`
        INSERT INTO skill_input
          (subject_player_id, rater_person_id, source, offence_score, defence_score)
        VALUES ($1, $2, 'self', $3, $4)
      `, [me.player_id, person_id, offence, defence]);

      const blend = await recomputePlayerSkill(me.player_id, client);
      await client.query('COMMIT');

      res.status(200).json({
        player_id: me.player_id,
        card,
        derived: { offence, defence },
        blend,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return fail(res, err);
    } finally { client.release(); }
  });

  // POST /api/rate — sparse peer rating (SPEC_16 §5).
  // Body: { subject_player_id, tier }
  // Behaviour:
  //  - Eligibility via isPeerRatingEligible (honours context.open_rating).
  //  - DELETE prior (rater, subject, 'peer'), then INSERT
  //    offence_score = defence_score = tierToScore(tier).
  //  - One bucket → no offence/defence distinction at peer time.
  //  - Weekly freeze: a second vote in the SAME ISO week overwrites the
  //    earlier one (never stacks); votes in subsequent weeks are accepted.
  app.post('/api/rate', resolveRater, async (req, res) => {
    const { subject_player_id, tier } = req.body || {};
    const score = tierToScore(tier);
    if (!subject_player_id || score == null) {
      return res.status(400).json({ error: 'subject_player_id and a valid tier required' });
    }
    if (subject_player_id === req.rater.player_id) {
      // (rater.player_id only present when /api/me already fetched, but we
      // also guard at the DB layer: self-on-self peer is silly.)
      return res.status(400).json({ error: 'cannot peer-rate yourself' });
    }

    const client = await pool.connect();
    try {
      // Subject must not be the rater's own player row
      const own = (await client.query(
        `SELECT 1 FROM player WHERE player_id = $1 AND person_id = $2`,
        [subject_player_id, req.rater.person_id],
      )).rows[0];
      if (own) return res.status(400).json({ error: 'cannot peer-rate yourself' });

      const elig = await isPeerRatingEligible(client, {
        raterPersonId: req.rater.person_id,
        subjectPlayerId: subject_player_id,
      });
      if (!elig.ok) return res.status(403).json({ error: elig.reason });

      // Overwrite-not-stack (weekly freeze is implicit because DELETE wipes
      // any prior peer row from this rater for this subject — across all
      // weeks. We surface the within-week flag for visibility / tests.)
      const overwroteThisWeek = await existingPeerVoteThisWeek(
        client, req.rater.person_id, subject_player_id,
      );

      await client.query(`
        DELETE FROM skill_input
         WHERE subject_player_id = $1 AND rater_person_id = $2 AND source = 'peer'
      `, [subject_player_id, req.rater.person_id]);
      await client.query(`
        INSERT INTO skill_input
          (subject_player_id, rater_person_id, source, offence_score, defence_score)
        VALUES ($1, $2, 'peer', $3, $3)
      `, [subject_player_id, req.rater.person_id, score]);

      const blend = await recomputePlayerSkill(subject_player_id, client);
      res.status(201).json({
        subject_player_id, tier, score,
        overwrote_this_week: overwroteThisWeek,
        blend,
      });
    } catch (err) { return fail(res, err); }
    finally { client.release(); }
  });

  // POST /api/build — run builderService and persist.
  app.post('/api/build', resolveActor, requireContextAuthority(), async (req, res) => {
    const { context_id, roster, num_teams, team_size, constraints } = req.body || {};
    if (!Array.isArray(roster) || !num_teams || !team_size) {
      return res.status(400).json({ error: 'roster (array), num_teams, team_size required' });
    }

    const client = await pool.connect();
    try {
      // Fetch player_skill (0–100 rating) + Elo + attributes for the roster.
      const rosterData = (await client.query(`
        SELECT pl.player_id, pl.context_id, pr.name,
               COALESCE(ps.headline_scalar, 50) AS rating,
               ps.offence_skill, ps.defence_skill,
               COALESCE(psc.current_elo, 1000) AS current_elo,
               (ps.player_id IS NOT NULL) AS rated,
               pa.position, pa.hand, pa.style, pa.od_preference
        FROM player pl
        JOIN person pr ON pr.person_id = pl.person_id
        LEFT JOIN player_skill ps             ON ps.player_id = pl.player_id
        LEFT JOIN player_statistics_cache psc ON psc.player_id = pl.player_id
        LEFT JOIN player_attribute pa         ON pa.player_id = pl.player_id
        WHERE pl.player_id = ANY($1) AND pl.context_id = $2
      `, [roster, context_id])).rows;

      if (rosterData.length !== roster.length) {
        return res.status(400).json({ error: 'some roster players are not in this context' });
      }

      // Teams are balanced on a blend of rating (0–100) and Elo (0–2500→0–100).
      // Weights default 50/50; override via constraints.{w_rating,w_elo}.
      const wRating = constraints?.w_rating;
      const wElo = constraints?.w_elo;
      const result = buildTeams({
        roster: rosterData.map(p => ({
          player_id: p.player_id,
          name: p.name,
          headline_scalar: combinedBalanceMetric(
            parseFloat(p.rating), parseFloat(p.current_elo),
            { ...(wRating != null ? { wRating } : {}), ...(wElo != null ? { wElo } : {}) },
          ),
          rating: parseFloat(p.rating),
          current_elo: parseFloat(p.current_elo),
          offence_skill: p.offence_skill,
          defence_skill: p.defence_skill,
          rated: p.rated,
          attribute: {
            position: p.position, hand: p.hand,
            style: p.style, od_preference: p.od_preference,
          },
        })),
        num_teams, team_size,
        constraints: constraints ?? {},
      });

      await client.query('BEGIN');
      const build = (await client.query(`
        INSERT INTO team_build (context_id, created_by, num_teams, team_size, params)
        VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING build_id, created_at
      `, [context_id, req.actor.person_id, num_teams, team_size,
          JSON.stringify({ roster, constraints: constraints ?? {} })])).rows[0];

      for (const team of result.teams) {
        for (const p of team.players) {
          await client.query(
            `INSERT INTO team_build_player (build_id, player_id, team_label) VALUES ($1, $2, $3)`,
            [build.build_id, p.player_id, team.team_label],
          );
        }
      }
      await client.query('COMMIT');

      res.status(201).json({
        build_id: build.build_id,
        created_at: build.created_at,
        teams: result.teams,
        spread: result.spread,
        warnings: result.warnings,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return fail(res, err);
    } finally { client.release(); }
  });

  // POST /api/match — record a pairwise match (default status='pending').
  app.post('/api/match', resolveActor, requireContextAuthority(), async (req, res) => {
    const {
      context_id, match_date, location,
      team_a_name, team_b_name,
      team_a_score, team_b_score,
      team_a_players, team_b_players,
      build_id,
    } = req.body || {};

    if (!context_id || !match_date
      || team_a_score == null || team_b_score == null
      || !Array.isArray(team_a_players) || !Array.isArray(team_b_players)) {
      return res.status(400).json({ error: 'missing required fields' });
    }
    if (team_a_score === team_b_score) return res.status(400).json({ error: 'draws not supported' });

    const winning_team = team_a_score > team_b_score ? 'A' : 'B';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const match = (await client.query(`
        INSERT INTO match
          (context_id, match_date, location, team_a_name, team_b_name,
           team_a_score, team_b_score, winning_team, status, entered_by, build_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10)
        RETURNING *
      `, [context_id, match_date, location ?? null,
          team_a_name ?? 'Team A', team_b_name ?? 'Team B',
          team_a_score, team_b_score, winning_team,
          req.actor.person_id, build_id ?? null])).rows[0];

      for (const pid of team_a_players) {
        await client.query(
          `INSERT INTO match_player (match_id, player_id, team) VALUES ($1, $2, 'A')`,
          [match.match_id, pid]);
      }
      for (const pid of team_b_players) {
        await client.query(
          `INSERT INTO match_player (match_id, player_id, team) VALUES ($1, $2, 'B')`,
          [match.match_id, pid]);
      }
      await client.query('COMMIT');
      res.status(201).json(match);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return fail(res, err);
    } finally { client.release(); }
  });

  // POST /api/match/:id/confirm — moves status to 'confirmed', runs Elo,
  // writes skill_input(source='result'), recomputes player_skill.
  app.post('/api/match/:id/confirm', resolveActor, requireContextAuthority(), async (req, res) => {
    const match_id = parseInt(req.params.id, 10);
    if (!Number.isFinite(match_id)) return res.status(400).json({ error: 'invalid match_id' });

    const client = await pool.connect();
    try {
      await ensurePlayerStatsCacheTable(client);

      const match = (await client.query(`SELECT * FROM match WHERE match_id = $1`, [match_id])).rows[0];
      if (!match) return res.status(404).json({ error: 'match not found' });
      if (match.status === 'confirmed') {
        return res.status(409).json({ error: 'match already confirmed' });
      }

      // Build the two teams from current Elo (0–2500, fall back to 1000).
      // NOTE: Elo is the match-results scale and is decoupled from the 0–100
      // player_skill rating — feed psc.current_elo here, NOT ps.headline_scalar.
      const teamRows = (await client.query(`
        SELECT mp.player_id, mp.team,
               COALESCE(psc.current_elo, 1000) AS current_elo,
               COALESCE(psc.total_games, 0) AS total_games,
               pa.od_preference
        FROM match_player mp
        LEFT JOIN player_statistics_cache psc ON psc.player_id = mp.player_id
        LEFT JOIN player_attribute pa         ON pa.player_id = mp.player_id
        WHERE mp.match_id = $1
      `, [match_id])).rows;

      if (teamRows.length === 0) {
        return res.status(400).json({ error: 'match has no players' });
      }

      const teamA = teamRows.filter(r => r.team === 'A').map(r => ({
        ...r, current_elo: parseFloat(r.current_elo),
      }));
      const teamB = teamRows.filter(r => r.team === 'B').map(r => ({
        ...r, current_elo: parseFloat(r.current_elo),
      }));

      const { updatedTeamA, updatedTeamB, teamAAvgElo, teamBAvgElo, expectedWinA, expectedWinB } =
        processMatch(teamA, teamB, match.winning_team);

      await client.query('BEGIN');

      await client.query(`
        UPDATE match SET
          status              = 'confirmed',
          team_a_avg_elo      = $1,
          team_b_avg_elo      = $2,
          expected_win_team_a = $3,
          expected_win_team_b = $4
        WHERE match_id = $5
      `, [teamAAvgElo, teamBAvgElo, expectedWinA, expectedWinB, match_id]);

      const skillSamplesA = resultSkillFromMatch(updatedTeamA);
      const skillSamplesB = resultSkillFromMatch(updatedTeamB);
      const all = [...skillSamplesA, ...skillSamplesB];
      const allUpdates = [
        ...updatedTeamA.map(p => ({ ...p, team: 'A' })),
        ...updatedTeamB.map(p => ({ ...p, team: 'B' })),
      ];

      for (const upd of allUpdates) {
        await client.query(`
          UPDATE match_player
             SET elo_before = $1, elo_after = $2, elo_change = $3
           WHERE match_id = $4 AND player_id = $5
        `, [upd.elo_before, upd.elo_after, upd.elo_change, match_id, upd.player_id]);
      }

      for (const sample of all) {
        await client.query(`
          INSERT INTO skill_input
            (subject_player_id, source, offence_score, defence_score, match_id)
          VALUES ($1, 'result', $2, $3, $4)
        `, [sample.player_id, sample.offence_score, sample.defence_score, match_id]);
      }

      // Record the admin's confirmation row.
      await client.query(`
        INSERT INTO match_confirmation (match_id, person_id) VALUES ($1, $2)
        ON CONFLICT DO NOTHING
      `, [match_id, req.actor.person_id]);

      await client.query('COMMIT');

      // Recompute each participant's blended player_skill.
      for (const sample of all) {
        await recomputePlayerSkill(sample.player_id, pool);
      }
      // And refresh the per-context cache asynchronously.
      updatePlayerStatsCache(null, { context_id: match.context_id }).catch(console.error);

      res.json({ match_id, status: 'confirmed', updates: all.length });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return fail(res, err);
    } finally { client.release(); }
  });

  // POST /api/match/:id/survey — per-game survey from a participating player.
  app.post('/api/match/:id/survey', resolveActor, requireAuthenticated, async (req, res) => {
    const match_id = parseInt(req.params.id, 10);
    const { player_id, balance_felt, enjoyment, effort, improve_note } = req.body || {};
    if (!Number.isFinite(match_id) || !player_id) {
      return res.status(400).json({ error: 'match_id (path) and player_id required' });
    }
    try {
      // Eligibility: player must have actually played in this match,
      // and the acting person must own that player row.
      const ok = await pool.query(`
        SELECT 1 FROM match_player mp
          JOIN player pl ON pl.player_id = mp.player_id
         WHERE mp.match_id = $1 AND mp.player_id = $2 AND pl.person_id = $3
      `, [match_id, player_id, req.actor.person_id]);
      if (ok.rows.length === 0) {
        return res.status(403).json({ error: 'player did not play this match (or is not yours)' });
      }
      const { rows } = await pool.query(`
        INSERT INTO game_survey
          (match_id, respondent_player_id, balance_felt, enjoyment, effort, improve_note)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (match_id, respondent_player_id)
          DO UPDATE SET balance_felt = EXCLUDED.balance_felt,
                        enjoyment    = EXCLUDED.enjoyment,
                        effort       = EXCLUDED.effort,
                        improve_note = EXCLUDED.improve_note
        RETURNING survey_id
      `, [match_id, player_id, balance_felt ?? null, enjoyment ?? null,
          effort ?? null, improve_note ?? null]);
      res.status(201).json({ survey_id: rows[0].survey_id });
    } catch (err) { return fail(res, err); }
  });

  // GET /api/match/:id — read a match (public; useful for the survey page).
  app.get('/api/match/:id', async (req, res) => {
    const match_id = parseInt(req.params.id, 10);
    try {
      const m = (await pool.query(`SELECT * FROM match WHERE match_id = $1`, [match_id])).rows[0];
      if (!m) return res.status(404).json({ error: 'match not found' });
      const players = (await pool.query(`
        SELECT mp.*, pr.name
          FROM match_player mp
          JOIN player pl ON pl.player_id = mp.player_id
          JOIN person pr ON pr.person_id = pl.person_id
         WHERE mp.match_id = $1
      `, [match_id])).rows;
      res.json({ ...m, players });
    } catch (err) { return fail(res, err); }
  });

  // GET /api/matches?context_id=&limit= — recent confirmed matches (newest
  // first) with per-team rosters. Public. Powers the player "Last Week" view.
  app.get('/api/matches', async (req, res) => {
    const context_id = parseInt(req.query.context_id, 10);
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    if (!Number.isFinite(context_id)) {
      return res.status(400).json({ error: 'context_id required' });
    }
    try {
      const matches = (await pool.query(`
        SELECT match_id, context_id, match_date, location,
               team_a_name, team_b_name, team_a_score, team_b_score,
               winning_team, team_a_avg_elo, team_b_avg_elo, status, created_at
          FROM match
         WHERE context_id = $1 AND status = 'confirmed'
         ORDER BY match_date DESC, created_at DESC
         LIMIT $2`, [context_id, limit])).rows;

      if (matches.length === 0) return res.json({ matches: [], latest_date: null });

      const ids = matches.map(m => m.match_id);
      const players = (await pool.query(`
        SELECT mp.match_id, mp.team, pr.name, pr.person_id
          FROM match_player mp
          JOIN player pl ON pl.player_id = mp.player_id
          JOIN person pr ON pr.person_id = pl.person_id
         WHERE mp.match_id = ANY($1)
         ORDER BY pr.name`, [ids])).rows;

      const byMatch = new Map(
        matches.map(m => [m.match_id, { ...m, team_a_players: [], team_b_players: [] }]));
      for (const p of players) {
        const slot = byMatch.get(p.match_id);
        if (!slot) continue;
        (p.team === 'A' ? slot.team_a_players : slot.team_b_players)
          .push({ name: p.name, person_id: p.person_id });
      }
      res.json({
        matches: matches.map(m => byMatch.get(m.match_id)),
        latest_date: matches[0].match_date,
      });
    } catch (err) { return fail(res, err); }
  });

  // GET /api/build/:build_id — read a persisted build (public).
  app.get('/api/build/:build_id', async (req, res) => {
    const build_id = parseInt(req.params.build_id, 10);
    try {
      const build = (await pool.query(`SELECT * FROM team_build WHERE build_id = $1`, [build_id])).rows[0];
      if (!build) return res.status(404).json({ error: 'build not found' });
      const players = (await pool.query(`
        SELECT tbp.team_label, tbp.player_id, pr.name,
               COALESCE(ps.headline_scalar, 1000) AS headline_scalar
        FROM team_build_player tbp
        JOIN player pl ON pl.player_id = tbp.player_id
        JOIN person pr ON pr.person_id = pl.person_id
        LEFT JOIN player_skill ps ON ps.player_id = tbp.player_id
        WHERE tbp.build_id = $1
        ORDER BY tbp.team_label, ps.headline_scalar DESC NULLS LAST
      `, [build_id])).rows;
      res.json({ ...build, players });
    } catch (err) { return fail(res, err); }
  });

  return app;
}

function fail(res, err) {
  console.error('[api] error:', err);
  return res.status(500).json({ error: err.message || 'internal server error' });
}

// Only listen when invoked directly (not when imported by tests).
const isDirectInvocation =
  import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isDirectInvocation) {
  const PORT = process.env.PORT || 5000;
  const app = createApp();
  app.listen(PORT, () => console.log(`UltiElo v2 listening on :${PORT}`));
}
