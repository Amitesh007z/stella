# Deploying RouteIntegrityRegistry to Stellar Testnet

## Quick Deployment Guide

### Option 1: GitHub Actions (Recommended)

1. **Push to GitHub** - The workflow will automatically build the WASM:
   ```bash
   git add -A && git commit -m "Add contract build workflow" && git push
   ```

2. **Download WASM** - Go to GitHub → Actions → Download artifact `route-integrity-registry-wasm`

3. **Deploy via Stellar Laboratory**:
   - Go to [Stellar Laboratory](https://laboratory.stellar.org/#txbuilder?network=test)
   - Create account or use existing testnet account funded via [Friendbot](https://friendbot.stellar.org/)
   - Use "Soroban" → "Deploy Contract" and upload the `.wasm` file

### Option 2: Manual Build (Linux/Mac/WSL)

```bash
# Install dependencies
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown
cargo install stellar-cli --locked

# Build contract
cd contracts/route-integrity-registry
stellar contract build

# Generate testnet account (if needed)
stellar keys generate deployer --network testnet --fund

# Deploy to testnet
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/route_integrity_registry.wasm \
  --network testnet \
  --source deployer

# Output: CONTRACT_ID (e.g., CDLZFC...XYZ)
```

### Option 3: Docker Build

```bash
# Build WASM using Docker
docker run --rm -v "$(pwd)":/code \
  --mount type=volume,source=registry_cache,target=/code/target \
  --mount type=volume,source=registry_cargo,target=/usr/local/cargo \
  rust:latest \
  bash -c "
    rustup target add wasm32-unknown-unknown && \
    cargo install stellar-cli --locked && \
    cd /code/contracts/route-integrity-registry && \
    stellar contract build
  "
```

---

## After Deployment

Once deployed, you'll receive a **Contract ID** like:
```
CDLZFCUM5WN722FYTNW7CGSYEAQAEHBLXR4XVNFRFKGRKTBBDQSWKNVU
```

### Update Your App

1. **Add Contract ID to environment**:
   ```bash
   # backend/.env
   REGISTRY_CONTRACT_ID=CDLZFC...
   ```

2. **Update README with deployed address**

3. **Test the contract**:
   ```bash
   # Check contract exists
   stellar contract invoke \
     --id CDLZFC... \
     --network testnet \
     -- \
     has_commit \
     --route_hash 0000000000000000000000000000000000000000000000000000000000000001
   ```

---

## Contract Functions

| Function | Description |
|----------|-------------|
| `commit_route(route_hash, rules_hash, solver_version_hash, expiry)` | Store a routing commitment |
| `get_commit(route_hash)` | Retrieve commitment metadata |
| `has_commit(route_hash)` | Check if commitment exists |
| `verify_commit(route_hash, expected_rules_hash, expected_solver_hash)` | Verify hashes match |

---

## Sharing with Mentor

Once deployed, share:

1. **Contract ID**: `CDLZFC...` (the deployment address)
2. **GitHub Repo**: https://github.com/Amitesh007z/stella
3. **Contract Source**: [contracts/route-integrity-registry/src/lib.rs](../contracts/route-integrity-registry/src/lib.rs)
4. **Testnet Explorer**: `https://stellar.expert/explorer/testnet/contract/CDLZFC...`

---

## Troubleshooting

### Windows Build Errors
Windows MSVC linker has known issues with Stellar CLI. Use:
- WSL (Windows Subsystem for Linux)
- Docker
- GitHub Actions (builds on Ubuntu)

### "Contract not found"
- Ensure you're on **testnet**, not mainnet
- Fund your account via [Friendbot](https://friendbot.stellar.org/?addr=YOUR_ADDRESS)

### "Insufficient balance"
- Fund account: `stellar keys fund deployer --network testnet`
