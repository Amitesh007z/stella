// ─── Stella Protocol — Route Finder Page ──────────────────────
import { useState, useEffect, useRef, useCallback } from 'react';
import * as api from '../api';
import { fmt, truncKey, useWallet } from '../hooks';
import { useToast } from '../components/Toast';
import WalletConnect from '../components/WalletConnect';

const WALLET_AND_SEP24_ENABLED = import.meta.env.VITE_ENABLE_WALLET_AND_SEP24 === 'true';

// ─── Curated Quick-Deposit Pairs ─────────────────────────────
// Known-working XLM ↔ asset pairs on Stellar testnet.
// All verified via testanchor.stellar.org (SEP-24 + SEP-10).
const CURATED_PAIRS = [
  {
    id: 'xlm-to-srt',
    label: 'XLM → SRT',
    description: 'Test Anchor — Stellar Reference Token',
    anchor: 'testanchor.stellar.org',
    from: { code: 'XLM', issuer: 'native', isNative: true },
    to: { code: 'SRT', issuer: 'GCDNJUBQSX7AJWLJACMJ7I4BC3Z47BQUTMHEICZLE6MU4KQBRYG5JY6B', isNative: false },
    depositAssetCode: 'SRT',
  },
  {
    id: 'srt-to-xlm',
    label: 'SRT → XLM',
    description: 'Test Anchor — Stellar Reference Token',
    anchor: 'testanchor.stellar.org',
    from: { code: 'SRT', issuer: 'GCDNJUBQSX7AJWLJACMJ7I4BC3Z47BQUTMHEICZLE6MU4KQBRYG5JY6B', isNative: false },
    to: { code: 'XLM', issuer: 'native', isNative: true },
    depositAssetCode: 'native',
  },
  {
    id: 'xlm-to-usdc',
    label: 'XLM → USDC',
    description: 'Test Anchor — USD Coin',
    anchor: 'testanchor.stellar.org',
    from: { code: 'XLM', issuer: 'native', isNative: true },
    to: { code: 'USDC', issuer: 'GCDNJUBQSX7AJWLJACMJ7I4BC3Z47BQUTMHEICZLE6MU4KQBRYG5JY6B', isNative: false },
    depositAssetCode: 'USDC',
  },
  {
    id: 'usdc-to-xlm',
    label: 'USDC → XLM',
    description: 'Test Anchor — USD Coin',
    anchor: 'testanchor.stellar.org',
    from: { code: 'USDC', issuer: 'GCDNJUBQSX7AJWLJACMJ7I4BC3Z47BQUTMHEICZLE6MU4KQBRYG5JY6B', isNative: false },
    to: { code: 'XLM', issuer: 'native', isNative: true },
    depositAssetCode: 'native',
  },
];

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
  // Deposit-only: in a routing context, SEP-24 deposit is the on-ramp.
  // The user interacts with the anchor to receive an asset into their
  // Stellar account. Withdraw (off-ramp) is not used in routing.
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

    // ── Determine the deposit asset ───────────────────────────
    // For SEP-24 deposit in a routing context, the asset_code is the
    // asset the anchor will credit to the user's Stellar account —
    // i.e. the OUTPUT of the anchor bridge leg.
    //
    // The anchor bridge leg has `from` and `to` keys like "SRT:GISSUER..."
    // We pick the NON-XLM side as the deposit asset. If both sides are
    // non-XLM, we pick the "to" side (destination of the leg).
    let asset = null;

    if (anchorLeg.from && anchorLeg.to) {
      // Parse asset key "CODE:ISSUER" or "XLM:native"
      const parseKey = (key) => {
        if (!key) return null;
        const [code, issuer] = key.split(':');
        return {
          code,
          issuer: issuer === 'native' ? undefined : issuer,
          isNative: code === 'XLM' || code === 'native' || issuer === 'native',
        };
      };
      const fromAsset = parseKey(anchorLeg.from);
      const toAsset = parseKey(anchorLeg.to);

      // The deposit asset is the non-XLM side of the anchor bridge.
      // XLM → SRT: deposit SRT (user receives SRT from anchor)
      // SRT → XLM: deposit native (user receives XLM from anchor)
      if (fromAsset?.isNative && toAsset && !toAsset.isNative) {
        asset = toAsset;     // XLM → Other: deposit the Other asset
      } else if (toAsset?.isNative && fromAsset && !fromAsset.isNative) {
        asset = toAsset;     // Other → XLM: deposit native/XLM
      } else {
        asset = toAsset;     // Fallback: destination side of the leg
      }
    }

    // Fallback: use route path destination
    if (!asset || !asset.code) {
      const dest = route.path?.[route.path.length - 1];
      if (dest) {
        asset = {
          code: dest.code,
          issuer: dest.issuer === 'native' ? undefined : dest.issuer,
          isNative: dest.code === 'XLM' || dest.code === 'native' || dest.issuer === 'native',
        };
      }
    }

    if (!asset || !asset.code) {
      toast.error('Unable to determine deposit asset');
      return;
    }

    // Skip trustline check when XLM is on either side of the edge.
    // XLM (native) never needs a trustline, and the anchor bridge
    // handles the conversion — no need to warn the user.
    const routeHasXlm = route.path?.some(
      (p) => p.code === 'XLM' || p.code === 'native' || p.isNative
    );

    if (!routeHasXlm && asset.issuer && asset.code !== 'XLM' && asset.code !== 'native') {
      try {
        const trustCheck = await api.checkTrustlines({
          userPublicKey: wallet.publicKey,
          assetKeys: [`stellar:${asset.code}:${asset.issuer}`],
        });
        const missing = trustCheck.data?.missingTrustlines || [];
        if (missing.length > 0) {
          toast.info(`Note: You'll need a ${asset.code} trustline to receive funds. You can add it before the anchor sends the deposit.`);
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

      toast.info('Initiating deposit...');

      // Step 4: Initiate SEP-24 deposit with token
      const resp = await api.initiateSep24({
        type: 'deposit',
        anchorDomain,
        authToken: tokenResult.token,
        request: {
          assetCode: asset.isNative ? 'native' : asset.code,
          assetIssuer: asset.issuer,
          amount: route.sendAmount || route.receiveAmount,
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
        type: 'deposit',
        assetCode: asset.code,
        amount: route.sendAmount || route.receiveAmount,
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
        toast.success('Deposit flow launched — complete KYC in the popup');
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
            toast.info(`Deposit ${s === 'completed' ? 'completed ✓' : s}`);
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
      toast.error(`SEP-24 deposit failed: ${err.message || 'Unknown error'}`);
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
        <h2><span className="card-icon">⇢</span> Route Finder</h2>
        <p>Discover optimal payment paths on the Stellar network</p>
      </div>

      {/* ── Wallet Connection ─────────────────────── */}
      {WALLET_AND_SEP24_ENABLED && (
        <div className="card" style={{ marginBottom: 16 }}>
          <WalletConnect wallet={wallet} />
        </div>
      )}

      {/* ── Quick Deposit — Curated XLM Pairs ─────── */}
      {WALLET_AND_SEP24_ENABLED && (
        <QuickDeposit
          pairs={CURATED_PAIRS}
          wallet={wallet}
          onLaunch={launchSep24Flow}
        />
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

  // Check if this route has anchor bridge legs AND XLM is in the path
  const anchorLegs = route.legs?.filter(
    (leg) => leg.type === 'anchor_bridge' || leg.type === 'ANCHOR_BRIDGE'
  ) || [];
  const hasAnchorBridge = anchorLegs.length > 0 || route.edgeTypes?.includes('anchor_bridge');
  const hasXlm = route.path?.some(
    (p) => p.code === 'XLM' || p.code === 'native' || p.issuer === 'native' || p.isNative
  );
  const showSep24 = hasAnchorBridge && hasXlm;

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
        {sep24Enabled && showSep24 && (
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
            <div style={{ marginTop: 12, padding: '10px 14px', background: 'rgba(212,85,58,0.08)', borderRadius: 6, fontSize: 13 }}>
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
        const hasXlm = route.path?.some(
          (p) => p.code === 'XLM' || p.code === 'native' || p.issuer === 'native' || p.isNative
        );
        const showSep24 = hasAnchorBridge && hasXlm;

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
                {sep24Enabled && showSep24 && (
                  <span className="badge" style={{ background: 'var(--accent)', color: '#fff', fontSize: 10 }}>
                    SEP-24 Deposit
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

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
              <div>Send: <strong>{route.sendAmount}</strong></div>
              <div>Est. Receive: <strong>{parseFloat(route.receiveAmount).toFixed(4)}</strong></div>
              <div>Weight: <strong>{route.totalWeight}</strong></div>
              <div>Price: <strong style={{ color: route.priceSource === 'horizon' ? 'var(--success)' : route.priceSource === 'unverified' ? '#ef4444' : route.priceSource === 'estimated' ? '#f59e0b' : 'var(--text-muted)' }}>
                {route.priceSource === 'horizon' ? '✓ Verified' : route.priceSource === 'unverified' ? '⚠ Unverified' : route.priceSource === 'estimated' ? '~ Estimated' : '○ Graph'}
              </strong></div>
            </div>

            <ScoreBar score={route.score} />

            {/* ── SEP-24 Launch ────────────────────── */}
            {sep24Enabled && showSep24 && (
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
// Deposit-only: SEP-24 deposit is the on-ramp for anchor bridge routes.
// Only shown when XLM is in the route path (XLM is the entry/exit point).
function Sep24LaunchPanel({ anchorLegs, route, onLaunch, walletConnected }) {
  // Filter: only show deposit buttons for anchors that support SEP-24 + SEP-10
  const sep24Legs = anchorLegs.filter(
    (leg) => leg.details?.sep24Supported !== false && leg.details?.sep10Supported !== false
  );
  const unsupportedLegs = anchorLegs.filter(
    (leg) => leg.details?.sep24Supported === false || leg.details?.sep10Supported === false
  );

  return (
    <div style={{
      marginTop: 10,
      padding: '12px 14px',
      background: 'linear-gradient(135deg, rgba(212,85,58,0.10), rgba(232,98,62,0.08))',
      borderRadius: 8,
      border: '1px solid rgba(212,85,58,0.25)',
    }}>
      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}
      >
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent)' }}>
          🚀 SEP-24 Deposit — On-ramp via Anchor
        </span>
        {!walletConnected && (
          <span style={{ fontSize: 11, color: 'var(--warning)', fontWeight: 600 }}>⚠ Connect wallet first</span>
        )}
      </div>

      {
        <div>
          {sep24Legs.length > 0 ? (
            sep24Legs.map((leg, i) => {
              const domain = leg.details?.anchorDomain || leg.details?.anchor || 'Unknown anchor';
              // Determine the deposit asset from leg.from/leg.to
              const parseKey = (k) => k?.split(':')[0];
              const fromCode = parseKey(leg.from);
              const toCode = parseKey(leg.to);
              const isFromXlm = fromCode === 'XLM' || fromCode === 'native';
              const isToXlm = toCode === 'XLM' || toCode === 'native';
              const depositAsset = isFromXlm ? toCode : isToXlm ? 'XLM' : toCode;

              return (
                <div key={i} style={{ marginBottom: 8, paddingBottom: 8, borderBottom: i < sep24Legs.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                    🏦 {domain}
                    {leg.details?.health && (
                      <span style={{ marginLeft: 6 }} className={`badge ${leg.details.health > 0.7 ? 'badge-success' : 'badge-warning'}`}>
                        Health {Math.round(leg.details.health * 100)}%
                      </span>
                    )}
                    {depositAsset && (
                      <span style={{ marginLeft: 6, fontWeight: 600, color: 'var(--accent)' }}>
                        → Deposit {depositAsset}
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={(e) => { e.stopPropagation(); onLaunch('deposit', leg, route); }}
                      disabled={!walletConnected}
                      style={{ fontSize: 11 }}
                    >
                      💰 Deposit via Anchor
                    </button>
                  </div>
                  {leg.details?.feeFixed != null && (
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
                      Fee: {leg.details.feeFixed} fixed + {leg.details.feePercent || 0}%
                    </div>
                  )}
                </div>
              );
            })
          ) : anchorLegs.length > 0 && sep24Legs.length === 0 ? (
            /* All anchor legs lack SEP-24 support */
            null
          ) : (
            /* Route has anchor_bridge in edgeTypes but no typed legs — show generic button */
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-sm btn-primary"
                onClick={(e) => { e.stopPropagation(); onLaunch('deposit', { details: {} }, route); }}
                disabled={!walletConnected}
                style={{ fontSize: 11 }}
              >
                💰 Deposit via Anchor
              </button>
            </div>
          )}

          {/* Show unsupported anchors as info (no button) */}
          {unsupportedLegs.length > 0 && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, fontStyle: 'italic' }}>
              {unsupportedLegs.map((leg, i) => {
                const domain = leg.details?.anchorDomain || leg.details?.anchor;
                return domain ? (
                  <div key={i}>⚠ {domain} — no interactive deposit (SEP-24 not supported)</div>
                ) : null;
              })}
            </div>
          )}

          {sep24Legs.length > 0 && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
              ⚠️ Opens the anchor's page for KYC &amp; deposit instructions
            </div>
          )}
        </div>
      }
    </div>
  );
}

// ─── Quick Deposit — Curated XLM Pairs ──────────────────────
// Lets the user pick a known-working XLM pair and launch a SEP-24
// deposit directly, without searching routes first.
function QuickDeposit({ pairs, wallet, onLaunch }) {
  const [selectedPair, setSelectedPair] = useState('');
  const [quickAmount, setQuickAmount] = useState('5');

  const pair = pairs.find((p) => p.id === selectedPair);

  const handleQuickDeposit = () => {
    if (!pair || !quickAmount) return;

    // Build a synthetic anchor leg + route for launchSep24Flow
    const leg = {
      type: 'anchor_bridge',
      from: `${pair.from.code}:${pair.from.issuer}`,
      to: `${pair.to.code}:${pair.to.issuer}`,
      details: {
        anchorDomain: pair.anchor,
        sep24Supported: true,
        sep10Supported: true,
      },
    };
    const route = {
      path: [pair.from, pair.to],
      sendAmount: quickAmount,
      receiveAmount: quickAmount,
    };
    onLaunch('deposit', leg, route);
  };

  return (
    <div className="card" style={{
      marginBottom: 16,
      borderColor: 'rgba(212, 85, 58, 0.2)',
    }}>
      <div className="card-header">
        <span className="card-title"><span className="card-icon">⚡</span> Quick Deposit — XLM Pairs</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Verified anchors, instant SEP-24</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: 12, alignItems: 'end' }}>
        <div className="input-group" style={{ marginBottom: 0 }}>
          <label style={{ fontSize: 12 }}>Pair</label>
          <select
            className="input"
            value={selectedPair}
            onChange={(e) => setSelectedPair(e.target.value)}
          >
            <option value="">— Select a pair —</option>
            {pairs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}  ·  {p.description}
              </option>
            ))}
          </select>
        </div>

        <div className="input-group" style={{ marginBottom: 0 }}>
          <label style={{ fontSize: 12 }}>Amount</label>
          <input
            className="input"
            type="text"
            value={quickAmount}
            onChange={(e) => setQuickAmount(e.target.value)}
            placeholder="5"
          />
        </div>

        <button
          className="btn btn-primary"
          onClick={handleQuickDeposit}
          disabled={!pair || !wallet.isConnected || !quickAmount}
          style={{ whiteSpace: 'nowrap' }}
        >
          🚀 Deposit
        </button>
      </div>

      {!wallet.isConnected && (
        <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: 8 }}>
          ⚠ Connect your wallet above to enable Quick Deposit
        </div>
      )}

      {pair && (
        <div style={{
          fontSize: 11, color: 'var(--text-muted)', marginTop: 8,
          display: 'flex', gap: 12, flexWrap: 'wrap',
        }}>
          <span>🏦 Anchor: <strong>{pair.anchor}</strong></span>
          <span>💎 Deposit asset: <strong>{pair.depositAssetCode}</strong></span>
          <span>📊 Amount range: 1 – 10 (testnet)</span>
        </div>
      )}
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
    pending_stellar: '#d4553a',
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
              ↓ Deposit {flow.assetCode} {flow.amount}
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
                  background: 'rgba(212,85,58,0.08)',
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
