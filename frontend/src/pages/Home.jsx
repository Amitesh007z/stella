// ─── Stella Protocol — Home Page (Swap Widget) ────────────────
import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../api';
import { useToast } from '../components/Toast';

export default function Home() {
  const [assets, setAssets] = useState([]);
  const [source, setSource] = useState('');
  const [dest, setDest] = useState('');
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState('buy');       // 'buy' | 'send'
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null); // which route is expanded
  const toast = useToast();

  // Load assets on mount
  useEffect(() => {
    api.getAssets({ limit: 200 })
      .then((d) => setAssets(d.assets || []))
      .catch(() => {});
  }, []);

  const parseAsset = (identifier) => {
    if (!identifier) return {};
    const [code, issuer] = identifier.split(':');
    return { code, issuer: issuer === 'native' ? undefined : issuer };
  };

  const getAssetLabel = (identifier) => {
    if (!identifier) return '';
    const [code] = identifier.split(':');
    return code;
  };

  const handleSwap = () => {
    const tmp = source;
    setSource(dest);
    setDest(tmp);
    setResult(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!source || !dest || !amount) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const s = parseAsset(source);
      const d = parseAsset(dest);
      const body = {
        sourceCode: s.code,
        sourceIssuer: s.issuer,
        destCode: d.code,
        destIssuer: d.issuer,
        amount: amount.trim(),
      };

      if (mode === 'buy') {
        body.slippageTolerance = 1.0;
        const data = await api.createQuote(body);
        // Quote returns {route, alternativeRoutes} - normalize to routes array
        const routeCount = 1 + (data.alternativeRoutes?.length || 0);
        setResult({ type: 'quote', data });
        toast.success(`Quote created — ${routeCount} route(s)`);
      } else {
        const data = await api.findRoutes(body);
        setResult({ type: 'routes', data });
        toast.success(`Found ${data.routes?.length || 0} route(s)`);
      }
    } catch (err) {
      setError(err.message || 'Something went wrong');
      toast.error(err.message || 'Request failed');
    } finally {
      setLoading(false);
    }
  };

  // Normalize routes from both quote and routes responses
  const routes = result?.type === 'quote'
    ? [result.data?.route, ...(result.data?.alternativeRoutes || [])].filter(Boolean)
    : result?.data?.routes || [];

  const bestRoute = routes[0];

  return (
    <div className="home-page">
      {/* Background Orbs */}
      <div className="bg-orb bg-orb-1" />
      <div className="bg-orb bg-orb-2" />
      <div className="bg-orb bg-orb-3" />

      {/* Top Nav */}
      <header className="home-header">
        <div className="home-logo">
          <img src="/logo.jpeg" alt="Stella" style={{ width: 28, height: 28, borderRadius: 5, objectFit: 'cover' }} />
          <span className="logo-text">STELLA</span>
        </div>
        <nav className="home-nav">
          <Link to="/admin" className="home-nav-link">Admin Console →</Link>
        </nav>
      </header>

      {/* Hero Section */}
      <div className="home-hero">
        <h1 className="home-title">
          <span className="gradient-text">Stellar</span> Routing Intelligence
        </h1>
        <p className="home-subtitle">
          Discover the best routes across Stellar anchors for cross-border payments & swaps
        </p>
      </div>

      {/* Swap Widget */}
      <div className="swap-widget">
        {/* Mode Tabs */}
        <div className="swap-tabs">
          <button
            className={`swap-tab ${mode === 'buy' ? 'active' : ''}`}
            onClick={() => { setMode('buy'); setResult(null); }}
          >
            GET QUOTE
          </button>
          <button
            className={`swap-tab ${mode === 'send' ? 'active' : ''}`}
            onClick={() => { setMode('send'); setResult(null); }}
          >
            FIND ROUTES
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          {/* From Box */}
          <div className="swap-box">
            <label className="swap-box-label">You send</label>
            <div className="swap-box-row">
              <input
                type="number"
                className="swap-amount-input"
                placeholder="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                step="any"
                min="0"
              />
              <div className="swap-asset-select">
                <select
                  value={source}
                  onChange={(e) => { setSource(e.target.value); setResult(null); }}
                  className="swap-asset-dropdown"
                >
                  <option value="">Select</option>
                  {assets.map((a) => {
                    const id = `${a.code}:${a.issuer || 'native'}`;
                    return <option key={id} value={id}>{a.code}</option>;
                  })}
                </select>
              </div>
            </div>
          </div>

          {/* Swap Direction Button */}
          <div className="swap-divider">
            <button type="button" className="swap-direction-btn" onClick={handleSwap} title="Swap direction">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M7 16V4M7 4L3 8M7 4l4 4M17 8v12M17 20l4-4M17 20l-4-4" />
              </svg>
            </button>
          </div>

          {/* To Box */}
          <div className="swap-box">
            <label className="swap-box-label">You receive</label>
            <div className="swap-box-row">
              <div className="swap-receive-amount">
                {loading ? (
                  <div className="swap-loading-dots">
                    <span></span><span></span><span></span>
                  </div>
                ) : bestRoute ? (
                  <>
                    <span className="swap-receive-value">
                      {parseFloat(bestRoute.receiveAmount || bestRoute.estimatedReceive || bestRoute.destAmount || 0).toFixed(4)}
                    </span>
                  </>
                ) : (
                  <span className="swap-receive-placeholder">0.0000</span>
                )}
              </div>
              <div className="swap-asset-select">
                <select
                  value={dest}
                  onChange={(e) => { setDest(e.target.value); setResult(null); }}
                  className="swap-asset-dropdown"
                >
                  <option value="">Select</option>
                  {assets.map((a) => {
                    const id = `${a.code}:${a.issuer || 'native'}`;
                    return <option key={id} value={id}>{a.code}</option>;
                  })}
                </select>
              </div>
            </div>
            {bestRoute && (
              <div className="swap-rate-hint">
                {bestRoute.priceSource === 'horizon' && '✓ '}
                {bestRoute.priceSource === 'unverified' && '⚠ '}
                {bestRoute.priceSource === 'estimated' && '~ '}
                Best rate via {bestRoute.path?.map(p => p.code || p).join(' → ')}
              </div>
            )}
          </div>

          {/* Rate Info */}
          {bestRoute && (
            <div className="swap-info-row">
              <div className="swap-info-item">
                <span className="swap-info-label">
                  1 {getAssetLabel(source)} = {amount && (bestRoute?.receiveAmount || bestRoute?.estimatedReceive)
                    ? (parseFloat(bestRoute.receiveAmount || bestRoute.estimatedReceive) / parseFloat(amount)).toFixed(6)
                    : '—'
                  } {getAssetLabel(dest)}
                </span>
                <span className="swap-info-badge">
                  {bestRoute.priceSource === 'horizon' ? '✓ Verified' : '~ Est'}
                </span>
              </div>
              <div className="swap-info-meta">
                <span>⏱ ~{bestRoute.hops || 1} hop{bestRoute.hops !== 1 ? 's' : ''}</span>
                <span className="swap-info-routes-link" onClick={() => document.getElementById('routes-section')?.scrollIntoView({ behavior: 'smooth' })}>
                  View all {routes.length} route{routes.length !== 1 ? 's' : ''} ↓
                </span>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="swap-error">
              {error}
            </div>
          )}

          {/* Submit Button */}
          <button
            type="submit"
            className="swap-submit-btn"
            disabled={loading || !source || !dest || !amount}
          >
            {loading ? (
              <span className="swap-btn-loading">
                <span className="spinner" style={{ width: 18, height: 18 }} />
                Finding best routes...
              </span>
            ) : mode === 'buy' ? (
              '🎯 Get Best Quote'
            ) : (
              '⇢ Find All Routes'
            )}
          </button>
        </form>
      </div>

      {/* ─── Routes Results Section ──────────────────────────────── */}
      {routes.length > 0 && (
        <div className="home-routes-section" id="routes-section">
          <h2 className="home-routes-title">
            {routes.length} Route{routes.length !== 1 ? 's' : ''} Found
            <span className="home-routes-subtitle">
              {getAssetLabel(source)} → {getAssetLabel(dest)} • {amount} {getAssetLabel(source)}
            </span>
          </h2>

          <div className="home-routes-list">
            {routes.map((route, idx) => (
              <RouteCard
                key={idx}
                route={route}
                index={idx}
                isBest={idx === 0}
                sourceLabel={getAssetLabel(source)}
                destLabel={getAssetLabel(dest)}
                amount={amount}
                expanded={expanded === idx}
                onToggle={() => setExpanded(expanded === idx ? null : idx)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="home-footer">
        <span>Stella Protocol • Stellar Testnet</span>
        <span>Powered by Horizon API</span>
      </footer>
    </div>
  );
}

// ─── Route Card Component ───────────────────────────────────────
function RouteCard({ route, index, isBest, sourceLabel, destLabel, amount, expanded, onToggle }) {
  const receive = parseFloat(route.receiveAmount || route.estimatedReceive || route.destAmount || 0);
  const rate = amount ? (receive / parseFloat(amount)) : 0;
  const score = route.score || route.totalScore || 0;
  const scorePercent = Math.min(score * 100, 100);
  const path = route.path || [];
  const hops = route.hops || path.length - 1 || 1;
  
  const priceTag = route.priceSource === 'horizon' ? { label: '✓ Verified', cls: 'verified' }
    : route.priceSource === 'unverified' ? { label: '⚠ Unverified', cls: 'unverified' }
    : route.priceSource === 'estimated' ? { label: '~ Estimated', cls: 'estimated' }
    : { label: '○ Graph', cls: 'graph' };

  return (
    <div className={`home-route-card ${isBest ? 'best' : ''}`} onClick={onToggle}>
      {/* Header */}
      <div className="home-route-header">
        <div className="home-route-rank">
          {isBest ? (
            <span className="home-route-best-badge">★ BEST</span>
          ) : (
            <span className="home-route-index">#{index + 1}</span>
          )}
          <span className={`home-route-price-tag ${priceTag.cls}`}>{priceTag.label}</span>
        </div>
        <div className="home-route-receive">
          <span className="home-route-receive-value">{receive.toFixed(4)}</span>
          <span className="home-route-receive-code">{destLabel}</span>
        </div>
      </div>

      {/* Path Visualization */}
      <div className="home-route-path">
        {path.map((stop, i) => (
          <span key={i} className="home-route-path-item">
            {i > 0 && <span className="home-route-path-arrow">→</span>}
            <span className="home-route-path-stop">{stop.code || stop}</span>
          </span>
        ))}
      </div>

      {/* Meta Row */}
      <div className="home-route-meta">
        <span className="home-route-meta-item">
          <span className="meta-icon">⇢</span> {hops} hop{hops !== 1 ? 's' : ''}
        </span>
        <span className="home-route-meta-item">
          <span className="meta-icon">⚡</span> Rate: {rate.toFixed(6)}
        </span>
        <span className="home-route-meta-item">
          <span className="meta-icon">📊</span> Score: {(score * 100).toFixed(0)}%
        </span>
      </div>

      {/* Score Bar */}
      <div className="home-route-score-bar">
        <div className="home-route-score-fill" style={{ width: `${scorePercent}%` }} />
      </div>

      {/* Expanded Details */}
      {expanded && (
        <div className="home-route-details">
          <div className="home-route-details-grid">
            <div className="detail-item">
              <span className="detail-label">Estimated Receive</span>
              <span className="detail-value">{receive.toFixed(7)} {destLabel}</span>
            </div>
            <div className="detail-item">
              <span className="detail-label">Exchange Rate</span>
              <span className="detail-value">1 {sourceLabel} = {rate.toFixed(6)} {destLabel}</span>
            </div>
            <div className="detail-item">
              <span className="detail-label">Hops</span>
              <span className="detail-value">{hops}</span>
            </div>
            <div className="detail-item">
              <span className="detail-label">Price Source</span>
              <span className="detail-value">{priceTag.label}</span>
            </div>
            {route.scoring && (
              <>
                <div className="detail-item">
                  <span className="detail-label">Amount Score</span>
                  <span className="detail-value">{(route.scoring.receiveAmountScore * 100).toFixed(0)}%</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Reliability</span>
                  <span className="detail-value">{(route.scoring.reliabilityScore * 100).toFixed(0)}%</span>
                </div>
              </>
            )}
          </div>
          {route.legs && route.legs.length > 0 && (
            <div className="home-route-legs">
              <span className="detail-label" style={{ marginBottom: 8, display: 'block' }}>Execution Plan</span>
              {route.legs.map((leg, i) => (
                <div key={i} className="home-route-leg">
                  <span className="leg-step">{i + 1}</span>
                  <div className="leg-info">
                    <span className="leg-type">{leg.type || leg.edgeType}</span>
                    <span className="leg-detail">{leg.from} → {leg.to}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
