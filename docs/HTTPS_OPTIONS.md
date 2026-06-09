# HTTPS options for UltiElo

UltiElo's player-facing magic-link flow (SPEC_16) is designed to work on
**plain HTTP** for the first deployment. This doc explains why that's safe
enough, and the cleanest paths to real HTTPS when you want them.

---

## 1. Threat model (plain HTTP, single-use tokens)

The token a player redeems comes in on `/api/session` exactly once. The
server then mints a short-lived **session id** (~30 min, in-memory) which
the client uses for every subsequent request. The raw `rating_token`
**never travels twice**.

A coffee-shop attacker who passively sniffs one request sees at most:

| What they see | What they can do |
|---|---|
| The token in the very first `/api/session` POST | **Nothing** — by the time they replay it, the server has already marked `token_used_at = NOW()` and rejects re-use. |
| The session id on subsequent requests | Cause mischief for ≤30 min, in *one* context, only for things the player themselves can do (fill their own card, rate teammates). They can't escalate to admin. The session expires; the next link mint cycles the underlying token too. |
| Card / peer-rating contents | They learn what one player thinks of their teammates — i.e. the data that would already be on the public leaderboard once the blend runs. Low value. |

The system is **deliberately NOT** safe against active man-in-the-middle on
plain HTTP (an attacker can hijack a session in real time). That's a
conscious trade for "ship before Wednesday with no DNS / no certs / no
domain". The HTTPS options below close that gap.

**The token TTL + single-use combo IS the non-HTTPS mitigation.** Don't
relax either of them without taking a serious look at this threat model
again.

### Things that are NOT used for security
- **IP address.** Carrier NAT and shared field wifi mean rater IPs are
  meaningless. We never dedup on IP and never block on IP.
- **User agent.** Mobile browsers lie / change. Don't trust it.
- **The Tier-0 `X-Person-Id` header.** It's a convenience for admins on the
  local network; anyone who's seen the public list can spoof it. Don't
  expose the admin routes to the public internet on plain HTTP.

---

## 2. Recommended: Tailscale Funnel (no domain, real HTTPS, free)

Tailscale Funnel gives you a public HTTPS URL bound to your tailnet host
with a real cert from Tailscale's CA — **no domain registration, no
Let's Encrypt, no Caddy**. Perfect for small-group ops where buying a
domain feels excessive.

```bash
# on the UltiElo VM (or your laptop)
sudo tailscale up
sudo tailscale funnel 5000   # exposes :5000 publicly over HTTPS
```

You'll get back a URL like `https://your-host.tail-scale.ts.net` (the exact
suffix depends on your tailnet). Use that as the `--base-url` argument to
`scripts/issue_tokens.js`:

```bash
node scripts/issue_tokens.js \
    --context 1 \
    --ttl-hours 48 \
    --base-url https://your-host.tail-scale.ts.net
```

Caveats:
- Funnel needs Tailscale ≥ 1.50. Older versions only have "serve" (tailnet-only).
- Funnel is gated to ports 443 / 8443 / 10000 by default — point it at
  your express port via the right CLI flag (`tailscale funnel --bg --https=443 5000`).
- A free Tailscale plan gives you the cert + URL; no payment required.

This is the **least friction** route to HTTPS today.

---

## 3. Alternative: Cloudflare Tunnel + a domain

If you already own a domain (any TLD), Cloudflare Tunnel gives you HTTPS
with their cert, no inbound ports, no public IP:

```bash
# one-time auth
cloudflared tunnel login
cloudflared tunnel create ultielo
cloudflared tunnel route dns ultielo ultielo.example.com
# run it
cloudflared tunnel --url http://localhost:5000 run ultielo
```

Pick this if you want a memorable URL and you're already in the Cloudflare
ecosystem.

---

## 4. Alternative: Caddy + Let's Encrypt (classic)

If you have a public IP and a DNS A-record pointing at it:

```caddy
ultielo.example.com {
    reverse_proxy localhost:5000
}
```

Caddy auto-provisions a Let's Encrypt cert. Most "real" path; least
disposable if the deployment moves.

---

## 5. When HTTPS is in place — what changes in the app

Once `base-url` is `https://...`:
1. **Nothing in the code needs to change** — the magic-link UX, the token
   redemption flow, and the session middleware all already work the same.
2. You can **lengthen `--ttl-hours`** — the active-MITM risk is gone, so
   24h-vs-7d is a UX call, not a security one.
3. You can finally enable the legacy `/api/skill/peer` route by setting
   `ENABLE_PEER_RATING=1` if any caller still uses it. (New callers should
   prefer the session-authed `/api/rate`.)
4. You can drop the deliberate "in-memory session store, restart-clears-it"
   trade-off and move sessions to a tiny `rater_session` table — only
   worth doing if the volume grows enough that restart-clears-it actually
   bites real users.

---

## 6. Decision matrix

| Situation | Pick |
|---|---|
| One-off, this week, no domain, friends only | **Plain HTTP + single-use tokens** (the default ship). Document the trade-off in the WhatsApp link drop. |
| Same as above but you have a spare Tailscale node | **Tailscale Funnel** (5-minute setup, real HTTPS) |
| Permanent home, you own a domain | **Caddy + Let's Encrypt** or **Cloudflare Tunnel** |
| Public deployment, multiple deployments per day | Caddy on a stable box; bind sessions to a Postgres table |
