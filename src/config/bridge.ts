/**
 * Bridge & Buy $KITS: where it brings funds from. NEARKITS is the interface; NEAR Intents (its
 * 1Click API) moves the funds across chains, and NEARKITS never holds them: the user's own wallet on
 * the source chain sends them to the deposit address of a quote, and NEAR Intents delivers NEAR to
 * the NEAR wallet the user chose. Then $KITS is bought with that NEAR through NEARKITS' own trading
 * (1Click doesn't deliver $KITS itself: it isn't one of its supported tokens).
 *
 * V1 is exactly three chains, each with its native coin. The asset ids are 1Click's; NEARKITS'
 * server offers a chain only while 1Click's token list still has that asset with these decimals.
 */

export type BridgeChainId = 'sol' | 'eth' | 'bsc'

export interface BridgeChain {
  id: BridgeChainId
  /** Its name, as people say it. */
  name: string
  /** Its native coin. */
  symbol: string
  /** The coin's asset id in NEAR Intents' 1Click API. */
  assetId: string
  decimals: number
  /** How its wallets sign: a Solana wallet, or an EVM wallet (Ethereum and BNB Chain share one). */
  family: 'solana' | 'evm'
  /** EVM chain id (EIP-155). */
  evmChainId?: number
  /** The chain's own explorer, for a transaction and an address. */
  explorerTx: (hash: string) => string
  explorerAddress: (address: string) => string
  /**
   * What MAX leaves in the source wallet for that chain's own network fee, in base units: the
   * transfer to the deposit address is paid in the same coin.
   */
  maxReserve: bigint
}

export const BRIDGE_CHAINS: readonly BridgeChain[] = Object.freeze([
  {
    id: 'sol',
    name: 'Solana',
    symbol: 'SOL',
    assetId: 'nep141:sol.omft.near',
    decimals: 9,
    family: 'solana',
    explorerTx: (h: string) => `https://solscan.io/tx/${encodeURIComponent(h)}`,
    explorerAddress: (a: string) => `https://solscan.io/account/${encodeURIComponent(a)}`,
    // 0.002 SOL: a transfer costs 0.000005; the rest keeps the account above rent and pays a priority fee.
    maxReserve: 2_000_000n,
  },
  {
    id: 'eth',
    name: 'Ethereum',
    symbol: 'ETH',
    assetId: 'nep141:eth.omft.near',
    decimals: 18,
    family: 'evm',
    evmChainId: 1,
    explorerTx: (h: string) => `https://etherscan.io/tx/${encodeURIComponent(h)}`,
    explorerAddress: (a: string) => `https://etherscan.io/address/${encodeURIComponent(a)}`,
    // 0.002 ETH: a plain transfer (21,000 gas) at up to ~95 gwei.
    maxReserve: 2_000_000_000_000_000n,
  },
  {
    id: 'bsc',
    name: 'BNB Chain',
    symbol: 'BNB',
    assetId: 'nep245:v2_1.omni.hot.tg:56_11111111111111111111',
    decimals: 18,
    family: 'evm',
    evmChainId: 56,
    explorerTx: (h: string) => `https://bscscan.com/tx/${encodeURIComponent(h)}`,
    explorerAddress: (a: string) => `https://bscscan.com/address/${encodeURIComponent(a)}`,
    // 0.0005 BNB: a plain transfer at a few gwei.
    maxReserve: 500_000_000_000_000n,
  },
] satisfies BridgeChain[])

export function bridgeChain(id: string): BridgeChain | null {
  return BRIDGE_CHAINS.find((c) => c.id === id) ?? null
}

/** What NEAR Intents delivers on NEAR: wNEAR (1Click's NEAR asset; native NEAR isn't one of its assets). */
export const BRIDGE_NEAR_ASSET = 'nep141:wrap.near'

/** Slippage NEAR Intents may take on the cross-chain leg, in bps (1%). */
export const BRIDGE_SLIPPAGE_BPS = 100

/**
 * How long a deposit address takes deposits (1Click's `deadline`): long enough for a transfer
 * on any of the three chains to confirm, short enough that a stale price can't be filled.
 */
export const BRIDGE_DEADLINE_MS = 20 * 60_000

/**
 * A review is signed within this: past it the page asks for a fresh quote before the user sends,
 * so the transfer always lands well before the deposit address stops taking deposits.
 */
export const BRIDGE_SIGN_WINDOW_MS = 5 * 60_000

/** Who NEARKITS is to 1Click (its distribution-channel id). */
export const BRIDGE_REFERRAL = 'nearkits'
