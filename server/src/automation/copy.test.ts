import { describe, expect, it } from 'vitest'
import { NETWORKS } from '@/config/networks'
import type { CopyConfig } from '@/lib/automation/config'
import { fromFastnear } from '@/services/near/flows'
import aggBuy from '@/services/near/fixtures/flows/aggregator-buy-with-rhea.fastnear.json'
import aggSell from '@/services/near/fixtures/flows/aggregator-sell.fastnear.json'
import directBuy from '@/services/near/fixtures/flows/direct-buy-wrap-dcl.fastnear.json'
import directSell from '@/services/near/fixtures/flows/direct-sell-dcl.fastnear.json'
import tax from '@/services/near/fixtures/flows/launchpad-tax.fastnear.json'
import storage from '@/services/near/fixtures/flows/storage-deposit.fastnear.json'
import swapUsdt from '@/services/near/fixtures/flows/testone-swap1-near-to-usdt.fastnear.json'
import swapUsdc from '@/services/near/fixtures/flows/testone-swap2-near-to-usdc.fastnear.json'
import registration from '@/services/near/fixtures/flows/testone-usdc-registration.fastnear.json'
import { copyBuySize, readCopyTrade } from './copy'

/**
 * Copy Trade's reading of real mainnet transactions (the repo's recorded fixtures): only NEAR swaps the
 * followed account started, through an exchange NEARKITS routes through, are copyable.
 */

const read = (fixture: unknown, account: string) => readCopyTrade(fromFastnear(fixture), account, NETWORKS.mainnet)
const SING = 'singularty.nearlytrade.near'

describe('which transactions Copy Trade copies', () => {
  it('a direct DCL buy and sell: the token, the side and both amounts', () => {
    expect(read(directBuy, 'mort1705.tg')).toEqual({ ok: true, side: 'buy', token: SING, tokenRaw: 69099416000669574619652n, nearRaw: 10n ** 24n })
    expect(read(directSell, 'iwillwin.user.intear.near')).toMatchObject({ ok: true, side: 'sell', token: SING })
  })

  it('NEAR to a token through Rhea’s aggregator (multi-hop): the token that arrived, the NEAR that left', () => {
    expect(read(swapUsdt, 'testone.near')).toMatchObject({ ok: true, side: 'buy', token: 'usdt.tether-token.near', tokenRaw: 883420n })
    expect(read(swapUsdc, 'testone.near')).toMatchObject({ ok: true, side: 'buy', token: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1' })
  })

  it('never copies a token-for-token swap, a refunded swap, a registration, a storage deposit or a launchpad’s own transfer', () => {
    // RHEA for SINGULARTY: no NEAR side to copy.
    expect(read(aggBuy, 'alijay3637.tg')).toEqual({ ok: false, reason: 'More than one token moved: not a NEAR swap' })
    expect(read(aggSell, 'pulamica.near')).toEqual({ ok: false, reason: 'No token traded' })
    expect(read(registration, 'testone.near')).toMatchObject({ ok: false })
    expect(read(storage, 'xhung1984.near')).toMatchObject({ ok: false })
    expect(read(tax, 'nearlytrade.near')).toMatchObject({ ok: false, reason: expect.stringMatching(/no NEAR received/) })
  })

  it('only the account that started the transaction is copied: an account merely touched by it is not', () => {
    expect(read(directBuy, 'someone-else.near')).toEqual({ ok: false, reason: 'Not started by the followed account' })
  })

  it('a buy that never touched an exchange NEARKITS routes through is not copied (another network’s exchanges)', () => {
    expect(
      readCopyTrade(fromFastnear(directBuy), 'mort1705.tg', {
        ...NETWORKS.mainnet,
        rhea: { ...NETWORKS.mainnet.rhea, aggregator: null, classic: { ...NETWORKS.mainnet.rhea.classic, exchange: 'x.near' } },
        dex: { dcl: { contract: 'y.near' } },
      }),
    ).toEqual({
      ok: false,
      reason: 'Not through an exchange NEARKITS routes through',
    })
  })
})

describe('how much a copied buy spends', () => {
  const rule = (patch: Partial<CopyConfig> = {}): CopyConfig => ({
    target: 'whale.near',
    copy: 'both',
    sizing: { mode: 'fixed', amountNear: 1 },
    maxTradeNear: 2,
    minTradeNear: null,
    maxExposureNear: 5,
    slippagePct: 1,
    minLiquidityUsd: null,
    exclude: [],
    ...patch,
  })
  it('a fixed size, never above the maximum trade', () => {
    expect(copyBuySize(rule(), 100, 0)).toEqual({ near: 1 })
    expect(copyBuySize(rule({ sizing: { mode: 'fixed', amountNear: 3 } }), 100, 0)).toEqual({ near: 2 })
  })
  it('a share of what the followed account spent', () => {
    expect(copyBuySize(rule({ sizing: { mode: 'percent', pct: 10 } }), 8, 0)).toEqual({ near: 0.8 })
  })
  it('never past the exposure limit: shrunk to the room left, skipped when there is none', () => {
    expect(copyBuySize(rule(), 100, 4.5)).toEqual({ near: 0.5 })
    expect(copyBuySize(rule(), 100, 5)).toEqual({ skip: 'The rule’s exposure limit (5 NEAR) is reached' })
  })
  it('skipped below the minimum trade', () => {
    expect(copyBuySize(rule({ minTradeNear: 1.5 }), 100, 0)).toEqual({ skip: 'Below the minimum trade (1.5 NEAR)' })
    expect(copyBuySize(rule({ sizing: { mode: 'percent', pct: 1 } }), 1, 0)).toMatchObject({ skip: expect.stringMatching(/minimum/) })
  })
})
