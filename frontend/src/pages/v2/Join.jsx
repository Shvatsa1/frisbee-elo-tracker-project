/**
 * /v2/join — website self-signup for a brand-new player. No event link and no
 * admin-minted magic link required: enter name + phone, get a profile + a
 * durable identity session, and land on your card to rate yourself.
 *
 * Reuses the same name-conflict guard as event self-signup: if the name matches
 * an existing player, we confirm before creating a separate identity (so we
 * don't orphan someone's Elo history).
 */
import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { UserPlus } from 'lucide-react';
import {
  v2, getSessionId, setSessionId, setActorId, setContextId, setAuthToken, getContextId,
} from './_api.js';

export default function Join() {
  const navigate = useNavigate();
  const [ctxId, setCtxId] = useState(getContextId());
  const [draft, setDraft] = useState({ name: '', phone: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const alreadyIn = !!getSessionId();

  // Resolve context: stored session context, else the only context.
  useEffect(() => {
    if (ctxId) return;
    v2.listContexts()
      .then(cs => { if (cs.length) setCtxId(cs[0].context_id); })
      .catch(() => {});
  }, [ctxId]);

  async function onJoin(confirm_new = false) {
    if (!draft.name.trim() || !draft.phone.trim()) {
      setErr('Name and phone are both required.');
      return;
    }
    if (!ctxId) { setErr('No group to join yet.'); return; }
    setBusy(true); setErr('');
    try {
      const data = await v2.join({
        context_id: ctxId,
        name: draft.name.trim(),
        phone: draft.phone.trim(),
        confirm_new,
      });
      setSessionId(data.session_id);
      setActorId(data.person_id);
      if (data.context_id) setContextId(data.context_id);
      if (data.rating_token) setAuthToken(data.rating_token);
      navigate('/v2/me');
    } catch (e) {
      const body = e?.response?.data;
      if (body?.error === 'name_conflict') {
        setErr('');
        const proceed = window.confirm(
          `${body.hint}\n\nProceed as a different player with the same name?`,
        );
        if (proceed) { setBusy(false); return onJoin(true); }
        setBusy(false);
        return;
      }
      setErr(body?.error || e.message);
    } finally { setBusy(false); }
  }

  if (alreadyIn) {
    return (
      <div className="max-w-md mx-auto glass-panel p-6 text-center space-y-3 animate-in fade-in duration-500">
        <p className="text-slate-200 font-medium">You're already signed in.</p>
        <Link to="/v2/me" className="btn-primary inline-block">Go to my card →</Link>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center gap-3">
        <div className="rounded-xl bg-primary/15 p-2.5 text-primary"><UserPlus className="w-5 h-5" /></div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Join</h1>
          <p className="text-slate-400 text-sm">New here? Create your player profile.</p>
        </div>
      </div>

      <div className="glass-panel p-5 space-y-3">
        <div className="text-sm text-slate-300">
          Already got a personal link from WhatsApp? Tap that instead — it keeps your
          rating history. Otherwise sign yourself up below.
        </div>
        <label className="space-y-1 block">
          <span className="text-xs text-slate-400">Your name</span>
          <input
            className="input-field"
            value={draft.name}
            onChange={e => setDraft({ ...draft, name: e.target.value })}
            placeholder="e.g. Priya Sharma"
          />
        </label>
        <label className="space-y-1 block">
          <span className="text-xs text-slate-400">Phone (so the admin can reach you)</span>
          <input
            className="input-field"
            value={draft.phone}
            onChange={e => setDraft({ ...draft, phone: e.target.value })}
            placeholder="e.g. +91 98765 43210"
          />
        </label>
        <button
          onClick={() => onJoin(false)}
          disabled={busy}
          className="btn-primary w-full disabled:opacity-50"
        >
          {busy ? '…' : 'Create my profile'}
        </button>
        <div className="text-xs text-slate-500">
          We only use your phone so the admin can WhatsApp you. It's never shown to other players.
        </div>
        {err && <div className="text-red-400 text-sm">{err}</div>}
      </div>

      <div className="flex justify-center text-xs text-slate-500">
        <Link to="/v2/results" className="hover:text-slate-300">← back to results</Link>
      </div>
    </div>
  );
}
