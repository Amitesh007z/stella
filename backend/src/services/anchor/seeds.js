// ─── Stella Protocol — Anchor Bootstrap Seeds ─────────────────
// Hardcoded seed domains for anchor discovery.
// Trust level: 'seeded' — highest priority, known reliable anchors.
//
// These are split by network. On testnet, we include SDF test anchors
// and well-known testnet services. On pubnet, real production anchors.
//
// The crawl pipeline treats these identically to discovered anchors
// except they get trust_level = 'seeded' (never auto-removed).

const TESTNET_SEEDS = [
  // ── SDF Reference Anchor (Testnet) ──────────────
  {
    domain: 'testanchor.stellar.org',
    name: 'SDF Test Anchor',
    description: 'Stellar Development Foundation reference anchor for testnet',
  },

  // ── Major Production Anchors (TOML is network-agnostic) ─────
  {
    domain: 'anclap.com',
    name: 'Anclap',
    description: 'ARS, PEN, BRL and multi-fiat anchor (LATAM)',
  },
  {
    domain: 'mykobo.co',
    name: 'MyKobo',
    description: 'EUR/NGN anchor (Africa/Europe)',
  },
  {
    domain: 'satoshipay.io',
    name: 'SatoshiPay',
    description: 'EUR anchor and payment provider',
  },
  {
    domain: 'apay.io',
    name: 'AnchorPay (apay)',
    description: 'Multi-asset anchor — BTC, ETH, LTC, USDT',
  },
  {
    domain: 'www.anchorusd.com',
    name: 'AnchorUSD',
    description: 'USD stablecoin anchor',
  },

  // ── Stablecoin Issuers ──────────────────────────────────────
  {
    domain: 'centre.io',
    name: 'Centre (USDC)',
    description: 'USDC stablecoin issuer on Stellar',
  },
  {
    domain: 'ntokens.com',
    name: 'nTokens',
    description: 'Nigerian Naira (NGNT) anchor',
  },
  {
    domain: 'stablex.cloud',
    name: 'StableX',
    description: 'Multi-currency stablecoin provider',
  },

  // ── Remittance & Payment Anchors ────────────────────────────
  {
    domain: 'clickpesa.com',
    name: 'ClickPesa',
    description: 'TZS/KES East African anchor',
  },
  {
    domain: 'www.tempo.eu.com',
    name: 'Tempo',
    description: 'EUR remittance anchor (Europe)',
  },
  {
    domain: 'cowrie.exchange',
    name: 'Cowrie Exchange',
    description: 'NGN fiat on/off-ramp (Nigeria)',
  },
  {
    domain: 'flutterwave.com',
    name: 'Flutterwave',
    description: 'Multi-currency African payment anchor',
  },
  {
    domain: 'thewwallet.com',
    name: 'The W Wallet',
    description: 'GHS/KES anchor (West/East Africa)',
  },

  // ── DEX / Exchange Anchors ──────────────────────────────────
  {
    domain: 'stellarport.io',
    name: 'Stellarport',
    description: 'Multi-asset DEX anchor',
  },
  {
    domain: 'ultrastellar.com',
    name: 'UltraStellar',
    description: 'yXLM yield token and services',
  },
  {
    domain: 'stellar.expert',
    name: 'StellarExpert',
    description: 'Stellar network explorer and directory',
  },

  // ── Crypto Bridge Anchors ───────────────────────────────────
  {
    domain: 'cryptoanchor.io',
    name: 'CryptoAnchor',
    description: 'BTC/ETH tokenized assets',
  },
  {
    domain: 'fchain.io',
    name: 'Firefly (FChain)',
    description: 'Multi-asset cross-chain bridge',
  },
  {
    domain: 'coins.asia',
    name: 'Coins.ph',
    description: 'PHP peso anchor (Philippines)',
  },

  // ── European Anchors ────────────────────────────────────────
  {
    domain: 'wirexapp.com',
    name: 'Wirex',
    description: 'EUR/GBP fiat anchor',
  },
  {
    domain: 'settle.network',
    name: 'Settle Network',
    description: 'Multi-currency settlement network (LATAM)',
  },
  {
    domain: 'stablecoin.group',
    name: 'Stablecoin Group',
    description: 'Regulated stablecoin issuance',
  },

  // ── Asian / Pacific Anchors ─────────────────────────────────
  {
    domain: 'kado.money',
    name: 'Kado',
    description: 'On/off-ramp multi-fiat',
  },
  {
    domain: 'stellarmint.io',
    name: 'StellarMint',
    description: 'Real-world asset tokenization',
  },

  // ── Infrastructure Anchors ──────────────────────────────────
  {
    domain: 'stellar.cheesecakelabs.com',
    name: 'CheesecakeLabs',
    description: 'Stellar anchor platform provider',
  },
  {
    domain: 'aidcoin.co',
    name: 'AidCoin',
    description: 'Charity and donation anchor',
  },
  {
    domain: 'saldo.com.ar',
    name: 'Saldo',
    description: 'ARS fiat on/off-ramp (Argentina)',
  },
  {
    domain: 'bfrancpay.com',
    name: 'BFranc Pay',
    description: 'XOF/XAF West African CFA franc anchor',
  },
];

const PUBNET_SEEDS = [
  // ── Major Stablecoin Anchors ────────────────────
  {
    domain: 'centre.io',
    name: 'Centre (USDC)',
    description: 'USDC issuer on Stellar',
  },
  {
    domain: 'stellar.cheesecakelabs.com',
    name: 'CheesecakeLabs',
    description: 'Anchor services provider',
  },
  {
    domain: 'ntokens.com',
    name: 'nTokens',
    description: 'Nigerian Naira (NGN) anchor',
  },
  {
    domain: 'apay.io',
    name: 'AnchorPay',
    description: 'Multi-asset anchor',
  },
  {
    domain: 'satoshipay.io',
    name: 'SatoshiPay',
    description: 'EUR anchor and payment provider',
  },
  {
    domain: 'anclap.com',
    name: 'Anclap',
    description: 'ARS and multi-fiat anchor',
  },
  {
    domain: 'mykobo.co',
    name: 'MyKobo',
    description: 'EUR/NGN anchor',
  },
  {
    domain: 'clickpesa.com',
    name: 'ClickPesa',
    description: 'TZS/KES anchor',
  },
  {
    domain: 'stellarport.io',
    name: 'Stellarport',
    description: 'Multi-asset anchor and DEX',
  },
  {
    domain: 'www.anchorusd.com',
    name: 'AnchorUSD',
    description: 'USD stablecoin anchor',
  },
];

/**
 * Get seed anchors for a specific network.
 * @param {'stellar_testnet' | 'stellar_pubnet'} network
 * @returns {Array<{domain: string, name: string, description: string}>}
 */
export function getSeeds(network) {
  switch (network) {
    case 'stellar_testnet':
      return TESTNET_SEEDS;
    case 'stellar_pubnet':
      return PUBNET_SEEDS;
    default:
      return TESTNET_SEEDS;
  }
}

/**
 * Get all seed domains as a flat Set for quick lookup.
 */
export function getSeedDomainSet(network) {
  return new Set(getSeeds(network).map((s) => s.domain));
}

export default { getSeeds, getSeedDomainSet };
