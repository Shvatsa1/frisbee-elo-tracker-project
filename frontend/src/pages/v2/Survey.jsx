/**
 * Per-game survey (`POST /api/match/:id/survey`).
 *
 * Tier-0: the acting person_id must own the chosen player_id. The
 * server enforces it; this page just helps you pick a player you
 * actually played as.
 */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { v2 } from './_api.js';
import ActingAs from './_ActingAs.jsx';

export default function Survey() {
  const { match_id } = useParams();
  const [match, setMatch] = useState(null);
  const [actor, setActor] = useState(null);
  const [playerId, setPlayerId] = useState('');
  const [balance, setBalance] = useState(3);
  const [enjoyment, setEnjoyment] = useState(4);
  const [effort, setEffort] = useState(4);
  const [note, setNote] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    v2.match(match_id).then(setMatch).catch(e => setStatus(e.message));
  }, [match_id]);

  async function submit(e) {
    e.preventDefault();
    setStatus('saving…');
    try {
      await v2.submitSurvey(match_id, {
        player_id: Number(playerId),
        balance_felt: Number(balance),
        enjoyment: Number(enjoyment),
        effort: Number(effort),
        improve_note: note || undefined,
      });
      setStatus('thanks — submitted');
    } catch (e) {
      setStatus(e?.response?.data?.error || e.message);
    }
  }

  if (!match) return <div className="text-slate-400">Loading match…</div>;

  return (
    <div className="max-w-xl mx-auto space-y-5 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Post-game survey</h1>
        <p className="text-slate-400 text-sm">
          {match.team_a_name} {match.team_a_score} – {match.team_b_score} {match.team_b_name} ·{' '}
          {new Date(match.match_date).toLocaleDateString()}
        </p>
      </div>

      <ActingAs onChange={setActor} />

      <form onSubmit={submit} className="glass-panel p-5 space-y-4">
        <div>
          <label className="text-xs text-slate-400 block mb-1">Submitting as which player?</label>
          <select className="input-field" value={playerId} onChange={e => setPlayerId(e.target.value)} required>
            <option value="">— select —</option>
            {match.players.map(p => (
              <option key={p.player_id} value={p.player_id}>
                {p.name} (Team {p.team})
              </option>
            ))}
          </select>
        </div>

        <Rating label="How balanced did it feel? (1=blowout, 5=razor)" value={balance} onChange={setBalance} />
        <Rating label="Enjoyment (1=meh, 5=loved it)"                  value={enjoyment} onChange={setEnjoyment} />
        <Rating label="Effort (1=jogged, 5=left it all out there)"     value={effort} onChange={setEffort} />

        <div>
          <label className="text-xs text-slate-400 block mb-1">Something to improve (optional)</label>
          <textarea className="input-field" rows={3} value={note} onChange={e => setNote(e.target.value)} />
        </div>

        <button type="submit" className="btn-primary" disabled={!actor || !playerId}>
          Submit
        </button>
        <span className="text-xs text-slate-400 ml-3">{status}</span>
      </form>
    </div>
  );
}

function Rating({ label, value, onChange }) {
  return (
    <div>
      <label className="text-xs text-slate-400 block mb-2">{label}</label>
      <div className="flex gap-2">
        {[1, 2, 3, 4, 5].map(n => (
          <button type="button" key={n} onClick={() => onChange(n)}
                  className={`w-10 h-10 rounded-lg font-bold ${Number(value) === n ? 'bg-primary text-white' : 'bg-white/5 text-slate-300 hover:bg-white/10'}`}>
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}
