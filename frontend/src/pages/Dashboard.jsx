// ─── Stella Protocol — Dashboard Page ─────────────────────────
import { usePolling, fmt, timeAgo } from '../hooks';
import * as api from '../api';

export default function Dashboard() {
  const health = usePolling(api.getHealth, 15000);
  const graphStats = usePolling(api.getGraphStats, 15000);
  const routeStats = usePolling(api.getRouteStats, 15000);
  const quoteStats = usePolling(api.getQuoteStats, 15000);
  const anchorStats = usePolling(api.getAnchorStats, 30000);
  const assetStats = usePolling(api.getAssetStats, 30000);

  const g = graphStats.data;
  const r = routeStats.data;
  const q = quoteStats.data;
  const a = anchorStats.data;
  const as = assetStats.data;

  return (
    <div>
      <div className="page-header">
        <h2>Dashboard</h2>
        <p>Real-time overview of Stella Protocol</p>
      </div>

      {/* ── System Status ─────────────────────────── */}
      <div className="stat-grid">
        <StatBox
          label="System"
          value={health.data?.status === 'ok' ? 'ONLINE' : 'DEGRADED'}
          cls={health.data?.status === 'ok' ? 'success' : 'danger'}
        />
        <StatBox label="Graph Version" value={g?.version ?? '—'} cls="accent" />
        <StatBox label="Last Build" value={timeAgo(g?.lastBuildTime)} />
        <StatBox label="Build Time" value={g?.lastBuildDurationMs ? `${g.lastBuildDurationMs}ms` : '—'} />
      </div>

      {/* ── Graph Overview ────────────────────────── */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Route Graph</span>
          <span className="badge badge-info">{g?.isBuilding ? 'Building…' : 'Ready'}</span>
        </div>
        <div className="stat-grid">
          <StatBox label="Nodes" value={fmt(g?.nodes, 0)} cls="info" />
          <StatBox label="Edges" value={fmt(g?.edges, 0)} cls="accent" />
          <StatBox label="DEX Edges" value={fmt(g?.dexEdges, 0)} />
          <StatBox label="Bridge Edges" value={fmt(g?.bridgeEdges, 0)} />
          <StatBox label="XLM Pairs" value={fmt(g?.xlmPairs, 0)} />
          <StatBox
            label="Connectivity"
            value={g ? `${(g.connectivity * 100).toFixed(0)}%` : '—'}
            cls={g?.connectivity > 0.5 ? 'success' : 'warning'}
          />
        </div>
      </div>

      {/* ── Routing Engine ────────────────────────── */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Routing Engine</span>
        </div>
        <div className="stat-grid">
          <StatBox label="Total Queries" value={fmt(r?.queries?.total, 0)} cls="accent" />
          <StatBox label="Cache Hits" value={fmt(r?.queries?.cacheHits, 0)} cls="success" />
          <StatBox
            label="Hit Rate"
            value={r?.queries?.hitRate ? `${r.queries.hitRate}%` : '0%'}
            cls={r?.queries?.hitRate > 50 ? 'success' : 'warning'}
          />
          <StatBox label="Mem Cache" value={fmt(r?.cache?.memory?.entries, 0)} />
        </div>
      </div>

      {/* ── Quotes ────────────────────────────────── */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Quote Manager</span>
        </div>
        <div className="stat-grid">
          <StatBox label="Live Quotes" value={fmt(q?.live, 0)} cls="success" />
          <StatBox label="Total Created" value={fmt(q?.totalCreated, 0)} cls="accent" />
          <StatBox label="Refreshed" value={fmt(q?.totalRefreshed, 0)} />
          <StatBox label="Expired" value={fmt(q?.expired, 0)} cls="warning" />
        </div>
      </div>

      {/* ── Anchors + Assets row ──────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="card">
          <div className="card-header">
            <span className="card-title">Anchors</span>
          </div>
          <div className="stat-grid">
            <StatBox label="Total" value={fmt(a?.total, 0)} cls="accent" />
            <StatBox label="Active" value={fmt(a?.active, 0)} cls="success" />
            <StatBox label="With Assets" value={fmt(a?.withAssets, 0)} />
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title">Asset Registry</span>
          </div>
          <div className="stat-grid">
            <StatBox label="Total" value={fmt(as?.total, 0)} cls="accent" />
            <StatBox label="Verified" value={fmt(as?.verified, 0)} cls="success" />
            <StatBox label="Codes" value={fmt(as?.uniqueCodes, 0)} />
          </div>
        </div>
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
