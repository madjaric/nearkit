import { SOCIAL } from '@/config/social'
import { NEARKIT_FEE_LABEL, NEARKIT_FEE_RECEIVED_LABEL, RHEA_APP_FEE_SHARE_LABEL } from '@/lib/fees'
import type { ServerConfig } from '../config'
import { bold, code, esc, shortAccount } from '../telegram/html'

/** Copy the bot reuses. Short and plain; every figure comes from NearKit's own config. */

export const SAFETY = '🔒 NEARKITS never asks for your seed phrase or private key, here or anywhere.'

export function networkNote(config: Pick<ServerConfig, 'network'>): string {
  return config.network.id === 'testnet' ? '🧪 Testnet beta: tokens have no real value.' : 'NEAR mainnet.'
}

/** The /start header: who is trading, with what, on which network. */
export function welcome(config: Pick<ServerConfig, 'network'>, wallet: { accountId: string; near: string | null; nearkit?: boolean } | null): string {
  const who = wallet ? (wallet.nearkit ? `NEARKITS wallet ${esc(shortAccount(wallet.accountId))}` : code(wallet.accountId)) : null
  return [
    `${bold('NEARKITS')} · NEAR trading toolkit`,
    wallet ? `👛 ${who}${wallet.near !== null ? ` · ${esc(wallet.near)} NEAR` : ''}` : '👛 No wallet linked yet',
    ...(config.network.id === 'testnet' ? [esc(networkNote(config))] : []),
  ].join('\n')
}

/**
 * The first screen for someone with no NearKit wallet yet, where one can be made right away: what
 * NEARKITS is, then the three steps (create a wallet, fund it, trade), then where $KITS and the
 * community are. Creating comes first; linking is optional. `bridge`: the Bridge to NEAR runs here.
 */
export function noWalletYet(config: Pick<ServerConfig, 'network'>, linked: { accountId: string; near: string | null } | null, options: { bridge?: boolean } = {}): string {
  return [
    `👜 ${bold('No NEARKITS wallet yet')}`,
    ...(linked ? [`🔗 Linked wallet ${code(linked.accountId)}${linked.near !== null ? ` · ${esc(linked.near)} NEAR` : ''}`] : []),
    '',
    'NEARKITS is a NEAR trading toolkit, right here in Telegram.',
    `1. ${bold('Create a wallet')}: one tap, below.`,
    options.bridge ? `2. ${bold('Fund it')}: send NEAR to it, or bring SOL, ETH or BNB with 🌉 Bridge to NEAR.` : `2. ${bold('Fund it')}: send NEAR to its address.`,
    `3. ${bold('Trade')}: buy and sell NEAR tokens from the menu.`,
    '',
    '🪙 $KITS is the NEARKITS token; 👥 Community has the Telegram group and X. Both are in the menu.',
    '🔒 NEARKITS never asks for your seed phrase or private key.',
    ...(config.network.id === 'testnet' ? [esc(networkNote(config))] : []),
  ].join('\n')
}

export function feeNote(config: Pick<ServerConfig, 'network'>): string {
  return config.network.id === 'mainnet'
    ? `NEARKITS fee ${NEARKIT_FEE_LABEL} per swap, taken once: through Rhea’s aggregator inside the swap (NEARKITS keeps ${NEARKIT_FEE_RECEIVED_LABEL}, Rhea ${RHEA_APP_FEE_SHARE_LABEL}, plus Rhea’s own fee), or all ${NEARKIT_FEE_LABEL} to NEARKITS with the swap on a route straight to a DCL pool. Pool fees and gas are separate; each quote shows them.`
    : 'No NEARKITS fee on testnet.'
}

export function help(config: Pick<ServerConfig, 'network'>, commands: { name: string; description: string; usage?: string; section: string }[]): string {
  const order = ['Trading', 'Portfolio', 'Account', 'Groups', 'General']
  const sections = order
    .map((section) => {
      const list = commands.filter((c) => c.section === section)
      if (!list.length) return null
      return [bold(section), ...list.map((c) => `/${c.name}${c.usage ? ` ${esc(c.usage)}` : ''} · ${esc(c.description)}`)].join('\n')
    })
    .filter((s): s is string => s !== null)
  return [
    bold('NEARKITS · help'),
    '',
    sections.join('\n\n'),
    '',
    esc(feeNote(config)),
    'Paste a token’s contract ID on its own to buy it.',
    `👥 Community: ${esc(SOCIAL.telegram.url)} · X: ${esc(SOCIAL.x.url)}`,
    'Trades from your NEARKITS wallet run right here when you confirm. Trades from a linked wallet are signed in your own wallet.',
    SAFETY,
  ].join('\n')
}
