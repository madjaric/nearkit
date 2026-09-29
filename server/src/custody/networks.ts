import type { NetworkId } from '@/config/networks'

/**
 * Networks where NearKit may hold trading-wallet keys: testnet only. Mainnet custody
 * needs a KMS-held key-encryption key, a separate signer process and a security
 * review first (NEARKIT_TELEGRAM_V2_ARCHITECTURE.md). Deliberately not configurable.
 */
export const CUSTODY_NETWORKS: readonly NetworkId[] = Object.freeze(['testnet'])
