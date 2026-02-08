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
        <h2>Asset Registry</h2>
        <p>All discovered Stellar assets across anchors &amp; Horizon</p>
      </div>

      {/* Stats */}
      <div className="stat-grid">
        <StatBox label="Total Assets" value={fmt(s?.total, 0)} cls="accent" />
        <StatBox label="Verified" value={fmt(s?.verified, 0)} cls="success" />
        <StatBox label="Unique Codes" value={fmt(s?.codes, 0)} cls="info" />
        <StatBox label="From TOML" value={fmt(s?.fromToml, 0)} />
        <StatBox label="From Horizon" value={fmt(s?.fromHorizon, 0)} />
      </div>

      {/* Filters */}
      <div className="card" style={{ marginBottom: 16, padding: 16 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="input-group" style={{ flex: '1 1 150px' }}>
            <label>Asset Code</label>
            <input
              className="input"
              placeholder="e.g. USDC"
              value={filter.code}
              onChange={(e) => applyFilter('code', e.target.value)}
            />
          </div>
          <div className="input-group" style={{ flex: '1 1 120px' }}>
            <label>Source</label>
            <select className="input" value={filter.source} onChange={(e) => applyFilter('source', e.target.value)}>
              <option value="">All sources</option>
              <option value="horizon">Horizon</option>
              <option value="toml">TOML</option>
            </select>
          </div>
          <div className="input-group" style={{ flex: '1 1 120px' }}>
            <label>Verified</label>
            <select className="input" value={filter.verified} onChange={(e) => applyFilter('verified', e.target.value)}>
              <option value="">All</option>
              <option value="true">Verified</option>
              <option value="false">Unverified</option>
            </select>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => { setFilter({ code: '', source: '', verified: '' }); setPage(1); }}>
            Clear
          </button>
        </div>
      </div>

      {/* Asset Table */}
      {assets.loading && <div className="loading"><div className="spinner" />Loading...</div>}
      {assets.error && <div className="error-box">{assets.error}</div>}

      <div className="card">
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Issuer</th>
                <th>Domain</th>
                <th>Source</th>
                <th>Accounts</th>
                <th>Verified</th>
              </tr>
            </thead>
            <tbody>
              {assets.data?.assets?.map((a) => (
                <tr key={a.id ?? `${a.code}:${a.issuer}`}>
                  <td><strong>{a.code}</strong></td>
                  <td className="mono">{a.issuer === 'native' ? 'native' : truncKey(a.issuer)}</td>
                  <td>{a.domain || '—'}</td>
                  <td><span className={`badge ${sourceColor(a.source)}`}>{a.source}</span></td>
                  <td className="mono">{fmt(a.num_accounts, 0)}</td>
                  <td>{a.is_verified ? <span className="badge badge-success">✓</span> : '—'}</td>
                </tr>
              ))}
              {!assets.loading && (assets.data?.assets?.length ?? 0) === 0 && (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No assets found</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 8, padding: '12px 0' }}>
            <button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Prev</button>
            <span style={{ lineHeight: '32px', fontSize: 12, color: 'var(--text-muted)' }}>
              Page {page} / {totalPages}
            </span>
            <button className="btn btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next →</button>
          </div>
        )}
      </div>
    </div>
  );
}

function StatBox({ label, value, cls = '' }) {
  return (
    <div className="stat-box">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${cls}`}>{value ?? '—'}</div>
    </div>
  );
}
