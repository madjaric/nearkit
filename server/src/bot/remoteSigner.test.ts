import { afterEach, describe, expect, it } from 'vitest'
import { base58Decode, base58Encode } from '@/lib/encoding'
import type { TradingWallet } from '../custody/store'
import { ownerKeypair } from '../signer/testing'
import { ALICE } from './testing'
import { LINKED, ONE, walletBot } from './walletTesting'

/**
 * The production topology: the bot and the separate signer service, over signed HTTP,
 * each with its own database. The app never holds a key: it only asks.
 */

let stops: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const s of stops) await s()
  stops = []
})

async function bot() {
  const owner = await ownerKeypair()
  const h = await walletBot({ linkedKey: owner.publicKey, remoteSigner: true })
  stops.push(h.stopSigner)
  return { h, owner }
}

describe('NEARKITS wallets with the separate signer service', { timeout: 60_000 }, () => {
  it('creates, withdraws, approves and exports through the signer; the app’s database never holds a key', async () => {
    const { h, owner } = await bot()
    const w = (await h.funded(3n * ONE)) as TradingWallet
    // The key lives in the signer's database, not the app's.
    expect(await h.signerVault?.key('testnet', w.accountId)).toMatchObject({ status: 'active', ownerAccount: LINKED })
    const tables =
      h.db.dialect === 'postgres'
        ? await h.db.all("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'signer_%'")
        : await h.db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'signer_%'")
    expect(tables).toEqual([])
    expect(JSON.stringify(await h.db.all('SELECT * FROM trading_wallets'))).not.toContain('"ct"')

    await h.press('cw:wd')
    await h.press(h.button('NEAR ·'))
    await h.say('1')
    await h.press(h.button('(linked)'))
    await h.press(h.button('Confirm withdraw'))
    expect(h.last()?.text).toContain('Withdrawal confirmed')

    h.advance(60_000)
    await h.approve(w.accountId, 'bob.testnet', owner)
    await h.press('cw:wd')
    await h.press(h.button('NEAR ·'))
    await h.say('0.5')
    await h.say('bob.testnet')
    await h.press(h.button('Confirm withdraw'))
    expect(h.last()?.text).toContain('Withdrawal confirmed')
    expect(h.chain.accounts.get('bob.testnet')?.amount).toBe(ONE + ONE / 2n)

    const secret = await h.exportViaWeb(w.accountId, owner, 'telegram')
    const raw = base58Decode(secret.slice('ed25519:'.length)) as Uint8Array
    expect(`ed25519:${base58Encode(raw.subarray(32))}`).toBe(w.publicKey)
    expect(ALICE.id).toBeGreaterThan(0)
  })

  it('a paused signer stops every wallet action, and Telegram says so plainly', async () => {
    const { h } = await bot()
    await h.funded(3n * ONE)
    await h.custody.signer.pause('incident drill')
    await h.press('cw:wd')
    await h.press(h.button('NEAR ·'))
    await h.say('1')
    await h.press(h.button('(linked)'))
    await h.press(h.button('Confirm withdraw'))
    expect(h.last()?.text).toContain('signer is paused')
    expect(h.chain.sent).toHaveLength(0)
    // Only the operator resumes (on the signer's host).
    await h.signerCore?.setPaused(false, 'drill over')
    h.advance(60_000)
    await h.press('cw:wd')
    await h.press(h.button('NEAR ·'))
    await h.say('1')
    await h.press(h.button('(linked)'))
    await h.press(h.button('Confirm withdraw'))
    expect(h.last()?.text).toContain('Withdrawal confirmed')
  })
})
