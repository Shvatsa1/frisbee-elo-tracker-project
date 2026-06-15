# SPEC_17 — Passwordless login, onboarding, and session registration (Soozy replacement)

**Status:** Draft for implementation
**Branch:** `ultielo-v2` (continue) or a fresh `ultielo-v2-spec17`
**Depends on:** SPEC_15 (skill blend, schema), SPEC_16 (magic-link tokens, sessions)
**Author handoff:** open a fresh session with "Read specs/SPEC_17…md and implement."

**Supersedes the earlier draft of this spec** (which used phone + password + planned
SMS OTP). That design has been **dropped** — see §0.1. There is no password, no
email, and no SMS/DLT dependency in v1.

---

## 0. Why this exists

Two things need to be true before UltiElo can replace the current tools:

1. **Players need an identity** keyed to their phone number, so every game sign-up
   is attributed to a real person — not the spoofable Tier-0 `X-Person-Id` header.
2. **The site must absorb what Soozy did:** publish a per-session sign-up link,
   fill a fixed number of slots in sign-up order, waitlist the overflow, and
   auto-promote from the waitlist when someone drops out.

This spec covers both, plus the HTTPS transport they ride on.

### 0.1 The auth model: magic-link-only, no password, no OTP

The hard, expensive part of "login" was never the logic — it was the **delivery
channel for one-time codes** (SMS needs DLT registration + ₹5,900 + KYC; email
needs addresses we don't have + a mail sender; WhatsApp Business needs Meta
verification). So we **don't send codes at all.**

`issue_tokens.js` already mints a unique link per player (`/r/<token>`). **That
link is the login.** This is exactly how Soozy / Doodle / Calendly work — nobody
remembers anything.

- Once per player, the admin DMs them their personal link (manual paste from a
  personal phone — no automation, no ban risk).
- They tap it → the device holds a **long-lived identity cookie** → they're "in"
  as themselves on that device, indefinitely.
- Every game after: they open the site (cookie still valid) or re-tap their link
  → tap **"I'm in."**
- Lost their link / new phone: the admin re-DMs the link. At ~60 people this is a
  once-in-a-while paste, not a system to build.

**Why not a password:** a password set via a magic link roots its trust in that
same link — whoever redeems the link first controls the account either way. So a
password adds *no* real assurance over the link, only friction. Dropped.

**Why not email:** we have phone numbers, not emails; collecting/verifying emails
is more work *and* data we don't have, for no security gain. Dropped.

### 0.2 Decisions locked by the user (do not re-litigate)
- **Passwordless.** Magic link = the entire login. No password, no email, no OTP.
- **One authenticated session does everything** (§2.5 / §3.6). Redeeming the magic
  link already proves identity; registration AND rating both run off that single
  long-lived identity session. **No separate per-round rating link.** Rating
  integrity is enforced server-side on the authenticated `person_id` (eligibility,
  one-row-per-pair, robust aggregation, self-weight decay), NOT by a second auth
  tier. **Peer rating is always available to every logged-in player — no admin
  gate, no open/close window.** The only gate is eligibility (played-together /
  roster).
- **The magic link is reusable** (re-tappable to re-establish the session on a new
  device), long-TTL — safe *because* HTTPS (§7) is a hard prerequisite. This
  relaxes SPEC_16's single-use property; see §3.6 note.
- **Capacity is per-event and admin-set** (default 28), chosen when the session
  link is generated. The 29th sign-up onward (at cap 28) goes to the waitlist.
- **One registration per member.** No +1 / guest slots in v1.
- **Players may remove their own name at any time** — no hard cut-off.
- **Waitlist promotion runs on a 30-minute sweep** (not event-driven). The
  earliest waitlisted player fills the freed slot.
- **WhatsApp promotion notice is admin-assisted, not auto-posted.** Auto-posting
  into the existing group and tagging a number is not cleanly buildable (Business
  Cloud API can't post into a normal member group; unofficial automation on a
  personal number risks a ban). Shippable default: the system produces the exact
  ready-to-paste, pre-tagged message and surfaces it to the admin, who taps to
  post. True auto-posting is a documented future option.
- **Data minimisation:** capture only **name + phone**. No email, address,
  location, or device IDs. `phone` is PII — admin-only, never in a public API
  response, never logged in plaintext.

### What already exists (do NOT rebuild)
- `backend/scripts/issue_tokens.js` — mints a TTL `rating_token` per player in a
  context and prints `Name: <base-url>/r/<token>`. This **is** the magic-link
  generator. Reuse it.
- `backend/authority.js` — session store (`_sessions` Map, 30-min TTL),
  `redeemToken(token, {context_id})`, `resolveActor`, `requireContextAuthority`.
- `person.rating_token / token_expires_at / token_used_at` columns (SPEC_16).
- `frontend/src/pages/v2/Redeem.jsx` (`/r/:token`) — redeems a token → session.
- **The SPEC_16 rating flow** (`/v2/me`, `/v2/me/rate`, single-use rating tokens):
  **leave it exactly as-is.** SPEC_17 does not modify, relax, or route around it.

---

## 1. User cohorts and onboarding

| Cohort | Who | Path in |
|---|---|---|
| **A — known** | the ~60 active players (≈44 already in the DB; ~16 added by hand from the WhatsApp group) | admin pre-seeds `person(name, phone)` → `issue_tokens.js` mints their magic link → admin DMs it → player taps `/r/:token` → **identity cookie set, done** |
| **B — brand new** | someone new to the sport, phone unknown in advance | public **Join** page → submits name + phone → lands as `pending` → admin approves → player gets a magic link (same as A) |

There is **no separate "login" step.** Redeeming the link *is* logging in. A
returning player with a live cookie just opens the site; one who cleared cookies
re-taps their link.

### 1.1 Seeding the known cohort
New script `backend/scripts/seed_people.js`:
- Input: a CSV `name,phone` (the ~60 active players). Header row required.
- For each row: upsert into `person` by `phone` (phone is the natural key);
  create a `player` row in the target context if missing. Idempotent.
- `--context <id|name>` (default "Wednesday Minis"), `--dry-run`, `--csv <path>`.
- Normalise phone to E.164-ish (`+91…`) before storing; reject obvious dupes.
- **Never** print full phone numbers to stdout — print name + last 4 digits only.
- Take a `pg_dump` of `frisbee_elo_v2` before the first bulk seed (the
  monthly-leanup / deploy routine already shows the pattern). Inserts/updates
  `person`/`player` only; no destructive writes.

Then run the existing `issue_tokens.js --context <id> --base-url <https-url>` to
mint links for the freshly-seeded players.

---

## 2. Schema changes

All additive, all guarded the way `initDb.js` already does it (idempotent
`CREATE TABLE IF NOT EXISTS` + `DO $$ … information_schema.columns …` blocks).
Add the new DDL to `createV2SchemaSql` in `backend/initDb.js`.

### 2.1 Account status on `person`
```sql
ALTER TABLE person ADD COLUMN status         VARCHAR(16) NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active','pending','blocked'));
ALTER TABLE person ADD COLUMN phone_verified BOOLEAN NOT NULL DEFAULT FALSE;
```
- **No `password_hash`** — passwordless (§0.1).
- `status='pending'` = self-signed-up via Join, awaiting admin approval. Such a
  person has **no `player` row** and **cannot register for events** until approved.
- `phone_verified` flips TRUE when the magic link is redeemed (proves control of
  the number that link was DMed to).

### 2.2 Events
```sql
CREATE TABLE IF NOT EXISTS event (
  event_id            SERIAL PRIMARY KEY,
  context_id          INTEGER NOT NULL REFERENCES context(context_id) ON DELETE CASCADE,
  title               VARCHAR(255) NOT NULL,            -- e.g. "Wednesday Minis — 17 Jun"
  event_date          DATE NOT NULL,
  event_time          VARCHAR(16),                      -- free text, e.g. "7:00 PM"
  location            VARCHAR(255),
  capacity            INTEGER NOT NULL DEFAULT 28 CHECK (capacity >= 1),  -- admin-set per event
  status              VARCHAR(16) NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','closed','cancelled')),
  registration_opens_at TIMESTAMP,                      -- NULL = open immediately
  share_token         VARCHAR(128) UNIQUE NOT NULL,     -- public, unguessable; the link players open
  created_by          INTEGER NOT NULL REFERENCES person(person_id),
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS event_context_idx ON event(context_id);
CREATE INDEX IF NOT EXISTS event_status_idx  ON event(status);
```

### 2.3 Registrations
```sql
CREATE TABLE IF NOT EXISTS event_registration (
  id            SERIAL PRIMARY KEY,
  event_id      INTEGER NOT NULL REFERENCES event(event_id)   ON DELETE CASCADE,
  person_id     INTEGER NOT NULL REFERENCES person(person_id) ON DELETE CASCADE,
  status        VARCHAR(16) NOT NULL DEFAULT 'main'
                 CHECK (status IN ('main','waitlist','withdrawn')),
  signed_up_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- ORDERING KEY (chronological)
  promoted_at   TIMESTAMP,                                     -- set when WL→main
  withdrawn_at  TIMESTAMP,
  UNIQUE (event_id, person_id)                                 -- one registration per member
);
CREATE INDEX IF NOT EXISTS event_reg_event_status_idx
  ON event_registration(event_id, status, signed_up_at);
```
- `signed_up_at` is the chronological key — both for filling main slots and for
  waitlist promotion order. **Never** overwrite it on status changes; promotion
  preserves the original sign-up time (strict FIFO).
- A player who withdraws and re-registers gets a **new** `signed_up_at` (back of
  the line) — enforce by resetting `signed_up_at` only when transitioning out of
  `withdrawn`.

### 2.4 Promotion notifications (admin-paste queue)
```sql
CREATE TABLE IF NOT EXISTS promotion_notice (
  id            SERIAL PRIMARY KEY,
  event_id      INTEGER NOT NULL REFERENCES event(event_id)   ON DELETE CASCADE,
  person_id     INTEGER NOT NULL REFERENCES person(person_id) ON DELETE CASCADE,
  message       TEXT NOT NULL,        -- pre-rendered, ready-to-paste, includes the @tag text
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at  TIMESTAMP             -- admin marks delivered after pasting; NULL = pending
);
```
This table **is** the pluggable notifier's default sink.

### 2.5 One session — rating integrity is server-side, not a second auth tier

The security model: **redeeming the magic link mints one long-lived identity
session, and that single session authorizes everything** the player can do —
register/withdraw for games, edit their own card, rate teammates. There is **no
separate, stricter "rating session" and no per-round rating link.**

Why this is safe (the earlier two-tier design was over-built): a fresh per-round
token would have re-proven identity to *exactly the same degree* as the existing
session — both root in the same link DM'd to the same phone. Re-authentication
adds friction, not assurance. What actually protects ratings is enforced
**server-side on the authenticated `person_id`:**

| Risk to rating integrity | Server-side control (keyed on `person_id`) |
|---|---|
| Rating as someone else | the session already resolves to a known person_id |
| Re-rating a teammate N× to swing them | one row per `(rater, ratee)`; re-rate = upsert latest |
| Rating someone you've never played with | eligibility gate (played-together, or full-roster if the context opts in) |
| One outlier skews a player | trimmed-mean / median aggregation (SPEC_16) |
| Sandbagging your own card | self-source weight decays fast in the blend (SPEC_15/16) |
| Session sniffed on the wire | **HTTPS (Tailscale Funnel, §7) — a hard prerequisite** |

**Hard rules (enforce in middleware / service):**
1. Rating endpoints **accept the identity session** (the authenticated person_id is
   the rater). They still enforce the eligibility gate and one-row-per-pair upsert.
2. Peer rating is **always available** to any authenticated player — no admin
   open/close gate, no rating "window", no token re-issue. The eligibility gate
   (played-together / roster) is the only thing that limits *whom* you can rate.
3. Anonymised display + who-rated-whom audit (SPEC_16) are unchanged.
4. The whole model assumes **HTTPS** (§7) — that is what lets the link be reusable
   and the session long-lived (HTTPS_OPTIONS §5: single-use was only the no-HTTPS
   mitigation).

Implementation: the `_sessions` store carries the resolved `person_id` and
`context_id` as today. No `tier` field, no rating-only session type. The redeem
path (§3.1) mints one session; rating routes read its `person_id`.

---

## 3. Backend routes

New file `backend/eventService.js` (slot math + promotion) + routes in `server.js`.

### 3.1 Identity / account
| Route | Auth | Body / params | Behaviour |
|---|---|---|---|
| `POST /api/identity/redeem` | none | `{ token }` | Redeem the magic link. Verify TTL; **reusable** (does NOT set `token_used_at` — re-tap re-establishes the session on a new device). Set `phone_verified=TRUE`. Mint the **long-lived identity session**; return its id (rides the existing `X-Session-Id` interceptor). This is the only "login." |
| `POST /api/logout` | session | — | Drop the session id. |
| `GET  /api/me` | session | — | Returns the caller's own card/context. Must **not** leak other people's phones. |

> **Link reusability:** the magic link is now reusable + long-TTL (re-tap to log in
> on a new phone, no admin round-trip). This relaxes SPEC_16's single-use
> `rating_token` behaviour — acceptable because HTTPS (§7) replaces single-use as
> the transport mitigation (HTTPS_OPTIONS §5). Implementation choice: either repurpose
> the existing `rating_token` as the durable identity token, or add a parallel
> reusable `invite_token` column and leave `rating_token` for any legacy caller.
> Prefer the former (one token, simpler) unless a legacy single-use caller still
> depends on it.

There is **no** `/api/login` (phone+password) and **no** `/api/account/password`.
Removed from the prior draft.

### 3.2 Self-serve join (Cohort B)
| Route | Auth | Body | Behaviour |
|---|---|---|---|
| `POST /api/join` | none (public) | `{ name, phone, context_id }` | Upsert `person` by phone with `status='pending'`. If the phone already maps to an `active` person, return a soft "you may already have an account — ask the admin for your link" (do **not** confirm/deny existence in a leaking way). No `player` row yet. |
| `GET  /api/admin/pending` | admin (context authority) | — | List pending people (name + masked phone). |
| `POST /api/admin/pending/:person_id/approve` | admin | `{ context_id }` | Flip `status='active'`, create the `player` row, mint a magic link via the `issue_tokens` core (`mintTokensForContext`), return `Name: <link>` for the admin to DM. |
| `POST /api/admin/pending/:person_id/reject` | admin | — | `status='blocked'` (or hard-delete the pending person). |

### 3.3 Events (admin)
| Route | Auth | Body | Behaviour |
|---|---|---|---|
| `POST /api/event` | admin | `{ context_id, title, event_date, event_time?, location?, capacity?, registration_opens_at? }` | Create event; generate `share_token` (`crypto.randomBytes(24).hex`); default `capacity=28`. Return the event incl. public URL `<base>/e/<share_token>`. |
| `PATCH /api/event/:id` | admin | partial | Edit title/date/capacity/status. **If capacity raised**, the next sweep promotes from the waitlist; **if lowered below current main count**, do NOT auto-demote — log a warning, leave mains (admin resolves manually). |
| `POST /api/event/:id/close` | admin | — | `status='closed'`; freezes registration + promotion. |
| `GET  /api/admin/event/:id` | admin | — | Full roster: main (ordered), waitlist (ordered), withdrawn, with names + masked phones + sign-up times. |
| `GET  /api/admin/event/:id/notices` | admin | — | Pending `promotion_notice` rows (paste queue). |
| `POST /api/admin/notice/:id/delivered` | admin | — | Mark a notice delivered. |

### 3.4 Events (player)
| Route | Auth | Params | Behaviour |
|---|---|---|---|
| `GET  /api/e/:share_token` | identity session | — | Event view (title/date/location/capacity, current main count, waitlist length, and — if the caller is registered — their own status + position). Does NOT list other registrants' phones. |
| `POST /api/e/:share_token/register` | identity session | — | Register the logged-in person. **Slot math (atomic):** lock the event row; count current `main`; if `main_count < capacity` → `main`, else → `waitlist`. Reject if `status != 'open'`, before `registration_opens_at`, or person is `pending`. Idempotent. |
| `POST /api/e/:share_token/withdraw` | identity session | — | Set the caller's registration to `withdrawn`, stamp `withdrawn_at`. Frees a main slot for the next sweep. |

### 3.5 Slot math — exact rules (encode in `eventService.js`)
- **Capacity check is on `status='main'` count only.** Waitlist is unbounded.
- **Register:** `main_count < capacity` ⇒ `main`; else `waitlist`. Ordering
  everywhere is `signed_up_at ASC, id ASC`.
- **Withdraw from `main`:** frees a slot; do **not** promote inline (sweep does it).
- **Withdraw from `waitlist`:** just removes.
- All writes that change `main` membership happen inside `BEGIN … SELECT … FOR
  UPDATE` on the event row to avoid two registrations exceeding cap.

### 3.6 Rating endpoints — now reachable from the identity session
The SPEC_16 rating routes (self-card submit/edit, peer rating) **accept the identity
session** — its `person_id` is the rater. Changes vs SPEC_16:
- Drop the requirement for a *fresh single-use* rating token; the durable session
  is the auth (§2.5).
- Keep the eligibility gate (played-together, or full roster if a context opts in).
- Peer rating writes upsert one row per `(rater, ratee, context)` — re-rating
  overwrites; no duplicate-vote inflation.
- **Peer rating is always available** to logged-in players — no admin open/close
  gate, no token re-issue.
- Anonymised display + who-rated-whom audit unchanged.

---

## 4. Waitlist promotion sweep (the Soozy behaviour)

New `backend/jobs/promotion_sweep.js`, every 30 minutes.

- **Scheduler:** `node-cron` (`*/30 * * * *`) started from `server.js` on boot,
  guarded by `ENABLE_PROMOTION_SWEEP=1` so tests/local don't fire it. Single
  process; still wrap each event's promotion in the `FOR UPDATE` transaction.
- **Per open event** (`status='open'`, `event_date >= today`):
  1. `main_count = count(status='main')`.
  2. While `main_count < capacity` and a `waitlist` row exists:
     - Promote the **earliest** waitlisted row (`ORDER BY signed_up_at, id`):
       set `status='main'`, `promoted_at=NOW()`. Keep original `signed_up_at`.
     - `main_count += 1`.
     - **Enqueue a `promotion_notice`** for that person (§5).
- **Idempotent / restart-safe:** derives everything from current state; a missed
  tick heals on the next run.
- **Logging:** per CLAUDE.md §4.2, one line per promotion to
  `backend/logs/promotion_sweep.log` (event_id, person masked, old→new count).

> Instant-on-withdraw promotion was explicitly **not** chosen. If responsiveness
> ever matters, the withdraw route can also call `promoteEvent(eventId)`; the
> design already supports it.

---

## 5. Promotion notification (admin-assisted, pluggable)

`backend/notifiers/index.js` exposing `notifyPromotion(person, event)`:

- **Default (`adminPaste`):** render the message, insert a `promotion_notice` row.
  Template (admin pastes into the group, where `@<phone>` becomes a real tag):
  ```
  🏃 @{phone}  ({name}) — a slot opened up for {title} on {date}.
  You're now on the MAIN list. Reply here if you can't make it so the next
  person can take the spot.
  ```
  The admin panel shows pending notices with a copy button; admin pastes, then
  hits "mark delivered".
- **Interface contract:** `notifyPromotion` returns `{ queued: true }`. A future
  `whatsAppCloud` / `botBridge` notifier implements the same signature and sends
  directly, setting `delivered_at` itself. **No route/sweep change when swapped** —
  only the notifier module + `PROMOTION_NOTIFIER=adminPaste|…`.
- **Why not auto-post now:** §0.2 — Business Cloud API can't post into the existing
  member group; unofficial automation risks a number ban. Revisit with a dedicated
  bot number.

---

## 6. Frontend

Mobile-first (players are on phones):

| Route | Page | Notes |
|---|---|---|
| `/r/:token` (exists) | `Redeem.jsx` | Now redeems an **identity** link → sets the long-lived identity session → routes to the event page or `/v2/me`. **No "set password" step.** |
| `/join` | `Join.jsx` (new) | Public. name + phone + context → `POST /api/join` → "thanks, the admin will send your link." |
| `/e/:share_token` | `EventRegister.jsx` (new) | The Soozy-style page: event details, a big **Register** button → main-or-waitlist result with live position; **Withdraw** button if registered. If no identity session, show "tap your personal link to join in" (no password form). |
| `/v2/admin/events` | `AdminEvents.jsx` (new) | Create event (with capacity field), see roster, see the **paste queue** with copy buttons + "mark delivered", approve/reject pending joins. Behind the existing admin gate. |

**Removed from the prior draft:** `SetPassword.jsx`, `Login.jsx` — passwordless.

The API client (`frontend/src/pages/v2/_api.js`) gains: `redeemIdentity`,
`logout`, `join`, `getEvent`, `registerEvent`, `withdrawEvent`, `createEvent`,
`adminEventRoster`, `adminNotices`, `markNoticeDelivered`, `adminPending`,
`approvePending`. Session id continues to ride the existing `X-Session-Id`
interceptor — no transport change. The SPEC_16 rating client calls are untouched.

---

## 7. HTTPS transport (Tailscale Funnel)

Per `docs/HTTPS_OPTIONS.md` §2 — the prerequisite for the identity cookie going
public, free, no domain. No code change (frontend uses a relative `/api` base;
magic-link `--base-url` is a CLI arg). **§2.5's rating guarantee assumes this is
in place.**

Ops steps (hand the interactive bits to the user):
1. On the VM: install Tailscale, `sudo tailscale up` (user completes browser
   auth), then `sudo tailscale funnel --bg --https=443 8080`.
2. Note the `https://<host>.ts.net` URL.
3. Re-mint links with it: `node scripts/issue_tokens.js --context 1 --base-url
   https://<host>.ts.net`. Use the same base for event share links.
4. Once HTTPS is live, optionally lengthen token TTL (HTTPS_OPTIONS §5).

---

## 8. Build / validation order (per CLAUDE.md process rules)

1. **Schema first** — add DDL + guards to `initDb.js`; run against a throwaway
   local `frisbee_elo_v2`; confirm tables/columns exist.
2. **Identity session** — `/api/identity/redeem` mints a reusable long-lived
   session; assert it authorizes register/withdraw AND (when the rating window is
   open) self-card + peer rating. Security test: assert peer-rating still enforces
   the eligibility gate and one-row-per-`(rater,ratee)` upsert off the session's
   person_id (§2.5).
3. **Seed + links** — `seed_people.js` with a 5-row sample CSV, `--dry-run` first;
   verify masked output; then `issue_tokens.js` on the sample context.
4. **Events + slot math** — create an event (capacity 3), register 4 people,
   assert #4 is `waitlist`; withdraw #1; run the sweep; assert #4 promoted and a
   `promotion_notice` row exists. **Acceptance test → `backend/test/event_registration.test.js` before scaling.**
5. **Frontend** — wire pages; smoke-test on a phone via the Funnel URL.
6. **Sweep scheduler** — enable `ENABLE_PROMOTION_SWEEP=1` on the VM only after 4
   passes.

**Acceptance criteria (define pass before testing):**
- A known player can redeem their link once and remain logged in on that device;
  re-tapping the same link re-establishes the session on a new device.
- The same identity session can register/withdraw AND, when the rating window is
  open, edit own card + rate eligible teammates; re-rating a teammate overwrites
  rather than stacks; rating a non-eligible player is rejected.
- A new player can Join → appears in admin pending → approve mints a link.
- Registering past capacity lands on the waitlist; withdrawing a main player +
  running the sweep promotes the earliest waitlister and queues a paste-ready
  notice with the correct name/phone tag.
- No public endpoint ever returns another person's phone number.

---

## 9. Open questions (resolve during implementation, not blockers)

1. **Token to repurpose (§3.1 note).** Reuse the existing `rating_token` as the
   durable identity token vs. add a parallel `invite_token`. Prefer reuse unless a
   legacy single-use caller still depends on `token_used_at`. Confirm before the
   redeem path.
2. **(Resolved 2026-06-11)** Peer rating is **always available** to logged-in
   players — no admin gate, no open/close window. Eligibility is the only limit.
3. **Multiple contexts.** Events FK a context; multi-context works, but the UI can
   hardcode the default ("Wednesday Minis") until a second context exists.
4. **Re-register ordering** (§2.3) — confirm "back of the line on re-register"
   matches how the old tool felt.
5. **Notice tagging format** — confirm `@<phone>` is what tags a person on paste;
   adjust template if the admin's client needs `+`/country code in a specific form.
