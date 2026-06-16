/**
 * eventService — slot-math for event_registration (SPEC_17 §3.5).
 *
 * Single source of truth for register/withdraw/promote so the route handlers
 * and the (future) promotion sweep stay consistent. All writes that change
 * `main` membership run inside `BEGIN ... SELECT ... FOR UPDATE` on the event
 * row so two registrations can't race past capacity.
 *
 * Ordering everywhere is `signed_up_at ASC, id ASC` (chronological).
 */
import crypto from 'crypto';
import { pool } from './db.js';

export function newShareToken() {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Register a person for an event. Returns the registration row.
 * Idempotent: re-calling for the same (event, person) returns the existing row.
 * Re-registering after a withdrawal resets signed_up_at (back of the line).
 */
export async function registerForEvent(event_id, person_id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const evRow = (await client.query(
      `SELECT event_id, capacity, status, registration_opens_at
         FROM event WHERE event_id = $1 FOR UPDATE`,
      [event_id],
    )).rows[0];
    if (!evRow) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'event not found' };
    }
    if (evRow.status !== 'open') {
      await client.query('ROLLBACK');
      return { ok: false, status: 409, error: `event is ${evRow.status}` };
    }
    if (evRow.registration_opens_at &&
        new Date(evRow.registration_opens_at).getTime() > Date.now()) {
      await client.query('ROLLBACK');
      return { ok: false, status: 409, error: 'registration not yet open' };
    }

    const existing = (await client.query(
      `SELECT * FROM event_registration
        WHERE event_id = $1 AND person_id = $2`,
      [event_id, person_id],
    )).rows[0];

    if (existing && existing.status !== 'withdrawn') {
      await client.query('COMMIT');
      return { ok: true, registration: existing, created: false };
    }

    const mainCount = parseInt((await client.query(
      `SELECT COUNT(*)::int AS c FROM event_registration
        WHERE event_id = $1 AND status = 'main'`,
      [event_id],
    )).rows[0].c, 10);

    const newStatus = mainCount < evRow.capacity ? 'main' : 'waitlist';

    let row;
    if (existing) {
      row = (await client.query(
        `UPDATE event_registration
            SET status = $1,
                signed_up_at = CURRENT_TIMESTAMP,
                withdrawn_at = NULL,
                promoted_at = NULL
          WHERE id = $2
          RETURNING *`,
        [newStatus, existing.id],
      )).rows[0];
    } else {
      row = (await client.query(
        `INSERT INTO event_registration (event_id, person_id, status)
              VALUES ($1, $2, $3)
              RETURNING *`,
        [event_id, person_id, newStatus],
      )).rows[0];
    }
    await client.query('COMMIT');
    return { ok: true, registration: row, created: true };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Withdraw a person from an event. Does NOT auto-promote (sweep does). */
export async function withdrawFromEvent(event_id, person_id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT 1 FROM event WHERE event_id = $1 FOR UPDATE`, [event_id],
    );
    const reg = (await client.query(
      `SELECT * FROM event_registration
        WHERE event_id = $1 AND person_id = $2`,
      [event_id, person_id],
    )).rows[0];
    if (!reg) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'not registered' };
    }
    if (reg.status === 'withdrawn') {
      await client.query('COMMIT');
      return { ok: true, registration: reg, changed: false };
    }
    const updated = (await client.query(
      `UPDATE event_registration
          SET status = 'withdrawn', withdrawn_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *`,
      [reg.id],
    )).rows[0];
    await client.query('COMMIT');
    return { ok: true, registration: updated, changed: true };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Promote waitlist → main until capacity is filled. Used by the (future)
 * 30-minute sweep or callable manually from admin. Idempotent.
 * Returns { promoted: [{ person_id, name, registration_id }, ...] }.
 */
export async function promoteEvent(event_id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const evRow = (await client.query(
      `SELECT event_id, capacity, status
         FROM event WHERE event_id = $1 FOR UPDATE`,
      [event_id],
    )).rows[0];
    if (!evRow || evRow.status !== 'open') {
      await client.query('ROLLBACK');
      return { ok: true, promoted: [] };
    }
    const mainCount = parseInt((await client.query(
      `SELECT COUNT(*)::int AS c FROM event_registration
        WHERE event_id = $1 AND status = 'main'`,
      [event_id],
    )).rows[0].c, 10);

    const slots = evRow.capacity - mainCount;
    if (slots <= 0) {
      await client.query('ROLLBACK');
      return { ok: true, promoted: [] };
    }

    const promoted = (await client.query(
      `UPDATE event_registration r
          SET status = 'main', promoted_at = CURRENT_TIMESTAMP
         FROM (
           SELECT id FROM event_registration
            WHERE event_id = $1 AND status = 'waitlist'
            ORDER BY signed_up_at ASC, id ASC
            LIMIT $2
         ) pick
        WHERE r.id = pick.id
        RETURNING r.id AS registration_id, r.person_id`,
      [event_id, slots],
    )).rows;

    await client.query('COMMIT');
    return { ok: true, promoted };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Self-service signup for someone who doesn't have a magic link yet
 * (e.g. friend-of-friend who saw the WA share). Creates a `person` row if
 * the phone is new, mints a durable rating_token (so they can log back in
 * later), and registers them to the event in one shot.
 *
 * Idempotency:
 *   - Phone match → re-use the existing person (no duplicate). Existing
 *     rating_token is preserved; we never rotate.
 *   - Already registered → return the existing registration (no double row).
 */
export async function selfSignupForEvent({ share_token, name, phone }) {
  const cleanName = (name || '').trim();
  const cleanPhone = (phone || '').trim();
  if (!cleanName) return { ok: false, status: 400, error: 'name required' };
  if (!cleanPhone || cleanPhone.length < 6) {
    return { ok: false, status: 400, error: 'phone required' };
  }

  const ev = (await pool.query(
    `SELECT event_id, context_id, status FROM event WHERE share_token = $1`,
    [share_token],
  )).rows[0];
  if (!ev) return { ok: false, status: 404, error: 'event not found' };
  if (ev.status !== 'open') {
    return { ok: false, status: 409, error: `event is ${ev.status}` };
  }

  // Phone is UNIQUE — match by phone first to avoid duplicates.
  let person = (await pool.query(
    `SELECT person_id, name, rating_token FROM person WHERE phone = $1`,
    [cleanPhone],
  )).rows[0];

  let createdPerson = false;
  if (!person) {
    const ratingToken = crypto.randomBytes(24).toString('hex');
    person = (await pool.query(
      `INSERT INTO person (name, phone, rating_token, token_expires_at)
            VALUES ($1, $2, $3, NULL)
            RETURNING person_id, name, rating_token`,
      [cleanName, cleanPhone, ratingToken],
    )).rows[0];
    createdPerson = true;
  }

  const reg = await registerForEvent(ev.event_id, person.person_id);
  if (!reg.ok) return reg;

  return {
    ok: true,
    person,
    context_id: ev.context_id,
    registration: reg.registration,
    created_person: createdPerson,
  };
}

/**
 * Public-safe event view by share_token. No phone numbers, no other-player
 * details unless the caller is registered (then we surface their position).
 */
export async function getPublicEvent(share_token, viewer_person_id = null) {
  const ev = (await pool.query(
    `SELECT event_id, context_id, title, event_date, event_time, location,
            capacity, status, registration_opens_at, share_token, created_at
       FROM event WHERE share_token = $1`,
    [share_token],
  )).rows[0];
  if (!ev) return null;

  const counts = (await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'main')::int     AS main_count,
       COUNT(*) FILTER (WHERE status = 'waitlist')::int AS waitlist_count
       FROM event_registration WHERE event_id = $1`,
    [ev.event_id],
  )).rows[0];

  let me = null;
  if (viewer_person_id) {
    const myReg = (await pool.query(
      `SELECT id, status, signed_up_at, promoted_at, withdrawn_at
         FROM event_registration
        WHERE event_id = $1 AND person_id = $2`,
      [ev.event_id, viewer_person_id],
    )).rows[0];
    if (myReg) {
      let position = null;
      if (myReg.status === 'waitlist') {
        position = parseInt((await pool.query(
          `SELECT COUNT(*)::int + 1 AS p FROM event_registration
            WHERE event_id = $1 AND status = 'waitlist'
              AND (signed_up_at < $2
                 OR (signed_up_at = $2 AND id < $3))`,
          [ev.event_id, myReg.signed_up_at, myReg.id],
        )).rows[0].p, 10);
      }
      me = { ...myReg, position };
    }
  }

  return { ...ev, ...counts, me };
}

/**
 * Admin-only full roster. Includes person names (NOT phone numbers — those
 * are PII; phone is admin-only via a separate endpoint, deferred to next slice).
 */
export async function getAdminRoster(event_id) {
  const ev = (await pool.query(
    `SELECT * FROM event WHERE event_id = $1`, [event_id],
  )).rows[0];
  if (!ev) return null;

  const rows = (await pool.query(
    `SELECT r.id, r.status, r.signed_up_at, r.promoted_at, r.withdrawn_at,
            r.person_id, p.name
       FROM event_registration r
       JOIN person p ON p.person_id = r.person_id
      WHERE r.event_id = $1
      ORDER BY r.status, r.signed_up_at ASC, r.id ASC`,
    [event_id],
  )).rows;

  const main      = rows.filter(r => r.status === 'main');
  const waitlist  = rows.filter(r => r.status === 'waitlist');
  const withdrawn = rows.filter(r => r.status === 'withdrawn');
  return { ...ev, main, waitlist, withdrawn };
}
