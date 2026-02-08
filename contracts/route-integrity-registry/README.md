# RouteIntegrityRegistry

A **non-custodial, immutable Soroban smart contract** for the Stella Protocol that enables transparent, verifiable routing commitments on the Stellar network.

## Design Philosophy

> This contract is a **public notice board**, NOT an execution engine.

| ❌ Does NOT | ✅ DOES |
|-------------|---------|
| Hold funds or custody assets | Store cryptographic hashes |
| Execute swaps or payments | Record timestamps |
| Interact with anchors or DEXs | Emit verifiable events |
| Contain routing logic | Enable off-chain verification |

## Why This Exists

When Stella Protocol finds the optimal route for a cross-border payment, users want assurance that:

1. The route was selected using **publicly committed rules** (not favoring certain anchors)
2. The **solver version** is auditable and reproducible
3. The **quote timing** aligns with market conditions

This contract provides cryptographic commitments that anyone can verify.

## Data Model

```rust
struct RouteCommitment {
    rules_hash: Bytes32,          // Hash of routing rules config
    solver_version_hash: Bytes32, // Hash of solver commit/version
    committer: Address,           // Who made the commitment
    timestamp: u64,               // Ledger time when committed
    expiry: u64,                  // When quote expires (0 = never)
}
```

## Contract Functions

### `commit_route(route_hash, rules_hash, solver_version_hash, expiry)`

Records a routing commitment to the blockchain.

**Validation:**
- `route_hash` must not be all zeros
- `expiry` (if non-zero) must be in the future
- `route_hash` must not already exist (no overwrites)

**Events:** Emits `RouteCommitted(route_hash, rules_hash, solver_version_hash, committer, timestamp, expiry)`

### `get_commit(route_hash) → RouteCommitment`

Retrieves the full commitment metadata for a given route hash.

### `has_commit(route_hash) → bool`

Gas-efficient existence check.

### `verify_commit(route_hash, expected_rules_hash, expected_solver_hash) → bool`

Convenience function to verify hashes match in a single call.

## Security Properties

| Property | Guarantee |
|----------|-----------|
| **No Admin** | Zero privileged functions |
| **No Upgrades** | Contract is final |
| **No Custody** | Cannot hold any assets |
| **Append-Only** | Commitments cannot be modified |
| **Open Access** | Anyone can commit |

## How Verification Works

```
┌─────────────────────────────────────────────────────────────────┐
│                    OFF-CHAIN (Stella Protocol)                   │
├─────────────────────────────────────────────────────────────────┤
│  1. User requests quote: USD → EUR via Stellar                  │
│  2. Solver finds optimal route using published rules            │
│  3. Protocol computes:                                          │
│     • route_hash = SHA256(route_manifest)                       │
│     • rules_hash = SHA256(rules_config)                         │
│     • solver_hash = SHA256(solver_version)                      │
│  4. Protocol calls contract.commit_route(...)                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    ON-CHAIN (This Contract)                      │
├─────────────────────────────────────────────────────────────────┤
│  5. Contract validates & stores commitment                      │
│  6. Emits RouteCommitted event                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    VERIFICATION (User/Auditor)                   │
├─────────────────────────────────────────────────────────────────┤
│  7. User receives route details + original data                 │
│  8. User recomputes hashes locally                              │
│  9. User calls contract.get_commit(route_hash)                  │
│ 10. User verifies hashes match → route was selected fairly      │
└─────────────────────────────────────────────────────────────────┘
```

## Building

```bash
# Install Soroban CLI
cargo install soroban-cli

# Build the contract
cd contracts/route-integrity-registry
soroban contract build

# Run tests
cargo test

# Deploy to testnet
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/route_integrity_registry.wasm \
  --network testnet \
  --source <YOUR_SECRET_KEY>
```

## Testing

```bash
cargo test

# Expected output:
# test tests::test_successful_commit ... ok
# test tests::test_commit_no_expiry ... ok
# test tests::test_reject_duplicate_route_hash ... ok
# test tests::test_reject_empty_route_hash ... ok
# test tests::test_reject_expired_timestamp ... ok
# test tests::test_reject_expiry_too_far ... ok
# test tests::test_get_nonexistent_commit ... ok
# test tests::test_has_commit ... ok
# test tests::test_verify_commit ... ok
```

## Usage Example (JavaScript/TypeScript)

```typescript
import { Contract, Keypair, SorobanRpc } from '@stellar/stellar-sdk';

const server = new SorobanRpc.Server('https://soroban-testnet.stellar.org');
const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

// Verify a route commitment
async function verifyRoute(routeHash: string) {
  const contract = new Contract(contractId);
  
  const result = await server.simulateTransaction(
    contract.call('get_commit', routeHashBytes)
  );
  
  console.log('Commitment:', result);
  console.log('Rules Hash:', result.rules_hash);
  console.log('Solver Version:', result.solver_version_hash);
  console.log('Timestamp:', new Date(result.timestamp * 1000));
}
```

## Gas & Storage Optimization

- **Compact structs**: All data packed efficiently
- **Persistent storage**: Used for long-term commitment retention
- **Minimal validation**: Only essential checks to reduce gas
- **No loops**: O(1) operations only

## License

MIT License - See [LICENSE](../../LICENSE) for details.

## Contributing

This contract is intentionally minimal and should remain so. Any changes should preserve:

1. Non-custodial nature
2. Immutability (no admin functions)
3. Simplicity (no routing logic)
4. Gas efficiency

---

**Stella Protocol** - Transparent, Verifiable Cross-Border Routing
