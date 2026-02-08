// ─── Stella Protocol — Assets Page ────────────────────────────
import { useState } from 'react';
import { usePolling, useFetch, fmt, truncKey } from '../hooks';
import * as api from '../api';

export default function Assets() {
  const stats  = usePolling(api.getAssetStats, 30_000);
  const [filter, setFilter] = useState({ code: '', source: '', verified: '' });
  const [page, setPage] = useState(1);
  const limit = 25;

  const assets = useFetch(() => {
    const params = { limit, offset: (page - 1) * limit };
    if (filter.code)     params.code     = filter.code;
    if (filter.source)   params.source   = filter.source;
    if (filter.verified)  params.verified = filter.verified;
    return api.getAssets(params);
  }, [page, filter.code, filter.source, filter.verified]);

  const s = stats.data;
  const totalPages = Math.ceil((assets.data?.count ?? 0) / limit);

  const applyFilter = (key, value) => {
    setFilter((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  };

  const sourceColor = (src) => {
    if (src === 'horizon')  return 'badge-info';
    if (src === 'toml')     return 'badge-warning';
    return '';
  };

  return (
    <div>
      <div className="page-header">
        <h2><span className="card-icon">◎</span> Assets</h2>
        <p>Browse all known Stellar assets indexed by Stella</p>
      </div>

      {/* Stats */}
      <div className="stat-grid">
        <StatBox label="Total Assets" value={fmt(s?.total, 0)} cls="accent" bar />
        <StatBox label="Verified" value={fmt(s?.verified, 0)} cls="success" bar />
        <StatBox label="Domains" value={fmt(s?.codes, 0)} cls="info" bar />
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center' }}>
        <div style={{ flex: 1 }}>
          <input
            className="input"
            placeholder="Search code, domain, issuer..."
            value={filter.code}
            onChange={(e) => applyFilter('code', e.target.value)}
          />
        </div>
        <select className="input" style={{ width: 'auto', minWidth: 100 }} value={filter.verified} onChange={(e) => applyFilter('verified', e.target.value)}>
          <option value="">All</option>
          <option value="true">Verified</option>
          <option value="false">Unverified</option>
        </select>
      </div>

      {/* Asset Table */}
      {assets.loading && <div className="loading"><div className="spinner" />Loading...</div>}
      {assets.error && <div className="error-box">{assets.error}</div>}

      <div className="card" style={{ marginBottom: 0 }}>
        <div style={{ padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-subtle)' }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{assets.data?.count ?? 0} assets</span>
          {totalPages > 1 && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Page {page} of {totalPages}</span>}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Code</th>
                <th>Domain</th>
                <th>Issuer</th>
                <th>Source</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {assets.data?.assets?.map((a) => (
                <tr key={a.id ?? `${a.code}:${a.issuer}`}>
                  <td><strong>{a.code}</strong></td>
                  <td>{a.domain || '—'}</td>
                  <td className="mono">{a.issuer === 'native' ? 'native' : truncKey(a.issuer)}</td>
                  <td><span className={`badge ${sourceColor(a.source)}`}>{a.source}</span></td>
                  <td>{a.is_verified ? <span className="badge badge-success">✓ Verified</span> : <span className="badge badge-muted">—</span>}</td>
                </tr>
              ))}
              {!assets.loading && (assets.data?.assets?.length ?? 0) === 0 && (
                <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No assets match filters</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 8, padding: '12px 20px', borderTop: '1px solid var(--border-subtle)' }}>
            <button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Prev</button>
            <button className="btn btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next →</button>
          </div>
        )}
      </div>
    </div>
  );
}

function StatBox({ label, value, cls = '', bar }) {
  return (
    <div className={`stat-box ${bar ? `stat-box-bar ${cls}` : ''}`}>
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${cls}`}>{value ?? '—'}</div>
    </div>
  );
}
