// ─── Stella Protocol — Route Finder Page ──────────────────────
import { useState, useEffect, useRef, useCallback } from 'react';
import * as api from '../api';
import { fmt, truncKey, useWallet } from '../hooks';
import { useToast } from '../components/Toast';
import WalletConnect from '../components/WalletConnect';

const WALLET_AND_SEP24_ENABLED = import.meta.env.VITE_ENABLE_WALLET_AND_SEP24 === 'true';

export default function RouteFinder() {
  const [assets, setAssets] = useState([]);
  const [source, setSource] = useState('');
  const [dest, setDest] = useState('');
  const [amount, setAmount] = useState('');
  const [slippageTolerance, setSlippageTolerance] = useState('1.0');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState('quote');
  // Wallet connection (Freighter + manual fallback)
  const wallet = useWallet();
  // Active interactive flows
  const [activeFlows, setActiveFlows] = useState([]);
  const pollIntervalsRef = useRef(new Map());
  const toast = useToast();

  // Load asset registry on mount
  useEffect(() => {
    api.getAssets({ limit: 200 })
      .then((d) => setAssets(d.assets || []))
      .catch(() => {});
  }, []);

  // Cleanup poll intervals on unmount
  useEffect(() => {
    return () => {
      pollIntervalsRef.current.forEach(clearInterval);
    };
  }, []);

  const parseAsset = (identifier) => {
    if (!identifier) return {};
    const [code, issuer] = identifier.split(':');
    return { code, issuer: issuer === 'native' ? undefined : issuer };
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
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

      if (mode === 'quote') {
        body.slippageTolerance = parseFloat(slippageTolerance) || 1.0;
        const data = await api.createQuote(body);
        setResult({ type: 'quote', data });
        toast.success(`Quote ${data.quoteId} created`);
      } else {
        const data = await api.findRoutes(body);
        setResult({ type: 'routes', data });
        const hasAnchorRoutes = data.routes?.some(r => r.edgeTypes?.includes('anchor_bridge'));
        if (WALLET_AND_SEP24_ENABLED && hasAnchorRoutes && !wallet.isConnected) {
          toast.info('Anchor bridge routes found — connect your wallet to launch SEP-24 flows');
        }
        toast.success(`Found ${data.routes?.length || 0} route(s)`);
      }
    } catch (err) {
      setError(err.message || JSON.stringify(err));
      toast.error(err.message || 'Request failed');
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async (quoteId) => {
    try {
      setLoading(true);
      const data = await api.refreshQuote(quoteId);
      setResult({ type: 'quote', data });
      toast.success('Quote refreshed');
    } catch (err) {
      setError(err.message || 'Refresh failed');
      toast.error('Quote refresh failed');
    } finally {
      setLoading(false);
    }
  };

  // ─── SEP-24 Launch Logic ──────────────────────────────────────
  const launchSep24Flow = useCallback(async (type, anchorLeg, route) => {
    if (!wallet.isConnected) {
      toast.error('Connect your wallet first to launch interactive flows');
      return;
    }

    if (wallet.walletType !== 'freighter') {
      toast.error('Freighter wallet required for SEP-24 flows');
      return;
    }

    const anchorDomain = anchorLeg.details?.anchorDomain || anchorLeg.details?.anchor;
    if (!anchorDomain) {
      toast.error('Unable to determine anchor domain for this leg');
      return;
    }

    // Determine asset based on flow direction
    const asset = type === 'deposit' ? route.path?.[0] : route.path?.[route.path.length - 1];
    if (!asset) {
      toast.error(`Unable to determine ${type} asset`);
      return;
    }

    // Check trustlines first
    if (asset.issuer && asset.code !== 'XLM') {
      try {
        const trustCheck = await api.checkTrustlines({
          userPublicKey: wallet.publicKey,
          assetKeys: [`stellar:${asset.code}:${asset.issuer}`],
        });
        const missing = trustCheck.data?.missingTrustlines || [];
        if (missing.length > 0) {
          toast.error(`Missing trustline for ${asset.code}. Add the trustline before proceeding.`);
          return;
        }
      } catch (err) {
        console.warn('Trustline check failed, proceeding anyway:', err);
      }
    }

    // Initiate SEP-24 with Freighter authentication
    try {
      toast.info('Authenticating with anchor...');

      // Step 1: Get SEP-10 challenge
      const challengeResult = await api.getSep10Challenge({
        anchorDomain,
        userPublicKey: wallet.publicKey
      });

      toast.info('Please sign the authentication request in Freighter...');

      // Step 2: Sign with Freighter
      let signedXdr;
      try {
        signedXdr = await wallet.signTransaction(challengeResult.challengeXdr, {
          networkPassphrase: challengeResult.networkPassphrase
        });
      } catch (signErr) {
        toast.error('Signing cancelled or failed');
        return;
      }

      if (!signedXdr) {
        toast.error('Signing was cancelled');
        return;
      }

      // Step 3: Submit signed challenge to get auth token
      const tokenResult = await api.submitSep10Response({
        signedXdr,
        authEndpoint: challengeResult.authEndpoint,
        anchorDomain,
        userPublicKey: wallet.publicKey
      });

      toast.info('Initiating deposit/withdraw...');

      // Step 4: Initiate SEP-24 flow with token
      const resp = await api.initiateSep24({
        type,
        anchorDomain,
        authToken: tokenResult.token,
        request: {
          assetCode: asset.code,
          assetIssuer: asset.issuer,
          amount: type === 'deposit' ? route.sendAmount : route.receiveAmount,
          account: wallet.publicKey,
        },
      });

      const { url, id } = resp;
      if (!url) {
        toast.error('Anchor did not return an interactive URL');
        return;
      }

      // Open anchor UI
      let popup = null;
      try {
        popup = window.open(url, `sep24_${type}_${id}`, 'width=800,height=600,scrollbars=yes,resizable=yes');
        if (popup) popup.focus();
      } catch { /* popup blocked */ }

      // Track active flow — always store the URL so user can click it
      const flow = {
        id,
        type,
        assetCode: asset.code,
        amount: type === 'deposit' ? route.sendAmount : route.receiveAmount,
        anchorDomain,
        interactiveUrl: url,
        authToken: tokenResult.token,
        status: 'pending_user_transfer_start',
        startedAt: Date.now(),
      };
      setActiveFlows(prev => [...prev, flow]);

      if (!popup) {
        toast.info('Popup was blocked — click the link below to open the anchor page');
      } else {
        toast.success(`${type === 'deposit' ? 'Deposit' : 'Withdraw'} flow launched — complete KYC in the popup`);
      }

      // Poll status with auth token
      const interval = setInterval(async () => {
        try {
          const status = await api.getSep24Status(id, {
            anchorDomain,
            authToken: tokenResult.token,
          });
          setActiveFlows(prev =>
            prev.map(f => (f.id === id ? { ...f, status: status.status || status.data?.status } : f))
          );
          const s = status.status || status.data?.status;
          if (['completed', 'error', 'refunded'].includes(s)) {
            clearInterval(interval);
            pollIntervalsRef.current.delete(id);
            toast.info(`${type} ${s === 'completed' ? 'completed ✓' : s}`);
          }
        } catch {
          // Silent poll failure
        }
      }, 5000);
      pollIntervalsRef.current.set(id, interval);

      // Auto-stop after 30 minutes
      setTimeout(() => {
        if (pollIntervalsRef.current.has(id)) {
          clearInterval(pollIntervalsRef.current.get(id));
          pollIntervalsRef.current.delete(id);
        }
      }, 30 * 60 * 1000);
    } catch (err) {
      toast.error(`SEP-24 ${type} failed: ${err.message || 'Unknown error'}`);
    }
  }, [wallet, toast]);

  const dismissFlow = (id) => {
    if (pollIntervalsRef.current.has(id)) {
      clearInterval(pollIntervalsRef.current.get(id));
      pollIntervalsRef.current.delete(id);
    }
    setActiveFlows(prev => prev.filter(f => f.id !== id));
  };

  return (
    <div>
      <div className="page-header">
        <h2>Route Finder</h2>
        <p>Discover optimal payment paths on the Stellar network</p>
      </div>

      {/* ── Wallet Connection ─────────────────────── */}
      {WALLET_AND_SEP24_ENABLED && (
        <div className="card" style={{ marginBottom: 16 }}>
          <WalletConnect wallet={wallet} />
        </div>
      )}

      {/* ── Query Form ────────────────────────────── */}
      <div className="card">
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div className="input-group">
              <label>Source Asset</label>
              <select className="input" value={source} onChange={(e) => setSource(e.target.value)} required>
                <option value="">— Select source asset —</option>
                {assets.map((a) => (
                  <option key={a.identifier} value={a.identifier}>
                    {a.code} {a.domain ? `(${a.domain})` : a.issuer === 'native' ? '(native)' : `(${a.issuer?.slice(0, 8)}…)`}
                  </option>
                ))}
              </select>
            </div>
            <div className="input-group">
              <label>Destination Asset</label>
              <select className="input" value={dest} onChange={(e) => setDest(e.target.value)} required>
                <option value="">— Select destination asset —</option>
                {assets.map((a) => (
                  <option key={a.identifier} value={a.identifier}>
                    {a.code} {a.domain ? `(${a.domain})` : a.issuer === 'native' ? '(native)' : `(${a.issuer?.slice(0, 8)}…)`}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Show selected issuers for clarity */}
          {(source || dest) && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 8 }}>
              {source && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
                  {parseAsset(source).issuer || 'native'}
                </div>
              )}
              {dest && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
                  {parseAsset(dest).issuer || 'native'}
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
            <div className="input-group">
              <label>Amount</label>
              <input className="input" type="text" placeholder="100" value={amount} onChange={(e) => setAmount(e.target.value)} required />
            </div>
            <div className="input-group">
              <label>Mode</label>
              <select className="input" value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="quote">Full Quote (with execution plan)</option>
                <option value="route">Routes Only (fast)</option>
              </select>
            </div>
            <div className="input-group">
              <label>Slippage Tolerance %</label>
              <input className="input" type="text" placeholder="1.0" value={slippageTolerance} onChange={(e) => setSlippageTolerance(e.target.value)} />
            </div>
          </div>

          <button className="btn btn-primary" type="submit" disabled={loading}>
            {loading ? 'Searching…' : mode === 'quote' ? 'Get Quote' : 'Find Routes'}
          </button>
        </form>
      </div>

      {error && <div className="error-box">{error}</div>}

      {/* ── Active SEP-24 Flows Tracker ───────────── */}
      {WALLET_AND_SEP24_ENABLED && activeFlows.length > 0 && (
        <ActiveFlowsBar flows={activeFlows} onDismiss={dismissFlow} />
      )}

      {/* ── Quote Result ──────────────────────────── */}
      {result?.type === 'quote' && (
        <QuoteResult
          data={result.data}
          onRefresh={handleRefresh}
          onLaunch={launchSep24Flow}
          walletConnected={wallet.isConnected}
          sep24Enabled={WALLET_AND_SEP24_ENABLED}
        />
      )}

      {/* ── Routes Result ─────────────────────────── */}
      {result?.type === 'routes' && (
        <RoutesResult
          data={result.data}
          onLaunch={launchSep24Flow}
          walletConnected={wallet.isConnected}
          sep24Enabled={WALLET_AND_SEP24_ENABLED}
        />
      )}
    </div>
  );
}

// ─── Quote Result Component ──────────────────────────────────
function QuoteResult({ data, onRefresh, onLaunch, walletConnected, sep24Enabled }) {
  const { route, executionPlan, status, quoteId, expiresAt } = data;
  const plan = executionPlan;
  const summary = plan?.summary;

  // Check if this route has anchor bridge legs
  const anchorLegs = route.legs?.filter(
    (leg) => leg.type === 'anchor_bridge' || leg.type === 'ANCHOR_BRIDGE'
  ) || [];
  const hasAnchorBridge = anchorLegs.length > 0 || route.edgeTypes?.includes('anchor_bridge');

  return (
    <div>
      {/* ── Quote Header ──────────────────────────── */}
      <div className="card" style={{ borderColor: 'var(--accent)' }}>
        <div className="card-header">
          <span className="card-title">Quote {quoteId}</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className={`badge ${status === 'live' ? 'badge-success' : 'badge-danger'}`}>
              {status.toUpperCase()}
            </span>
            <button className="btn btn-ghost btn-sm" onClick={() => onRefresh(quoteId)}>
              Refresh
            </button>
          </div>
        </div>

        {/* Summary stats */}
        <div className="stat-grid">
          <StatMini label="Send" value={`${route.sendAmount} ${route.path?.[0]?.code}`} />
          <StatMini label="Receive (est.)" value={`${parseFloat(route.receiveAmount).toFixed(4)} ${route.path?.[route.path.length-1]?.code}`} />
          <StatMini label="Min Receive" value={summary?.minFinalReceive ? `${parseFloat(summary.minFinalReceive).toFixed(4)}` : '—'} />
          <StatMini label="Score" value={route.score?.toFixed(4)} />
          <StatMini label="Hops" value={route.hops} />
          <StatMini label="Fee Rate" value={plan?.fees?.effectiveFeeRate || '0%'} />
        </div>

        {/* Path visualization */}
        <div className="route-path">
          {route.path?.map((stop, i) => (
            <span key={i} style={{ display: 'contents' }}>
              {i > 0 && <span className="route-arrow">→</span>}
              <span className="route-stop" title={stop.issuer || 'native'}>
                {stop.code}
                {stop.domain && <small style={{ color: 'var(--text-muted)', marginLeft: 4 }}>({stop.domain})</small>}
              </span>
            </span>
          ))}
        </div>

        {/* Score bar */}
        <ScoreBar score={route.score} />

        {/* ── SEP-24 Launch Section ───────────────── */}
        {sep24Enabled && hasAnchorBridge && (
          <Sep24LaunchPanel
            anchorLegs={anchorLegs}
            route={route}
            onLaunch={onLaunch}
            walletConnected={walletConnected}
          />
        )}
      </div>

      {/* ── Execution Plan ────────────────────────── */}
      {plan?.steps && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Execution Plan ({plan.steps.length} step{plan.steps.length !== 1 ? 's' : ''})</span>
            <span className={`badge ${plan.slippage?.severity === 'low' ? 'badge-success' : plan.slippage?.severity === 'medium' ? 'badge-warning' : 'badge-danger'}`}>
              Slippage: {plan.slippage?.severity}
            </span>
          </div>

          {plan.steps.map((step) => (
            <div key={step.step} style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <span style={{ fontWeight: 700, color: 'var(--accent)', marginRight: 8 }}>Step {step.step}</span>
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{step.description}</span>
                </div>
                <span className="badge badge-info">{step.operation.replace(/_/g, ' ')}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginTop: 8, fontSize: 12 }}>
                <div><span style={{ color: 'var(--text-muted)' }}>Send:</span> {parseFloat(step.sendAmount).toFixed(4)}</div>
                <div><span style={{ color: 'var(--text-muted)' }}>Expect:</span> {parseFloat(step.expectedReceive).toFixed(4)}</div>
                <div><span style={{ color: 'var(--text-muted)' }}>Min:</span> {parseFloat(step.minReceiveAmount).toFixed(4)}</div>
                <div><span style={{ color: 'var(--text-muted)' }}>Slippage:</span> {step.slippageTolerance}</div>
              </div>
            </div>
          ))}

          {/* Recommendation */}
          {summary?.recommendation && (
            <div style={{ marginTop: 12, padding: '10px 14px', background: 'rgba(99,102,241,0.08)', borderRadius: 6, fontSize: 13 }}>
              {summary.recommendation}
            </div>
          )}
        </div>
      )}

      {/* ── Scoring Breakdown ─────────────────────── */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Scoring Breakdown</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          {Object.entries(route.scoring || {}).filter(([k]) => k !== 'composite').map(([k, v]) => (
            <div key={k}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'capitalize' }}>{k} ({k === 'weight' ? '35%' : k === 'hops' ? '25%' : '20%'})</div>
              <ScoreBar score={v} height={4} />
              <div style={{ fontSize: 13, fontFamily: 'var(--font-mono)', marginTop: 2 }}>{v?.toFixed(4)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Routes-only Result ──────────────────────────────────────
function RoutesResult({ data, onLaunch, walletConnected, sep24Enabled }) {
  return (
    <div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
        {data.meta?.routesFound} route(s) found in {data.meta?.computeTimeMs}ms · strategy: {data.meta?.strategy}
      </div>
      {data.routes?.map((route, i) => {
        const anchorLegs = route.legs?.filter(
          (leg) => leg.type === 'anchor_bridge' || leg.type === 'ANCHOR_BRIDGE'
        ) || [];
        const hasAnchorBridge = anchorLegs.length > 0 || route.edgeTypes?.includes('anchor_bridge');

        return (
          <div className="route-card" key={route.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>
                Route #{i + 1}
                <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>
                  {route.edgeTypes?.join(' + ')}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="badge badge-info">{route.hops} hop{route.hops !== 1 ? 's' : ''}</span>
                <span className="badge badge-success">Score {route.score?.toFixed(3)}</span>
                {sep24Enabled && hasAnchorBridge && (
                  <span className="badge" style={{ background: 'var(--accent)', color: '#fff', fontSize: 10 }}>
                    SEP-24
                  </span>
                )}
              </div>
            </div>

            <div className="route-path">
              {route.path?.map((stop, j) => (
                <span key={j} style={{ display: 'contents' }}>
                  {j > 0 && <span className="route-arrow">→</span>}
                  <span className="route-stop">{stop.code}</span>
                </span>
              ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
              <div>Send: <strong>{route.sendAmount}</strong></div>
              <div>Est. Receive: <strong>{parseFloat(route.receiveAmount).toFixed(4)}</strong></div>
              <div>Weight: <strong>{route.totalWeight}</strong></div>
            </div>

            <ScoreBar score={route.score} />

            {/* ── SEP-24 Launch ────────────────────── */}
            {sep24Enabled && hasAnchorBridge && (
              <Sep24LaunchPanel
                anchorLegs={anchorLegs}
                route={route}
                onLaunch={onLaunch}
                walletConnected={walletConnected}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── SEP-24 Launch Panel (inside route cards) ───────────────
function Sep24LaunchPanel({ anchorLegs, route, onLaunch, walletConnected }) {
  return (
    <div style={{
      marginTop: 10,
      padding: '12px 14px',
      background: 'linear-gradient(135deg, rgba(99,102,241,0.12), rgba(139,92,246,0.12))',
      borderRadius: 8,
      border: '1px solid rgba(99,102,241,0.35)',
    }}>
      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}
      >
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent)' }}>
          🚀 SEP-24 Interactive Flow — Click to Deposit / Withdraw
        </span>
        {!walletConnected && (
          <span style={{ fontSize: 11, color: 'var(--warning)', fontWeight: 600 }}>⚠ Connect wallet first</span>
        )}
      </div>

      {
        <div>
          {anchorLegs.length > 0 ? (
            anchorLegs.map((leg, i) => {
              const domain = leg.details?.anchorDomain || leg.details?.anchor || 'Unknown anchor';
              return (
                <div key={i} style={{ marginBottom: 8, paddingBottom: 8, borderBottom: i < anchorLegs.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                    🏦 {domain}
                    {leg.details?.health && (
                      <span style={{ marginLeft: 6 }} className={`badge ${leg.details.health > 0.7 ? 'badge-success' : 'badge-warning'}`}>
                        Health {Math.round(leg.details.health * 100)}%
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {leg.details?.depositEnabled !== false && (
                      <button
                        className="btn btn-sm btn-primary"
                        onClick={(e) => { e.stopPropagation(); onLaunch('deposit', leg, route); }}
                        disabled={!walletConnected}
                        style={{ fontSize: 11 }}
                      >
                        💰 Deposit
                      </button>
                    )}
                    {leg.details?.withdrawEnabled !== false && (
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={(e) => { e.stopPropagation(); onLaunch('withdraw', leg, route); }}
                        disabled={!walletConnected}
                        style={{ fontSize: 11 }}
                      >
                        🏦 Withdraw
                      </button>
                    )}
                  </div>
                  {leg.details?.feeFixed != null && (
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
                      Fee: {leg.details.feeFixed} fixed + {leg.details.feePercent || 0}%
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            /* Route has anchor_bridge in edgeTypes but no typed legs — show generic buttons */
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-sm btn-primary"
                onClick={(e) => { e.stopPropagation(); onLaunch('deposit', { details: {} }, route); }}
                disabled={!walletConnected}
                style={{ fontSize: 11 }}
              >
                💰 Deposit via Anchor
              </button>
              <button
                className="btn btn-sm btn-ghost"
                onClick={(e) => { e.stopPropagation(); onLaunch('withdraw', { details: {} }, route); }}
                disabled={!walletConnected}
                style={{ fontSize: 11 }}
              >
                🏦 Withdraw via Anchor
              </button>
            </div>
          )}
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
            ⚠️ Clicking opens the anchor's website for KYC &amp; payment instructions
          </div>
        </div>
      }
    </div>
  );
}

// ─── Active Flows Status Bar ─────────────────────────────────
function ActiveFlowsBar({ flows, onDismiss }) {
  const statusColors = {
    completed: 'var(--success)',
    error: 'var(--danger)',
    refunded: 'var(--warning)',
    pending_user_transfer_start: 'var(--accent)',
    pending_anchor: '#f59e0b',
    pending_stellar: '#8b5cf6',
    pending_trust: '#ec4899',
  };

  return (
    <div className="card" style={{ marginBottom: 16, borderColor: 'var(--accent)' }}>
      <div className="card-header">
        <span className="card-title">Active SEP-24 Flows ({flows.length})</span>
      </div>
      {flows.map((flow) => (
        <div key={flow.id} style={{
          padding: '10px 0', borderBottom: '1px solid var(--border)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <span style={{ fontWeight: 600, fontSize: 13 }}>
                {flow.type === 'deposit' ? '↓ Deposit' : '↑ Withdraw'} {flow.assetCode} {flow.amount}
              </span>
              <span style={{ color: 'var(--text-muted)', fontSize: 11, marginLeft: 8 }}>
                via {flow.anchorDomain}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{
                fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                background: statusColors[flow.status] || 'var(--text-muted)',
                color: '#fff',
              }}>
                {(flow.status || 'unknown').replace(/_/g, ' ')}
              </span>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => onDismiss(flow.id)}
                style={{ fontSize: 11, padding: '2px 6px' }}
              >
                ✕
              </button>
            </div>
          </div>
          {/* ── Clickable interactive URL ────────── */}
          {flow.interactiveUrl && (
            <div style={{ marginTop: 6 }}>
              <a
                href={flow.interactiveUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--accent)',
                  textDecoration: 'underline',
                  cursor: 'pointer',
                  padding: '4px 10px',
                  background: 'rgba(99,102,241,0.08)',
                  borderRadius: 4,
                }}
              >
                🔗 Open Anchor Page (SEP-24)
              </a>
              <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 8 }}>
                Click to complete KYC &amp; payment
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Shared Components ───────────────────────────────────────
function StatMini({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{value ?? '—'}</div>
    </div>
  );
}

function ScoreBar({ score, height = 6 }) {
  const pct = Math.round((score || 0) * 100);
  const color = pct >= 80 ? 'var(--success)' : pct >= 50 ? 'var(--warning)' : 'var(--danger)';
  return (
    <div className="score-bar" style={{ height }}>
      <div className="score-fill" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}
