import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { base58Decode, base58Encode } from '@/lib/encoding'
import { recoveryRoutes } from '../api/recoveryRoutes'
import type { TradingWallet } from '../custody/store'
import { openDatabase } from '../db/open'
import { migrate } from '../db/schema'
import { Store } from '../db/store'
import { runOpsAdmin } from '../ops/admin'
import type { ChallengeView } from '../signer/core'
import { exportAsOwner, ownerKeypair } from '../signer/testing'
import { ONE, USDT, walletBot } from './walletTesting'

async function bot() {
  const owner = await ownerKeypair()
  const h = await walletBot({ linkedKey: owner.publicKey })
  const w = (await h.funded(5n * ONE)) as TradingWallet
  return { h, w, owner }
}

const withdrawToOwner = async (h: Awaited<ReturnType<typeof bot>>['h']) => {
  h.advance(60_000)
  await h.press('cw:wd')
  await h.press(h.button('NEAR ·'))
  await h.say('1')
  await h.press(h.button('(linked)'))
  await h.press(h.button('Confirm withdraw'))
}

describe('kill switches', () => {
  it('trading paused: no quote and no Confirm goes through; withdrawals still work', async () => {
    const { h } = await bot()
    // A quote made before the pause…
    await h.say('/buy')
    await h.say('USDT')
    await h.press(h.button('0.1 NEAR'))
    const confirm = h.button('Confirm buy')
    expect(confirm).toBeTruthy()
    await h.custody.ops.set('trading', true, 'incident', 'test')
    // …is refused at Confirm, before anything is planned or signed.
    await h.press(confirm)
    expect(h.last()?.text).toContain('Trading from NearKit wallets is paused')
    expect(h.chain.sent).toHaveLength(0)
    // New quotes are refused too.
    h.advance(60_000)
    await h.say('/buy')
    await h.say('USDT')
    await h.press(h.button('0.1 NEAR'))
    expect(h.last()?.text).toContain('Trading from NearKit wallets is paused')
    // Withdrawing to the owner still works.
    await withdrawToOwner(h)
    expect(h.last()?.text).toContain('Withdrawal confirmed')
    await h.custody.ops.set('trading', false, 'over', 'test')
    h.advance(60_000)
    await h.say('/buy')
    await h.say('USDT')
    await h.press(h.button('0.1 NEAR'))
    await h.press(h.button('Confirm buy'))
    expect(h.last()?.text).toContain('Buy confirmed')
    expect(h.chain.tokens.get(USDT)).toBeTruthy()
  })

  it('withdrawals paused: nothing leaves, but the owner can still export the key', async () => {
    const { h, w, owner } = await bot()
    await h.custody.ops.set('withdrawals', true, 'incident', 'test')
    h.advance(60_000)
    await h.press('cw:wd')
    expect(h.last()?.text).toContain('Withdrawals are paused')
    expect(h.chain.sent).toHaveLength(0)
    const routes = recoveryRoutes({ recovery: h.custody.recovery, onExported: async () => undefined, onDestinationApproved: async () => undefined })
    const secret = await exportAsOwner(
      {
        challenge: async (req) => (await routes['/api/recovery/challenge']?.(req, {} as never)) as ChallengeView,
        exportKey: async (p) => (await routes['/api/recovery/export']?.(p, {} as never)) as { sealed: unknown },
      },
      w.accountId,
      owner,
    )
    expect(`ed25519:${base58Encode((base58Decode(secret.slice(8)) as Uint8Array).subarray(32))}`).toBe(w.publicKey)
    expect((await h.custody.store.auditOf(w.id)).map((a) => a.action)).toContain('key-exported')
  })

  it('a frozen wallet neither trades nor withdraws; its backup key still goes on; other wallets are unaffected', async () => {
    const { h, w } = await bot()
    await h.custody.store.setFrozen(w.id, 'suspicious activity')
    h.advance(60_000)
    await h.press('cw:wd')
    expect(h.last()?.text).toContain('frozen by NearKit')
    h.advance(60_000)
    await h.say('/buy')
    await h.say('USDT')
    await h.press(h.button('0.1 NEAR'))
    expect(h.last()?.text).toContain('frozen by NearKit')
    // The backup key hands control to the owner: still allowed.
    h.advance(60_000)
    await h.press(`cr:show:${w.id}`)
    await h.press(h.button('Add backup key'))
    await h.press(h.button('Add backup key'))
    expect(h.last()?.text).toContain('Backup key added')
    // Another wallet of the same user works.
    h.advance(60_000)
    await h.press('cw:list')
    await h.press(h.button('New wallet'))
    const other = (await h.wallet()) as TradingWallet
    h.chain.fund(other.accountId, 3n * ONE)
    await withdrawToOwner(h)
    expect(h.last()?.text).toContain('Withdrawal confirmed')
    expect(h.chain.sent.every((s) => s.tx.signerId === other.accountId || s.tx.actions.some((a) => a.type === 'AddKey'))).toBe(true)
  })

  it('switches that can’t be read count as paused (fail closed)', async () => {
    const { h } = await bot()
    await h.db.exec('DROP TABLE ops_switches')
    h.advance(60_000)
    await h.press('cw:wd')
    expect(h.last()?.text).toContain('can’t confirm that this is allowed')
    expect(h.chain.sent).toHaveLength(0)
  })

  it('the host can hold a switch paused from its environment (no shell needed); the database can’t lift it', async () => {
    const owner = await ownerKeypair()
    const h = await walletBot({ linkedKey: owner.publicKey, env: { NEARKIT_OPS_PAUSED: 'trading' } })
    await h.funded(5n * ONE)
    await h.custody.ops.set('trading', false, 'trying to lift it', 'test')
    expect((await h.custody.ops.state()).trading).toMatchObject({ paused: true, reason: expect.stringContaining('NEARKIT_OPS_PAUSED') })
    await h.say('/buy')
    await h.say('USDT')
    await h.press(h.button('0.1 NEAR'))
    expect(h.last()?.text).toContain('Trading from NearKit wallets is paused')
    expect(h.chain.sent).toHaveLength(0)
    // Only trading: withdrawing to the owner still works.
    await withdrawToOwner(h)
    expect(h.last()?.text).toContain('Withdrawal confirmed')
  })

  it('the operator’s command line: status, pause, resume, freeze, events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nearkit-ops-'))
    try {
      const path = join(dir, 'app.sqlite')
      const db = await openDatabase({ kind: 'sqlite', path })
      await migrate(db)
      await new Store(db).upsertUser({ userId: 1, username: null, firstName: 'U', languageCode: null })
      await db.run(
        "INSERT INTO trading_wallets (id, user_id, network, account_id, public_key, key_ref, status, slot, created_at, updated_at) VALUES ('w1', 1, 'testnet', 'acc.testnet', 'ed25519:K', 'r', 'active', 1, 1, 1)",
      )
      await db.close()
      const out: string[] = []
      const env = { NEAR_NETWORK: 'testnet', NEARKIT_DB_PATH: path, NEARKIT_WALLET_KEK: Buffer.alloc(32, 3).toString('base64') }
      const run = (argv: string[]) => runOpsAdmin(argv, env, (l) => void out.push(l))
      expect(await run(['pause', 'trading', 'incident', 'drill'])).toBe(0)
      expect(await run(['freeze', 'acc.testnet', 'drill'])).toBe(0)
      expect(await run(['signer-pause', 'drill'])).toBe(0)
      out.length = 0
      expect(await run(['status'])).toBe(0)
      expect(out).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^trading: PAUSED since .* \(incident drill\)$/),
          'withdrawals: running',
          'frozen wallets: 1',
          '  w1 acc.testnet (drill)',
          'signer (in this process): paused true',
        ]),
      )
      expect(await run(['resume', 'trading', 'drill over'])).toBe(0)
      expect(await run(['unfreeze', 'w1', 'drill over'])).toBe(0)
      out.length = 0
      expect(await run(['events', '10'])).toBe(0)
      expect(out.map((l) => l.split(' ')[1])).toEqual(['ops-paused', 'wallet-frozen', 'ops-signer-paused', 'ops-resumed', 'wallet-unfrozen'])
      expect(await run(['pause', 'everything', 'x'])).toBe(2)
      expect(await run(['freeze', 'nobody.testnet', 'x'])).toBe(1)
      // A switch the host holds paused stays paused, and the command line says why.
      const held = (argv: string[]) => runOpsAdmin(argv, { ...env, NEARKIT_OPS_PAUSED: 'withdrawals' }, (l) => void out.push(l))
      out.length = 0
      expect(await held(['status'])).toBe(0)
      expect(out).toContain('withdrawals: PAUSED on the host (NEARKIT_OPS_PAUSED)')
      out.length = 0
      expect(await held(['resume', 'withdrawals', 'try'])).toBe(1)
      expect(out.join(' ')).toContain('NEARKIT_OPS_PAUSED')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
