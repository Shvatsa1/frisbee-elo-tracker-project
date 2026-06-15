# UltiElo v2 — MVP walkthrough for Sourabh

**From:** Shantanu · **Date:** 2026-06-15 · **Branch:** `ultielo-v2` on my fork (`github.com/Shvatsa1/frisbee-elo-tracker-project`); not opened as a PR into your repo yet.
**Purpose:** get you (Sourabh, who built v1) up to speed on the v2 rebuild, agree the data model, and lock the handful of decisions only you/we can make — before next minis.

> **TL;DR for the read:** v1 on `159.89.160.51:80` is **untouched and stays the public site** until you sign off. v2 is live in parallel at **`https://ultielo.taildd7ac1.ts.net/v2/results`** behind Tailscale Funnel HTTPS (free, no domain) — only people I share a magic link with land there. Six minis games from 2026-06-04 are already imported and the leaderboard/results reflect them. Open it, click around, and tell me what looks wrong.

---

## 0. STATE AT HANDOVER (2026-06-15)

**What's live and verified working:**
- **v2 deployed on the VM alongside untouched v1.** V1 on `:80` (your original). V2 on `:8080` + Tailscale Funnel HTTPS at `https://ultielo.taildd7ac1.ts.net`. Separate DB (`frisbee_elo_v2`), separate compose stack (`docker-compose.v2.yml`). VM checkout `/root/ultielo-v2`. V1 DB backed up: `/root/v1_db_backup_*.sql`.
- **Full v2 schema** (person/player/context split, skill blend, builder, match lifecycle, FIFA card, tokens, photo_url).
- **Player Rating (0–100) decoupled from Elo (0–2500).** Rating = human judgement (admin + self + peer); Elo accrues from match results. **Team builder balances on `0.5·rating + 0.5·(Elo÷25)`** (weights tunable). Verified: a 14-player build produced two teams at avg metric 46.6, spread 0.22.
- **6 v1 minis games (2026-06-04) imported** into v2 via `backend/scripts/import_v1_games.js` (idempotent, mirrors confirm-flow exactly): fresh Elo recomputed from 1000 baseline; Team D (3-0) lands at 1055.4 Elo. Visible on the new landing page.
- **Landing page** (`/v2/results`): Last Week shown by default — team-vs-team rosters, winner accent, players link to FIFA profile cards. Buttons: Rate Yourself / Rate Teammates / Leaderboard.
- **Passwordless magic-link auth (forever sessions).** Magic link IS the login — reusable, 48h to first click, then a **1-year session** that self-heals on backend restart (the client silently re-redeems the stored token on any 401). Token issuance: `backend/scripts/issue_tokens.js --context 1 --base-url <funnel-url>`. 44 fresh links minted today, ready for WhatsApp distribution.
- **Peer rating always-on.** Backed by `context.open_rating=TRUE` + session identity (no eligibility gate). Rating integrity enforced server-side on the authenticated `person_id` (5-tier buckets → 90/70/50/30/10, identity-based dedup, trimmed-mean aggregation, self-weight decay, one row per (rater, ratee) upsert).
- **Admin / player gating.** Frontend Navbar role-buckets (`publicItems` / `playerItems` / `adminItems`) keyed by device-local `ultielo:adminView`. Admins unlock with a one-time URL `?admin=1&key=<secret>` that sets localStorage + strips from URL. Backend writes additionally require `X-Admin-Key` (constant-time compare; no-op if env unset). Players never see admin tabs; an attacker who sets the localStorage flag still gets 403 on writes.
- **FIFA-style PlayerCard component**, rendered on PlayerProfile (per context): photo or initials, color-coded rating badge, OFF/DEF + ELO row, six attribute bars (THR/CUT/HAN/DEF/SPD/END), W/L footer. Display options `showElo/showRating/showAttrs`.
- **Tests: 8 suites, all green** including the reusable-token assertion flip and the new import-flow suite.
- **Bug fixed earlier:** match-confirm was feeding the 0–100 *rating* into the Elo engine instead of real Elo. Now reads `player_statistics_cache.current_elo` correctly.

**What's NOT done (open for you / next session):**
- **Photo upload UI** — `photo_url` column exists, no upload flow yet (fast-follow; file storage TBD — S3 vs local volume).
- **Name→roster resolver** for game day — `/api/build` takes player_ids; there's no "paste attendance names → match to roster → flag unknowns" step yet. This is the main game-day gap.
- **"Try v2 →" button on v1** — players who land on v1 don't yet know v2 exists. Intentional until you sign off; snippet in `DEPLOY_V2.md` when we're ready.
- **WhatsApp mood poll: shelved**; `PLAYER_INPUT_MOOD_POLL.md` kept for reference only.
- **PR fork→yours** — I'll open it once you've poked around and we're aligned on the data model.
- Per-session minis preferences (today's cut/handle, O/D, availability) — deferred to a later spec (SPEC_17 drafted).

**Spec of record for the player-input layer:** `Agent_for_Anti_Gravity/specs/SPEC_16_ultielo_player_inputs.md`.

---

## 1. TL;DR

v1 was a single flat `players` table with one Elo number per player. v2 splits **identity** from **per-context participation** and turns the single Elo into a **multi-source skill blend** (admin rating + self + peers + match results), so the same person can play in different leagues/contexts and we can build **balanced teams** before a game instead of only ranking after.

It already runs end to end locally: I ported your 44 real v1 players, rated all 44 via an Excel sheet, imported them, and the leaderboard + team builder work. **The thing I need from you is a review of the model and sign-off on the open decisions in §5.**

---

## 2. What changed since your v1

| Area | v1 | v2 |
|------|----|----|
| Data model | `players(player_id, name, current_elo, w/l)` | `person` (human) → `player` (person *in a context*) → `player_skill` / `player_statistics_cache` |
| Rating | one Elo, updated only by match results | **two separate numbers:** a human **Rating** (0–100, blend of admin+self+peer, offence/defence split) *and* **Elo** (0–2500, from match results). Decoupled on purpose. |
| Pre-game | none | **team builder**: snake draft + role-aware rebalance to even out teams |
| Post-game | win/loss | match recording + confirmation + per-player survey, feeds back into skill |
| Contexts | single implicit league | multiple (e.g. "Wednesday Minis", tournaments) — same person, separate stats |
| Stack | same React/Express/Postgres | same, plus embedded-Postgres test harness + sanity suites (schema/skill/elo/builder/routes/export/import) |

Your v1 data is **untouched and safe** — I pulled a read-only snapshot + full backup; the live VM DB was never modified.

---

## 3. The MVP you can poke at right now

Backend routes live (`backend/server.js`):

- `GET /api/leaderboard` — players as rows, skill columns (the v1-style view, now blended)
- `GET /api/export/skills` — same as an `.xlsx` download
- `POST /api/skill/admin|self|peer` — rating inputs (admin is what we used for seeding)
- `POST /api/build` — generate balanced teams for a roster (rating + Elo mix)
- `POST /api/match`, `/api/match/:id/confirm`, `/api/match/:id/survey` — record + confirm + survey a game
- `GET /api/player/:person_id` — player profile
- **SPEC-16 player-facing:** `POST /api/session` (redeem magic link), `GET/PUT /api/me` + `/api/me/card` + `/api/me/profile` (self), `POST /api/rate` (peer rating, 5-tier)

Frontend pages (`frontend/src/pages/v2/`): `Leaderboard`, `AdminRating`, `Builder`, `Survey`, `PlayerProfile`, **`MyCard`, `RateTeammates`, `Redeem`** (player-facing, token-authed).

**Seed state (already imported):** 44 players, all admin-rated. Current top of the blended leaderboard:

| # | Player | Off | Def | Headline (0–100) |
|---|--------|-----|-----|----------|
| 1 | Steffi K | 60 | 64 | 62 |
| 2 | Niddhi | 60 | 64 | 62 |
| 3 | Karan Arora | 64 | 60 | 62 |
| 4 | Sourabh Meena | 60 | 56 | 58 |
| 5 | Vignesh | 56 | 58 | 57 |

(Ratings on 0–100; Elo shown separately. Full sheet: `exports/Wednesday_Minis_skills_populated.xlsx`.)

---

## 4. How to run it locally

### Option A — no Docker (embedded Postgres, fastest to try)
```powershell
cd backend
npm install
node scripts/seed_local.js        # builds .localdb, ports v1, imports ratings, writes populated xlsx
node scripts/local_db.js          # keeps Postgres up (Ctrl-C to stop)
# in a second terminal:
$env:DATABASE_URL="postgres://postgres:localpw@localhost:55433/frisbee_elo"; npm start
# in a third terminal:
cd ../frontend; npm install; npm run dev
```

### Option B — Docker (your v1 workflow)
`docker-compose.yml` is still here. Point `DATABASE_URL` at the compose `db`, run `npm run init-db`, then `npm run port-v1 -- --csv migrations/v1_data/v1_players_20260608_142429.csv`, then `npm run import-ratings -- --xlsx ../exports/Wednesday_Minis_rating_template.xlsx`.

### The rating round-trip (how the seed data got there)
```powershell
# 1. generate a blank rating sheet from the roster (no DB needed)
node scripts/rating_template.js --csv migrations/v1_data/v1_players_20260608_142429.csv --out ../exports/Wednesday_Minis_rating_template.xlsx
# 2. (admin fills Offence/Defence/Position/O-D pref in Excel)
# 3. import the filled sheet
npm run import-ratings -- --xlsx ../exports/Wednesday_Minis_rating_template.xlsx
```
Import is **idempotent** — re-importing an edited sheet refreshes scores, never stacks duplicates.

---

## 4b. Model — SETTLED (Shantanu, 2026-06-09)

- **Rating = human judgement only**, on **0–100** (50 = average), blended from admin + self + peer. **Independent of Elo** — match results do *not* move the rating.
- **Elo = 0–2500**, accrues from each minis session's results (Sourabh's engine, untouched).
- **Team builder balances on a *mix* of both**: `0.5·rating + 0.5·(Elo÷25)`, weights tunable per build via `constraints.{w_rating,w_elo}`. Early on (few games) you can lean on rating.
- Existing 44 admin scores were **auto-converted ÷25** from the old 0–2500 sheet (e.g. 1500→60). New ratings are entered natively on 0–100.
- **Self-only fields** (player owns; not peer-settable): hand, position, O/D preference, style.

*All of this is implemented, tested (7 suites green), and reseeded into the local DB.*

## 5. ⛳ DECISIONS I STILL NEED FROM YOU (please mark a choice)

> D1–D3 are now settled (see §4b). The rest below are still open. Reply inline or in a call.

| # | Decision | My default / proposal | Your call |
|---|----------|----------------------|-----------|
| D4 | **Peer rating rollout** — players rate each other after games. Needs HTTPS first (tokens sniffable on plain HTTP). | keep `ENABLE_PEER_RATING` OFF until Caddy/TLS is on the VM | ☐ agree ☐ rush it |
| D5 | **Team builder algorithm** — snake draft + role-aware rebalance. Good enough for Wednesday? | yes for v1; iterate after | ☐ ship ☐ rework |
| D6 | **Deploy target** — local-only for Wednesday, or push to the VM now? VM is 1 GB and shares with other bots. | local-only Wednesday; deliberate VM deploy later (backup first) | ☐ agree ☐ deploy now |
| D7 | **Roster of 44 vs full list** — 8 v1 demo rows (Alice…Heidi) dropped; ~5 more real players may exist. | start with 44, add the missing 5 when the group admin shares them | ☐ ok ☐ wait for full list |
| D8 | **Contexts** — is "Wednesday Minis" the only context for now, or do we model tournaments too? | one context now | ☐ one ☐ more |
| D9 | **Repo/branch** — merge `ultielo-v2` strategy: rename to `main`, or keep v1 deployed and v2 parallel? | keep v1 live, v2 on branch until demo'd | ☐ agree ☐ other |

---

## 6. What we need from the minis players for tomorrow (2026-06-10)

To make the game itself a live test of the loop, we want **two things** from players:

1. **Confirm the roster** — who's actually playing Wednesday (subset of the 44). Group admin to share the final attendance list so we build teams only from those present.
2. **Their self-rating (optional but valuable)** — a quick offence/defence self-score on the same 0–2500 scale, so we have a `self` source alongside admin to test the blend. Either:
   - a short Google Form (name + offence + defence + position + O/D pref), or
   - we collect verbally and I enter via the admin sheet.

**On the day we can demo the full loop:** attendance → `POST /api/build` → balanced teams → play → record result + 1-tap survey → leaderboard updates. That's the story for you.

**Open question for players' data:** are we OK storing names + ratings, or do we want pseudonyms/consent first? (Small friendly group — probably fine, but worth a sentence in the group.)

---

## 7. Suggested next steps (in order)

1. **You review §5** and mark the decisions. (~20 min, unblocks everything.)
2. Get the **Wednesday attendance list** + any missing players from the group admin.
3. (Optional) Stand up the **self-rating form** for players before the game.
4. Wednesday: run the **build → play → record** loop live; collect first real `result` data.
5. After Wednesday: tune blend weights (D1) against real data; decide on VM deploy + TLS (D4/D6).

---

*Files referenced: `backend/scripts/{rating_template,import_ratings,seed_local,local_db}.js`, `backend/migrations/port_v1_players.js`, `exports/Wednesday_Minis_*.xlsx`. Tests: `backend/test/{export,import}.test.js` (run `npm test`).*
