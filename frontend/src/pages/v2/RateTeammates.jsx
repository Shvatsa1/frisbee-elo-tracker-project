/**
 * SPEC_16 §6: RateTeammates — sparse peer rating.
 *
 * The CORE design rule is "never make anyone rate all 44". So:
 *  - Searchable filter at the top to find a known player fast.
 *  - Each row has a 5-tier picker AND a prominent "Skip — don't know".
 *  - Save is per-row (autosave on tier click); no "submit all" button.
 *  - Re-clicking a tier in the same ISO week overwrites (server enforces).
 *  - Progress text is honest: "rated 8 of N teammates you scored".
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { v2 } from './_api.js';
import { ensureSession } from './_token.js';

const DEFAULT_TIER_ORDER = ['New', 'Developing', 'Solid', 'Strong', 'Elite'];

export default function RateTeammates() {
  const [me, setMe] = useState(null);
  const [q, setQ] = useState('');
  const [ratings, setRatings] = useState({}); // { player_id: { tier, status: 'saving'|'saved'|'error', msg? } }
  const [skipped, setSkipped] = useState({}); // { player_id: true }
  const [topError, setTopError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        await ensureSession();
        const data = await v2.me();
        setMe(data);
      } catch (e) {
        setTopError(e?.response?.data?.error || e.message || 'failed to load');
      }
    })();
  }, []);

  const orderedTiers = useMemo(() => {
    const tiers = me?.tier_score ? Object.keys(me.tier_score) : DEFAULT_TIER_ORDER;
    return [...tiers].sort((a, b) => (me?.tier_score?.[a] ?? 0) - (me?.tier_score?.[b] ?? 0));
  }, [me]);

  const filtered = useMemo(() => {
    if (!me) return [];
    const lc = q.trim().toLowerCase();
    return me.teammates.filter(t =>
      !lc || t.name.toLowerCase().includes(lc),
    );
  }, [me, q]);

  async function rate(playerId, tier) {
    setRatings(r => ({ ...r, [playerId]: { tier, status: 'saving' } }));
    setSkipped(s => { const n = { ...s }; delete n[playerId]; return n; });
    try {
      await v2.ratePeer(playerId, tier);
      setRatings(r => ({ ...r, [playerId]: { tier, status: 'saved' } }));
    } catch (e) {
      const msg = e?.response?.data?.error || e.message || 'save failed';
      setRatings(r => ({ ...r, [playerId]: { tier, status: 'error', msg } }));
    }
  }

  if (topError && !me) {
    return (
      <div className="max-w-md mx-auto text-center py-12 space-y-2">
        <h1 className="text-xl font-bold">Couldn’t load the roster</h1>
        <p className="text-slate-400 text-sm">{topError}</p>
      </div>
    );
  }
  if (!me) return <div className="text-slate-400 text-center py-12">Loading roster…</div>;

  const ratedCount = Object.values(ratings).filter(r => r.status === 'saved').length;
  const total = me.teammates.length;
  const skippedCount = Object.keys(skipped).length;

  return (
    <div className="max-w-3xl mx-auto space-y-6 animate-in fade-in duration-500">
      <header className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">Rate teammates</h1>
        <p className="text-slate-400 text-sm">
          Score only the people you’ve actually played with. Skip the rest —
          you don’t need to rate everyone.
        </p>
        {!me.context?.open_rating && (
          <p className="text-amber-400 text-xs">
            Strict mode: you can only rate people you’ve played a confirmed
            match with. Ask the admin to flip <code>open_rating</code> to
            relax this.
          </p>
        )}
      </header>

      <div className="glass-panel p-4 flex items-center justify-between gap-4">
        <input
          className="input-field flex-grow"
          placeholder="Search teammates…"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
        <div className="text-right text-xs text-slate-400 whitespace-nowrap">
          rated {ratedCount} · skipped {skippedCount} · roster {total}
        </div>
      </div>

      <div className="space-y-2">
        {filtered.map(t => {
          const r = ratings[t.player_id];
          const isSkipped = !!skipped[t.player_id];
          return (
            <RatingRow
              key={t.player_id}
              teammate={t}
              tiers={orderedTiers}
              chosen={r?.tier}
              status={r?.status}
              statusMsg={r?.msg}
              skipped={isSkipped}
              onTier={tier => rate(t.player_id, tier)}
              onSkip={() => skipPlayer(t.player_id, setSkipped, setRatings)}
            />
          );
        })}
        {filtered.length === 0 && (
          <p className="text-slate-500 text-sm text-center py-6">No teammates match "{q}".</p>
        )}
      </div>

      <p className="text-slate-500 text-xs">
        Your ratings save as you tap. You can re-tap a different tier this week
        to change your mind — it overwrites, never stacks.
      </p>

      <Link to="/v2/me" className="text-sm text-slate-400 hover:text-white">
        ← back to your card
      </Link>
    </div>
  );
}

function skipPlayer(playerId, setSkipped, setRatings) {
  setSkipped(s => ({ ...s, [playerId]: true }));
  setRatings(r => { const n = { ...r }; delete n[playerId]; return n; });
}

function RatingRow({ teammate, tiers, chosen, status, statusMsg, skipped, onTier, onSkip }) {
  return (
    <div className={`glass-panel p-3 flex items-center gap-3 flex-wrap ${
      skipped ? 'opacity-50' : ''
    }`}>
      <div className="flex-grow min-w-[140px]">
        <div className="font-medium">{teammate.name}</div>
        {status === 'saved' && (
          <div className="text-xs text-emerald-400">saved · {chosen}</div>
        )}
        {status === 'saving' && (
          <div className="text-xs text-slate-400">saving…</div>
        )}
        {status === 'error' && (
          <div className="text-xs text-red-400">error: {statusMsg}</div>
        )}
        {skipped && <div className="text-xs text-slate-500">skipped — don't know</div>}
      </div>
      <div className="flex gap-1.5 flex-wrap">
        {tiers.map(t => (
          <button key={t} onClick={() => onTier(t)}
            className={`px-2.5 py-1 rounded text-sm ${chosen === t
              ? 'bg-primary text-white'
              : 'bg-white/5 text-slate-300 hover:bg-white/10'}`}
          >{t}</button>
        ))}
        <button onClick={onSkip}
          className="px-2.5 py-1 rounded text-sm bg-white/5 text-slate-400 hover:bg-white/10"
        >Skip</button>
      </div>
    </div>
  );
}
