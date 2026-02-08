# Stella Protocol — Deployment Guide

## Live URLs

| Service | URL |
|---------|-----|
| **Backend API** | https://stellabackend-production.up.railway.app |
| **Frontend** | (Deploy to Vercel) |

## Quick Start

### Frontend (Vercel)

```bash
cd frontend
vercel
```

Set environment variable in Vercel dashboard:
- `VITE_API_URL` = `https://stellabackend-production.up.railway.app`

### Backend Options

The backend uses SQLite for data persistence. Choose your deployment:

#### Option 1: Railway (Recommended)
Railway supports persistent storage and is ideal for this backend.

```bash
cd backend
railway init
railway up
```

#### Option 2: Render
```bash
# Deploy via Render dashboard
# Use "Web Service" type
# Build: npm install
# Start: npm start
```

#### Option 3: Vercel (Limited)
⚠️ **Note**: Vercel serverless functions don't support persistent SQLite storage.
For full functionality, the database routes will return mock/cached data.

```bash
cd backend
vercel
```

For production with Vercel, consider migrating to Turso (SQLite-compatible cloud DB).

---

## Environment Variables

### Frontend
| Variable | Description | Example |
|----------|-------------|---------|
| `VITE_API_URL` | Backend API URL | `https://api.stella.app` |

### Backend
| Variable | Description | Default |
|----------|-------------|---------|
| `STELLAR_NETWORK` | Network type | `testnet` |
| `HORIZON_URL` | Stellar Horizon URL | `https://horizon-testnet.stellar.org` |
| `PORT` | Server port | `3002` |
| `LOG_LEVEL` | Logging level | `info` |

---

## Architecture

```
┌──────────────────┐     ┌──────────────────┐
│   Vercel CDN     │────▶│  Backend API     │
│   (Frontend)     │     │  (Railway/Render)│
└──────────────────┘     └──────────────────┘
                               │
                               ▼
                    ┌──────────────────┐
                    │  Stellar Horizon │
                    │     (Testnet)    │
                    └──────────────────┘
```

## Domains Setup

1. Deploy frontend to Vercel → get `stella-frontend.vercel.app`
2. Backend is live at → `https://stellabackend-production.up.railway.app`
3. Set `VITE_API_URL=https://stellabackend-production.up.railway.app` in Vercel
4. (Optional) Add custom domains in each platform's dashboard
