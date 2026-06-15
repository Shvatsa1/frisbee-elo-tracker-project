/**
 * authority — Tier-0 admin/coach gate for write routes (SPEC_15 §4) and
 * Tier-1 player-facing session gate (SPEC_16 §4).
 *
 * Tier-0 (admin paths): no real auth. `X-Person-Id` header → req.actor.
 *
 * Tier-1 (player paths, SPEC_16):
 *   - The player follows a magic link `/r/<token>` (their personal
 *     `person.rating_token`). The client POSTs the token to `/api/session`
 *     which validates expiry + single-use, **consumes the token**
 *     (`person.token_used_at = NOW()`), and **mints a short-lived session**
 *     (in-memory, ~30 min). The client then sends `X-Session-Id: <id>`
 *     on every subsequent request — the raw token never travels twice,
 *     so a plain-HTTP sniff is already useless.
 *   - `resolveRater` middleware reads `X-Session-Id`, looks the session
 *     up in the in-memory store, and populates `req.rater = { person_id,
 *     name, context_id, session_id }`.
 *   - Sessions live in `_sessions` (Map). Lost on restart — fine for the
 *     volume; spec §"Open questions" suggests this over a DB table for v1.
 *
 * Plain HTTP is the documented operating assumption for early use; the
 * `docs/HTTPS_OPTIONS.md` doc shows the Tailscale Funnel upgrade path.
 */
import { pool } from './db.js';
import crypto from 'crypto';

function getPersonHeader(req) {
  const raw = req.header('X-Person-Id');
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Interim admin hardening (pre-SPEC_17 identity sessions).
 *
 * Tier-0 trusts the `X-Person-Id` header, which is spoofable — fine while the
 * deploy was IP-only, but a hole once the site is public (Tailscale Funnel).
 * When `ADMIN_KEY` is set in the environment, every admin-authority route ALSO
 * requires a matching `X-Admin-Key` header, so spoofing a person_id alone is no
 * longer enough. If `ADMIN_KEY` is unset (local dev / test), the gate is a
 * no-op and behaviour is unchanged. Constant-time compare to avoid leaking the
 * key length/prefix via timing.
 */
function adminKeyOk(req) {
  const expected = process.env.ADMIN_KEY;
  if (!expected) return true; // gate disabled
  const got = req.header('X-Admin-Key') || '';
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

/**
 * Populate req.actor from the X-Person-Id header. Returns 401 if missing
 * or not a real person. Public-read routes don't use this.
 */
export async function resolveActor(req, res, next) {
  const person_id = getPersonHeader(req);
  if (!person_id) {
    return res.status(401).json({ error: 'X-Person-Id header is required for this route' });
  }
  const { rows } = await pool.query(
    `SELECT person_id, name FROM person WHERE person_id = $1`, [person_id],
  );
  if (rows.length === 0) {
    return res.status(401).json({ error: 'unknown person_id' });
  }
  req.actor = rows[0];
  next();
}

/**
 * Anyone authenticated may pass. Useful for `POST /api/match/:id/survey`,
 * where any participating player can submit (eligibility is checked by
 * route logic, not by role).
 */
export function requireAuthenticated(req, res, next) {
  if (!req.actor) {
    return res.status(401).json({ error: 'not authenticated' });
  }
  next();
}

/**
 * Require the acting person be a `context_authority` (admin or coach)
 * for the context_id referenced by the route.
 *
 * Resolution order for the context_id:
 *   1. req.params.context_id (e.g. /api/context/:context_id/...)
 *   2. req.body.context_id
 *   3. for /api/match/:id/* — look up the match row.
 *   4. for /api/build/:build_id/* — look up the team_build row.
 *
 * Roles allowed default to `['admin','coach']` ("Tier-0 = admin only" in
 * the spec is the operational expectation; we still honour `coach` if it
 * was granted in the DB).
 */
export function requireContextAuthority(opts = {}) {
  const roles = opts.roles ?? ['admin', 'coach'];

  return async function (req, res, next) {
    try {
      if (!req.actor) {
        return res.status(401).json({ error: 'not authenticated' });
      }
      if (!adminKeyOk(req)) {
        return res.status(403).json({ error: 'admin key required or invalid' });
      }
      const context_id = await resolveContextId(req);
      if (!context_id) {
        return res.status(400).json({ error: 'context_id could not be resolved for this request' });
      }
      const { rows } = await pool.query(
        `SELECT role FROM context_authority
         WHERE context_id = $1 AND person_id = $2`,
        [context_id, req.actor.person_id],
      );
      if (rows.length === 0 || !roles.includes(rows[0].role)) {
        return res.status(403).json({ error: 'not authorised for this context' });
      }
      req.actor.role = rows[0].role;
      req.context_id = context_id;
      next();
    } catch (err) {
      console.error('[authority] error:', err);
      res.status(500).json({ error: 'authority check failed' });
    }
  };
}

/**
 * Admin-only writes (e.g. `POST /api/context` itself, which creates a
 * context — there's no context to be authority of yet). Tier-0 rule:
 * the acting person must be an admin in **at least one** context.
 */
export function requireGlobalAdmin(req, res, next) {
  if (!req.actor) return res.status(401).json({ error: 'not authenticated' });
  if (!adminKeyOk(req)) return res.status(403).json({ error: 'admin key required or invalid' });
  pool.query(
    `SELECT 1 FROM context_authority WHERE person_id = $1 AND role = 'admin' LIMIT 1`,
    [req.actor.person_id],
  ).then(({ rows }) => {
    if (rows.length === 0) {
      return res.status(403).json({ error: 'admin role required' });
    }
    next();
  }).catch(err => {
    console.error('[authority] error:', err);
    res.status(500).json({ error: 'authority check failed' });
  });
}

// ====================================================================
// SPEC_16: token redemption + session middleware
// ====================================================================

// In-memory session store. Map<session_id, { person_id, name, context_id, expires_at }>.
// Cleared on process restart. Not shared across cluster workers (we run a
// single process). Tradeoff documented in SPEC_16 §"Open questions".
const _sessions = new Map();

// Session TTL: long-lived now that we're on HTTPS (Tailscale Funnel). The
// magic link is the durable identity credential (reusable — see redeemToken),
// and players need to be able to rate peers at leisure over days/weeks, so a
// 30-minute window is wrong. 1 year. The client also auto-re-redeems its stored
// token if the in-memory store is lost on restart (see frontend _api.js), so an
// expired/forgotten session self-heals without bothering the admin.
const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;

function nowMs() { return Date.now(); }

function purgeExpired() {
  const now = nowMs();
  for (const [id, s] of _sessions) {
    if (s.expires_at <= now) _sessions.delete(id);
  }
}

/**
 * Validate a magic-link `rating_token` and mint a fresh session.
 *
 * Token contract (REUSABLE TTL — revised 2026-06-11; was single-use in SPEC_16):
 *   - person.rating_token must equal the supplied token
 *   - person.token_expires_at must be NULL or in the future
 *
 * The link is now the player's durable identity credential: re-tapping it
 * re-establishes a session on any device, and the client keeps the token to
 * auto-re-redeem after a server restart. Single-use was the plain-HTTP
 * mitigation (SPEC_16 §4 / docs/HTTPS_OPTIONS §5); HTTPS (Tailscale Funnel)
 * replaces it, so we no longer consume `token_used_at` on redeem. A link can
 * still be revoked/rotated by re-minting (issue_tokens) or setting expiry.
 *
 * Resolves the "default context" for the rater as the context they have a
 * `player` row in. If there are multiple, the caller must pass `context_id`
 * (or `/api/me` will pick the most-recently-created — chosen for the common
 * single-context case).
 */
export async function redeemToken(token, { context_id } = {}) {
  if (!token || typeof token !== 'string') {
    return { ok: false, status: 400, error: 'token required' };
  }

  const { rows } = await pool.query(
    `SELECT person_id, name, token_expires_at, token_used_at
       FROM person WHERE rating_token = $1`,
    [token],
  );
  const person = rows[0];
  if (!person) {
    return { ok: false, status: 401, error: 'invalid token' };
  }
  if (person.token_expires_at && new Date(person.token_expires_at).getTime() <= nowMs()) {
    return { ok: false, status: 401, error: 'token expired' };
  }

  // Resolve context: explicit arg wins, else newest player row for this person.
  let chosenContextId = context_id ?? null;
  if (chosenContextId == null) {
    const ctxRow = (await pool.query(
      `SELECT context_id FROM player
        WHERE person_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [person.person_id],
    )).rows[0];
    chosenContextId = ctxRow?.context_id ?? null;
  }

  // Stamp first-seen for audit (proves the link reached the right phone), but
  // do NOT block re-redemption — the token is reusable (see header). Only set
  // it once so it records the first redemption time.
  if (!person.token_used_at) {
    await pool.query(
      `UPDATE person SET token_used_at = CURRENT_TIMESTAMP WHERE person_id = $1`,
      [person.person_id],
    );
  }

  const session_id = crypto.randomBytes(24).toString('hex');
  const session = {
    session_id,
    person_id: person.person_id,
    name: person.name,
    context_id: chosenContextId,
    expires_at: nowMs() + SESSION_TTL_MS,
  };
  _sessions.set(session_id, session);
  purgeExpired();

  return { ok: true, session };
}

/**
 * `resolveRater` middleware — populate req.rater from `X-Session-Id`.
 * Returns 401 on missing / unknown / expired session.
 */
export function resolveRater(req, res, next) {
  const sid = req.header('X-Session-Id');
  if (!sid) return res.status(401).json({ error: 'X-Session-Id header required' });
  const s = _sessions.get(sid);
  if (!s) return res.status(401).json({ error: 'unknown or expired session' });
  if (s.expires_at <= nowMs()) {
    _sessions.delete(sid);
    return res.status(401).json({ error: 'session expired' });
  }
  req.rater = s;
  next();
}

// Test-only — allow suites to nuke the in-memory store between scenarios.
export function _resetSessionsForTests() { _sessions.clear(); }

// ---------- helpers ----------

async function resolveContextId(req) {
  // 1. Explicit param or body
  if (req.params?.context_id) {
    return parseInt(req.params.context_id, 10);
  }
  if (req.body?.context_id) {
    return parseInt(req.body.context_id, 10);
  }

  // Use originalUrl (full path) since we mount handlers on the root app
  // without a baseUrl prefix.
  const url = req.originalUrl || req.url || '';

  // 2. /api/match/:id[/...]  → look up via match row
  const matchMatch = url.match(/\/api\/match\/(\d+)(?:\/|\?|$)/);
  if (matchMatch) {
    const match_id = parseInt(matchMatch[1], 10);
    const { rows } = await pool.query(
      `SELECT context_id FROM match WHERE match_id = $1`, [match_id],
    );
    return rows[0]?.context_id ?? null;
  }

  // 3. /api/build/:build_id[/...] → look up via team_build row
  const buildMatch = url.match(/\/api\/build\/(\d+)(?:\/|\?|$)/);
  if (buildMatch) {
    const build_id = parseInt(buildMatch[1], 10);
    const { rows } = await pool.query(
      `SELECT context_id FROM team_build WHERE build_id = $1`, [build_id],
    );
    return rows[0]?.context_id ?? null;
  }

  return null;
}
