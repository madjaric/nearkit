import { NEARKIT_FEE_LABEL, NEARKIT_FEE_RECEIVED_LABEL } from '@/lib/fees'
import type { ServerConfig } from '../config'
import { bold, code, esc, shortAccount } from '../telegram/html'

/** Copy the bot reuses. Short and plain; every figure comes from NearKit's own config. */

export const SAFETY = '🔒 NearKit never asks for your seed phrase or private key, here or anywhere.'

export function networkNote(config: Pick<ServerConfig, 'network'>): string {
  return config.network.id === 'testnet' ? '🧪 Testnet beta: tokens have no real value.' : 'NEAR mainnet.'
}

/** The /start header: who is trading, with what, on which network. */
export function welcome(config: Pick<ServerConfig, 'network'>, wallet: { accountId: string; near: string | null; nearkit?: boolean } | null): string {
  const who = wallet ? (wallet.nearkit ? `NearKit wallet ${code(shortAccount(wallet.accountId))}` : code(wallet.accountId)) : null
  return [
    `${bold('NearKit')} · NEAR trading`,
    wallet ? `👛 ${who}${wallet.near !== null ? ` · ${esc(wallet.near)} NEAR` : ''}` : '👛 No wallet linked yet',
    ...(config.network.id === 'testnet' ? [esc(networkNote(config))] : []),
  ].join('\n')
}

export function feeNote(config: Pick<ServerConfig, 'network'>): string {
  return config.network.id === 'mainnet'
    ? `NearKit fee ${NEARKIT_FEE_LABEL} per swap (NearKit keeps ${NEARKIT_FEE_RECEIVED_LABEL}, Rhea the rest), plus Rhea’s own fee and gas.`
    : 'No NearKit fee on testnet.'
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
    bold('NearKit · help'),
    '',
    sections.join('\n\n'),
    '',
    esc(feeNote(config)),
    'Trades from your NearKit wallet run right here when you confirm. Trades from a linked wallet are signed in your own wallet.',
    SAFETY,
  ].join('\n')
}
