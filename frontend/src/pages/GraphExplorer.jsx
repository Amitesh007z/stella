// ─── Stella Protocol — Graph Explorer Page ────────────────────
import { useState } from 'react';
import { useFetch, fmt, truncKey, timeAgo } from '../hooks';
import * as api from '../api';
import { useToast } from '../components/Toast';

export default function GraphExplorer() {
  const stats = useFetch(api.getGraphStats);
  const nodes = useFetch(() => api.getGraphNodes(false));
  const edges = useFetch(api.getGraphEdges);
  const [selectedNode, setSelectedNode] = useState(null);
  const [neighbors, setNeighbors] = useState(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [tab, setTab] = useState('nodes');
  const toast = useToast();

  const g = stats.data;

  const handleNodeClick = async (node) => {
    setSelectedNode(node);
    try {
      const data = await api.getGraphNeighbors(node.code, node.issuer || 'native');
      setNeighbors(data);
    } catch {
      setNeighbors(null);
    }
  };

  const handleRebuild = async () => {
    setRebuilding(true);
    try {
      await api.triggerGraphRebuild();
      toast.success('Graph rebuild triggered');
      setTimeout(() => { stats.refetch(); nodes.refetch(); edges.refetch(); }, 3000);
    } catch (err) {
      toast.error('Graph rebuild failed');
    } finally {
      setTimeout(() => setRebuilding(false), 3000);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h2><span className="card-icon">❖</span> Network Graph</h2>
        <p>Explore the Stellar anchor and asset relationship graph</p>
      </div>

      {/* ── Graph Stats ───────────────────────────── */}
      <div className="stat-grid">
        <StatBox label="Nodes" value={fmt(g?.nodes, 0)} cls="info" bar />
        <StatBox label="Edges" value={fmt(g?.edges, 0)} cls="accent" bar />
        <StatBox label="Density" value={g ? `${(g.connectivity * 100).toFixed(0)}%` : '—'} cls={g?.connectivity > 0.5 ? 'success' : 'warning'} bar />
      </div>

      <div style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className={`btn btn-ghost btn-sm ${tab === 'nodes' ? 'active' : ''}`} onClick={() => setTab('nodes')}>
          Nodes ({nodes.data?.count ?? 0})
        </button>
        <button className={`btn btn-ghost btn-sm ${tab === 'edges' ? 'active' : ''}`} onClick={() => setTab('edges')}>
          Edges ({edges.data?.count ?? 0})
        </button>
        <input
          className="input"
          placeholder="Search..."
          style={{ flex: 1, maxWidth: 400 }}
        />
        <button className="btn btn-primary btn-sm" onClick={handleRebuild} disabled={rebuilding} style={{ marginLeft: 'auto' }}>
          {rebuilding ? '↻ Rebuilding…' : '↻ Rebuild'}
        </button>
      </div>

      {/* ── Nodes Tab ─────────────────────────────── */}
      {tab === 'nodes' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div className="card">
            <div className="card-header">
              <span className="card-title">Nodes</span>
            </div>
            {nodes.loading && <div className="loading"><div className="spinner" />Loading...</div>}
            {nodes.data?.nodes?.map((node) => (
              <div
                key={node.key}
                className={`graph-node ${node.isNative ? 'native' : ''} ${node.edgeCount > 0 ? 'connected' : ''}`}
                onClick={() => handleNodeClick(node)}
                style={{ margin: '4px 4px', cursor: 'pointer' }}
              >
                <strong>{node.code}</strong>
                {node.domain && <small style={{ color: 'var(--text-muted)' }}>({node.domain})</small>}
                {node.edgeCount > 0 && <span className="badge badge-success" style={{ marginLeft: 4 }}>{node.edgeCount}</span>}
              </div>
            ))}
          </div>

          {/* Node Detail */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">{selectedNode ? `${selectedNode.code} Details` : 'Select a node'}</span>
            </div>
            {selectedNode ? (
              <div>
                <DetailRow label="Key" value={selectedNode.key} mono />
                <DetailRow label="Code" value={selectedNode.code} />
                <DetailRow label="Issuer" value={truncKey(selectedNode.issuer)} />
                <DetailRow label="Domain" value={selectedNode.domain || '—'} />
                <DetailRow label="Native" value={selectedNode.isNative ? 'Yes' : 'No'} />
                <DetailRow label="Edges" value={selectedNode.edgeCount} />

                {neighbors?.neighbors && (
                  <div style={{ marginTop: 16 }}>
                    <h4 style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8 }}>
                      Neighbors ({neighbors.neighbors.length})
                    </h4>
                    {neighbors.neighbors.map((n) => (
                      <div key={n.key} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                        <strong>{n.code}</strong>
                        {n.domain && <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>({n.domain})</span>}
                        <div style={{ marginTop: 4 }}>
                          {n.edges.map((e, i) => (
                            <span key={i} className={`badge ${e.type === 'dex' ? 'badge-info' : 'badge-warning'}`} style={{ marginRight: 4 }}>
                              {e.type} w={e.weight?.toFixed(2)}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Click a node on the left to inspect it.</p>
            )}
          </div>
        </div>
      )}

      {/* ── Edges Tab ─────────────────────────────── */}
      {tab === 'edges' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">All Edges</span>
          </div>
          {edges.loading && <div className="loading"><div className="spinner" />Loading...</div>}
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Target</th>
                  <th>Type</th>
                  <th>Weight</th>
                  <th>Details</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {edges.data?.edges?.map((e) => (
                  <tr key={e.id}>
                    <td className="mono">{e.source.split(':')[0]}</td>
                    <td className="mono">{e.target.split(':')[0]}</td>
                    <td>
                      <span className={`badge ${e.type === 'dex' ? 'badge-info' : 'badge-warning'}`}>
                        {e.type}
                      </span>
                    </td>
                    <td className="mono">{e.weight?.toFixed(4)}</td>
                    <td style={{ fontSize: 11 }}>
                      {e.type === 'dex' && `spread:${e.spread?.toFixed(4)} bid:${e.bidDepth?.toFixed(0)} ask:${e.askDepth?.toFixed(0)}`}
                      {e.type === 'anchor_bridge' && `${e.anchorDomain} health:${e.anchorHealth?.toFixed(2)}`}
                    </td>
                    <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>{timeAgo(e.lastUpdated)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
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

function DetailRow({ label, value, mono }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid rgba(51,65,85,0.3)', fontSize: 13 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className={mono ? 'mono' : ''} style={{ color: 'var(--text-primary)', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis' }}>{value ?? '—'}</span>
    </div>
  );
}
