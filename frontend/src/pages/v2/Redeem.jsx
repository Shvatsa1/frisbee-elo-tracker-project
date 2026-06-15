/**
 * /r/:token — magic-link landing page.
 *
 * The route exists only to swap the (one-shot) token for a session and then
 * redirect the player to /v2/me. We never render the token UI: the helper
 * also strips it from window.history so it won't be re-shared.
 */
import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { ensureSession } from './_token.js';

export default function Redeem() {
  const [state, setState] = useState({ phase: 'loading' });

  useEffect(() => {
    ensureSession()
      .then(s => setState({ phase: s ? 'ok' : 'no-token', session: s }))
      .catch(e => setState({
        phase: 'fail',
        error: e?.response?.data?.error || e.message || 'redemption failed',
      }));
  }, []);

  if (state.phase === 'loading') {
    return <div className="text-slate-400 text-center py-12">Signing you in…</div>;
  }
  if (state.phase === 'ok') {
    return <Navigate to="/v2/results" replace />;
  }
  if (state.phase === 'no-token') {
    return (
      <div className="max-w-md mx-auto text-center space-y-3 py-12">
        <h1 className="text-2xl font-bold">No magic link found</h1>
        <p className="text-slate-400 text-sm">
          Ask your captain to re-send your personal link, or open the one from
          WhatsApp.
        </p>
      </div>
    );
  }
  return (
    <div className="max-w-md mx-auto text-center space-y-3 py-12">
      <h1 className="text-2xl font-bold">That link didn’t work</h1>
      <p className="text-slate-400 text-sm">{state.error}</p>
      <p className="text-slate-500 text-xs">
        Ask your captain to re-send your personal link.
      </p>
    </div>
  );
}
