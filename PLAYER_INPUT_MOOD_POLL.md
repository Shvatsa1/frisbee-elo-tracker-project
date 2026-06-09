# UltiElo — player mood poll (run BEFORE building the collection UX)

**Why this poll exists:** the single biggest unknown is *how much time the group will
actually spend rating themselves and each other.* That answer decides which parts of
SPEC-16 we build. Run this as a **WhatsApp poll** (or a 60-sec Google Form) before
investing in the interactive peer screen. Each question maps to a concrete build call.

---

## Paste-ready WhatsApp version

> 🥏 *Quick one for the team-balancer we're building — 30 seconds, no wrong answers:*
>
> **1. Rate YOURSELF (a quick "FIFA card" — throws, cutting, D, speed, etc., ~2 min). Would you?**
> 🅰️ Yes, sounds fun
> 🅱️ Sure, if it's quick
> 🅾️ Nah, you rate me
>
> **2. Rate a few TEAMMATES you know well (just the ones you've played with, skip the rest, ~3 min on a webpage). Would you?**
> 🅰️ Yes, happy to
> 🅱️ Maybe, if it's easy
> 🅾️ No, too much effort
>
> **3. Before each Minis, tell us your preference for THAT day (handle/cut, O/D, are you in)? (~20 sec)**
> 🅰️ Yes, every time
> 🅱️ Sometimes
> 🅾️ Just put me anywhere
>
> **4. How do you feel about a personal link (WhatsApp DM) to do your ratings — no login, no password?**
> 🅰️ Fine by me
> 🅱️ Don't care
> 🅾️ Prefer not to click links

*(Optional free text: anything you'd actually want the app to do?)*

---

## How each answer changes the build

| Q | If mostly 🅰️/🅱️ (willing) | If mostly 🅾️ (low effort) |
|---|---------------------------|---------------------------|
| **1 — self card** | Build `MyCard.jsx` (full 6-attribute FIFA card). | Drop the card; admin sets a default profile. Self stays optional, low weight. |
| **2 — peer rating** | Build `RateTeammates.jsx` (sparse, skip-friendly). **This is the swing vote.** | **Don't build peer collection at all** — lean on admin rating + Elo from results. Saves the most work. |
| **3 — session prefs** | Worth the later Type-D build (same-day pref-aware teams). | Defer indefinitely; build teams from standing profile + Elo. |
| **4 — magic links** | Per-person `rating_token` links are accepted → ship them. | Switch to in-person/kiosk collection at the field, or a name+PIN login. |

**The decision that matters most is Q2.** If the group won't rate each other, the whole
peer/token/HTTPS apparatus is unnecessary and we ship a much smaller thing
(admin + results only). Read Q2 first.

## Reading the result
- **Q2 ≥ ~60% willing** → build the peer screen; proceed with SPEC-16 in full.
- **Q2 mixed** → build it but keep `context.open_rating` opt-in; pilot with the keen subset.
- **Q2 mostly 🅾️** → **skip SPEC-16's peer half**; implement only A/B (self) + keep admin
  rating as the backbone.
- **Q4 mostly 🅾️** → revisit auth (kiosk / PIN) before issuing any magic links.

## Notes
- Keep it to these 4 — longer polls get ignored. The free-text box is where the real
  product ideas show up.
- Run it in the same WhatsApp group the attendance list comes from, so Q3/availability
  doubles as a nudge for the roster.
