import type { NetworkConfig } from '@/config/networks'

/** NearBlocks links on the active network. Hashes and IDs are URL-encoded. */
export const explorerTxUrl = (network: Pick<NetworkConfig, 'explorerUrl'>, hash: string) => `${network.explorerUrl}/txns/${encodeURIComponent(hash)}`
export const explorerAccountUrl = (network: Pick<NetworkConfig, 'explorerUrl'>, accountId: string) => `${network.explorerUrl}/address/${encodeURIComponent(accountId)}`
export const explorerTokenUrl = (network: Pick<NetworkConfig, 'explorerUrl'>, contract: string) => `${network.explorerUrl}/tokens/${encodeURIComponent(contract)}`
