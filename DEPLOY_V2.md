# Deploying UltiElo v2 alongside v1 on `159.89.160.51:8080`

**Goal:** keep the existing v1 site (what Sourabh has seen) running untouched on
`:80`, and serve the new v2 on `:8080`, with a "Try the new version →" link on
the old site. No DNS / extra URLs — one IP, two ports.

> **STATUS: staged, NOT deployed.** Everything below is ready to run, but the
> actual VM push is deliberately left to a human because of the RAM constraint
> (see ⚠️). Nothing here has touched the live box.

---

## ⚠️ Read first — RAM

The VM is **1 GB**, shared with `consultant-bot` and the **7 pm IST trading-bot**
task. The v2 stack adds processes. **Before deploying:**

1. **Add a swapfile** (cheap OOM insurance):
   ```bash
   fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
   echo '/swapfile none swap sw 0 0' >> /etc/fstab
   free -h     # confirm swap is live
   ```
2. **Prefer the lean variant** (reuse the v1 Postgres — no 2nd DB process) unless
   you have headroom. See *Option B* below.
3. Deploy **outside the 7 pm window** and watch `free -h` / `docker stats`.

---

## Design

```
                          :80   ─────────────►  v1 frontend  ──►  v1 backend  ──►  v1 Postgres   (UNTOUCHED)
http://159.89.160.51
                          :8080 ─►  nginx (v2)  ──► serves v2 SPA
                                       └── /api ─►  backend-v2  ──►  frisbee_elo_v2 DB
```

- v2 frontend is built with `VITE_API_BASE=/api`; nginx on :8080 proxies `/api`
  to `backend-v2`. (Code: `frontend/nginx.v2.conf`, `frontend/Dockerfile.prod`,
  `frontend/src/pages/v2/_api.js`.)
- v2 uses its **own database** so v1 data is never at risk.

---

## Option A — self-contained (simplest, heavier)

Uses `docker-compose.v2.yml` (its own Postgres). Good if swap is on and RAM is OK.

```bash
# on the VM, in the v2 repo checkout (e.g. /root/ultielo-v2)
git fetch && git checkout ultielo-v2 && git pull
docker compose -f docker-compose.v2.yml up -d --build

# seed the v2 DB (schema + 44 players + 0–100 ratings)
docker compose -f docker-compose.v2.yml exec backend-v2 npm run init-db
docker compose -f docker-compose.v2.yml exec backend-v2 \
  npm run port-v1 -- --csv migrations/v1_data/v1_players_20260608_142429.csv
docker compose -f docker-compose.v2.yml exec backend-v2 \
  npm run import-ratings -- --xlsx ../exports/Wednesday_Minis_rating_template.xlsx --from-scale 2500

# verify
curl -s http://localhost:8080/api/leaderboard?context_id=1 | head
```
Open `http://159.89.160.51:8080`.

## Option B — lean (reuse the v1 Postgres, no 2nd DB) — RECOMMENDED on 1 GB

Skip `db-v2`; point `backend-v2` at the **existing** v1 Postgres container with a
**new database** `frisbee_elo_v2` (v1's `frisbee_elo` is never touched):

```bash
# create the v2 database inside the running v1 Postgres
docker compose -f docker-compose.yml exec -T db \
  psql -U postgres -c "CREATE DATABASE frisbee_elo_v2;"
```
Then in `docker-compose.v2.yml`: delete the `db-v2` service + `pgdata_v2` volume,
and set `backend-v2`'s `DATABASE_URL` to the v1 db host, e.g.
`postgres://postgres:password@<v1-db-container>:5432/frisbee_elo_v2`
(put both stacks on the same docker network, or use the host IP). Bring up only
`backend-v2` + `frontend-v2`, then run the same seed commands as Option A.

---

## The link on the old site

Add a small banner/button to the **v1** frontend (the live one) pointing at the
new site. Minimal, dependency-free — drop into the v1 layout/Navbar:

```html
<a href="http://159.89.160.51:8080"
   style="display:inline-block;padding:6px 12px;border-radius:8px;
          background:#6d28d9;color:#fff;font:600 13px sans-serif;text-decoration:none">
  ✨ Try the new UltiElo (v2) →
</a>
```
(If you'd rather not rebuild the old frontend, this can also be injected via the
old site's nginx `sub_filter`, or just shared as a link in WhatsApp for now.)

---

## Rollback (v1 is never affected)

```bash
docker compose -f docker-compose.v2.yml down          # stops v2 only
# v1 keeps running on :80 the entire time
```

## Monitoring after bring-up
```bash
docker stats --no-stream      # check backend-v2 / db-v2 memory
free -h                       # confirm swap headroom, no OOM kills
journalctl -k | grep -i oom   # verify nothing got OOM-killed (esp. the trading bot)
```
