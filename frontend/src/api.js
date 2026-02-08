// ─── Stella Protocol — API Client ─────────────────────────────
// Centralized fetch helpers for all backend endpoints.
// All routes are proxied via Vite → localhost:3001.

const BASE = '';  // Proxied by Vite dev server

async function fetchJSON(url, opts = {}) {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  const data = await res.json();
  if (!res.ok) throw { status: res.status, ...data };
  return data;
}

// ─── Health ───────────────────────────────────────────────────
export const getHealth = () => fetchJSON('/health');

// ─── Anchors ──────────────────────────────────────────────────
export const getAnchors = () => fetchJSON('/api/anchors');
export const getAnchor = (domain) => fetchJSON(`/api/anchors/${domain}`);
export const getAnchorAssets = (domain) => fetchJSON(`/api/anchors/${domain}/assets`);
export const getAnchorStats = () => fetchJSON('/api/anchors/stats');
export const triggerCrawl = () => fetchJSON('/api/anchors/crawl', { method: 'POST' });

// ─── Assets ───────────────────────────────────────────────────
export const getAssets = (params = {}) => {
  const qs = new URLSearchParams(params).toString();
  return fetchJSON(`/api/assets${qs ? '?' + qs : ''}`);
};
export const getAssetStats = () => fetchJSON('/api/assets/stats');

// ─── Graph ────────────────────────────────────────────────────
export const getGraphStats = () => fetchJSON('/api/graph/stats');
export const getGraphNodes = (connected) =>
  fetchJSON(`/api/graph/nodes${connected ? '?connected=true' : ''}`);
export const getGraphEdges = (params = {}) => {
  const qs = new URLSearchParams(params).toString();
  return fetchJSON(`/api/graph/edges${qs ? '?' + qs : ''}`);
};
export const getGraphNeighbors = (code, issuer) =>
  fetchJSON(`/api/graph/neighbors/${code}/${issuer || 'native'}`);
export const triggerGraphRebuild = () =>
  fetchJSON('/api/graph/rebuild', { method: 'POST' });

// ─── Routes ───────────────────────────────────────────────────
export const findRoutes = (body) =>
  fetchJSON('/api/routes/find', { method: 'POST', body: JSON.stringify(body) });
export const getRouteStats = () => fetchJSON('/api/routes/stats');
export const getRouteCache = () => fetchJSON('/api/routes/cache');

// ─── Quotes ───────────────────────────────────────────────────
export const createQuote = (body) =>
  fetchJSON('/api/quotes', { method: 'POST', body: JSON.stringify(body) });
export const getQuote = (id) => fetchJSON(`/api/quotes/${id}`);
export const refreshQuote = (id) =>
  fetchJSON(`/api/quotes/${id}/refresh`, { method: 'POST' });
export const getQuoteStats = () => fetchJSON('/api/quotes/stats');

// ─── SEP-10 Web Authentication ────────────────────────────────
export const getSep10Challenge = (body) =>
  fetchJSON('/api/sep10/challenge', { method: 'POST', body: JSON.stringify(body) });
export const submitSep10Response = (body) =>
  fetchJSON('/api/sep10/submit', { method: 'POST', body: JSON.stringify(body) });
export const getCachedToken = (body) =>
  fetchJSON('/api/sep10/token', { method: 'POST', body: JSON.stringify(body) });

// ─── SEP-24 Interactive Flows ─────────────────────────────────
export const initiateSep24 = (body) =>
  fetchJSON('/api/sep24/initiate', { method: 'POST', body: JSON.stringify(body) });
export const getSep24Status = (id, body) =>
  fetchJSON(`/api/sep24/status/${id}`, { method: 'POST', body: JSON.stringify(body) });
export const getSep24Info = (anchorDomain) => 
  fetchJSON(`/api/sep24/info?anchorDomain=${encodeURIComponent(anchorDomain)}`);

// ─── Trustlines ───────────────────────────────────────────────
export const checkTrustlines = (body) =>
  fetchJSON('/api/trustlines/check', { method: 'POST', body: JSON.stringify(body) });
export const checkAssetTrustline = (body) =>
  fetchJSON('/api/trustlines/check-asset', { method: 'POST', body: JSON.stringify(body) });
export const canReceiveAsset = (body) =>
  fetchJSON('/api/trustlines/can-receive', { method: 'POST', body: JSON.stringify(body) });
