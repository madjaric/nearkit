/**
 * EVM wallets for Bridge & Buy's source (Ethereum and BNB Chain share them): the browser's injected
 * wallets, found through EIP-6963 (each announces itself with its name and icon), with the legacy
 * `window.ethereum` as a fallback. The wallet signs and sends; NEARKITS never sees a key. A plain
 * native transfer of exactly the quoted amount to the quote's deposit address is all it is asked for.
 */

export interface Eip1193 {
  request(args: { method: string; params?: unknown }): Promise<unknown>
  on?(event: string, listener: (...args: unknown[]) => void): void
  removeListener?(event: string, listener: (...args: unknown[]) => void): void
}

export interface EvmWallet {
  id: string
  name: string
  /** The wallet's own icon (a data: URI it announced), when it gave one. */
  icon: string | null
  provider: Eip1193
}

/** What went wrong, in words for the page; `rejected`: the user said no in the wallet. */
export class SourceWalletError extends Error {
  constructor(
    message: string,
    readonly rejected = false,
  ) {
    super(message)
    this.name = 'SourceWalletError'
  }
}

const codeOf = (e: unknown): number | null => {
  const c = (e as { code?: unknown } | null)?.code
  return typeof c === 'number' ? c : null
}

export function evmError(e: unknown): SourceWalletError {
  const code = codeOf(e)
  if (code === 4001) return new SourceWalletError('You declined in your wallet. Nothing was sent.', true)
  if (code === -32002) return new SourceWalletError('Your wallet already has a request open: finish or close it there first.')
  if (code === 4100) return new SourceWalletError('Your wallet hasn’t connected this site yet. Connect it first.')
  const message = (e as { message?: unknown } | null)?.message
  return new SourceWalletError(typeof message === 'string' && message.length < 200 ? message : 'Your wallet couldn’t do that. Nothing was sent.')
}

/** Listens for EIP-6963 wallets (and the legacy injected one); calls back with the list as it grows. */
export function discoverEvmWallets(onChange: (wallets: EvmWallet[]) => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const found = new Map<string, EvmWallet>()
  const announce = (e: Event) => {
    const d = (e as CustomEvent<{ info?: { uuid?: unknown; name?: unknown; icon?: unknown }; provider?: Eip1193 }>).detail
    const info = d?.info
    if (!d?.provider || typeof d.provider.request !== 'function' || typeof info?.uuid !== 'string' || typeof info.name !== 'string') return
    const icon = typeof info.icon === 'string' && /^data:image\/(svg\+xml|png|webp|jpeg);/.test(info.icon) ? info.icon : null
    found.set(info.uuid, { id: info.uuid, name: info.name.slice(0, 40), icon, provider: d.provider })
    onChange([...found.values()])
  }
  window.addEventListener('eip6963:announceProvider', announce)
  window.dispatchEvent(new Event('eip6963:requestProvider'))
  // A wallet that only injects window.ethereum (no EIP-6963).
  const legacy = setTimeout(() => {
    const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum
    if (found.size === 0 && eth && typeof eth.request === 'function') {
      found.set('injected', { id: 'injected', name: 'Browser wallet', icon: null, provider: eth })
      onChange([...found.values()])
    }
  }, 400)
  return () => {
    window.removeEventListener('eip6963:announceProvider', announce)
    clearTimeout(legacy)
  }
}

export async function connectEvm(provider: Eip1193): Promise<string> {
  let accounts: unknown
  try {
    accounts = await provider.request({ method: 'eth_requestAccounts' })
  } catch (e) {
    throw evmError(e)
  }
  const first = Array.isArray(accounts) ? accounts[0] : null
  if (typeof first !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(first)) throw new SourceWalletError('Your wallet returned no account.')
  return first
}

const hex = (n: bigint | number) => `0x${n.toString(16)}`

/** BNB Chain, for wallets that don't know it yet (wallet_addEthereumChain). */
const ADD_CHAIN: Record<number, unknown> = {
  56: {
    chainId: '0x38',
    chainName: 'BNB Smart Chain',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: ['https://bsc-dataseed.bnbchain.org'],
    blockExplorerUrls: ['https://bscscan.com'],
  },
}

export async function evmChainId(provider: Eip1193): Promise<number | null> {
  const id = await provider.request({ method: 'eth_chainId' }).catch(() => null)
  return typeof id === 'string' && /^0x[0-9a-fA-F]+$/.test(id) ? Number.parseInt(id, 16) : null
}

/** Puts the wallet on `chainId` (asks it to switch, or to add BNB Chain first). */
export async function ensureEvmChain(provider: Eip1193, chainId: number): Promise<void> {
  if ((await evmChainId(provider)) === chainId) return
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex(chainId) }] })
  } catch (e) {
    if (codeOf(e) === 4902 && ADD_CHAIN[chainId]) {
      try {
        await provider.request({ method: 'wallet_addEthereumChain', params: [ADD_CHAIN[chainId]] })
      } catch (e2) {
        throw evmError(e2)
      }
    } else throw evmError(e)
  }
  if ((await evmChainId(provider)) !== chainId) throw new SourceWalletError('Your wallet is on another network. Switch it, then try again.')
}

export async function evmBalance(provider: Eip1193, address: string): Promise<bigint> {
  const raw = await provider.request({ method: 'eth_getBalance', params: [address, 'latest'] })
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw)) throw new SourceWalletError('Your wallet returned no balance.')
  return BigInt(raw)
}

/**
 * Sends exactly `value` (wei) of the native coin from `from` to `to`, on `chainId` (checked right
 * before sending: a wallet switched meanwhile sends nothing). Returns the transaction hash.
 */
export async function sendEvmNative(provider: Eip1193, tx: { from: string; to: string; value: bigint; chainId: number }): Promise<string> {
  if ((await evmChainId(provider)) !== tx.chainId) throw new SourceWalletError('Your wallet switched networks. Nothing was sent: try again.')
  let hash: unknown
  try {
    hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: tx.from, to: tx.to, value: hex(tx.value) }] })
  } catch (e) {
    throw evmError(e)
  }
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new SourceWalletError('Your wallet returned no transaction hash. Check it before sending again.')
  return hash
}
