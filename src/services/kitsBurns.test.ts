import { describe, expect, it } from 'vitest'
import { fetchKitsBurns, parseKitsBurnView, type KitsBurnView } from './kitsBurns'

/** The $KITS page shows burn figures only from a reply about kits.nearlytrade.near on mainnet whose numbers hold together. */

const VIEW: KitsBurnView = {
  network: 'mainnet',
  token: 'kits.nearlytrade.near',
  launchpad: 'nearlytrade.near',
  launchId: '2699',
  decimals: 18,
  launchSupply: '1000000000000000000000000000',
  supply: '996766484385607587716865419',
  burnedTotal: '3233515614392412283134581',
  burnedByTax: '3233515614392412283134581',
  burns: [{ tx: '8SzmYJDy4fnKkrZmuYPYkBtzPBZYrFt9frofsWVDjcg6', at: 1791418038627, amount: '78155059288019410500855', kind: 'tax' }],
  burnCount: 6,
  historyComplete: true,
  readAt: 1791421447361,
  historyReadAt: 1791421446913,
}

describe('the burn data the $KITS page accepts', () => {
  it('is $KITS on mainnet, as the server read it', () => {
    expect(parseKitsBurnView(VIEW)).toEqual(VIEW)
    expect(parseKitsBurnView({ ...VIEW, burns: [], burnCount: 0, historyComplete: false, historyReadAt: null })).toMatchObject({ burns: [], historyReadAt: null })
  })

  it('refuses another network, another token or a source other than Nearly’s launchpad', () => {
    expect(() => parseKitsBurnView({ ...VIEW, network: 'testnet' })).toThrow(/mainnet/)
    expect(() => parseKitsBurnView({ ...VIEW, token: 'kits.fake.near' })).toThrow(/kits\.nearlytrade\.near/)
    expect(() => parseKitsBurnView({ ...VIEW, launchpad: 'someone.near' })).toThrow(/nearlytrade\.near/)
  })

  it('refuses figures that aren’t whole numbers or don’t hold together', () => {
    expect(() => parseKitsBurnView({ ...VIEW, burnedTotal: '3.2e24' })).toThrow(/whole number/)
    expect(() => parseKitsBurnView({ ...VIEW, burnedTotal: '1' })).toThrow(/supply burned/)
    expect(() => parseKitsBurnView({ ...VIEW, burnedByTax: '4000000000000000000000000' })).toThrow(/tax burned more/)
    expect(() => parseKitsBurnView({ ...VIEW, supply: '2000000000000000000000000000', burnedTotal: '0' })).toThrow(/above the launch supply/)
  })

  it('refuses a burn without a real transaction hash, time or amount', () => {
    const burn = VIEW.burns[0]
    expect(() => parseKitsBurnView({ ...VIEW, burns: [{ ...burn, tx: 'not-a-hash' }] })).toThrow(/hash/)
    expect(() => parseKitsBurnView({ ...VIEW, burns: [{ ...burn, kind: 'buyback' }] })).toThrow(/kind/)
    expect(() => parseKitsBurnView({ ...VIEW, burns: [{ ...burn, amount: '-5' }] })).toThrow(/whole number/)
    expect(() => parseKitsBurnView({ ...VIEW, burns: [{ ...burn, at: 0 }] })).toThrow(/time/)
  })

  it('is asked of NEARKITS’ server, with nothing to choose: no token, no account', async () => {
    const asked: { url: string; body: unknown }[] = []
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      asked.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify(VIEW), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    expect(await fetchKitsBurns('https://api.example', fetchImpl)).toEqual(VIEW)
    expect(asked).toEqual([{ url: 'https://api.example/api/kits/burns', body: {} }])
  })
})
