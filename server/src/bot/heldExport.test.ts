import { describe, expect, it } from 'vitest'
import { base58Decode, base58Encode } from '@/lib/encoding'
import { createExportKeyPair, openExport, type SealedExport } from '@/lib/exportCrypto'
import { ownerSign } from '../signer/testing'
import type { TgUser } from '../telegram/types'
import { exportLink, setup, status, webApi, type Harness } from './recoveryTesting'
import { ALICE } from './testing'
import { LINKED, ONE } from './walletTesting'

/**
 * AUTH-05 through NEARKITS' app and bot: a key export the owner wallet signs is held, its wallet's
 * Telegram account is told at once (Release it now, Cancel), and the API releases nothing before the
 * hold is over or Telegram released it. (Its own file: each test's bot keeps its database until the
 * file ends, so this keeps the recovery tests' memory where it was.)
 */

const MALLORY_TG: TgUser = { id: 666, is_bot: false, first_name: 'Mallory', username: 'mallory' }

describe('export: held, announced in Telegram, released there or after the hold (AUTH-05)', () => {
  /** The owner's browser asks and the owner wallet signs, through NEARKITS web's API. */
  async function requested(o: { notices?: unknown[] } = {}) {
    const { h, linked } = await setup()
    const w = await h.funded(ONE)
    // From Telegram's Export button to the web page for this wallet.
    expect(await exportLink(h)).toBe(w.accountId)
    const api = webApi(h, o.notices)
    const browser = await createExportKeyPair()
    const c = await api.challenge({ kind: 'export', accountId: w.accountId, recipientKey: browser.publicKey })
    const held = await api.requestExport({ challengeId: c.id, publicKey: linked.publicKey, signature: await ownerSign(c, linked.pair) })
    return { h, w, api, browser, c, held, linked }
  }
  const notice = (h: Harness) => [...h.fake.messages()].reverse().find((m) => m.text.includes('Key export requested'))
  const fingerprintOf = (text: string) => /Browser key: ([0-9a-f ]{19})/.exec(text)?.[1]
  const opened = (r: Awaited<ReturnType<typeof requested>>, sealed: SealedExport) =>
    openExport(r.browser.privateKey, sealed, { challengeId: r.c.id, network: 'testnet', accountId: r.w.accountId })

  it('a signed export is held and the wallet’s Telegram account is told at once, with Release it now and Cancel; nothing is released yet', async () => {
    const notices: unknown[] = []
    const r = await requested({ notices })
    expect(r.held).toMatchObject({ exportId: r.c.id, accountId: r.w.accountId, ownerAccount: LINKED, status: 'held', browserKey: fingerprintOf(r.c.message) })
    expect(r.held.releaseAt - r.h.deps.now()).toBeGreaterThanOrEqual(24 * 60 * 60_000)
    // What the browser sees carries neither the Telegram account nor the Mini App's parameter.
    expect(Object.keys(r.held)).not.toContain('digest')
    expect(Object.keys(r.held)).not.toContain('userId')
    const n = notice(r.h)
    expect(n?.chatId).toBe(ALICE.id)
    expect(n?.text).toContain(`Your owner wallet <code>${LINKED}</code> signed a request in NEARKITS web`)
    expect(n?.text).toContain(`<code>${r.held.browserKey}</code>`)
    expect(n?.text).toContain('The key itself never comes to Telegram.')
    const release = n?.buttons.find((b) => b.text.includes('Release it now'))?.url ?? ''
    // The Mini App link names exactly this export: its start parameter is the signer's digest of it.
    expect(release).toBe(`https://t.me/${r.h.deps.me.username}?startapp=${(await r.h.custody.recovery.exportStatus({ exportId: r.held.exportId }))?.digest}`)
    expect(n?.buttons.find((b) => b.text.includes('Cancel export'))?.data).toBe(`cr:xcancel:${r.held.exportId}`)
    expect(notices).toEqual([{ kind: 'export-requested', userId: ALICE.id, accountId: r.w.accountId, owner: LINKED, browserKey: r.held.browserKey }])
    // Held: the browser gets nothing yet.
    expect(await status(r.api.collect(r.held.exportId))).toBe(425)
    expect((await r.api.status(r.held.exportId)).status).toBe('held')
    expect((await r.h.custody.store.auditOf(r.w.id)).map((a) => a.action)).toEqual(expect.arrayContaining(['key-export-requested', 'key-export-notified']))
  })

  it('normal confirmed export: Alice releases it in the Mini App, the browser collects it at once, and Telegram hears of both; the key never reaches Telegram', async () => {
    const notices: unknown[] = []
    const r = await requested({ notices })
    await r.h.approveInTelegram()
    expect(r.h.last()?.text).toContain('You released the key export of your NEARKITS wallet')
    expect((await r.api.status(r.held.exportId)).status).toBe('ready')
    const out = await r.api.collect(r.held.exportId)
    expect(out.released).toBe('telegram')
    const secret = await opened(r, out.sealed)
    const raw = base58Decode(secret.slice('ed25519:'.length)) as Uint8Array
    expect(`ed25519:${base58Encode(raw.subarray(32))}`).toBe(r.w.publicKey)
    expect(r.h.last()?.text).toContain('was exported to the browser with the key')
    expect(notices.at(-1)).toMatchObject({ kind: 'exported', released: 'telegram' })
    // Once only.
    expect(await status(r.api.collect(r.held.exportId))).toBe(409)
    // Nothing in Telegram, the audit log or the API's answers holds the key.
    const audit = await r.h.custody.store.auditOf(r.w.id)
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['key-export-requested', 'key-export-notified', 'key-export-released', 'key-exported']))
    for (const place of [JSON.stringify(r.h.fake.calls), JSON.stringify(audit), JSON.stringify(out)]) expect(place).not.toContain(secret.slice(8))
  })

  it('without Telegram: once the hold is over, the browser that asked collects it', async () => {
    const r = await requested()
    r.h.advance(r.held.releaseAt - r.h.deps.now() - 1)
    expect(await status(r.api.collect(r.held.exportId))).toBe(425)
    r.h.advance(1)
    const out = await r.api.collect(r.held.exportId)
    expect(out.released).toBe('hold')
    expect(await opened(r, out.sealed)).toMatch(/^ed25519:/)
  })

  it('❌ Cancel export in the chat: only the wallet’s own Telegram account can, and then nothing is released, ever', async () => {
    const r = await requested()
    const cancel = `cr:xcancel:${r.held.exportId}`
    // Another Telegram account pressing the same button (a forwarded message, a guessed ID): refused.
    await r.h.say('/start', MALLORY_TG)
    await r.h.press(cancel, MALLORY_TG)
    expect(r.h.last()?.text).toContain('Only the Telegram account of this NEARKITS wallet can cancel its export')
    expect((await r.api.status(r.held.exportId)).status).toBe('held')
    // Alice cancels.
    await r.h.press(cancel)
    expect(r.h.last()?.text).toContain('Export cancelled')
    expect(r.h.last()?.text).toContain('Nothing was released, and nothing will be')
    expect((await r.api.status(r.held.exportId)).status).toBe('cancelled')
    // Not after the hold, and not by a release in the Mini App afterwards.
    r.h.advance(r.held.releaseAt - r.h.deps.now() + 60_000)
    expect(await status(r.api.collect(r.held.exportId))).toBe(410)
    await expect(r.h.approveInTelegram()).rejects.toMatchObject({ code: 'cancelled' })
    expect((await r.h.custody.store.auditOf(r.w.id)).map((a) => a.action)).toContain('key-export-cancelled')
  })

  it('the page that asked can cancel it too, and Telegram hears of it', async () => {
    const r = await requested()
    expect((await r.api.cancel(r.held.exportId)).status).toBe('cancelled')
    expect(r.h.last()?.text).toContain('was cancelled in NEARKITS web. Nothing was released.')
    r.h.advance(r.held.releaseAt - r.h.deps.now())
    expect(await status(r.api.collect(r.held.exportId))).toBe(410)
  })

  it('if the wallet’s Telegram account can’t be told (it blocked the bot), the export is cancelled and nothing is released', async () => {
    const { h, linked } = await setup()
    const w = await h.funded(ONE)
    const api = webApi(h)
    await h.store.markBlocked(ALICE.id)
    const browser = await createExportKeyPair()
    const c = await api.challenge({ kind: 'export', accountId: w.accountId, recipientKey: browser.publicKey })
    const refused = await api.requestExport({ challengeId: c.id, publicKey: linked.publicKey, signature: await ownerSign(c, linked.pair) }).catch((e: unknown) => e)
    expect(refused).toMatchObject({ status: 503, code: 'telegram' })
    expect(await h.custody.recovery.exportStatus({ accountId: w.accountId })).toBeNull()
    expect((await h.custody.recovery.exportStatus({ exportId: c.id }))?.status).toBe('cancelled')
    h.advance(25 * 60 * 60_000)
    // The API releases nothing Telegram wasn't told of, and the signer itself holds it cancelled.
    expect(await status(api.collect(c.id))).toBe(403)
    await expect(h.custody.signer.collectExport(c.id)).rejects.toMatchObject({ problem: 'cancelled' })
  })

  it('nothing is released through the API for an export Telegram wasn’t told of, even once its hold is over', async () => {
    const { h, linked } = await setup()
    const w = await h.funded(ONE)
    const api = webApi(h)
    const browser = await createExportKeyPair()
    const c = await api.challenge({ kind: 'export', accountId: w.accountId, recipientKey: browser.publicKey })
    // The signer held it, but the notice step never happened (a crash between the two, say).
    const { held } = await h.custody.recovery.requestExport({ challengeId: c.id, publicKey: linked.publicKey, signature: await ownerSign(c, linked.pair) })
    h.advance(held.releaseAt - h.deps.now())
    expect(await status(api.collect(held.exportId))).toBe(403)
  })

  it('the Recovery screen shows an open export with Release it now and Cancel', async () => {
    const r = await requested()
    await r.h.press('cr:show')
    expect(r.h.last()?.text).toContain('An export is open')
    expect(r.h.last()?.text).toContain(r.held.browserKey)
    expect(r.h.buttons().find((b) => b.text.includes('Release it now'))?.url).toMatch(/startapp=/)
    await r.h.press(r.h.button('Cancel export'))
    expect(r.h.last()?.text).toContain('Export cancelled')
    await r.h.press('cr:show')
    expect(r.h.last()?.text).not.toContain('An export is open')
  })
})
