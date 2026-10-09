import { KIT_POOL_FEE_NOTE, KIT_TAX_NOTE, KITS_CONTRACT } from '@/config/kit'
import { SOCIAL } from '@/config/social'
import { formatUnits } from '@/lib/amounts'
import { explorerTokenUrl } from '@/services/near/explorer'
import { NEAR_DECIMALS, NETWORKS } from '@/config/networks'
import { bold, code, esc } from '../telegram/html'
import { btn, copyBtn, documented, keyboard, urlBtn, type BotCtx, type BotModule } from './context'
import { marketLines, MARKET_WAIT_MS, within } from './trade'
import { tradingWallet } from './tradingWallet'
import { linkedAccount } from './wallet'

/**
 * $KITS (Near Kits), the NEARKITS token, and NEARKITS' community, in the bot. $KITS' screen shows
 * only what is read live or fixed by its launch: the contract, the market (as /token reads it), the
 * Buyback & Burn and holder rewards NEARKITS' server reads from chain (as the $KITS page shows them),
 * and the launch's tax rules. A figure that can't be read says so; nothing is cached into a claim.
 * Buy opens the ordinary buy flow; Bridge & Buy is NEARKITS web's.
 */

const CALLBACK_TTL_MS = 30 * 60_000
const KITS_DECIMALS = 18
const menuRow = [btn('« Menu', 'menu:home')]

/** "1,234,567 KITS (0.12% of the launch supply)", from the burn tracker's own figures. */
function burnedLine(burned: bigint, launchSupply: bigint): string {
  const share = launchSupply > 0n ? Number((burned * 1_000_000n) / launchSupply) / 10_000 : null
  return `🔥 Burned: ${bold(`${formatUnits(burned, KITS_DECIMALS, { maxFraction: 0, group: true })} KITS`)}${share !== null ? ` (${share.toFixed(2)}% of the launch supply)` : ''}`
}

export async function kitsScreen(ctx: BotCtx) {
  const { deps } = ctx
  const live = deps.config.network.kitsContract === KITS_CONTRACT
  const web = deps.config.webUrl
  const head = [`🪙 ${bold('$KITS · Near Kits')}`, 'The NEARKITS token, on NEAR mainnet (launched on Nearly).', code(KITS_CONTRACT)]
  if (!live) {
    return ctx.show(
      [...head, '', `$KITS trades on NEAR mainnet. This NEARKITS bot runs on NEAR ${esc(deps.config.network.label)}, where it doesn’t exist.`].join('\n'),
      keyboard([copyBtn('📋 Copy CA', KITS_CONTRACT), urlBtn('🌐 $KITS page', `${web}/kit`)], menuRow),
    )
  }
  const [market, burns, rewards] = await Promise.all([
    within(deps.near.tokens.getMarketData(KITS_CONTRACT), MARKET_WAIT_MS),
    deps.kits?.burns ? within(deps.kits.burns.view(), MARKET_WAIT_MS).catch(() => null) : Promise.resolve(null),
    deps.kits?.rewards ? within(deps.kits.rewards.view(), MARKET_WAIT_MS).catch(() => null) : Promise.resolve(null),
  ])
  const lines = [
    ...head,
    '',
    ...marketLines(market),
    burns ? burnedLine(BigInt(burns.burnedTotal), BigInt(burns.launchSupply)) : '🔥 Burned: unavailable right now',
    rewards
      ? `🎁 Paid to holders: ${bold(`${formatUnits(BigInt(rewards.paid), NEAR_DECIMALS, { maxFraction: 2, group: true })} NEAR`)} · ${esc(formatUnits(BigInt(rewards.waiting), NEAR_DECIMALS, { maxFraction: 2, group: true }))} NEAR waiting`
      : '🎁 Holder rewards: unavailable right now',
    '',
    `Tokenomics: ${esc(KIT_TAX_NOTE)} ${esc(KIT_POOL_FEE_NOTE)}`,
  ]
  // Buy opens the ordinary buy flow on $KITS, from the wallet the user trades from (as /token's Buy).
  const nearkit = await tradingWallet(deps, ctx.user.id)
  const account = nearkit?.accountId ?? (await linkedAccount(ctx))
  const buy = account
    ? await deps.store.putCallback({ side: 'buy', account, token: KITS_CONTRACT, native: nearkit !== null, walletId: nearkit?.id ?? '' }, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)
    : null
  await ctx.show(
    lines.join('\n'),
    keyboard(
      [buy ? btn('🟢 Buy $KITS', `tr:start:${buy}`) : null, urlBtn('🌉 Bridge & Buy $KITS', `${web}/bridge`)],
      [urlBtn('🌐 $KITS page', `${web}/kit`), copyBtn('📋 Copy CA', KITS_CONTRACT)],
      [urlBtn('🔗 Explorer', explorerTokenUrl(NETWORKS.mainnet, KITS_CONTRACT))],
      menuRow,
    ),
  )
}

export async function communityScreen(ctx: BotCtx) {
  await ctx.show(
    [
      `👥 ${bold('NEARKITS community')}`,
      'NEARKITS is a NEAR trading toolkit: trade from Telegram or the web, bring SOL, ETH or BNB to NEAR, and follow $KITS.',
      '',
      `Talk with other users in the ${bold('NEARKITS Community')} on Telegram, and follow ${bold(SOCIAL.x.handle)} on X for updates.`,
    ].join('\n'),
    keyboard([urlBtn('💬 Telegram community', SOCIAL.telegram.url)], [urlBtn('𝕏 Follow on X', SOCIAL.x.url)], [urlBtn('🌐 nearkits.com', ctx.deps.config.webUrl)], menuRow),
  )
}

export function kitsModule(): BotModule {
  return {
    commands: {
      kits: { ...documented('kits'), run: (ctx) => kitsScreen(ctx) },
      community: { ...documented('community'), run: (ctx) => communityScreen(ctx) },
    },
    callbacks: {
      kit: async (ctx, action) => {
        await ctx.answer()
        if (action === 'community') return communityScreen(ctx)
        return kitsScreen(ctx)
      },
    },
  }
}
