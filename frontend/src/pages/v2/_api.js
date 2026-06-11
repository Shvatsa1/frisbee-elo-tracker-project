/**
 * v2 API client (Tier-0).
 *
 * Tier-0 has no real auth: the acting person_id is stored in
 * localStorage under `ultielo:actorId` and sent as `X-Person-Id` on
 * every write. Public reads omit it.
 *
 * Tier-1 swap path: replace this header with a capability token (the
 * `rating_token` of a `person`) once HTTPS is in place — no route
 * changes required (see SPEC_15 §"Edge cases & constraints").
 */
import axios from 'axios';

// API base is build-time configurable so the same bundle works in:
//   - local dev      → default http://localhost:5000/api
//   - the :8080 deploy → build with VITE_API_BASE=/api and let nginx on :8080
//     proxy /api to the v2 backend (see DEPLOY_V2.md).
const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || 'http://localhost:5000/api',
});

export function getActorId() {
  const v = localStorage.getItem('ultielo:actorId');
  return v ? parseInt(v, 10) : null;
}

export function setActorId(id) {
  if (id == null || id === '') localStorage.removeItem('ultielo:actorId');
  else localStorage.setItem('ultielo:actorId', String(id));
}

export function getContextId() {
  const v = localStorage.getItem('ultielo:contextId');
  return v ? parseInt(v, 10) : null;
}

export function setContextId(id) {
  if (id == null || id === '') localStorage.removeItem('ultielo:contextId');
  else localStorage.setItem('ultielo:contextId', String(id));
}

// SPEC_16: player-facing session id (returned by POST /api/session).
// Sent as `X-Session-Id` on every request that needs the rater identity.
export function getSessionId() {
  return localStorage.getItem('ultielo:sessionId') || null;
}

export function setSessionId(id) {
  if (id == null || id === '') localStorage.removeItem('ultielo:sessionId');
  else localStorage.setItem('ultielo:sessionId', String(id));
}

// Fast role-gate (interim, pre-SPEC_17 identity sessions): a device-local flag
// that reveals the admin-only nav (Admin Rating, Team Builder, Survey). Players
// never see those tabs. An admin unlocks their own device by visiting any page
// with `?admin=1` (and `?admin=0` to hide again). This is a UI convenience only —
// the backend still enforces authority on every admin write.
export function isAdminView() {
  return localStorage.getItem('ultielo:adminView') === '1';
}

export function setAdminView(on) {
  if (on) localStorage.setItem('ultielo:adminView', '1');
  else localStorage.removeItem('ultielo:adminView');
}

// Interim admin hardening (pairs with backend ADMIN_KEY). A device-local secret
// attached as `X-Admin-Key` on writes; without it the backend 403s admin routes
// even if X-Person-Id is spoofed. Admins set it once via `?key=<secret>`.
export function getAdminKey() {
  return localStorage.getItem('ultielo:adminKey') || null;
}

export function setAdminKey(k) {
  if (k == null || k === '') localStorage.removeItem('ultielo:adminKey');
  else localStorage.setItem('ultielo:adminKey', String(k));
}

api.interceptors.request.use((cfg) => {
  // Tier-0 admin header — attached only on writes; reads stay public.
  if (cfg.method && cfg.method.toLowerCase() !== 'get') {
    const id = getActorId();
    if (id) cfg.headers['X-Person-Id'] = String(id);
    const ak = getAdminKey();
    if (ak) cfg.headers['X-Admin-Key'] = ak;
  }
  // SPEC_16: session header — attached on EVERY request (the /api/me reads
  // need it too). Routes that don't require a session simply ignore it.
  const sid = getSessionId();
  if (sid) cfg.headers['X-Session-Id'] = sid;
  return cfg;
});

export default api;

// ---- typed-ish helpers (thin wrappers around §4) ----

export const v2 = {
  // public reads
  listContexts:   ()          => api.get('/contexts').then(r => r.data),
  leaderboard:    (ctxId)     => api.get(`/leaderboard?context_id=${ctxId}`).then(r => r.data),
  playerProfile:  (personId)  => api.get(`/player/${personId}`).then(r => r.data),
  match:          (matchId)   => api.get(`/match/${matchId}`).then(r => r.data),
  build:          (buildId)   => api.get(`/build/${buildId}`).then(r => r.data),

  // writes (Tier-0; require actor set)
  createContext:  (body)      => api.post('/context', body).then(r => r.data),
  createPlayer:   (body)      => api.post('/player', body).then(r => r.data),
  adminRate:      (body)      => api.post('/skill/admin', body).then(r => r.data),
  selfRate:       (body)      => api.post('/skill/self', body).then(r => r.data),
  buildTeams:     (body)      => api.post('/build', body).then(r => r.data),
  recordMatch:    (body)      => api.post('/match', body).then(r => r.data),
  confirmMatch:   (matchId)   => api.post(`/match/${matchId}/confirm`).then(r => r.data),
  submitSurvey:   (matchId, body) => api.post(`/match/${matchId}/survey`, body).then(r => r.data),

  // SPEC_16: player-facing (session-authed) ----------------------------
  redeemToken:    (token, context_id) =>
    api.post('/session', { token, context_id }).then(r => r.data),
  me:             ()          => api.get('/me').then(r => r.data),
  updateProfile:  (body)      => api.put('/me/profile', body).then(r => r.data),
  updateCard:     (card)      => api.put('/me/card', { card }).then(r => r.data),
  ratePeer:       (subject_player_id, tier) =>
    api.post('/rate', { subject_player_id, tier }).then(r => r.data),
};
