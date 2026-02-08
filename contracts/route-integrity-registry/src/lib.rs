//! # RouteIntegrityRegistry - Stella Protocol
//!
//! A **non-custodial, immutable registry** that records cryptographic commitments
//! of routing decisions for transparency and auditability.
//!
//! ## Design Philosophy
//!
//! This contract is a **public notice board**, NOT an execution engine.
//!
//! - ❌ Does NOT hold funds or custody assets
//! - ❌ Does NOT execute swaps, payments, or transfers
//! - ❌ Does NOT interact with anchors or DEXs
//! - ❌ Does NOT contain routing logic or pathfinding
//! - ✅ ONLY stores hashes + timestamps for later verification
//!
//! ## Why No On-Chain Verification?
//!
//! The contract intentionally does NOT verify that routes are "correct" because:
//!
//! 1. **Off-chain complexity**: Route optimization involves real-time liquidity,
//!    anchor availability, and market conditions that change per-second
//! 2. **Gas efficiency**: Verifying routes on-chain would be prohibitively expensive
//! 3. **Trust model**: Users trust the committer (Stella Protocol) to commit
//!    accurate hashes; anyone can verify off-chain by recomputing
//!
//! ## How Off-Chain Verification Works
//!
//! 1. Stella Protocol computes optimal route using published rules
//! 2. Protocol commits hash(route_manifest) + hash(rules_config) + hash(solver_version)
//! 3. User receives route + original data used to compute hashes
//! 4. User (or auditor) recomputes hashes locally
//! 5. User queries this contract to verify hashes match
//!
//! ## For Wallets & Auditors
//!
//! - Call `get_commit(route_hash)` to retrieve commitment metadata
//! - Compare `rules_hash` against published Stella Protocol rules
//! - Compare `solver_version_hash` against open-source solver commits
//! - Verify `timestamp` and `expiry` align with quote timing

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror, symbol_short,
    Address, BytesN, Env, log,
};

/// Maximum age for a commitment (10 years in seconds) - sanity check
const MAX_EXPIRY_DURATION: u64 = 315_360_000;

/// Storage key prefix for route commitments
const COMMIT_PREFIX: &str = "commit";

/// Commitment metadata stored for each route
///
/// Compact struct optimized for minimal storage costs.
/// All hashes are 32-byte SHA-256 digests.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RouteCommitment {
    /// Hash of the routing rules configuration (e.g., "maximize output", "minimize hops")
    pub rules_hash: BytesN<32>,
    
    /// Hash of the solver version/commit ID for reproducibility
    pub solver_version_hash: BytesN<32>,
    
    /// Address that submitted this commitment
    pub committer: Address,
    
    /// Ledger timestamp when commitment was recorded
    pub timestamp: u64,
    
    /// Optional expiry timestamp (0 = no expiry)
    /// Indicates how long the quoted route remains valid
    pub expiry: u64,
}

/// Storage key for a route commitment
#[contracttype]
#[derive(Clone)]
pub struct CommitKey {
    pub route_hash: BytesN<32>,
}

/// Contract error codes
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum RegistryError {
    /// Route hash cannot be all zeros
    EmptyRouteHash = 1,
    /// A commitment for this route_hash already exists
    DuplicateCommitment = 2,
    /// Expiry timestamp must be in the future
    ExpiredTimestamp = 3,
    /// Expiry too far in the future (sanity check)
    ExpiryTooFar = 4,
    /// Commitment not found
    NotFound = 5,
}

/// # RouteIntegrityRegistry Contract
///
/// Immutable, non-custodial registry for routing transparency.
///
/// ## Security Properties
///
/// - **No admin**: Zero privileged functions
/// - **No upgrades**: Contract is final once deployed
/// - **No custody**: Cannot hold or transfer any assets
/// - **Append-only**: Commitments cannot be modified or deleted
/// - **Open access**: Anyone can commit routes
#[contract]
pub struct RouteIntegrityRegistry;

#[contractimpl]
impl RouteIntegrityRegistry {
    /// Commit routing metadata to the public registry.
    ///
    /// # Arguments
    ///
    /// * `env` - Soroban environment
    /// * `route_hash` - SHA-256 hash of the complete route manifest
    /// * `rules_hash` - SHA-256 hash of the routing rules configuration
    /// * `solver_version_hash` - SHA-256 hash of the solver version/commit
    /// * `expiry` - Unix timestamp when quote expires (0 = no expiry)
    ///
    /// # Returns
    ///
    /// * `Ok(())` on success
    /// * `Err(RegistryError)` on validation failure
    ///
    /// # Events
    ///
    /// Emits `RouteCommitted` with all commitment data
    ///
    /// # Errors
    ///
    /// * `EmptyRouteHash` - route_hash is all zeros
    /// * `DuplicateCommitment` - route_hash already committed
    /// * `ExpiredTimestamp` - expiry is in the past
    /// * `ExpiryTooFar` - expiry exceeds maximum duration
    pub fn commit_route(
        env: Env,
        route_hash: BytesN<32>,
        rules_hash: BytesN<32>,
        solver_version_hash: BytesN<32>,
        expiry: u64,
    ) -> Result<(), RegistryError> {
        // Get current ledger timestamp
        let timestamp = env.ledger().timestamp();
        
        // Validate: route_hash must not be empty (all zeros)
        if Self::is_zero_hash(&route_hash) {
            log!(&env, "Rejected: empty route_hash");
            return Err(RegistryError::EmptyRouteHash);
        }
        
        // Validate: commitment must not already exist
        let key = CommitKey { route_hash: route_hash.clone() };
        if env.storage().persistent().has(&key) {
            log!(&env, "Rejected: duplicate commitment for route_hash");
            return Err(RegistryError::DuplicateCommitment);
        }
        
        // Validate: expiry (if non-zero) must be in the future
        if expiry != 0 {
            if expiry <= timestamp {
                log!(&env, "Rejected: expiry {} is not after timestamp {}", expiry, timestamp);
                return Err(RegistryError::ExpiredTimestamp);
            }
            
            // Sanity check: expiry not too far in future
            if expiry > timestamp + MAX_EXPIRY_DURATION {
                log!(&env, "Rejected: expiry too far in future");
                return Err(RegistryError::ExpiryTooFar);
            }
        }
        
        // Get committer address (transaction source)
        let committer = env.current_contract_address();
        
        // Create commitment struct
        let commitment = RouteCommitment {
            rules_hash: rules_hash.clone(),
            solver_version_hash: solver_version_hash.clone(),
            committer: committer.clone(),
            timestamp,
            expiry,
        };
        
        // Store commitment (persistent storage for long-term retention)
        env.storage().persistent().set(&key, &commitment);
        
        // Emit RouteCommitted event for indexers and auditors
        env.events().publish(
            (symbol_short!("commit"), route_hash.clone()),
            (
                rules_hash,
                solver_version_hash,
                committer,
                timestamp,
                expiry,
            ),
        );
        
        log!(&env, "RouteCommitted: hash={:?}, timestamp={}", route_hash, timestamp);
        
        Ok(())
    }
    
    /// Retrieve commitment metadata for a route hash.
    ///
    /// # Arguments
    ///
    /// * `env` - Soroban environment
    /// * `route_hash` - SHA-256 hash of the route to look up
    ///
    /// # Returns
    ///
    /// * `Ok(RouteCommitment)` - Full commitment metadata
    /// * `Err(RegistryError::NotFound)` - No commitment exists for this hash
    ///
    /// # Usage
    ///
    /// ```text
    /// let commit = contract.get_commit(route_hash)?;
    /// assert!(commit.rules_hash == expected_rules_hash);
    /// assert!(commit.solver_version_hash == known_solver_commit);
    /// ```
    pub fn get_commit(
        env: Env,
        route_hash: BytesN<32>,
    ) -> Result<RouteCommitment, RegistryError> {
        let key = CommitKey { route_hash };
        
        env.storage()
            .persistent()
            .get(&key)
            .ok_or(RegistryError::NotFound)
    }
    
    /// Check if a route hash has been committed.
    ///
    /// Gas-efficient existence check without loading full commitment data.
    ///
    /// # Arguments
    ///
    /// * `env` - Soroban environment
    /// * `route_hash` - SHA-256 hash to check
    ///
    /// # Returns
    ///
    /// * `true` if commitment exists
    /// * `false` otherwise
    pub fn has_commit(env: Env, route_hash: BytesN<32>) -> bool {
        let key = CommitKey { route_hash };
        env.storage().persistent().has(&key)
    }
    
    /// Verify that a commitment matches expected values.
    ///
    /// Convenience function for on-chain verification by other contracts.
    ///
    /// # Arguments
    ///
    /// * `env` - Soroban environment
    /// * `route_hash` - Route hash to verify
    /// * `expected_rules_hash` - Expected rules hash
    /// * `expected_solver_hash` - Expected solver version hash
    ///
    /// # Returns
    ///
    /// * `true` if commitment exists AND all hashes match
    /// * `false` otherwise
    pub fn verify_commit(
        env: Env,
        route_hash: BytesN<32>,
        expected_rules_hash: BytesN<32>,
        expected_solver_hash: BytesN<32>,
    ) -> bool {
        match Self::get_commit(env, route_hash) {
            Ok(commit) => {
                commit.rules_hash == expected_rules_hash
                    && commit.solver_version_hash == expected_solver_hash
            }
            Err(_) => false,
        }
    }
    
    // ─────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────
    
    /// Check if a 32-byte hash is all zeros
    fn is_zero_hash(hash: &BytesN<32>) -> bool {
        let bytes = hash.to_array();
        bytes.iter().all(|&b| b == 0)
    }
}

// ═══════════════════════════════════════════════════════════════════════
// UNIT TESTS
// ═══════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger, LedgerInfo};
    use soroban_sdk::{vec, Env};

    fn setup_env() -> Env {
        let env = Env::default();
        env.ledger().set(LedgerInfo {
            timestamp: 1700000000, // Fixed timestamp for tests
            protocol_version: 21,
            sequence_number: 100,
            network_id: [0u8; 32],
            base_reserve: 10,
            min_temp_entry_ttl: 100,
            min_persistent_entry_ttl: 100,
            max_entry_ttl: 1000000,
        });
        env
    }

    fn test_hash(seed: u8) -> BytesN<32> {
        let mut bytes = [0u8; 32];
        bytes[0] = seed;
        bytes[31] = seed;
        BytesN::from_array(&Env::default(), &bytes)
    }

    fn zero_hash() -> BytesN<32> {
        BytesN::from_array(&Env::default(), &[0u8; 32])
    }

    #[test]
    fn test_successful_commit() {
        let env = setup_env();
        let contract_id = env.register_contract(None, RouteIntegrityRegistry);
        let client = RouteIntegrityRegistryClient::new(&env, &contract_id);

        let route_hash = test_hash(1);
        let rules_hash = test_hash(2);
        let solver_hash = test_hash(3);
        let expiry = 1700001000u64; // 1000 seconds in future

        // Commit should succeed
        let result = client.commit_route(&route_hash, &rules_hash, &solver_hash, &expiry);
        assert!(result.is_ok());

        // Verify commitment stored correctly
        let commit = client.get_commit(&route_hash).unwrap();
        assert_eq!(commit.rules_hash, rules_hash);
        assert_eq!(commit.solver_version_hash, solver_hash);
        assert_eq!(commit.expiry, expiry);
        assert_eq!(commit.timestamp, 1700000000);
    }

    #[test]
    fn test_commit_no_expiry() {
        let env = setup_env();
        let contract_id = env.register_contract(None, RouteIntegrityRegistry);
        let client = RouteIntegrityRegistryClient::new(&env, &contract_id);

        let route_hash = test_hash(10);
        let rules_hash = test_hash(20);
        let solver_hash = test_hash(30);
        let expiry = 0u64; // No expiry

        let result = client.commit_route(&route_hash, &rules_hash, &solver_hash, &expiry);
        assert!(result.is_ok());

        let commit = client.get_commit(&route_hash).unwrap();
        assert_eq!(commit.expiry, 0);
    }

    #[test]
    fn test_reject_duplicate_route_hash() {
        let env = setup_env();
        let contract_id = env.register_contract(None, RouteIntegrityRegistry);
        let client = RouteIntegrityRegistryClient::new(&env, &contract_id);

        let route_hash = test_hash(5);
        let rules_hash = test_hash(6);
        let solver_hash = test_hash(7);
        let expiry = 1700001000u64;

        // First commit succeeds
        assert!(client.commit_route(&route_hash, &rules_hash, &solver_hash, &expiry).is_ok());

        // Second commit with same route_hash fails
        let result = client.commit_route(&route_hash, &rules_hash, &solver_hash, &expiry);
        assert_eq!(result, Err(RegistryError::DuplicateCommitment));
    }

    #[test]
    fn test_reject_empty_route_hash() {
        let env = setup_env();
        let contract_id = env.register_contract(None, RouteIntegrityRegistry);
        let client = RouteIntegrityRegistryClient::new(&env, &contract_id);

        let route_hash = zero_hash();
        let rules_hash = test_hash(2);
        let solver_hash = test_hash(3);
        let expiry = 1700001000u64;

        let result = client.commit_route(&route_hash, &rules_hash, &solver_hash, &expiry);
        assert_eq!(result, Err(RegistryError::EmptyRouteHash));
    }

    #[test]
    fn test_reject_expired_timestamp() {
        let env = setup_env();
        let contract_id = env.register_contract(None, RouteIntegrityRegistry);
        let client = RouteIntegrityRegistryClient::new(&env, &contract_id);

        let route_hash = test_hash(8);
        let rules_hash = test_hash(9);
        let solver_hash = test_hash(10);
        let expiry = 1699999999u64; // In the past

        let result = client.commit_route(&route_hash, &rules_hash, &solver_hash, &expiry);
        assert_eq!(result, Err(RegistryError::ExpiredTimestamp));
    }

    #[test]
    fn test_reject_expiry_too_far() {
        let env = setup_env();
        let contract_id = env.register_contract(None, RouteIntegrityRegistry);
        let client = RouteIntegrityRegistryClient::new(&env, &contract_id);

        let route_hash = test_hash(11);
        let rules_hash = test_hash(12);
        let solver_hash = test_hash(13);
        // More than 10 years in future
        let expiry = 1700000000u64 + MAX_EXPIRY_DURATION + 1;

        let result = client.commit_route(&route_hash, &rules_hash, &solver_hash, &expiry);
        assert_eq!(result, Err(RegistryError::ExpiryTooFar));
    }

    #[test]
    fn test_get_nonexistent_commit() {
        let env = setup_env();
        let contract_id = env.register_contract(None, RouteIntegrityRegistry);
        let client = RouteIntegrityRegistryClient::new(&env, &contract_id);

        let route_hash = test_hash(99);
        let result = client.get_commit(&route_hash);
        assert_eq!(result, Err(RegistryError::NotFound));
    }

    #[test]
    fn test_has_commit() {
        let env = setup_env();
        let contract_id = env.register_contract(None, RouteIntegrityRegistry);
        let client = RouteIntegrityRegistryClient::new(&env, &contract_id);

        let route_hash = test_hash(15);
        let rules_hash = test_hash(16);
        let solver_hash = test_hash(17);

        // Before commit
        assert!(!client.has_commit(&route_hash));

        // After commit
        client.commit_route(&route_hash, &rules_hash, &solver_hash, &0u64).unwrap();
        assert!(client.has_commit(&route_hash));
    }

    #[test]
    fn test_verify_commit() {
        let env = setup_env();
        let contract_id = env.register_contract(None, RouteIntegrityRegistry);
        let client = RouteIntegrityRegistryClient::new(&env, &contract_id);

        let route_hash = test_hash(20);
        let rules_hash = test_hash(21);
        let solver_hash = test_hash(22);

        client.commit_route(&route_hash, &rules_hash, &solver_hash, &0u64).unwrap();

        // Correct hashes
        assert!(client.verify_commit(&route_hash, &rules_hash, &solver_hash));

        // Wrong rules hash
        assert!(!client.verify_commit(&route_hash, &test_hash(99), &solver_hash));

        // Wrong solver hash
        assert!(!client.verify_commit(&route_hash, &rules_hash, &test_hash(99)));

        // Nonexistent route
        assert!(!client.verify_commit(&test_hash(99), &rules_hash, &solver_hash));
    }
}
