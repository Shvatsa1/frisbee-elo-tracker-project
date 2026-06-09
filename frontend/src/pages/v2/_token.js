/**
 * SPEC_16 §6: magic-link token helper.
 *
 * What this file does:
 *   - On a player-facing page mount, look for `?t=<token>` or a path like
 *     `/r/:token` in the current URL.
 *   - POST it to `/api/session` exactly once (the server marks the token
 *     consumed). Stash the returned session_id in localStorage.
 *   - Strip the token from the visible URL with history.replaceState so
 *     it never gets shared, screenshotted, or logged.
 *   - Subsequent requests use the session (via _api.js interceptor).
 *
 * Why a session, not the token, on every request: SPEC_16 §4 "non-HTTPS
 * mitigation" — a sniffed long-lived token would be reusable; a session id
 * is short-lived (~30 min) AND is bound to the in-memory store of the one
 * server process, so even a leaked session expires fast.
 */
import api, { getSessionId, setSessionId, setActorId, setContextId } from './_api';

const TOKEN_QUERY_PARAM = 't';
const REDEEM_PATH_RE = /^\/r\/([A-Za-z0-9._\-]+)\/?$/;

export function readTokenFromLocation(loc = window.location) {
  // 1. /r/<token>
  const m = REDEEM_PATH_RE.exec(loc.pathname);
  if (m) return m[1];
  // 2. ?t=<token>
  const qs = new URLSearchParams(loc.search);
  const t = qs.get(TOKEN_QUERY_PARAM);
  return t || null;
}

function stripTokenFromUrl(loc = window.location) {
  // Replace history entry with the same page, sans token. If we're on
  // /r/:token, drop the prefix to the app root (`/v2/me`).
  let nextPath = loc.pathname;
  if (REDEEM_PATH_RE.test(loc.pathname)) {
    nextPath = '/v2/me';
  }
  const qs = new URLSearchParams(loc.search);
  qs.delete(TOKEN_QUERY_PARAM);
  const newUrl = nextPath + (qs.toString() ? `?${qs}` : '') + loc.hash;
  window.history.replaceState({}, document.title, newUrl);
}

/**
 * Redeem the token (if present in the URL) and return the resulting
 * session object, or the existing session if one is already live, or
 * null if neither is available. Idempotent: safe to call many times.
 */
export async function ensureSession() {
  const existing = getSessionId();
  // If a token is in the URL, prefer it (operator wants to re-authenticate).
  const token = readTokenFromLocation();
  if (!token) {
    return existing ? { session_id: existing } : null;
  }

  try {
    const { data } = await api.post('/session', { token });
    setSessionId(data.session_id);
    setActorId(data.person_id);
    if (data.context_id != null) setContextId(data.context_id);
    stripTokenFromUrl();
    return data;
  } catch (err) {
    // Even on failure, strip the token so the user doesn't re-trigger.
    stripTokenFromUrl();
    throw err;
  }
}

export function logout() {
  setSessionId(null);
}
