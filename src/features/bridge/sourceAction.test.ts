import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { bridgeChain, type BridgeChain } from '@/config/bridge'
import { sourceActionState } from './sourceAction'
import { SourceAction } from './SourceFields'
import type { SourceSide } from './useSourceSide'

/**
 * The sending wallet, right above Bridge to NEAR (the Telegram Mini App's report of 2026-10-12: a
 * quote, a disabled Bridge to NEAR and "Connect your Solana wallet", with nothing to press). The page
 * connects only wallets that register themselves on it (the Wallet Standard; EIP-6963 for EVM), and
 * Telegram's in-app browser has none: there it says so and takes the address to send from instead.
 */

const SOL = bridgeChain('sol') as BridgeChain
const ETH = bridgeChain('eth') as BridgeChain
const ADDRESS = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const wallet = (name: string) => ({ family: 'solana', wallet: { id: name, name, icon: null, wallet: {} } })

function side(
  o: {
    wallets?: unknown[]
    connection?: { name: string; address: string } | null
    error?: string | null
    manual?: boolean
    manualAddress?: string
    manualError?: string | null
  } = {},
) {
  const manualAddress = o.manualAddress ?? ''
  return {
    source: {
      wallets: o.wallets ?? [],
      connection: o.connection ? { family: 'solana', walletId: o.connection.name, ...o.connection } : null,
      error: o.error ?? null,
      busy: false,
      connect: () => undefined,
      disconnect: () => undefined,
    },
    manual: o.manual ?? false,
    setManual: () => undefined,
    manualAddress,
    setManualAddress: () => undefined,
    manualError: o.manualError ?? null,
    sourceAddress: o.connection?.address ?? (o.manual && manualAddress && !o.manualError ? manualAddress : null),
  } as unknown as SourceSide
}

const render = (s: SourceSide, { inTelegram = true, chain = SOL }: { inTelegram?: boolean; chain?: BridgeChain } = {}) =>
  renderToStaticMarkup(createElement(SourceAction, { chain, side: s, inTelegram }))
const read = (html: string) =>
  html
    .replace(/<\/?span[^>]*>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, '’')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
/** The text of every button, as a screen reader names it. */
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => read(m[1] as string))

describe('which state the sending wallet is in', () => {
  it('no wallet on the page; wallets to connect; one connected; an address typed in', () => {
    expect(sourceActionState(side())).toEqual({ kind: 'none' })
    expect(sourceActionState(side({ wallets: [wallet('Phantom'), wallet('Solflare')] }))).toEqual({ kind: 'connect', wallets: 2 })
    expect(sourceActionState(side({ wallets: [wallet('Phantom')], connection: { name: 'Phantom', address: ADDRESS } }))).toEqual({
      kind: 'connected',
      name: 'Phantom',
      address: ADDRESS,
    })
    expect(sourceActionState(side({ manual: true }))).toEqual({ kind: 'address' })
  })
})

describe('the sending wallet, above Bridge to NEAR', () => {
  it('disconnected, with a wallet this page can reach: a Connect Solana Wallet key that says which wallet opens and that connecting sends nothing', () => {
    const html = render(side({ wallets: [wallet('Phantom')] }))
    expect(buttons(html)[0]).toBe('Connect Solana Wallet')
    const text = read(html)
    expect(text).toContain('Opens Phantom to approve the connection.')
    expect(text).toContain('It shares your address only: nothing is sent, and no deposit address is made until you start the bridge.')
    expect(text).not.toContain('No Solana wallet')
    expect(buttons(html)).toContain('Send from another wallet instead')
  })

  it('disconnected, with several wallets: one Connect Solana Wallet key that opens the choice', () => {
    const html = render(side({ wallets: [wallet('Phantom'), wallet('Solflare')] }))
    expect(buttons(html)[0]).toBe('Connect Solana Wallet')
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>.*?Connect Solana Wallet/)
    expect(read(html)).toContain('Choose Phantom or Solflare.')
  })

  it('a connection the wallet rejected: said plainly, and Connect Solana Wallet stays to try again', () => {
    const html = render(side({ wallets: [wallet('Phantom')], error: 'You declined in your wallet.' }))
    expect(html).toMatch(/role="alert"[^>]*>You declined in your wallet\./)
    expect(buttons(html)[0]).toBe('Connect Solana Wallet')
  })

  it('Telegram’s browser with no wallet on the page: no dead Connect key; it says why and offers the address to send from, or the bot’s Send manually', () => {
    const html = render(side())
    const text = read(html)
    expect(buttons(html)).not.toContain('Connect Solana Wallet')
    expect(text).toContain('No Solana wallet in Telegram')
    expect(text).toContain('Telegram’s in-app browser has no Solana wallet this page can connect to')
    expect(text).toContain('Phantom, Solflare and Backpack connect only from a browser or app where they’re installed.')
    expect(buttons(html)[0]).toBe('Enter my Solana address')
    expect(text).toContain('✍️ Send manually')
  })

  it('a browser with no wallet (not Telegram): the same way forward, without Telegram’s wording', () => {
    const text = read(render(side(), { inTelegram: false }))
    expect(text).toContain('No Solana wallet in this browser')
    expect(text).not.toContain('Telegram')
  })

  it('connected: the wallet and its address, shortened (in full on hover), and Disconnect; no Connect key', () => {
    const html = render(side({ wallets: [wallet('Phantom')], connection: { name: 'Phantom', address: ADDRESS } }))
    const text = read(html)
    expect(text).toContain('Sending from Phantom')
    expect(text).toContain('7xKXtg…gAsU')
    expect(html).toContain(`title="${ADDRESS}"`)
    expect(buttons(html)).toEqual(['Disconnect'])
  })

  it('the address to send from: its field, what happens next, and the way back to a wallet when there is one', () => {
    const html = render(side({ wallets: [wallet('Phantom')], manual: true, manualAddress: ADDRESS }))
    const text = read(html)
    expect(text).toContain('Your Solana address')
    expect(text).toContain('Bridge to NEAR shows the deposit address to send exactly the amount to, from this address.')
    expect(buttons(html)).toContain('Connect a wallet instead')
    // With no wallet on the page there is nothing to go back to.
    expect(buttons(render(side({ manual: true })))).not.toContain('Connect a wallet instead')
  })

  it('Ethereum and BNB Chain name their own network and EVM wallets', () => {
    expect(buttons(render(side({ wallets: [wallet('E2E EVM')] }), { chain: ETH }))[0]).toBe('Connect Ethereum Wallet')
    expect(read(render(side(), { chain: ETH }))).toContain('MetaMask, Rabby and other EVM wallets connect only from a browser or app where they’re installed.')
  })
})
