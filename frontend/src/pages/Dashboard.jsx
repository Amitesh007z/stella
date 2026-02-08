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
          icon="⚡"
          label="System"
          value={health.data?.status === 'ok' ? 'ONLINE' : 'DEGRADED'}
          cls={health.data?.status === 'ok' ? 'success' : 'danger'}
        />
        <StatBox icon="▤" label="Graph Version" value={g?.version ?? '—'} cls="accent" />
        <StatBox icon="◷" label="Last Build" value={timeAgo(g?.lastBuildTime)} />
        <StatBox icon="⚡" label="Build Time" value={g?.lastBuildDurationMs ? `${(g.lastBuildDurationMs / 1000).toFixed(1)}s` : '—'} />
      </div>

      {/* ── Graph Overview ────────────────────────── */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">
            <span className="card-icon">⊛</span> Route Graph
          </h3>
          <div className={`badge ${g?.isBuilding ? 'badge-warning' : 'badge-success'}`}>
            {g?.isBuilding ? '● Building' : '● Ready'}
          </div>
        </div>
        <div className="card-content">
          <div className="stat-grid">
            <StatBox label="Nodes" value={fmt(g?.nodes, 0)} cls="info" />
            <StatBox label="Edges" value={fmt(g?.edges, 0)} cls="accent" />
            <StatBox label="DEX Edges" value={fmt(g?.dexEdges, 0)} />
            <StatBox label="Bridge Edges" value={fmt(g?.bridgeEdges, 0)} />
            <StatBox label="XLM Pairs" value={fmt(g?.xlmPairs, 0)} />
            <StatBox
              label="Connectivity"
              value={g ? `${(g.connectivity * 100).toFixed(0)}%` : '—'}
              cls={g?.connectivity > 0.8 ? 'success' : g?.connectivity > 0.5 ? 'warning' : 'danger'}
            />
          </div>
        </div>
      </div>

      {/* ── Routing Engine ────────────────────────── */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">
            <span className="card-icon">⟐</span> Routing Engine
          </h3>
        </div>
        <div className="card-content">
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
      </div>

      {/* ── Quotes ────────────────────────────────── */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">
            <span className="card-icon">▤</span> Quote Manager
          </h3>
        </div>
        <div className="card-content">
          <div className="stat-grid">
            <StatBox label="Live Quotes" value={fmt(q?.live, 0)} cls="success" />
            <StatBox label="Total Created" value={fmt(q?.totalCreated, 0)} cls="accent" />
            <StatBox label="Refreshed" value={fmt(q?.totalRefreshed, 0)} />
            <StatBox label="Expired" value={fmt(q?.expired, 0)} cls="warning" />
          </div>
        </div>
      </div>

      {/* ── Anchors + Assets row ──────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="card-header">
            <h3 className="card-title">
              <span className="card-icon">⚓</span> Anchors
            </h3>
          </div>
          <div className="card-content">
            <div className="stat-grid">
              <StatBox label="Total" value={fmt(a?.total, 0)} cls="accent" />
              <StatBox label="Active" value={fmt(a?.active, 0)} cls="success" />
              <StatBox label="With Assets" value={fmt(a?.withAssets, 0)} />
            </div>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 0 }}>
          <div className="card-header">
            <h3 className="card-title">
              <span className="card-icon">◎</span> Asset Registry
            </h3>
          </div>
          <div className="card-content">
            <div className="stat-grid">
              <StatBox label="Total" value={fmt(as?.total, 0)} cls="accent" />
              <StatBox label="Verified" value={fmt(as?.verified, 0)} cls="success" />
              <StatBox label="Codes" value={fmt(as?.uniqueCodes, 0)} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatBox({ label, value, cls = '', icon }) {
  return (
    <div className="stat-box">
      {icon && <span className="stat-icon">{icon}</span>}
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${cls}`}>{value ?? '—'}</div>
    </div>
  );
}
