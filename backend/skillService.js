/**
 * skillService — the blend engine.
 *
 * Reads every `skill_input` row for a player (self / admin / peer / result)
 * and produces a cached `player_skill` row with `offence_skill`,
 * `defence_skill`, and the `headline_scalar = w_off*off + w_def*def`.
 *
 * Per SPEC_15 §2:
 *  - Source weights are dynamic and **renormalize to 1.0** each recompute.
 *  - `self` starts ~0.2, decays fast once any other source arrives (→ ~0.05).
 *  - `admin` is a cold-start anchor; meaningful at seed, overtaken by results.
 *  - `peer` weight grows with n_peers: w_peer ∝ n_peers / (n_peers + K_PEER).
 *    Peer offence/defence aggregated via **trimmed mean** (drop top+bottom
 *    one when n_peers ≥ 4, else mean) for robustness.
 *  - `result` weight ≈ 0.30 after game 1, grows with n_results; result
 *    samples are **recency-weighted** via an exponential decay with
 *    half-life HALF_LIFE_DAYS.
 *
 * The recompute is event-triggered (call `recomputePlayerSkill` after
 * inserting a skill_input or confirming a match). No cron.
 *
 * Constants below are starting defaults; tune against the first real
 * Wednesday Minis dataset (spec §"Open questions").
 */
import { pool } from './db.js';

// --- Tunables (see SPEC_15 §"Open questions") ---
export const HEADLINE_OFF_WEIGHT = 0.5;
export const HEADLINE_DEF_WEIGHT = 0.5;

const W_SELF_BASE      = 0.20;
const W_SELF_DECAYED   = 0.05;
const W_ADMIN_BASE     = 0.20;

const K_PEER           = 4;     // saturation constant for peer weight
const W_PEER_MAX       = 0.45;

const RESULT_BASE_AT_1 = 0.30;  // w_result after exactly 1 game
const RESULT_GROWTH_K  = 8;     // saturation for result weight
const W_RESULT_MAX     = 0.65;
const HALF_LIFE_DAYS   = 60;    // recency half-life on result samples

// Player ratings live on a 0–100 scale (50 = average). This is DELIBERATELY
// decoupled from Elo (0–2500): Elo accrues from match results, the rating is a
// human judgement (admin / self / peer). Cold-start fallback = mid-scale.
const DEFAULT_SCORE = 50;
const RATING_MIN = 0;
const RATING_MAX = 100;

const clampRating = (v) => Math.max(RATING_MIN, Math.min(RATING_MAX, v));

// ---------- pure helpers ----------

export function trimmedMean(values) {
  if (!values.length) return null;
  if (values.length < 4) {
    return values.reduce((a, b) => a + b, 0) / values.length;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const kept = sorted.slice(1, -1); // drop one min and one max
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

export function recencyWeight(createdAt, now = new Date()) {
  const ageMs = now.getTime() - new Date(createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays <= 0) return 1;
  // Exponential decay with half-life HALF_LIFE_DAYS:
  //   w = 2^(-ageDays / HALF_LIFE_DAYS)
  return Math.pow(2, -ageDays / HALF_LIFE_DAYS);
}

export function weightedMean(values, weights) {
  let num = 0, den = 0;
  for (let i = 0; i < values.length; i++) {
    num += values[i] * weights[i];
    den += weights[i];
  }
  return den === 0 ? null : num / den;
}

/**
 * Compute the raw, un-normalized source weights given which sources
 * have data. Returns `{ self, admin, peer, result }` where any absent
 * source is 0.
 */
export function rawSourceWeights({ hasSelf, hasAdmin, nPeers, nResults }) {
  const hasOther = hasAdmin || nPeers > 0 || nResults > 0;
  const w = {
    self:   hasSelf  ? (hasOther ? W_SELF_DECAYED : W_SELF_BASE) : 0,
    admin:  hasAdmin ? W_ADMIN_BASE : 0,
    peer:   nPeers > 0 ? Math.min(W_PEER_MAX, W_PEER_MAX * (nPeers / (nPeers + K_PEER))) : 0,
    result: 0,
  };
  if (nResults > 0) {
    // Grow from RESULT_BASE_AT_1 toward W_RESULT_MAX as n_results grows.
    const sat = nResults / (nResults + RESULT_GROWTH_K);
    w.result = Math.min(
      W_RESULT_MAX,
      RESULT_BASE_AT_1 + (W_RESULT_MAX - RESULT_BASE_AT_1) * sat,
    );
  }
  return w;
}

export function renormalize(weights) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (total === 0) return weights;
  const out = {};
  for (const k of Object.keys(weights)) out[k] = weights[k] / total;
  return out;
}

/**
 * Compute the cached player_skill row purely from a list of skill_input rows.
 * Useful for unit-testing; the DB-backed `recomputePlayerSkill` is a thin
 * wrapper around this.
 *
 * Each input must look like:
 *   { source, offence_score, defence_score, created_at }
 */
export function computeSkillFromInputs(inputs, now = new Date()) {
  const buckets = { self: [], admin: [], peer: [], result: [] };
  for (const inp of inputs) {
    if (!buckets[inp.source]) continue;
    buckets[inp.source].push(inp);
  }

  const hasSelf  = buckets.self.length > 0;
  const hasAdmin = buckets.admin.length > 0;
  const nPeers   = buckets.peer.length;
  const nResults = buckets.result.length;

  // Per-source offence/defence aggregates ---------------------------------
  // self / admin: latest row wins (most recent created_at)
  function latest(arr) {
    if (!arr.length) return null;
    return [...arr].sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at),
    )[0];
  }

  const selfRow  = latest(buckets.self);
  const adminRow = latest(buckets.admin);

  const peerOff  = trimmedMean(buckets.peer.map(p => p.offence_score));
  const peerDef  = trimmedMean(buckets.peer.map(p => p.defence_score));

  // NOTE: the `result` source is intentionally NOT blended into the rating.
  // Ratings are a human judgement (admin/self/peer) on 0–100; match outcomes
  // accrue into Elo (player_statistics_cache.current_elo) instead. We still
  // surface n_results for context, but it carries zero weight here. (`now` is
  // retained for signature compatibility / future recency use.)
  void now;

  // Source weights (raw → renormalized) — result excluded (weight 0) --------
  const raw = rawSourceWeights({ hasSelf, hasAdmin, nPeers, nResults: 0 });
  const norm = renormalize(raw);

  // Final O/D blend -------------------------------------------------------
  function blend(field) {
    const values = [];
    const weights = [];
    if (selfRow)  { values.push(selfRow[field]);  weights.push(norm.self);   }
    if (adminRow) { values.push(adminRow[field]); weights.push(norm.admin);  }
    if (nPeers > 0 && peerOff !== null) {
      values.push(field === 'offence_score' ? peerOff : peerDef);
      weights.push(norm.peer);
    }
    if (values.length === 0) return DEFAULT_SCORE;
    return clampRating(weightedMean(values, weights) ?? DEFAULT_SCORE);
  }

  const offence = blend('offence_score');
  const defence = blend('defence_score');
  const headline = HEADLINE_OFF_WEIGHT * offence + HEADLINE_DEF_WEIGHT * defence;

  return {
    offence_skill: offence,
    defence_skill: defence,
    headline_scalar: headline,
    n_peers: nPeers,
    n_results: nResults,
    weights: norm,
  };
}

/**
 * DB-backed entry point. Recomputes the blend for `playerId` from every
 * `skill_input` row currently in the DB, then upserts into `player_skill`.
 *
 * Event-triggered only: call after writing a new skill_input or after a
 * match transitions to status='confirmed'.
 */
export async function recomputePlayerSkill(playerId, client = pool) {
  const { rows } = await client.query(
    `SELECT source, offence_score, defence_score, created_at
       FROM skill_input
      WHERE subject_player_id = $1
      ORDER BY created_at ASC`,
    [playerId],
  );

  const blend = computeSkillFromInputs(rows);

  await client.query(
    `
    INSERT INTO player_skill
      (player_id, offence_skill, defence_skill, headline_scalar,
       n_peers, n_results, weights, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, CURRENT_TIMESTAMP)
    ON CONFLICT (player_id) DO UPDATE SET
      offence_skill   = EXCLUDED.offence_skill,
      defence_skill   = EXCLUDED.defence_skill,
      headline_scalar = EXCLUDED.headline_scalar,
      n_peers         = EXCLUDED.n_peers,
      n_results       = EXCLUDED.n_results,
      weights         = EXCLUDED.weights,
      updated_at      = CURRENT_TIMESTAMP
    `,
    [
      playerId,
      blend.offence_skill,
      blend.defence_skill,
      blend.headline_scalar,
      blend.n_peers,
      blend.n_results,
      JSON.stringify(blend.weights),
    ],
  );

  return blend;
}
