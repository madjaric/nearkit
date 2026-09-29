import type { NetworkId } from '@/config/networks'

/**
 * Networks where NearKit may hold trading-wallet keys. Testnet: with a KEK in the app's
 * environment (the signer in the same process) or the signer service. Mainnet: only when
 * the owner turns it on (NEARKIT_MAINNET_CUSTODY=enabled on the app AND the signer), with
 * the separate signer service, a KMS-held KEK, PostgreSQL and the production fee account;
 * both refuse to start in mainnet custody mode without every one of them (config.ts,
 * signer/config.ts).
 */
export const CUSTODY_NETWORKS: readonly NetworkId[] = Object.freeze(['testnet', 'mainnet'])
