import { describe, expect, it } from 'vitest'
import { BRIDGE_CHAINS, bridgeChain } from '@/config/bridge'
import { KITS_CONTRACT } from '@/config/kit'
import { BRIDGE_FEE_BPS, BRIDGE_FEE_LABEL, NEARKIT_FEE_BPS } from '@/lib/fees'
import { isEvmAddress, isEvmTxHash, isSolanaAddress, isSolanaSignature, isSourceTxHash, sourceAddressError } from './addresses'
import { bpsOf, bpsPct, bridgeAppFeeRequestBps, feeSplitOf } from './fee'
import { bridgeHeadline, bridgeSteps } from './progress'
import type { BridgeOrderView } from './types'

/** Bridge & Buy's shared rules: the fee, the chains, the addresses, and how an order reads. */

describe('the bridge fee: one value, NEARKITS’ 0.25%, separate from the 0.50% trading fee', () => {
  it('is 25 bps, shown as 0.25%, and never the trading fee', () => {
    expect(BRIDGE_FEE_BPS).toBe(25)
    expect(BRIDGE_FEE_LABEL).toBe('0.25%')
    expect(NEARKIT_FEE_BPS).toBe(50)
  })

  it('asks 1Click for twice NEARKITS’ share (it keeps half of an app fee, at least 0.20%)', () => {
    expect(bridgeAppFeeRequestBps()).toBe(50)
    expect(bridgeAppFeeRequestBps(20)).toBe(40)
    expect(() => bridgeAppFeeRequestBps(0)).toThrow()
    expect(() => bridgeAppFeeRequestBps(2.5)).toThrow()
  })

  it('reads the split from 1Click’s echo: NEARKITS’ recipient is NEARKITS’, the rest NEAR Intents’', () => {
    expect(
      feeSplitOf(
        [
          { recipient: 'nearkitfee.near', fee: 25 },
          { recipient: '5880ad', fee: 25 },
        ],
        'nearkitfee.near',
      ),
    ).toEqual({ nearkitsBps: 25, intentsBps: 25, totalBps: 50 })
    expect(
      feeSplitOf(
        [
          { recipient: 'nearkitfee.near', fee: 13 },
          { recipient: '5880ad', fee: 20 },
        ],
        'nearkitfee.near',
      ),
    ).toEqual({ nearkitsBps: 13, intentsBps: 20, totalBps: 33 })
    expect(feeSplitOf(undefined, 'nearkitfee.near')).toEqual({ nearkitsBps: 0, intentsBps: 0, totalBps: 0 })
    expect(feeSplitOf([{ recipient: 'nearkitfee.near', fee: '25' }], 'nearkitfee.near')).toBeNull()
    expect(feeSplitOf({}, 'nearkitfee.near')).toBeNull()
  })

  it('is an input-side share, rounded down: 0.25% of 1 SOL is 0.0025 SOL', () => {
    expect(bpsOf(1_000_000_000n, 25)).toBe(2_500_000n)
    expect(bpsOf(3n, 25)).toBe(0n)
    expect(bpsPct(25)).toBe('0.25%')
  })
})

describe('the source chains: Solana, Ethereum and BNB Chain, each with its native coin', () => {
  it('is exactly three, with 1Click’s asset ids and decimals', () => {
    expect(BRIDGE_CHAINS.map((c) => [c.id, c.symbol, c.assetId, c.decimals])).toEqual([
      ['sol', 'SOL', 'nep141:sol.omft.near', 9],
      ['eth', 'ETH', 'nep141:eth.omft.near', 18],
      ['bsc', 'BNB', 'nep245:v2_1.omni.hot.tg:56_11111111111111111111', 18],
    ])
    expect(BRIDGE_CHAINS.filter((c) => c.family === 'evm').map((c) => c.evmChainId)).toEqual([1, 56])
    expect(bridgeChain('base')).toBeNull()
    expect(bridgeChain('hood')).toBeNull()
  })

  it('the destination is the one $KITS contract', () => {
    expect(KITS_CONTRACT).toBe('kits.nearlytrade.near')
  })
})

describe('addresses and transaction hashes on the source chains', () => {
  const sol = 'FDHEVP16btz5HCjFjMkQWzwGDqYpMpgDk6i7taVdK442'
  it('Solana: 32-byte base58 addresses, 64-byte base58 signatures', () => {
    expect(isSolanaAddress(sol)).toBe(true)
    expect(isSolanaAddress('0x' + 'a'.repeat(40))).toBe(false)
    expect(isSolanaAddress('FDHEVP16btz5HCjFjMkQWzwGDqYpMpgDk6i7taVdK44l')).toBe(false)
    expect(isSolanaSignature('0' + '1'.repeat(87))).toBe(false)
    expect(isSolanaSignature(sol)).toBe(false)
  })

  it('EVM: 0x and 40 hex for an address, 64 for a transaction', () => {
    expect(isEvmAddress('0xdb0f8971f948f7e14f7bfb12c1b870388a4cf12a')).toBe(true)
    expect(isEvmAddress('0xdb0f8971f948f7e14f7bfb12c1b870388a4cf12')).toBe(false)
    expect(isEvmTxHash('0x' + 'ab'.repeat(32))).toBe(true)
    expect(isEvmTxHash('0x' + 'ab'.repeat(20))).toBe(false)
  })

  it('checks an address against its chain, in words', () => {
    const sola = bridgeChain('sol')!
    const eth = bridgeChain('eth')!
    expect(sourceAddressError(sola, sol)).toBeNull()
    expect(sourceAddressError(eth, sol)).toMatch(/Ethereum address/)
    expect(sourceAddressError(sola, ' ')).toMatch(/Enter your Solana address/)
    expect(isSourceTxHash(eth, '0x' + '1'.repeat(64))).toBe(true)
    expect(isSourceTxHash(sola, '0x' + '1'.repeat(64))).toBe(false)
  })
})

describe('how an order reads: two stages, a step done only on what was seen', () => {
  const order = (status: BridgeOrderView['status'], kind: 'nearkits' | 'connected' = 'nearkits') =>
    ({ status, chain: 'sol', depositTx: null, destination: { kind, accountId: 'a.near', walletId: null, name: null } }) as Pick<
      BridgeOrderView,
      'status' | 'chain' | 'depositTx' | 'destination'
    >
  const states = (o: ReturnType<typeof order>, signing = false) => bridgeSteps(o, signing).map((s) => `${s.key}:${s.state}`)

  it('walks source transfer → NEAR Intents → NEAR received → buy $KITS → complete', () => {
    expect(states(order('awaiting-deposit'))).toEqual(['source:todo', 'bridge:todo', 'near:todo', 'kits:todo', 'complete:todo'])
    expect(states(order('awaiting-deposit'), true)).toEqual(['source:active', 'bridge:todo', 'near:todo', 'kits:todo', 'complete:todo'])
    expect(states(order('bridging'))).toEqual(['source:done', 'bridge:active', 'near:todo', 'kits:todo', 'complete:todo'])
    expect(states(order('delivered'))).toEqual(['source:done', 'bridge:done', 'near:active', 'kits:todo', 'complete:todo'])
    expect(states(order('buying'))).toEqual(['source:done', 'bridge:done', 'near:done', 'kits:active', 'complete:todo'])
    expect(states(order('complete'))).toEqual(['source:done', 'bridge:done', 'near:done', 'kits:done', 'complete:done'])
  })

  it('marks where it stopped: a refund at the bridge, a purchase that didn’t happen at the purchase', () => {
    expect(states(order('refunded'))).toContain('bridge:error')
    expect(states(order('buy-needed'))).toEqual(['source:done', 'bridge:done', 'near:done', 'kits:error', 'complete:todo'])
    expect(states(order('expired'))[0]).toBe('source:error')
  })

  it('never says complete before $KITS arrived', () => {
    for (const s of ['awaiting-deposit', 'deposit-seen', 'bridging', 'delivered', 'buying', 'buy-needed', 'refunded', 'failed', 'expired'] as const)
      expect(bridgeHeadline(order(s))).not.toMatch(/purchase complete/i)
    expect(bridgeHeadline(order('complete'))).toBe('$KITS purchase complete')
    expect(bridgeHeadline(order('buy-needed'))).toBe('Bridge completed, $KITS not bought')
    expect(bridgeHeadline(order('delivered', 'connected'))).toBe('NEAR arrived: buy $KITS')
  })
})
