/**
 * Admin Rating screen.
 *
 * For each player in the chosen context, the admin sets an offence
 * and a defence score on a 0–100 scale (50 = average). Hits
 * `POST /api/skill/admin`, which writes a `skill_input(source='admin')`
 * and recomputes `player_skill`.
 *
 * Tier-0: the acting admin's person_id comes from the `_ActingAs`
 * picker (localStorage → `X-Person-Id` header).
 */
import { useEffect, useState, useCallback } from 'react';
import { v2 } from './_api.js';
import ActingAs from './_ActingAs.jsx';
import ContextPicker from './_ContextPicker.jsx';

export default function AdminRating() {
  const [actor, setActor] = useState(null);
  const [ctxId, setCtxId] = useState(null);
  const [players, setPlayers] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [status, setStatus] = useState({});

  const refresh = useCallback(() => {
    if (!ctxId) { setPlayers([]); return; }
    v2.leaderboard(ctxId).then(rows => {
      setPlayers(rows);
      setDrafts(Object.fromEntries(rows.map(r => [
        r.player_id,
        { offence: r.offence_skill ?? 50, defence: r.defence_skill ?? 50 },
      ])));
    });
  }, [ctxId]);

  useEffect(() => { refresh(); }, [refresh]);

  async function save(playerId) {
    if (!actor) { setStatus(s => ({ ...s, [playerId]: 'set "Acting as" first' })); return; }
    if (!ctxId) return;
    const draft = drafts[playerId];
    setStatus(s => ({ ...s, [playerId]: 'saving…' }));
    try {
      await v2.adminRate({
        context_id: ctxId,
        player_id: playerId,
        offence_score: Number(draft.offence),
        defence_score: Number(draft.defence),
      });
      setStatus(s => ({ ...s, [playerId]: 'saved' }));
      refresh();
    } catch (e) {
      setStatus(s => ({ ...s, [playerId]: e?.response?.data?.error || e.message }));
    }
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Admin Rating</h1>
        <p className="text-slate-400">Set offence / defence scores (0–100, 50 = average) for each player. These feed the blended rating, separate from Elo.</p>
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <ActingAs onChange={setActor} />
        <ContextPicker onChange={setCtxId} />
      </div>

      <CreatePlayerForm ctxId={ctxId} onCreated={refresh} />

      <div className="glass-panel overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="bg-white/5 border-b border-white/10 text-sm text-slate-400">
              <th className="p-3">Player</th>
              <th className="p-3 text-right">Current Headline</th>
              <th className="p-3 text-right">Offence</th>
              <th className="p-3 text-right">Defence</th>
              <th className="p-3"></th>
              <th className="p-3 text-right">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {players.map(p => {
              const d = drafts[p.player_id] || { offence: 50, defence: 50 };
              return (
                <tr key={p.player_id} className="hover:bg-white/5">
                  <td className="p-3 font-medium">{p.name}</td>
                  <td className="p-3 text-right text-accent font-bold">
                    {p.headline_scalar != null ? Math.round(p.headline_scalar) : '—'}
                  </td>
                  <td className="p-3 text-right">
                    <input
                      type="number" min="0" max="100"
                      className="bg-slate-900 border border-white/10 rounded px-2 py-1 w-24 text-right"
                      value={d.offence}
                      onChange={e => setDrafts(s => ({ ...s, [p.player_id]: { ...s[p.player_id], offence: e.target.value } }))}
                    />
                  </td>
                  <td className="p-3 text-right">
                    <input
                      type="number" min="0" max="100"
                      className="bg-slate-900 border border-white/10 rounded px-2 py-1 w-24 text-right"
                      value={d.defence}
                      onChange={e => setDrafts(s => ({ ...s, [p.player_id]: { ...s[p.player_id], defence: e.target.value } }))}
                    />
                  </td>
                  <td className="p-3">
                    <button onClick={() => save(p.player_id)} className="btn-primary text-sm">Save</button>
                  </td>
                  <td className="p-3 text-right text-xs text-slate-400">{status[p.player_id] || ''}</td>
                </tr>
              );
            })}
            {players.length === 0 && (
              <tr><td colSpan={6} className="p-8 text-center text-slate-400">No players. Add one above.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CreatePlayerForm({ ctxId, onCreated }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [position, setPosition] = useState('cutter');
  const [odPref, setOdPref] = useState('both');
  const [status, setStatus] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (!ctxId || !name.trim()) return;
    setStatus('saving…');
    try {
      await v2.createPlayer({
        context_id: ctxId,
        name: name.trim(),
        phone: phone.trim() || undefined,
        attribute: { position, od_preference: odPref },
      });
      setName(''); setPhone('');
      setStatus('added');
      onCreated?.();
    } catch (e) {
      setStatus(e?.response?.data?.error || e.message);
    }
  }

  return (
    <form onSubmit={submit} className="glass-panel p-4 flex flex-wrap gap-2 items-end">
      <div className="flex-grow min-w-[180px]">
        <label className="text-xs text-slate-400">Name</label>
        <input className="input-field" placeholder="e.g. Sai" value={name} onChange={e => setName(e.target.value)} />
      </div>
      <div className="min-w-[180px]">
        <label className="text-xs text-slate-400">Phone (dedupe key)</label>
        <input className="input-field" placeholder="+91-..." value={phone} onChange={e => setPhone(e.target.value)} />
      </div>
      <div>
        <label className="text-xs text-slate-400">Position</label>
        <select className="input-field" value={position} onChange={e => setPosition(e.target.value)}>
          <option value="handler">handler</option>
          <option value="cutter">cutter</option>
          <option value="hybrid">hybrid</option>
        </select>
      </div>
      <div>
        <label className="text-xs text-slate-400">O/D pref</label>
        <select className="input-field" value={odPref} onChange={e => setOdPref(e.target.value)}>
          <option value="offence">offence</option>
          <option value="defence">defence</option>
          <option value="both">both</option>
        </select>
      </div>
      <button type="submit" className="btn-primary">Add Player</button>
      <span className="text-xs text-slate-400 ml-2">{status}</span>
    </form>
  );
}
