// ─── Stella Protocol — Anchors Page ───────────────────────────
import { useState } from 'react';
import { useFetch, usePolling, truncKey, timeAgo } from '../hooks';
import * as api from '../api';
import { useToast } from '../components/Toast';

export default function Anchors() {
  const anchors = usePolling(api.getAnchors, 30_000);
  const stats   = usePolling(api.getAnchorStats, 30_000);
  const [expanded, setExpanded] = useState(null);       // domain
  const [assets, setAssets]     = useState({});          // { domain: [...] }
  const [crawling, setCrawling] = useState(false);
  const toast = useToast();

  const s = stats.data;

  const toggleExpand = async (domain) => {
    if (expanded === domain) { setExpanded(null); return; }
    setExpanded(domain);
    if (!assets[domain]) {
      try {
        const data = await api.getAnchorAssets(domain);
        setAssets((prev) => ({ ...prev, [domain]: data.assets ?? data }));
      } catch {
        setAssets((prev) => ({ ...prev, [domain]: [] }));
      }
    }
  };

  const handleCrawl = async () => {
    setCrawling(true);
    try {
      await api.triggerCrawl();
      toast.success('Anchor crawl triggered');
      setTimeout(() => { anchors.refetch(); stats.refetch(); }, 5000);
    } catch (err) {
      toast.error('Crawl failed');
    } finally {
      setTimeout(() => setCrawling(false), 5000);
    }
  };

  const statusColor = (st) => {
    if (st === 'active' || st === 'verified') return 'badge-success';
    if (st === 'pending') return 'badge-warning';
    return 'badge-error';
  };

  return (
    <div>
      <div className="page-header">
        <h2>Anchors</h2>
        <p>Stellar anchor directory — TOML discovery, assets &amp; health</p>
      </div>

      {/* Stats */}
      <div className="stat-grid">
        <StatBox label="Total" value={s?.total ?? '—'} cls="accent" />
        <StatBox label="Active" value={s?.active ?? '—'} cls="success" />
        <StatBox label="With Assets" value={s?.withAssets ?? '—'} cls="info" />
        <StatBox label="Pending" value={s?.pending ?? '—'} />
      </div>

      <div style={{ marginBottom: 16 }}>
        <button className="btn btn-primary btn-sm" onClick={handleCrawl} disabled={crawling}>
          {crawling ? 'Crawling…' : 'Trigger Crawl'}
        </button>
      </div>

      {/* Anchor List */}
      {anchors.loading && <div className="loading"><div className="spinner" />Loading anchors...</div>}
      {anchors.error && <div className="error-box">{anchors.error}</div>}

      {anchors.data?.anchors?.map((a) => (
        <div key={a.domain} className="card" style={{ marginBottom: 12 }}>
          <div
            className="card-header"
            style={{ cursor: 'pointer', userSelect: 'none' }}
            onClick={() => toggleExpand(a.domain)}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
              <span className="card-title">{a.domain}</span>
              <span className={`badge ${statusColor(a.status)}`}>{a.status}</span>
              {a.org_name && <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{a.org_name}</span>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, color: 'var(--text-muted)' }}>
              <span>Health: <strong style={{ color: a.health_score >= 0.7 ? 'var(--success)' : a.health_score >= 0.4 ? 'var(--warning)' : 'var(--error)' }}>{(a.health_score * 100).toFixed(0)}%</strong></span>
              <span>Assets: {a.asset_count ?? 0}</span>
              <span>{expanded === a.domain ? '▲' : '▼'}</span>
            </div>
          </div>

          {expanded === a.domain && (
            <div style={{ padding: '0 16px 16px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8, marginBottom: 12 }}>
                <DetailRow label="Transfer Server" value={a.transfer_server ? '✓' : '—'} />
                <DetailRow label="Sep-24" value={a.sep24_url ? '✓' : '—'} />
                <DetailRow label="Sep-6" value={a.sep6_url ? '✓' : '—'} />
                <DetailRow label="Federation" value={a.federation_server ? '✓' : '—'} />
                <DetailRow label="TOML URL" value={a.toml_url || '—'} />
                <DetailRow label="Last Crawl" value={a.last_crawl ? timeAgo(a.last_crawl) : '—'} />
              </div>

              <h4 style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8 }}>Assets ({(assets[a.domain] ?? []).length})</h4>

              {(assets[a.domain] ?? []).length === 0 ? (
                <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>No assets registered</p>
              ) : (
                <table className="data-table" style={{ fontSize: 12 }}>
                  <thead>
                    <tr><th>Code</th><th>Issuer</th><th>Status</th><th>Deposit</th><th>Withdraw</th></tr>
                  </thead>
                  <tbody>
                    {assets[a.domain].map((asset, i) => (
                      <tr key={i}>
                        <td><strong>{asset.code}</strong></td>
                        <td className="mono">{truncKey(asset.issuer)}</td>
                        <td><span className={`badge ${statusColor(asset.status)}`}>{asset.status}</span></td>
                        <td>{asset.deposit_enabled ? '✓' : '—'}</td>
                        <td>{asset.withdraw_enabled ? '✓' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      ))}
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

function DetailRow({ label, value }) {
  return (
    <div style={{ fontSize: 12 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}: </span>
      <span style={{ color: 'var(--text-primary)' }}>{value}</span>
    </div>
  );
}
