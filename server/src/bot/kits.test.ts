import { describe, expect, it } from 'vitest'
import { KITS_CONTRACT } from '@/config/kit'
import { NETWORKS } from '@/config/networks'
import { SOCIAL } from '@/config/social'
import type { MarketFigure, TokenMarket } from '@/types/domain'
import type { KitsBurnTracker } from '../kits/burns'
import type { KitsRewardsTracker } from '../kits/rewards'
import type { InlineKeyboard } from '../telegram/types'
import type { BotCtx } from './context'
import { kitsScreen } from './kits'
import { ALICE } from './testing'
import { walletBot } from './walletTesting'

/**
 * $KITS and the community in the bot. $KITS' screen shows its one contract with a copy key, the market
 * as /token reads it, the Buyback & Burn and holder rewards NEARKITS' server reads from chain, and the
 * launch's tax rules; anything that can't be read says so, and nothing else is claimed. Where $KITS
 * doesn't exist (testnet) it says where it trades. The Community screen links the two official accounts.
 */

const known = (value: number): MarketFigure => ({ state: 'known', value, source: 'test', at: 1 })
const none: MarketFigure = { state: 'unavailable', reason: 'no source' }
const MARKET = {
  tokenId: KITS_CONTRACT,
  priceUsd: known(0.0012),
  priceNear: none,
  change24hPct: known(3.5),
  marketCapUsd: none,
  fdvUsd: known(1_200_000),
  liquidityUsd: known(80_000),
  volume24hUsd: none,
  supply: { circulating: null, total: null, source: null },
  pair: null,
  updatedAt: 1,
} as unknown as TokenMarket

/** The $KITS screen on mainnet, with the trackers and market given (or failing). */
async function mainnetScreen(o: { market?: TokenMarket | 'fail'; burns?: 'fail'; rewards?: 'fail'; linked?: string | null } = {}) {
  const shown: { text: string; markup?: InlineKeyboard }[] = []
  const burns = {
    view: async () => {
      if (o.burns === 'fail') throw new Error('NearBlocks answered 500')
      return { burnedTotal: (1_000n * 10n ** 18n).toString(), launchSupply: (1_000_000n * 10n ** 18n).toString() }
    },
  } as unknown as KitsBurnTracker
  const rewards = {
    view: async () => {
      if (o.rewards === 'fail') throw new Error('RPC down')
      return { paid: (125n * 10n ** 22n).toString(), waiting: (5n * 10n ** 22n).toString() }
    },
  } as unknown as KitsRewardsTracker
  const ctx = {
    user: ALICE,
    chat: { id: ALICE.id, type: 'private' },
    deps: {
      config: { network: NETWORKS.mainnet, webUrl: 'https://nearkits.com' },
      near: {
        tokens: {
          getMarketData: async () => {
            if (o.market === 'fail') throw new Error('no market')
            return o.market ?? MARKET
          },
        },
      },
      kits: { burns, rewards },
      custody: null,
      store: {
        linksOf: async () => (o.linked ? [{ accountId: o.linked }] : []),
        getSettings: async () => ({ defaultAccount: null }),
        putCallback: async () => 'cb-kits-1',
      },
    },
    show: async (text: string, markup?: InlineKeyboard) => void shown.push({ text, markup }),
  } as unknown as BotCtx
  await kitsScreen(ctx)
  const last = shown.at(-1) as { text: string; markup?: InlineKeyboard }
  return { text: last.text, buttons: last.markup?.inline_keyboard.flat() ?? [] }
}

describe('$KITS in the bot', () => {
  it('shows the one contract with a copy key, the live market, burns and holder rewards read from chain, and the launch’s tax rules', async () => {
    const { text, buttons } = await mainnetScreen({ linked: 'alice.near' })
    expect(text).toContain(`<code>${KITS_CONTRACT}</code>`)
    expect(text).toMatch(/FDV <b>\$1\.2\d?M<\/b>/)
    expect(text).toMatch(/Price <b>\$0\.0012/)
    expect(text).toContain('🔥 Burned: <b>1,000 KITS</b> (0.10% of the launch supply)')
    expect(text).toContain('🎁 Paid to holders: <b>1.25 NEAR</b> · 0.05 NEAR waiting')
    expect(text).toMatch(/2% tax applies to buys and sells\. Tax revenue is split 50\/50 between Buyback &amp; Burn and Holder rewards\./)
    expect(buttons.find((b) => b.copy_text)?.copy_text?.text).toBe(KITS_CONTRACT)
    expect(buttons.find((b) => b.text.includes('Buy $KITS') && !b.text.includes('Bridge'))?.callback_data).toBe('tr:start:cb-kits-1')
    expect(buttons.find((b) => b.text.includes('Bridge & Buy'))?.url).toBe('https://nearkits.com/bridge')
    expect(buttons.find((b) => b.text.includes('$KITS page'))?.url).toBe('https://nearkits.com/kit')
  })

  it('a figure that can’t be read says so: never a stale or made-up number', async () => {
    const { text, buttons } = await mainnetScreen({ market: 'fail', burns: 'fail', rewards: 'fail' })
    expect(text).toContain('Market data didn’t load')
    expect(text).toContain('🔥 Burned: unavailable right now')
    expect(text).toContain('🎁 Holder rewards: unavailable right now')
    expect(text).not.toMatch(/\$\d/)
    // No wallet to trade from: no Buy button, Bridge & Buy still offered.
    expect(buttons.some((b) => b.callback_data?.startsWith('tr:start:'))).toBe(false)
    expect(buttons.some((b) => b.text.includes('Bridge & Buy'))).toBe(true)
  })

  it('on testnet, where $KITS doesn’t exist, it says where it trades and offers nothing to trade', async () => {
    const h = await walletBot()
    await h.say('/kits')
    expect(h.last()?.text).toMatch(/\$KITS trades on NEAR mainnet/)
    expect(h.buttons().find((b) => b.copy)?.copy).toBe(KITS_CONTRACT)
    expect(h.buttons().some((b) => b.data?.startsWith('tr:'))).toBe(false)
  })

  it('the main menu has $KITS and Community, and no Bridge where the bridge doesn’t run', async () => {
    const h = await walletBot()
    await h.say('/start')
    const data = h.buttons().map((b) => b.data)
    expect(data).toEqual(expect.arrayContaining(['kit:show', 'kit:community', 'menu:help']))
    expect(data).not.toContain('brg:home')
    await h.press('kit:show')
    expect(h.last()?.text).toMatch(/\$KITS · Near Kits/)
  })
})

describe('the community', () => {
  it('links the NEARKITS Community on Telegram and NEARKITS on X, the official two, and the website', async () => {
    const h = await walletBot()
    await h.say('/community')
    expect(h.last()?.text).toMatch(/NEARKITS community/)
    expect(h.last()?.text).toContain('@Near_Kits')
    const urls = h.buttons().map((b) => b.url)
    expect(urls).toEqual(expect.arrayContaining([SOCIAL.telegram.url, SOCIAL.x.url]))
    expect(SOCIAL.telegram.url).toBe('https://t.me/NearKitsCommunity')
    expect(SOCIAL.x.url).toBe('https://x.com/Near_Kits')
    await h.press('kit:community')
    expect(h.buttons().map((b) => b.url)).toEqual(expect.arrayContaining([SOCIAL.telegram.url, SOCIAL.x.url]))
  })

  it('help points to the community, and community links never ride along on other screens', async () => {
    const h = await walletBot()
    await h.say('/help')
    expect(h.last()?.text).toContain('https://t.me/NearKitsCommunity')
    await h.say('/cancel')
    expect(h.last()?.text).not.toContain('NearKitsCommunity')
  })
})
