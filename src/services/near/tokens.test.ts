import { describe, expect, it, vi } from 'vitest'
import { RpcError, type RpcClient } from './rpc'
import { createTokenReader, parseU128, sanitizeIcon, validateMetadata } from './tokens'
import { storageBoundsMin, storageStatus } from './storage'

const meta = { spec: 'ft-1.0.0', name: 'USD Coin', symbol: 'USDC', decimals: 6, icon: 'data:image/svg+xml,%3Csvg%3E%3C/svg%3E', reference: null, reference_hash: null }

function rpcWith(views: Record<string, (args: Record<string, unknown>) => unknown>): RpcClient & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    urls: [],
    call: async () => {
      throw new Error('unused')
    },
    viewAccount: async () => {
      throw new Error('unused')
    },
    txStatus: async () => {
      throw new Error('unused')
    },
    async viewFunction<T>(contract: string, method: string, args: Record<string, unknown> = {}) {
      calls.push(`${contract}.${method}`)
      const fn = views[`${contract}.${method}`] ?? views[method]
      if (!fn) throw new RpcError('contract', 'wasm execution failed with error: MethodResolveError(MethodNotFound)')
      const out = fn(args)
      if (out instanceof Error) throw out
      return out as T
    },
  }
}

describe('validateMetadata', () => {
  it('accepts NEP-148 metadata and keeps only safe icons', () => {
    expect(validateMetadata(meta)).toEqual({ ok: true, value: { spec: 'ft-1.0.0', name: 'USD Coin', symbol: 'USDC', decimals: 6, icon: meta.icon } })
  })

  it('rejects contracts that do not behave like a token', () => {
    expect(validateMetadata(null).ok).toBe(false)
    expect(validateMetadata({ ...meta, decimals: 6.5 }).ok).toBe(false)
    expect(validateMetadata({ ...meta, decimals: 300 }).ok).toBe(false)
    expect(validateMetadata({ ...meta, decimals: '6' }).ok).toBe(false)
    expect(validateMetadata({ ...meta, symbol: '   ' }).ok).toBe(false)
    expect(validateMetadata({ ...meta, name: 5 }).ok).toBe(false)
  })

  it('trims symbols and strips control characters instead of trusting them', () => {
    const dirty = ` U${String.fromCharCode(0x200b)}SD${String.fromCharCode(0)}C `
    const r = validateMetadata({ ...meta, symbol: dirty })
    expect(r.ok && r.value.symbol).toBe('USDC')
  })
})

describe('sanitizeIcon', () => {
  it('allows image data URLs and plain https image URLs; nothing else', () => {
    expect(sanitizeIcon('data:image/png;base64,iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=')
    // A token's https icon (shown in an <img> only, without a referrer).
    expect(sanitizeIcon('https://assets.example/token/icon.png')).toBe('https://assets.example/token/icon.png')
    expect(sanitizeIcon('http://assets.example/icon.png')).toBeNull()
    expect(sanitizeIcon('https://x.example/a b.png')).toBeNull()
    expect(sanitizeIcon('https://x.example/"onerror=x.png')).toBeNull()
    expect(sanitizeIcon(`https://x.example/${'a'.repeat(2_100)}.png`)).toBeNull()
    expect(sanitizeIcon('javascript:alert(1)')).toBeNull()
    expect(sanitizeIcon('data:text/html;base64,PHNjcmlwdD4=')).toBeNull()
    expect(sanitizeIcon(`data:image/svg+xml,${'a'.repeat(70_000)}`)).toBeNull()
    expect(sanitizeIcon(null)).toBeNull()
  })
})

describe('parseU128', () => {
  it('reads only canonical unsigned integer strings', () => {
    expect(parseU128('0')).toBe(0n)
    expect(parseU128('340282366920938463463374607431768211455')).toBe(2n ** 128n - 1n)
    expect(() => parseU128('340282366920938463463374607431768211456')).toThrow()
    expect(() => parseU128('-1')).toThrow()
    expect(() => parseU128('1e5')).toThrow()
    expect(() => parseU128(5 as unknown as string)).toThrow()
  })
})

describe('token reader', () => {
  it('reads metadata once and serves it from cache', async () => {
    const rpc = rpcWith({ ft_metadata: () => meta })
    const reader = createTokenReader(rpc, { network: 'testnet', persist: false })
    expect((await reader.metadata('usdc.testnet')).symbol).toBe('USDC')
    expect((await reader.metadata('usdc.testnet')).decimals).toBe(6)
    expect(rpc.calls).toEqual(['usdc.testnet.ft_metadata'])
  })

  it('reads decimals from chain again when a plan asks for a fresh read', async () => {
    const rpc = rpcWith({ ft_metadata: () => meta })
    const reader = createTokenReader(rpc, { network: 'testnet', persist: false })
    await reader.metadata('usdc.testnet')
    await reader.metadata('usdc.testnet', { fresh: true })
    expect(rpc.calls).toEqual(['usdc.testnet.ft_metadata', 'usdc.testnet.ft_metadata'])
  })

  it('ignores a stored entry dated in the future (it could never expire)', async () => {
    const store = new Map<string, string>([['nearkit:testnet:ftmeta:usdc.testnet', JSON.stringify({ at: Date.now() + 10 ** 12, value: { ...meta, decimals: 24 } })]])
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) })
    try {
      const rpc = rpcWith({ ft_metadata: () => meta })
      const reader = createTokenReader(rpc, { network: 'testnet', persist: true })
      expect((await reader.metadata('usdc.testnet')).decimals).toBe(6)
      expect(rpc.calls).toEqual(['usdc.testnet.ft_metadata'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('turns a broken contract into an INVALID_TOKEN error without affecting others', async () => {
    const rpc = rpcWith({ 'good.testnet.ft_metadata': () => meta, 'bad.testnet.ft_metadata': () => ({ nonsense: true }) })
    const reader = createTokenReader(rpc, { network: 'testnet', persist: false })
    await expect(reader.metadata('bad.testnet')).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
    await expect(reader.metadata('nothing.testnet')).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
    expect((await reader.metadata('good.testnet')).symbol).toBe('USDC')
  })

  it('reads balances and supply as exact bigints', async () => {
    const rpc = rpcWith({ ft_balance_of: (a) => (a.account_id === 'alice.testnet' ? '1234567890123456789012345' : '0'), ft_total_supply: () => '1000000000000000' })
    const reader = createTokenReader(rpc, { network: 'testnet', persist: false })
    expect(await reader.balanceOf('t.testnet', 'alice.testnet')).toBe(1234567890123456789012345n)
    expect(await reader.balanceOf('t.testnet', 'bob.testnet')).toBe(0n)
    expect(await reader.totalSupply('t.testnet')).toBe(1_000_000_000_000_000n)
  })
})

describe('NEP-145 storage', () => {
  it('reads registration per account: registered, unregistered or not checkable', async () => {
    const rpc = rpcWith({ storage_balance_of: (a) => (a.account_id === 'reg.testnet' ? { total: '1250000000000000000000', available: '0' } : null) })
    const status = await storageStatus(rpc, 'usdc.testnet', ['reg.testnet', 'new.testnet'])
    expect(status.get('reg.testnet')).toBe(true)
    expect(status.get('new.testnet')).toBe(false)
    const none = await storageStatus(rpcWith({}), 'legacy.testnet', ['x.testnet'])
    expect(none.get('x.testnet')).toBeNull()
  })

  it('reads the minimum deposit from the contract instead of assuming 0.00125 NEAR', async () => {
    expect(await storageBoundsMin(rpcWith({ storage_balance_bounds: () => ({ min: '2350000000000000000000', max: null }) }), 't.testnet')).toBe(2_350_000_000_000_000_000_000n)
    expect(await storageBoundsMin(rpcWith({}), 'legacy.testnet')).toBeNull()
    await expect(storageBoundsMin(rpcWith({ storage_balance_bounds: () => ({ min: 'lots' }) }), 'weird.testnet')).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
  })
})
