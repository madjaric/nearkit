import { describe, expect, it } from 'vitest'
import { base58Decode, base58Encode, base64Decode, base64Encode } from '@/lib/encoding'
import { nep413Digest } from '@/services/near/nep413'
import { recoveryRoutes } from '../api/recoveryRoutes'
import type { RecoveryDescription } from '../custody/recovery'
import type { Db } from '../db/sqlite'
import type { Logger } from '../log'
import { exportedText } from './recovery'
import { LINKED, ONE, walletBot } from './walletTesting'

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const json = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) =>
    typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? hex(x) : x instanceof Error ? `${x.name}: ${x.message}\n${x.stack ?? ''}` : x,
  )
/** Every row of every table, as text. */
const dump = (db: Db) => json(db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => [t.name, db.all(`SELECT * FROM "${t.name}"`)]))

describe('the NearKit wallet key over a whole lifecycle', () => {
  it('reaches neither Telegram, the logs nor the database in plain form; only the one export response carries it', async () => {
    const logs: unknown[] = []
    const capture = (level: string) => (msg: string, fields?: Record<string, unknown>) => void logs.push({ level, msg, fields })
    const log: Logger = { debug: capture('debug'), info: capture('info'), warn: capture('warn'), error: capture('error') }
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
    const ownerKey = `ed25519:${base58Encode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))}`
    const h = await walletBot({ linkedKey: ownerKey, log })

    await h.funded(3n * ONE)
    // A minute between steps, as a person would take (the bot rate-limits bursts).
    h.advance(60_000)
    await h.say('/buy')
    await h.say('USDT')
    await h.press(h.button('0.1 NEAR'))
    await h.press(h.button('Confirm buy'))
    expect(h.last()?.text).toContain('Buy confirmed')
    h.advance(60_000)
    await h.press('cw:wd')
    await h.press(h.button('NEAR ·'))
    await h.say('0.5')
    await h.press(h.button('(linked)'))
    await h.press(h.button('Confirm withdraw'))
    expect(h.last()?.text).toContain('Withdrawal confirmed')
    // The paths that log: a refused revoke (no backup key yet) and a send the RPC times out on.
    h.advance(60_000)
    await h.press('cr:revoke')
    await h.press(h.button('Remove NearKit’s key'))
    expect(h.last()?.text).toContain('Add your backup key first')
    h.advance(60_000)
    h.chain.onSend('timeout')
    await h.press('cw:wd')
    await h.press(h.button('NEAR ·'))
    await h.say('0.1')
    await h.press(h.button('(linked)'))
    await h.press(h.button('Confirm withdraw'))
    h.chain.onSend('apply')
    expect(h.last()?.text).toContain('Withdrawal confirmed')
    h.advance(60_000)
    await h.press('cr:show')
    await h.press(h.button('Add backup key'))
    await h.press(h.button('Add backup key'))
    expect(h.last()?.text).toContain('Backup key added')

    // The export happens in the web app; Telegram only hears that it happened.
    h.advance(60_000)
    await h.press('cr:export')
    const code = (h.buttons().find((b) => b.url)?.url ?? '').split('#recover=')[1] as string
    const routes = recoveryRoutes({ recovery: h.custody.recovery, onExported: async (r) => void (await h.app.notify(r.userId, exportedText(r.wallet, r.signedBy))) })
    const d = (await routes['/api/recovery/describe']?.({ code }, {} as never)) as RecoveryDescription
    const digest = await nep413Digest({ message: d.message, nonce: base64Decode(d.nonce) as Uint8Array, recipient: d.recipient })
    const signature = base64Encode(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, digest)))
    const out = (await routes['/api/recovery/export']?.({ code, accountId: LINKED, publicKey: ownerKey, signature }, {} as never)) as { secretKey: string }
    const heldDb = dump(h.db)

    h.advance(60_000)
    await h.press('cr:show')
    await h.press(h.button('Remove NearKit’s access'))
    await h.press(h.button('Remove NearKit’s key'))
    expect(h.last()?.text).toContain('NearKit’s key was removed')

    const raw = base58Decode(out.secretKey.slice('ed25519:'.length)) as Uint8Array
    const seed = raw.subarray(0, 32)
    const forms = [out.secretKey.slice(8), base58Encode(seed), hex(seed), hex(raw), base64Encode(seed), base64Encode(raw), Buffer.from(seed).toString('base64url')]
    // The scan does see the key where it is allowed: the export response.
    expect(json(out)).toContain(forms[0])
    const telegram = json(h.fake.calls)
    expect(telegram).toContain('was just exported in NearKit web')
    expect(json(logs)).toContain('intent refused before signing')
    expect(json(logs)).toContain('send unclear')
    const places = { telegram, logs: json(logs), heldDb, finalDb: dump(h.db), describe: json(d) }
    for (const [place, text] of Object.entries(places)) for (const form of forms) expect(text.includes(form), `${place} holds the key`).toBe(false)
  })
})
