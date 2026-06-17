/**
 * SPEC_16 §6: MyCard — self profile + FIFA card.
 *
 * Session-authed (X-Session-Id from localStorage). On mount we:
 *   - ensureSession() in case the page was opened with `?t=...` directly
 *   - GET /api/me for the player's current attribute + card + tier mapping
 *
 * The 6 attributes are picked from a 5-tier UI; we POST the chosen tier
 * NAME (e.g. "Strong"). The server converts tier→midpoint via the shared
 * TIER_SCORE constant and derives a `self` skill_input. The blend engine
 * we don't touch.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { v2 } from './_api.js';
import { ensureSession } from './_token.js';

const ATTRIBUTES = [
  { key: 'throwing',  label: 'Throws — variety',     hint: 'flicks, backhands, scoobers, hammers' },
  { key: 'cutting',   label: 'Cutting',              hint: 'reading defenders, getting open downfield' },
  { key: 'handling',  label: 'Handling — overall',   hint: 'accuracy, decision-making, dump / reset' },
  { key: 'defense',   label: 'Defense',              hint: 'D blocks, person & zone, on-disc pressure' },
  { key: 'speed',     label: 'Speed',                hint: 'top-end + first-step burst' },
  { key: 'endurance', label: 'Endurance',            hint: 'late-game legs, double points' },
];

const POSITIONS  = ['handler', 'cutter', 'hybrid'];
const HANDS      = ['left', 'right'];
const STYLES     = ['direct', 'short', 'aerial'];
const OD_PREFS   = ['offence', 'defence', 'both'];

const DEFAULT_TIER_ORDER = ['New', 'Developing', 'Solid', 'Strong', 'Elite'];

export default function MyCard() {
  const [me, setMe] = useState(null);
  const [card, setCard] = useState({});      // { throwing: 'Strong', ... } (tier names)
  const [profile, setProfile] = useState({}); // { position, hand, style, od_preference }
  const [savingCard, setSavingCard] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [error, setError] = useState(null);
  const [derived, setDerived] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await ensureSession();
        const data = await v2.me();
        if (cancelled) return;
        setMe(data);
        // Pre-populate card with closest tier for any numeric values found
        if (data.card) {
          const pre = {};
          for (const a of ATTRIBUTES) {
            const v = data.card[a.key];
            if (v != null) pre[a.key] = nearestTier(v, data.tier_score);
          }
          setCard(pre);
        }
        if (data.attribute) setProfile(data.attribute);
      } catch (e) {
        setError(e?.response?.data?.error || e.message || 'failed to load /api/me');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function saveCard() {
    if (!me) return;
    setSavingCard(true);
    setError(null);
    try {
      const res = await v2.updateCard(card);
      setDerived(res.derived);
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'save failed');
    } finally {
      setSavingCard(false);
    }
  }

  async function saveProfile() {
    if (!me) return;
    setSavingProfile(true);
    setError(null);
    try {
      await v2.updateProfile(profile);
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'save failed');
    } finally {
      setSavingProfile(false);
    }
  }

  if (error && !me) {
    return (
      <div className="max-w-md mx-auto text-center py-12 space-y-2">
        <h1 className="text-xl font-bold">Couldn’t open your card</h1>
        <p className="text-slate-400 text-sm">{error}</p>
        <p className="text-slate-500 text-xs">If your link expired, ask for a new one.</p>
      </div>
    );
  }
  if (!me) return <div className="text-slate-400 text-center py-12">Loading your card…</div>;

  const tiers = me.tier_score ? Object.keys(me.tier_score) : DEFAULT_TIER_ORDER;
  // Sort tiers by score asc so the buttons read left→right (worst→best).
  const orderedTiers = [...tiers].sort(
    (a, b) => (me.tier_score?.[a] ?? 0) - (me.tier_score?.[b] ?? 0),
  );

  return (
    <div className="max-w-2xl mx-auto space-y-6 animate-in fade-in duration-500">
      {/* Hero header — matches the /v2/results landing's visual language */}
      <div className="glass-panel relative overflow-hidden p-6 md:p-8">
        <div className="absolute inset-0 bg-[url('https://images.unsplash.com/photo-1598024220557-93ba2a488e02?auto=format&fit=crop&q=80')] bg-cover bg-center opacity-10 mix-blend-overlay" />
        <div className="absolute inset-0 bg-gradient-to-t from-[#131C31] via-[#131C31]/80 to-transparent" />
        <div className="relative z-10">
          <div className="text-xs uppercase tracking-widest text-primary font-bold mb-1">Your player card</div>
          <h1 className="text-4xl md:text-5xl font-black tracking-tight leading-none">{me.person.name}</h1>
          <p className="text-slate-400 text-sm mt-3 max-w-lg">
            Rate yourself on six attributes. Five levels, no half-points.
            We’ll work out your blended offence/defence so the team-builder
            can use it.
          </p>
        </div>
      </div>

      <section className="glass-panel p-5 space-y-4">
        <h2 className="text-lg font-semibold">Style</h2>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <Select label="Position"  value={profile.position}      onChange={v => setProfile({ ...profile, position: v })}      options={POSITIONS} />
          <Select label="Hand"      value={profile.hand}          onChange={v => setProfile({ ...profile, hand: v })}          options={HANDS} />
          <Select label="Style"     value={profile.style}         onChange={v => setProfile({ ...profile, style: v })}         options={STYLES} />
          <Select label="O/D pref"  value={profile.od_preference} onChange={v => setProfile({ ...profile, od_preference: v })} options={OD_PREFS} />
        </div>
        <button className="btn-primary" onClick={saveProfile} disabled={savingProfile}>
          {savingProfile ? 'Saving…' : 'Save style'}
        </button>
      </section>

      <section className="glass-panel p-5 space-y-4">
        <h2 className="text-lg font-semibold">Attribute-wise rating</h2>
        {ATTRIBUTES.map(a => (
          <TierRow
            key={a.key}
            label={a.label}
            hint={a.hint}
            value={card[a.key]}
            onChange={v => setCard({ ...card, [a.key]: v })}
            tiers={orderedTiers}
          />
        ))}
        <div className="flex items-center gap-4">
          <button className="btn-primary" onClick={saveCard} disabled={savingCard}>
            {savingCard ? 'Saving…' : 'Save card'}
          </button>
          {derived && (
            <span className="text-xs text-slate-400">
              Saved · Offence <b className="text-white">{derived.offence.toFixed(0)}</b> ·
              Defence <b className="text-white">{derived.defence.toFixed(0)}</b>
            </span>
          )}
        </div>
        {error && <p className="text-red-400 text-sm">{error}</p>}
      </section>

      <section>
        <Link to="/v2/me/rate" className="btn-secondary inline-block">
          Rate teammates (sparse) →
        </Link>
        <p className="text-slate-500 text-xs mt-2">
          Only score the people you’ve actually played with — skip the rest.
        </p>
      </section>
    </div>
  );
}

function TierRow({ label, hint, value, onChange, tiers }) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-slate-500">{hint}</span>
      </div>
      <div className="flex gap-2 flex-wrap">
        {tiers.map(t => (
          <button type="button" key={t} onClick={() => onChange(t)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium ${value === t
              ? 'bg-primary text-white'
              : 'bg-white/5 text-slate-300 hover:bg-white/10'}`}
          >{t}</button>
        ))}
      </div>
    </div>
  );
}

function Select({ label, value, onChange, options }) {
  return (
    <label className="block">
      <span className="text-xs text-slate-400 block mb-1">{label}</span>
      <select className="input-field"
        value={value ?? ''} onChange={e => onChange(e.target.value || null)}>
        <option value="">—</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

// Given a numeric 0–100 score, pick the tier whose midpoint is closest.
function nearestTier(score, tierMap) {
  const entries = Object.entries(tierMap ?? {});
  if (!entries.length) return null;
  let best = entries[0][0];
  let bestDist = Math.abs(entries[0][1] - score);
  for (const [name, mid] of entries.slice(1)) {
    const d = Math.abs(mid - score);
    if (d < bestDist) { best = name; bestDist = d; }
  }
  return best;
}
