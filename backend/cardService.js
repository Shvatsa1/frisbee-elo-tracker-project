/**
 * cardService — FIFA-style self card → offence/defence derivation.
 *
 * Imported by:
 *   - server.js          (writes player_card, derives the `self` skill_input)
 *   - skill.test.js      (pure unit tests for the mapping)
 *   - scripts/import_ratings.js may also use it for card-based imports.
 *
 * Why this file exists (SPEC_16 §3):
 *   The tested 0–100 blend engine (`skillService.js`) and team builder
 *   (`builderService.js`) work in terms of `offence_score` / `defence_score`
 *   on a 0–100 scale. The new player-facing card collects 6 richer
 *   attributes on a 5-tier scale. Rather than disturb the blend or builder,
 *   we *derive* `{ offence, defence }` from the card here and write that as
 *   a `skill_input(source='self')` row. Everything downstream is unchanged.
 *
 * The same tier→midpoint mapping is also used by the peer-rating bucket
 * (a player rates a single teammate on the same 5-tier scale).
 */

// ---------- shared tier scale (SPEC_16 §2) ----------

// Order matters for any UI iterating left→right (worst → best).
export const TIERS = ['New', 'Developing', 'Solid', 'Strong', 'Elite'];

// Tier → 0–100 midpoint (SPEC_16 §2). Single source of truth; used by both
// the card UI and the peer-rating bucket so they're always in lockstep.
export const TIER_SCORE = Object.freeze({
  New: 10,
  Developing: 30,
  Solid: 50,
  Strong: 70,
  Elite: 90,
});

/**
 * Convert a tier name to its 0–100 midpoint. Unknown tiers return null (so
 * the caller can decide what to do — usually 400 the request).
 */
export function tierToScore(tier) {
  if (typeof tier !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(TIER_SCORE, tier)
    ? TIER_SCORE[tier]
    : null;
}

// Clamp any candidate score into the 0–100 rating range. Exported because
// the route layer occasionally clamps direct numeric inputs.
export const clamp0100 = (x) => {
  if (!Number.isFinite(x)) return null;
  return Math.max(0, Math.min(100, x));
};

// ---------- card → offence/defence derivation (SPEC_16 §3) ----------

// Per-attribute weights into offence vs defence. Speed contributes a smaller
// share to both halves (SPEC_16 §3 "speed half-weight"). Endurance is mostly
// defensive (longer points / D-line stamina), throwing/cutting/handling are
// the offensive trinity, defense is the dedicated D attribute.
//
// These weights are TUNABLE — the spec lists "card attribute weights into
// O/D" as an open question; tune against the first real card dataset.
const OFFENCE_WEIGHTS = Object.freeze({
  throwing: 1.0,
  cutting:  1.0,
  handling: 1.0,
  speed:    0.5,
});

const DEFENCE_WEIGHTS = Object.freeze({
  defense:   1.0,
  endurance: 1.0,
  speed:     0.5,
});

// Mid-scale fallback when *no* attributes are set on a half (50 = average).
// We use 50 (matching skillService.DEFAULT_SCORE) rather than null so the
// derivation always returns concrete numbers the blend can consume.
const DEFAULT_MIDPOINT = 50;

function weightedAverage(attrs, weights) {
  let num = 0;
  let den = 0;
  for (const [k, w] of Object.entries(weights)) {
    const v = attrs?.[k];
    if (Number.isFinite(v)) {
      num += v * w;
      den += w;
    }
  }
  return den === 0 ? null : num / den;
}

/**
 * Map a (possibly partial) FIFA card to a `{ offence, defence }` pair on
 * the 0–100 rating scale. Pure; no I/O.
 *
 * `card` shape (all fields optional, all 0–100):
 *   { throwing, cutting, handling, defense, speed, endurance }
 *
 * Returns `{ offence, defence }` — never null, always 0–100. If *every*
 * field is missing, both halves fall back to DEFAULT_MIDPOINT.
 */
export function cardToOffenceDefence(card = {}) {
  const off = weightedAverage(card, OFFENCE_WEIGHTS);
  const def = weightedAverage(card, DEFENCE_WEIGHTS);
  return {
    offence: clamp0100(off ?? DEFAULT_MIDPOINT),
    defence: clamp0100(def ?? DEFAULT_MIDPOINT),
  };
}

// ---------- card validation (route helper) ----------

const CARD_FIELDS = ['throwing', 'cutting', 'handling', 'defense', 'speed', 'endurance'];

/**
 * Validate a card payload coming from the client. Returns `{ ok, card, error }`.
 * Accepts: all-numbers (0–100), all-tier-names, or a mix per field. Tier
 * names are converted to numbers via TIER_SCORE so storage is uniform 0–100.
 * Missing fields are passed through as `null` (DB columns are nullable).
 */
export function validateCard(input) {
  if (input == null || typeof input !== 'object') {
    return { ok: false, error: 'card payload must be an object' };
  }
  const out = {};
  for (const f of CARD_FIELDS) {
    const raw = input[f];
    if (raw == null || raw === '') {
      out[f] = null;
      continue;
    }
    if (typeof raw === 'string') {
      const score = tierToScore(raw);
      if (score == null) {
        return { ok: false, error: `card.${f} is not a valid tier name` };
      }
      out[f] = score;
      continue;
    }
    if (typeof raw === 'number') {
      const v = clamp0100(raw);
      if (v == null) return { ok: false, error: `card.${f} is not a finite number` };
      out[f] = v;
      continue;
    }
    return { ok: false, error: `card.${f} must be a tier name or 0–100 number` };
  }
  return { ok: true, card: out };
}

export const CARD_ATTRIBUTES = CARD_FIELDS.slice();
