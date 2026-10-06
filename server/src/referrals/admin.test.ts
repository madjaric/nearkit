import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NETWORKS } from '@/config/networks'
import { RpcError, type RpcClient, type RpcTxResult } from '@/services/near/rpc'
import { openDatabase } from '../db/open'
import { migrate } from '../db/schema'
import { Store } from '../db/store'
import { runReferralsAdmin } from './admin'
import { createReferrals } from './service'

const USDT = 'usdt.itachicara.testnet'

function payout(receiver: string, to: string, amount: string, ok = true): RpcTxResult {
  return {
    status: ok ? { SuccessValue: '' } : { Failure: {} },
    transaction: {
      hash: 'h',
      signer_id: 'fees.testnet',
      receiver_id: receiver,
      actions: [{ FunctionCall: { method_name: 'ft_transfer', args: Buffer.from(JSON.stringify({ receiver_id: to, amount })).toString('base64'), gas: 1, deposit: '1' } }],
    },
    transaction_outcome: { id: 'h', outcome: { status: { SuccessReceiptId: 'r' }, logs: [], receipt_ids: [], gas_burnt: 0, executor_id: 'fees.testnet' } },
    receipts_outcome: [],
  } as unknown as RpcTxResult
}

describe('the owner’s referral payouts', () => {
  it('lists claims, marks one paid only after checking the payout on chain, and rejects another', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nearkit-referrals-'))
    try {
      const path = join(dir, 'app.sqlite')
      const db = await openDatabase({ kind: 'sqlite', path })
      await migrate(db)
      const store = new Store(db)
      for (const userId of [101, 202]) await store.upsertUser({ userId, username: null, firstName: 'U', languageCode: null })
      const r = createReferrals({ db, store, custody: null, network: NETWORKS.testnet, feeRecipient: 'fees.testnet' })
      await r.attribute(202, (await r.link(101, 'b')).code)
      await r.recordTrade({ source: 'intent', sourceId: 't1', userId: 202, fee: { token: USDT, raw: '4000000', recipient: 'fees.testnet' }, txHash: 'x', trader: null })
      const claim = await r.requestClaim(101, USDT, 'alice.testnet')
      const id = claim.kind === 'created' ? claim.claim.id : ''
      await db.close()

      const out: string[] = []
      const env = { NEAR_NETWORK: 'testnet', NEARKIT_DB_PATH: path }
      let answer: RpcTxResult | Error = payout(USDT, 'alice.testnet', '800000')
      const rpc = {
        urls: [],
        txStatus: async () => {
          if (answer instanceof Error) throw answer
          return answer
        },
      } as unknown as RpcClient
      const run = (argv: string[]) => runReferralsAdmin(argv, env, (l) => void out.push(l), { rpc })

      expect(await run(['claims', 'requested'])).toBe(0)
      expect(out.at(-1)).toContain(`${id} · requested · user 101 · 800000 raw ${USDT} → alice.testnet`)
      // Not on chain, the wrong amount, a failed transaction: not marked paid.
      answer = new RpcError('handler', 'unknown', 'UNKNOWN_TRANSACTION')
      expect(await run(['paid', id, 'tx1', 'fees.testnet'])).toBe(1)
      answer = payout(USDT, 'alice.testnet', '799999')
      expect(await run(['paid', id, 'tx1', 'fees.testnet'])).toBe(1)
      expect(out.at(-1)).toMatch(/not marked paid/)
      answer = payout(USDT, 'alice.testnet', '800000', false)
      expect(await run(['paid', id, 'tx1', 'fees.testnet'])).toBe(1)
      answer = payout(USDT, 'alice.testnet', '800000')
      expect(await run(['paid', id, 'tx1', 'fees.testnet'])).toBe(0)
      expect(await run(['paid', id, 'tx1', 'fees.testnet'])).toBe(1)
      expect(out.at(-1)).toMatch(/already paid/)
      expect(await run(['summary'])).toBe(0)
      expect(out.at(-1)).toBe(`${USDT}: earned 800000 · paid 800000 · requested 0 · available 0 · NEARKITS net 3200000 (raw units)`)
      expect(await run(['reject', 'nope', 'reason'])).toBe(1)
      expect(await run(['nonsense'])).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
