// ─── Enhanced Route Finder with SEP-24 Support ─────────────────
// Extends the Route Finder with interactive flow capabilities,
// fiat asset support, and trustline checking.

import React, { useState } from 'react';
import { useInteractiveFlows, LaunchButton } from '../components/InteractiveFlowLauncher';
import { toast } from 'react-toastify';

/**
 * Enhanced Route Card with SEP-24 launch capabilities
 */
export function EnhancedRouteCard({ route, userAccount, userSecret, mode = 'quote' }) {
  const [showLaunchOptions, setShowLaunchOptions] = useState(false);
  const [isCheckingTrustlines, setIsCheckingTrustlines] = useState(false);
  const { launchFlow } = useInteractiveFlows();

  // Check if route can be launched (has anchor bridge legs)
  const canLaunch = route.legs?.some(leg => 
    leg.type === 'anchor_bridge' || leg.type === 'ANCHOR_BRIDGE'
  );

  // Extract anchor bridges for launch
  const anchorLegs = route.legs?.filter(leg => 
    leg.type === 'anchor_bridge' || leg.type === 'ANCHOR_BRIDGE'
  ) || [];

  const handleLaunchClick = () => {
    if (!userAccount || !userSecret) {
      toast.error('Please provide your account keys to launch flows');
      return;
    }
    setShowLaunchOptions(!showLaunchOptions);
  };

  const checkTrustlines = async () => {
    if (!userAccount) return true;

    setIsCheckingTrustlines(true);
    try {
      const assetKeys = route.path
        ?.filter(asset => asset.issuer) // Skip native XLM
        .map(asset => `stellar:${asset.code}:${asset.issuer}`) || [];

      if (assetKeys.length === 0) return true;

      const response = await fetch('/api/trustlines/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userPublicKey: userAccount,
          assetKeys
        })
      });

      if (!response.ok) {
        throw new Error('Trustline check failed');
      }

      const data = await response.json();
      const missing = data.data.missingTrustlines;

      if (missing.length > 0) {
        const codes = missing.map(t => t.assetCode).join(', ');
        toast.warning(
          `Missing trustlines for: ${codes}. Please add these trustlines first.`,
          { autoClose: 8000 }
        );
        return false;
      }

      return true;

    } catch (error) {
      console.error('Trustline check failed:', error);
      toast.error('Failed to check trustlines');
      return false;
    } finally {
      setIsCheckingTrustlines(false);
    }
  };

  const launchDepositFlow = async (anchorLeg) => {
    const trustlinesOk = await checkTrustlines();
    if (!trustlinesOk) return;

    // For deposit, we need the first asset in the route
    const sourceAsset = route.path?.[0];
    if (!sourceAsset) {
      toast.error('Unable to determine source asset');
      return;
    }

    const config = {
      type: 'deposit',
      anchorDomain: anchorLeg.details?.anchorDomain || anchorLeg.details?.anchor,
      assetCode: sourceAsset.code,
      assetIssuer: sourceAsset.issuer,
      amount: route.sendAmount,
      userAccount,
      userSecret,
      checkTrustline: true,
      prefill: {
        // Could be expanded with user profile data
      }
    };

    try {
      const transactionId = await launchFlow(config);
      toast.success(`Deposit flow launched! Transaction ID: ${transactionId.slice(0, 12)}...`);
    } catch (error) {
      // Error already handled in launchFlow
    }
  };

  const launchWithdrawFlow = async (anchorLeg) => {
    const trustlinesOk = await checkTrustlines();
    if (!trustlinesOk) return;

    // For withdraw, we need the last asset in the route
    const destAsset = route.path?.[route.path.length - 1];
    if (!destAsset) {
      toast.error('Unable to determine destination asset');
      return;
    }

    const config = {
      type: 'withdraw', 
      anchorDomain: anchorLeg.details?.anchorDomain || anchorLeg.details?.anchor,
      assetCode: destAsset.code,
      assetIssuer: destAsset.issuer,
      amount: route.receiveAmount,
      userAccount,
      userSecret,
      checkTrustline: true
    };

    try {
      const transactionId = await launchFlow(config);
      toast.success(`Withdraw flow launched! Transaction ID: ${transactionId.slice(0, 12)}...`);
    } catch (error) {
      // Error already handled in launchFlow
    }
  };

  return (
    <div className="route-card enhanced">
      {/* Standard route display */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>
          {route.routeId || `Route ${route.id}`}
          <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>
            {route.edgeTypes?.join(' + ')}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <span className="badge badge-info">{route.hops} hop{route.hops !== 1 ? 's' : ''}</span>
          <span className="badge badge-success">Score {route.score?.toFixed(3)}</span>
          {canLaunch && (
            <button 
              onClick={handleLaunchClick}
              className="btn btn-sm btn-primary"
              disabled={isCheckingTrustlines}
            >
              {isCheckingTrustlines ? 'Checking...' : 'Launch'}
            </button>
          )}
        </div>
      </div>

      {/* Route path visualization */}
      <div className="route-path">
        {route.path?.map((stop, j) => (
          <span key={j} style={{ display: 'contents' }}>
            {j > 0 && <span className="route-arrow">→</span>}
            <span className="route-stop">{stop.code}</span>
          </span>
        ))}
      </div>

      {/* Route metrics */}
      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: 'repeat(3, 1fr)', 
        gap: 8, 
        fontSize: 12, 
        color: 'var(--text-secondary)' 
      }}>
        <div>Send: <strong>{route.sendAmount}</strong></div>
        <div>Est. Receive: <strong>{parseFloat(route.receiveAmount).toFixed(4)}</strong></div>
        <div>Weight: <strong>{route.totalWeight}</strong></div>
      </div>

      {/* Launch options (expandable) */}
      {showLaunchOptions && canLaunch && (
        <div className="launch-options" style={{ 
          marginTop: 12, 
          padding: 12, 
          background: 'var(--bg-secondary)', 
          borderRadius: 6,
          border: '1px solid var(--border)'
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
            Interactive Flows Available:
          </div>
          
          {anchorLegs.map((leg, i) => (
            <div key={i} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {leg.details?.anchorDomain || leg.details?.anchor}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() => launchDepositFlow(leg)}
                  className="btn btn-xs btn-outline"
                  disabled={isCheckingTrustlines}
                >
                  💰 Deposit
                </button>
                <button
                  onClick={() => launchWithdrawFlow(leg)}
                  className="btn btn-xs btn-outline"
                  disabled={isCheckingTrustlines}
                >
                  🏦 Withdraw
                </button>
              </div>
            </div>
          ))}
          
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8 }}>
            ⚠️ Clicking will open anchor's website for KYC/payment
          </div>
        </div>
      )}

      {/* Score bar */}
      <div className="score-bar" style={{ height: 6, marginTop: 8 }}>
        <div 
          className="score-fill" 
          style={{ 
            width: `${Math.round((route.score || 0) * 100)}%`, 
            background: route.score >= 0.8 ? 'var(--success)' : 
                       route.score >= 0.5 ? 'var(--warning)' : 'var(--danger)'
          }} 
        />
      </div>
    </div>
  );
}

/**
 * Asset Input with Fiat Support
 */
export function FiatAssetInput({ 
  value, 
  onChange, 
  assets = [], 
  placeholder = 'Select asset...',
  label
}) {
  const [inputValue, setInputValue] = useState(value || '');
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Combine Stellar assets with fiat currencies
  const fiatCurrencies = [
    'iso4217:USD', 'iso4217:EUR', 'iso4217:GBP', 'iso4217:JPY', 
    'iso4217:CHF', 'iso4217:CAD', 'iso4217:AUD', 'iso4217:BRL',
    'iso4217:ARS', 'iso4217:PEN', 'iso4217:MXN'
  ];

  const stellarAssets = assets.map(asset => 
    asset.issuer === 'native' ? 
      'stellar:XLM' : 
      `stellar:${asset.code}:${asset.issuer}`
  );

  const allAssets = [...fiatCurrencies, ...stellarAssets];

  const handleInputChange = (e) => {
    const val = e.target.value;
    setInputValue(val);

    // Filter suggestions
    const filtered = allAssets.filter(asset =>
      asset.toLowerCase().includes(val.toLowerCase())
    ).slice(0, 8);
    
    setSuggestions(filtered);
    setShowSuggestions(val.length > 0);
  };

  const selectAsset = (asset) => {
    setInputValue(asset);
    setShowSuggestions(false);
    onChange?.(asset);
  };

  const formatAssetDisplay = (assetId) => {
    try {
      if (assetId.startsWith('iso4217:')) {
        const currency = assetId.split(':')[1];
        const names = {
          'USD': 'US Dollar',
          'EUR': 'Euro',
          'GBP': 'British Pound',
          'JPY': 'Japanese Yen',
          'ARS': 'Argentine Peso',
          'PEN': 'Peruvian Sol'
        };
        return `💰 ${currency} (${names[currency] || 'Fiat'})`;
      } else if (assetId.startsWith('stellar:')) {
        const parts = assetId.split(':');
        const code = parts[1];
        const issuer = parts[2];
        if (code === 'XLM') {
          return `⭐ XLM (Native)`;
        }
        return `🌌 ${code} (${issuer.slice(0, 8)}...)`;
      }
      return assetId;
    } catch {
      return assetId;
    }
  };

  return (
    <div style={{ position: 'relative' }}>
      {label && (
        <label style={{ 
          display: 'block', 
          fontSize: 12, 
          fontWeight: 600, 
          marginBottom: 4,
          color: 'var(--text-secondary)'
        }}>
          {label}
        </label>
      )}
      
      <input
        type="text"
        value={inputValue}
        onChange={handleInputChange}
        onFocus={() => setShowSuggestions(inputValue.length > 0)}
        onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
        placeholder={placeholder}
        style={{
          width: '100%',
          padding: 8,
          border: '1px solid var(--border)',
          borderRadius: 4,
          fontSize: 14
        }}
      />

      {showSuggestions && suggestions.length > 0 && (
        <div style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          right: 0,
          background: 'white',
          border: '1px solid var(--border)',
          borderTop: 'none',
          borderRadius: '0 0 4px 4px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
          zIndex: 1000,
          maxHeight: 200,
          overflowY: 'auto'
        }}>
          {suggestions.map((asset, i) => (
            <div
              key={i}
              onClick={() => selectAsset(asset)}
              style={{
                padding: 8,
                cursor: 'pointer',
                fontSize: 13,
                borderBottom: i < suggestions.length - 1 ? '1px solid var(--border-light)' : 'none'
              }}
              onMouseEnter={(e) => e.target.style.background = 'var(--bg-secondary)'}
              onMouseLeave={(e) => e.target.style.background = 'white'}
            >
              {formatAssetDisplay(asset)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * User Account Input Section
 */
export function UserAccountSection({ userAccount, userSecret, onChange }) {
  const [showSecret, setShowSecret] = useState(false);

  return (
    <div className="user-account-section" style={{
      padding: 12,
      background: 'var(--bg-secondary)',
      borderRadius: 6,
      border: '1px solid var(--border)',
      marginBottom: 16
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--text-secondary)' }}>
        💳 Account Details (Required for Interactive Flows)
      </div>
      
      <div style={{ display: 'grid', gap: 8 }}>
        <input
          type="text"
          placeholder="Stellar Account (G...)"
          value={userAccount || ''}
          onChange={(e) => onChange?.({ userAccount: e.target.value, userSecret })}
          style={{
            padding: 6,
            border: '1px solid var(--border)',
            borderRadius: 3,
            fontSize: 12
          }}
        />
        
        <div style={{ position: 'relative' }}>
          <input
            type={showSecret ? 'text' : 'password'}
            placeholder="Secret Key (S...)"
            value={userSecret || ''}
            onChange={(e) => onChange?.({ userAccount, userSecret: e.target.value })}
            style={{
              padding: 6,
              border: '1px solid var(--border)',
              borderRadius: 3,
              fontSize: 12,
              paddingRight: 30
            }}
          />
          <button
            type="button"
            onClick={() => setShowSecret(!showSecret)}
            style={{
              position: 'absolute',
              right: 6,
              top: '50%',
              transform: 'translateY(-50%)',
              background: 'none',
              border: 'none',
              fontSize: 12,
              cursor: 'pointer',
              color: 'var(--text-muted)'
            }}
          >
            {showSecret ? '🙈' : '👁️'}
          </button>
        </div>
      </div>
      
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
        🔒 Keys are only used locally for SEP-10 authentication. Not stored or transmitted.
      </div>
    </div>
  );
}