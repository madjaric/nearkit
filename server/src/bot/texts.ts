import { NEARKIT_FEE_LABEL, NEARKIT_FEE_RECEIVED_LABEL } from '@/lib/fees'
import type { ServerConfig } from '../config'
import { bold, esc, link } from '../telegram/html'

/** Copy the bot reuses. Plain words; every figure it quotes comes from NearKit's own config. */

export const SAFETY = '🔒 NearKit never asks for your seed phrase, recovery phrase or private key, here or anywhere. Anyone who does is trying to rob you.'

export function networkNote(config: Pick<ServerConfig, 'network'>): string {
  return config.network.id === 'testnet' ? 'Testnet beta: accounts end in .testnet and tokens have no real value.' : 'NEAR mainnet.'
}

export function welcome(config: Pick<ServerConfig, 'network' | 'webUrl'>, name: string): string {
  return [
    `${bold(`Welcome to NearKit, ${name}`)}`,
    '',
    'Trade NEAR tokens and follow your positions from Telegram:',
    '• Link your NEAR wallet. You sign in your own wallet; NearKit never holds keys.',
    '• Buy and sell through Rhea with the same quotes and checks as the web app.',
    '• Positions and PnL from your on-chain history.',
    '• Buy alerts for your token’s group: add me to the group and send /buybot.',
    '',
    esc(networkNote(config)),
    '',
    SAFETY,
    '',
    `Web app: ${link(config.webUrl, config.webUrl.replace(/^https?:\/\//, ''))}`,
  ].join('\n')
}

export function help(config: Pick<ServerConfig, 'network'>, commands: { name: string; description: string; usage?: string; section: string }[]): string {
  const fee =
    config.network.id === 'mainnet'
      ? `Swaps carry the NearKit fee of ${NEARKIT_FEE_LABEL} (NearKit keeps ${NEARKIT_FEE_RECEIVED_LABEL}, Rhea the rest) plus Rhea’s own fee. Every quote shows them.`
      : 'On testnet no NearKit fee is charged.'
  const order = ['Account', 'Trading', 'Portfolio', 'Groups', 'General']
  const sections = order
    .map((section) => {
      const list = commands.filter((c) => c.section === section)
      if (!list.length) return null
      return [bold(section), ...list.map((c) => `/${c.name}${c.usage ? ` ${esc(c.usage)}` : ''}: ${esc(c.description)}`)].join('\n')
    })
    .filter((s): s is string => s !== null)
  return [
    bold('NearKit bot'),
    '',
    sections.join('\n\n'),
    '',
    esc(fee),
    'Trades are prepared here and signed in your own wallet in the NearKit web app, after one more review.',
    '',
    SAFETY,
  ].join('\n')
}
