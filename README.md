# 𝖲𝗍𝖾𝗅𝗅𝖺 𝖯𝗋𝗈𝗍𝗈𝖼𝗈𝗅

<div align="center">

![Stella Protocol](frontend/public/logo.jpeg)

### **The Routing Intelligence Engine for Stellar Network**

*Discover optimal payment paths • Real-time anchor crawling • Execution-grade quotes*

[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Stellar](https://img.shields.io/badge/Stellar-Testnet-7C3AED?style=for-the-badge&logo=stellar&logoColor=white)](https://stellar.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black)](https://react.dev/)
[![Fastify](https://img.shields.io/badge/Fastify-5-000000?style=for-the-badge&logo=fastify&logoColor=white)](https://fastify.dev/)
[![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)

---

[🚀 Live Demo](#quick-start) • [📖 Documentation](#api-reference) • [🏗️ Architecture](#architecture)

</div>

---

## What is Stella Protocol? 🎯

Stella Protocol is a **deterministic, protocol-grade routing engine** that discovers optimal payment paths across the Stellar network. It crawls real anchors, indexes assets, builds a live route graph, and provides execution-grade quotes with fee breakdown and slippage estimation.

> *"DeFi's first intelligent routing layer for Stellar, powered by real Horizon data and live anchor discovery."*

**Key Capabilities:**
- 🔍 **Anchor Discovery** — Automated crawling of stellar.toml files from verified anchors
- 📊 **Route Graph** — In-memory directed weighted graph with DEX, bridge, and XLM hub edges
- ⚡ **Smart Routing** — Dijkstra + Yen's K-shortest paths with composite scoring
- 💰 **Execution Quotes** — Per-leg fee calculation, slippage estimation, and execution plans
- 🔐 **SEP-10/SEP-24** — Full web authentication and interactive deposit/withdraw support

---

## Architecture 🏗️

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│                         STELLA PROTOCOL ARCHITECTURE                        │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                     FRONTEND (React 19 + Vite)                      │   │
│   │   Home (Swap) │ Dashboard │ Route Finder │ Graph │ Anchors │ Assets │   │
│   └─────────────────────────────────┬───────────────────────────────────┘   │
│                                     │ REST API                              │
│   ┌─────────────────────────────────┴───────────────────────────────────┐   │
│   │                       BACKEND (Fastify 5)                           │   │
│   │                                                                     │   │
│   │   ┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐   │   │
│   │   │   Anchor     │   │    Asset     │   │    Route Graph       │   │   │
│   │   │   Crawler    │   │   Registry   │   │  (In-Memory Graph)   │   │   │
│   │   └──────┬───────┘   └──────┬───────┘   └──────────┬───────────┘   │   │
│   │          │                  │                      │               │   │
│   │   ┌──────┴──────────────────┴──────────────────────┴───────────┐   │   │
│   │   │              ROUTE DISCOVERY ENGINE                        │   │   │
│   │   │    Pathfinder  →  Resolver  →  Scorer  →  Cache           │   │   │
│   │   └────────────────────────────┬───────────────────────────────┘   │   │
│   │                                │                                   │   │
│   │   ┌────────────────────────────┴───────────────────────────────┐   │   │
│   │   │               EXECUTION ENGINE                             │   │   │
│   │   │    Fee Calc  →  Slippage  →  Execution Plan  →  Quote     │   │   │
│   │   └────────────────────────────────────────────────────────────┘   │   │
│   │                                                                     │   │
│   │   ┌─────────────────────────────────────────────────────────────┐   │   │
│   │   │  SQLite (WAL)  │  Horizon Testnet  │  stellar.toml Crawl   │   │   │
│   │   └─────────────────────────────────────────────────────────────┘   │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Core Services

| Service | Description |
|---------|-------------|
| **Anchor Crawler** | Discovers and indexes Stellar anchors via stellar.toml files |
| **Asset Registry** | Unified asset database with verification status and capabilities |
| **Route Graph** | Directed weighted graph with DEX, bridge, and XLM hub edges |
| **Route Resolver** | K-shortest paths with Horizon validation and composite scoring |
| **Execution Engine** | Fee calculation, slippage estimation, and step-by-step execution plans |
| **Quote Manager** | TTL-managed quotes with refresh capability and LRU eviction |

---

## Quick Start 🚀

### Prerequisites

- **Node.js** ≥ 18.0.0 (recommended: 20+)
- **npm** ≥ 8
- **Freighter Wallet** (optional, for transaction signing)

### Clone & Install

```bash
git clone https://github.com/Amitesh007z/stella.git
cd stella-protocol

# Install all dependencies (backend + frontend)
npm install
```

### Run Locally

```bash
# Terminal 1: Start backend
cd backend && npm run dev
# → API running on http://localhost:3002

# Terminal 2: Start frontend
cd frontend && npm run dev
# → UI running on http://localhost:5173
```

Open **http://localhost:5173** in your browser.

### Production Build

```bash
# Build frontend for production
cd frontend && npm run build

# Start backend (serves API)
cd backend && npm start
```

---

## How It Works 💡

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   1️⃣ CRAWL           2️⃣ BUILD           3️⃣ ROUTE          4️⃣ EXECUTE     │
│                                                                             │
│   ┌─────────┐       ┌─────────┐       ┌─────────┐       ┌─────────┐       │
│   │ Anchor  │──────▶│  Graph  │──────▶│  Find   │──────▶│ Quote   │       │
│   │ TOML    │       │  Build  │       │  Paths  │       │ Execute │       │
│   └─────────┘       └─────────┘       └─────────┘       └─────────┘       │
│                                                                             │
│   Discover real     Build weighted     Find optimal      Generate          │
│   anchors from      graph from DEX     paths using       execution-grade   │
│   stellar.toml      orderbooks and     K-shortest        quotes with       │
│   files             anchor bridges     algorithm         fee + slippage    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Example Flow

1. **User requests route**: XLM → USDC (100 XLM)
2. **Pathfinder searches**: Finds all viable paths through the graph
3. **Routes scored**: Composite score = weight (35%) + hops (25%) + liquidity (20%) + reliability (20%)
4. **Horizon validation**: Verify paths exist on Stellar network
5. **Quote generated**: Fee breakdown, slippage estimate, execution plan
6. **User executes**: Step-by-step operations via Freighter wallet

---

## Features ✨

### Route Discovery Engine

| Feature | Description |
|---------|-------------|
| **K-Shortest Paths** | Dijkstra + Yen's algorithm for finding optimal routes |
| **Composite Scoring** | Multi-factor scoring: weight, hops, liquidity, reliability |
| **Horizon Validation** | Real-time path verification via `findStrictSendPaths` |
| **Two-Layer Cache** | In-memory LRU (30s) + SQLite (120s) for performance |

### Execution Engine

| Feature | Description |
|---------|-------------|
| **Fee Calculation** | Per-leg fees: network, DEX spread, anchor fees |
| **Slippage Estimation** | Orderbook-walk estimation with severity classification |
| **Execution Plans** | Step-by-step Stellar operation sequences |
| **Quote Management** | 30s TTL, refresh capability, LRU eviction |

### Security & Reliability

| Feature | Implementation |
|---------|----------------|
| **Rate Limiting** | 100 requests/minute per IP |
| **Request Tracing** | `x-request-id` header on all responses |
| **Graceful Shutdown** | Clean database and scheduler cleanup |
| **Error Handling** | Typed error classes with structured logging |
| **WAL Mode** | SQLite write-ahead logging for crash safety |

---

## Tech Stack 🛠️

### Backend

| Technology | Version | Purpose |
|------------|---------|---------|
| Node.js | 20+ | Runtime environment |
| Fastify | 5.x | High-performance web framework |
| SQLite | 3.x | Embedded database (WAL mode) |
| better-sqlite3 | 11.x | Synchronous SQLite driver |
| @stellar/stellar-sdk | 12.x | Stellar network interaction |
| Pino | 9.x | Structured logging |

### Frontend

| Technology | Version | Purpose |
|------------|---------|---------|
| React | 19 | UI framework |
| Vite | 6.x | Build tool & dev server |
| React Router | 7.x | Client-side routing |
| @stellar/freighter-api | 6.x | Wallet integration |

---

## Project Structure 📁

```
stella-protocol/
├── package.json                    # Monorepo root
│
├── backend/
│   ├── package.json
│   └── src/
│       ├── index.js                # Boot sequence & graceful shutdown
│       ├── app.js                  # Fastify factory + middleware
│       ├── config/
│       │   └── index.js            # Centralized configuration
│       ├── db/
│       │   ├── index.js            # SQLite initialization
│       │   ├── migrate.js          # Migration runner
│       │   └── migrations/         # Schema migrations
│       ├── lib/
│       │   ├── horizon.js          # Stellar SDK wrapper
│       │   └── logger.js           # Pino logger factory
│       ├── plugins/
│       │   └── errorHandler.js     # Global error handling
│       ├── routes/
│       │   ├── anchors.js          # /api/anchors endpoints
│       │   ├── assets.js           # /api/assets endpoints
│       │   ├── graph.js            # /api/graph endpoints
│       │   ├── routes.js           # /api/routes endpoints
│       │   ├── quotes.js           # /api/quotes endpoints
│       │   ├── sep10.js            # SEP-10 authentication
│       │   ├── sep24.js            # SEP-24 interactive flows
│       │   └── trustlines.js       # Trustline management
│       └── services/
│           ├── anchor/             # TOML crawler, indexer, health scoring
│           ├── asset/              # Asset discovery, registry, sync
│           ├── auth/               # SEP-10 authentication service
│           ├── graph/              # Route graph, edge discovery, builder
│           ├── route/              # Pathfinder, resolver, cache
│           └── execution/          # Fees, slippage, planner, quotes
│
└── frontend/
    ├── package.json
    ├── vite.config.js
    ├── vercel.json                 # Vercel deployment config
    ├── public/
    │   └── logo.jpeg               # Brand logo
    └── src/
        ├── main.jsx                # React entry point
        ├── App.jsx                 # Router + ErrorBoundary + Toast
        ├── index.css               # Design system (2000+ lines)
        ├── api.js                  # API client
        ├── hooks.js                # Custom React hooks
        ├── components/
        │   ├── AdminLayout.jsx     # Sidebar layout for admin
        │   ├── ErrorBoundary.jsx   # Error fallback UI
        │   ├── Toast.jsx           # Notification system
        │   └── WalletConnect.jsx   # Freighter integration
        └── pages/
            ├── Home.jsx            # Swap widget (main page)
            ├── Dashboard.jsx       # System overview
            ├── RouteFinder.jsx     # Route discovery UI
            ├── GraphExplorer.jsx   # Network visualization
            ├── Anchors.jsx         # Anchor browser
            ├── Assets.jsx          # Asset registry
            └── NotFound.jsx        # 404 page
```

---

## API Reference 📖

### Health & Info

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Quick health check |
| GET | `/health/deep` | Deep check (DB + Horizon + ledger) |
| GET | `/info` | Protocol metadata |

### Anchors

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/anchors` | List all anchors |
| GET | `/api/anchors/stats` | Anchor statistics |
| GET | `/api/anchors/:domain` | Anchor detail by domain |
| POST | `/api/anchors/crawl` | Trigger manual crawl |

### Assets

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/assets` | Browse assets (filterable) |
| GET | `/api/assets/stats` | Asset registry statistics |
| GET | `/api/assets/routable` | Assets available for routing |

### Graph

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/graph/stats` | Graph metrics |
| GET | `/api/graph/nodes` | All graph nodes |
| GET | `/api/graph/edges` | All graph edges |
| POST | `/api/graph/rebuild` | Trigger manual rebuild |

### Routes

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/routes/find` | Find routes between assets |
| GET | `/api/routes/stats` | Routing engine statistics |

**POST /api/routes/find** body:
```json
{
  "sourceCode": "XLM",
  "destCode": "USDC",
  "destIssuer": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  "amount": "100"
}
```

### Quotes

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/quotes` | Create execution-grade quote |
| GET | `/api/quotes/:id` | Get existing quote |
| POST | `/api/quotes/:id/refresh` | Refresh quote with live data |

---

## Configuration ⚙️

Environment variables (`.env`):

| Key | Default | Description |
|-----|---------|-------------|
| `PORT` | 3002 | Server port |
| `STELLAR_NETWORK` | testnet | Network (testnet/mainnet) |
| `HORIZON_URL` | horizon-testnet.stellar.org | Horizon API URL |
| `LOG_LEVEL` | info | Logging level |

---

## Deployment 🚀

### Vercel (Frontend)

```bash
cd frontend
vercel
```

Set `VITE_API_URL` to your backend URL in Vercel dashboard.

### Railway (Backend)

```bash
cd backend
railway init
railway up
```

See [DEPLOY.md](DEPLOY.md) for detailed deployment instructions.

---

## Roadmap 🗺️

### Phase 1: Foundation ✅
- [x] Core routing engine
- [x] Anchor crawler & asset registry
- [x] Route graph with DEX + bridge edges
- [x] K-shortest paths algorithm
- [x] Execution-grade quotes
- [x] Premium UI with swap widget

### Phase 2: Execution 🔄
- [x] SEP-10 web authentication
- [x] SEP-24 interactive deposits/withdraws
- [x] Freighter wallet integration
- [x] Trustline management

### Phase 3: Mainnet 🎯
- [ ] Security audit
- [ ] Mainnet deployment
- [ ] Multi-path execution
- [ ] Advanced slippage protection
- [ ] Liquidity aggregation

---

## Stellar Integration Deep Dive 🔗

### Horizon API Integration

```javascript
// Real-time path finding via Stellar Horizon
import { findStrictSendPaths, StellarSdk } from './lib/horizon.js';

const paths = await findStrictSendPaths({
  sourceAsset: StellarSdk.Asset.native(),
  sourceAmount: '100',
  destinationAssets: [
    new StellarSdk.Asset('USDC', 'GBBD47IF...')
  ]
});

// Returns validated paths with destination amounts
paths.records.forEach(path => {
  console.log(`Receive: ${path.destination_amount} USDC`);
});
```

### SEP-10 Authentication

```javascript
// Web authentication for anchor APIs
const challenge = await getSep10Challenge({
  anchorDomain: 'testanchor.stellar.org',
  userAccount: 'GUSER...'
});

// Sign with Freighter
const signedTx = await freighter.signTransaction(challenge.transaction);

// Submit for JWT token
const { token } = await submitSep10Response({
  transaction: signedTx
});
```

---

## Contributing 🤝

Contributions are welcome! Please read our contributing guidelines before submitting PRs.

```bash
# Fork the repository
git fork https://github.com/Amitesh007z/stella.git

# Create feature branch
git checkout -b feature/amazing-feature

# Commit changes
git commit -m "Add amazing feature"

# Push and create PR
git push origin feature/amazing-feature
```

---

## License 📜

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

---

<div align="center">

**Built with ❤️ for the Stellar Ecosystem**

[Website](#) • [GitHub](https://github.com/Amitesh007z/stella) • [Twitter](https://x.com/stella_protocol)

---

**Stella Protocol** — *Routing Intelligence for Stellar*

</div>
