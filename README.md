# Stella Protocol

**Neutral Routing Intelligence for the Stellar Network**

Stella Protocol is a deterministic, protocol-grade routing engine that discovers optimal payment paths across the Stellar network. It crawls real anchors, indexes assets, builds a live route graph, and provides execution-grade quotes with fee breakdown and slippage estimation.

> ⚡ Built for Stellar — powered by real Horizon testnet data, not mocks.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Frontend (React)                   │
│  Dashboard │ Route Finder │ Graph │ Anchors │ Assets │
└───────────────────────┬─────────────────────────────┘
                        │ REST API
┌───────────────────────┴─────────────────────────────┐
│                 Backend (Fastify)                     │
│                                                       │
│  ┌─────────┐  ┌──────────┐  ┌────────────────────┐  │
│  │ Anchor  │  │  Asset   │  │   Route Graph      │  │
│  │ Crawler │  │ Registry │  │ (In-Memory Graph)   │  │
│  └────┬────┘  └────┬─────┘  └────┬───────────────┘  │
│       │            │              │                    │
│  ┌────┴────────────┴──────────────┴───────────────┐  │
│  │          Route Discovery Engine                 │  │
│  │  Pathfinder → Resolver → Scorer → Cache        │  │
│  └────────────────────┬───────────────────────────┘  │
│                       │                               │
│  ┌────────────────────┴───────────────────────────┐  │
│  │          Execution Engine                       │  │
│  │  Fee Calc → Slippage → Execution Plan → Quote  │  │
│  └────────────────────────────────────────────────┘  │
│                                                       │
│  SQLite (WAL) + Horizon Testnet + stellar.toml crawl │
└──────────────────────────────────────────────────────┘
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js 20+, Fastify 5, ESM modules |
| Database | SQLite (WAL mode) via better-sqlite3 |
| Stellar | @stellar/stellar-sdk 12, Horizon Testnet |
| Frontend | React 19, Vite 6, React Router 7 |
| Logging | Pino + pino-pretty |
| Monorepo | npm workspaces |

## Quick Start

### Prerequisites

- **Node.js** ≥ 18.0.0 (recommended: 20+)
- **npm** ≥ 8

### Install & Run (Development)

```bash
# Clone and install
cd "stella protocol"
npm install

# Start both backend + frontend
npm run dev

# Or start them separately:
npm run dev:backend    # → http://localhost:3001
npm run dev:frontend   # → http://localhost:5173
```

The backend starts on **port 3001**, the frontend on **port 5173** (with proxy to backend).

### Production Build

```bash
# Build frontend
npm run build

# Start backend (serves API + built frontend)
npm start
# → http://localhost:3001  (API + UI on single port)
```

---

## Features

### Phase 1 — Core Infrastructure
- Fastify 5 server with CORS, rate limiting (100 req/min), request-id tracing
- SQLite with WAL mode, migration system, graceful shutdown
- Structured Pino logging with child loggers
- Custom error classes (`StellaError`) with typed error factories

### Phase 2 — Anchor Discovery
- Seed-based anchor crawling (anclap.com, mykobo.co, etc.)
- Real `stellar.toml` fetching + TOML parsing
- Horizon account validation for asset issuers
- Health scoring (availability × completeness × recency)
- Scheduled re-crawling with configurable intervals

### Phase 3 — Asset Registry
- Dual-source discovery: anchor TOMLs + Horizon queries
- Global asset registry with code, issuer, domain, verification status
- Filtering by code, source, domain, deposit/withdraw capabilities

### Phase 4 — Route Graph
- In-memory directed weighted graph
- Edge types: DEX (orderbook-based), Anchor Bridge (cross-asset via anchor), XLM Hub
- Real-time edge weight computation from orderbook spread + depth
- Scheduled light refresh (5 min) + full rebuild (30 min)

### Phase 5 — Route Discovery Engine
- Dijkstra shortest path + Yen's K-shortest paths algorithm
- Route resolver: validate → pathfind → enrich → score → manifest
- Two-layer cache: in-memory LRU (30s) + SQLite (120s)
- Composite scoring: weight (35%) + hops (25%) + liquidity (20%) + reliability (20%)
- Horizon fallback via `findStrictSendPaths`

### Phase 6 — Execution Engine
- Per-leg fee calculation (network fees, DEX spread costs, anchor fees)
- Orderbook-walk slippage estimation with severity classification
- Step-by-step execution plans with Stellar operation types
- Live quote manager with 30s TTL, refresh capability, LRU eviction

### Phase 7 — Reference UI
- 5-page React SPA: Dashboard, Route Finder, Graph Explorer, Anchors, Assets
- Real-time auto-polling dashboard with all subsystem stats
- Asset-dropdown Route Finder (no manual issuer typing)
- Interactive graph explorer with node inspection + neighbor edges
- Expandable anchor cards with TOML capabilities + asset tables
- Filterable, paginated asset registry browser

### Phase 8 — Polish
- React Error Boundary with friendly fallback UI
- Toast notification system (success/error/warning/info)
- 404 Not Found page
- Request-ID tracing (`x-request-id` header)
- Production build pipeline (Vite build → Fastify static serving)
- Loading skeletons + empty state CSS

---

## API Reference

### Health & Info

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Quick health check |
| GET | `/health/deep` | Deep check (DB + Horizon + ledger) |
| GET | `/info` | Protocol metadata |

### Anchors

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/anchors` | List all anchors (filter: status, health, trust) |
| GET | `/api/anchors/stats` | Anchor statistics |
| GET | `/api/anchors/:domain` | Anchor detail by domain |
| GET | `/api/anchors/:domain/assets` | Assets for an anchor |
| GET | `/api/anchors/verified-assets` | All verified anchor assets |
| GET | `/api/anchors/crawl-history` | Crawl history log |
| POST | `/api/anchors/crawl` | Trigger manual crawl |

### Assets

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/assets` | Browse assets (filter: code, source, verified, etc.) |
| GET | `/api/assets/stats` | Asset registry statistics |
| GET | `/api/assets/codes` | Distinct asset codes |
| GET | `/api/assets/routable` | Assets available for routing |
| GET | `/api/assets/:identifier` | Asset by identifier |
| GET | `/api/assets/discover/:code` | Discover asset from Horizon |
| POST | `/api/assets/sync` | Trigger asset sync |

### Graph

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/graph/stats` | Graph metrics (nodes, edges, connectivity) |
| GET | `/api/graph/nodes` | All graph nodes |
| GET | `/api/graph/edges` | All graph edges |
| GET | `/api/graph/edges/:type` | Edges by type (dex, anchor_bridge) |
| GET | `/api/graph/neighbors/:code/:issuer` | Neighbors of a node |
| GET | `/api/graph/snapshot` | Full graph snapshot |
| POST | `/api/graph/rebuild` | Trigger manual rebuild |

### Routes

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/routes/find` | Find routes between two assets |
| GET | `/api/routes/stats` | Routing engine statistics |
| GET | `/api/routes/cache` | Cache statistics |
| DELETE | `/api/routes/cache` | Invalidate route cache |

**POST /api/routes/find** body:
```json
{
  "sourceCode": "ARS",
  "sourceIssuer": "GCYE7C77EB5AWAA25R5XMWNI2EDOKTTFTTPZKM2SR5DI4B4WFD52DARS",
  "destCode": "PEN",
  "destIssuer": "GA4TDPNUCZPTOHB3TKUYMDCRVATXKEADH7ZEYEBWJKQKE2UBFCYNBPEN",
  "amount": "100"
}
```

### Quotes

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/quotes` | Create execution-grade quote |
| GET | `/api/quotes/stats` | Quote manager statistics |
| GET | `/api/quotes/:id` | Get existing quote |
| POST | `/api/quotes/:id/refresh` | Refresh quote with live data |

---

## Project Structure

```
stella protocol/
├── package.json              # Monorepo root (npm workspaces)
├── backend/
│   ├── package.json
│   └── src/
│       ├── index.js          # Boot sequence & graceful shutdown
│       ├── app.js            # Fastify factory + middleware
│       ├── config/           # Centralized configuration
│       ├── db/               # SQLite init + migrations
│       ├── lib/              # Logger, Horizon client
│       ├── plugins/          # Error handler plugin
│       ├── routes/           # REST API endpoints
│       └── services/
│           ├── anchor/       # TOML crawler, indexer, health scoring
│           ├── asset/        # Asset discovery, registry, sync
│           ├── graph/        # Route graph, edge discovery, builder
│           ├── route/        # Pathfinder, resolver, cache
│           └── execution/    # Fees, slippage, planner, quotes
└── frontend/
    ├── package.json
    ├── vite.config.js
    └── src/
        ├── main.jsx          # React entry
        ├── App.jsx           # Router + ErrorBoundary + Toast
        ├── index.css         # Design system
        ├── api.js            # API client
        ├── hooks.js          # useFetch, usePolling, utilities
        ├── components/       # Layout, ErrorBoundary, Toast
        └── pages/            # Dashboard, RouteFinder, GraphExplorer, Anchors, Assets, NotFound
```

---

## Configuration

All configuration is in `backend/src/config/index.js`:

| Key | Default | Description |
|-----|---------|-------------|
| `port` | 3001 | Server port |
| `network` | stellar_testnet | Stellar network |
| `horizonUrl` | horizon-testnet.stellar.org | Horizon API |
| `maxHops` | 4 | Max path hops |
| `maxRoutesPerDest` | 5 | Routes per query |
| `crawlIntervalMs` | 300000 | Anchor recrawl (5 min) |
| `graphRefreshMs` | 300000 | Light graph refresh (5 min) |
| `graphRebuildMs` | 1800000 | Full graph rebuild (30 min) |

---

## Verification

Everything uses real Stellar testnet data:

1. **Anchor TOMLs**: Visit https://anclap.com/.well-known/stellar.toml — same issuers we store
2. **Asset Issuers**: Check on https://testnet.stellar.expert — real testnet accounts
3. **Horizon**: Our `/health/deep` returns the same ledger as https://horizon-testnet.stellar.org

---

## License

MIT
