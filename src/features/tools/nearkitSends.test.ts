import { describe, expect, it } from 'vitest'
import type { WebSendInput, WebSendReview, WebSendStatus } from '@/services/nearkitWeb'
import { LinkRequestError } from '@/services/telegramLink'
import { reviewLines, sendLines, type LineState, type SendsApi } from './nearkitSends'

/**
 * Split and Batch Send from a NearKit wallet: every line is an ordinary web send (NearKit's server
 * reviews it, the custody rule and the signer decide), reviewed first, then sent one after another.
 */

const WALLET = 'srv-wallet-1'
const review = (to: string, amount: string): WebSendReview => ({
  walletId: WALLET,
  from: 'Main',
  accountId: 'main.near',
  asset: 'near',
  symbol: 'NEAR',
  decimals: 24,
  amount,
  to,
  linked: false,
  feeNear: '1000000000000000000000',
  registration: null,
  fresh: true,
})

/** A fake web API: who is approved, what each review answers, how each send ends. It records every call in order. */
function api(opts: { unapproved?: string[]; broken?: Record<string, string>; ending?: Record<string, WebSendStatus['status']>; ttlMs?: number; pausedAfter?: number } = {}) {
  const calls: string[] = []
  let now = 0
  let n = 0
  let executed = 0
  const intents = new Map<string, { to: string; expiresAt: number; polls: number }>()
  const fake: SendsApi = {
    async reviewSend(input: WebSendInput) {
      calls.push(`review ${input.to} ${input.amount}`)
      if (opts.unapproved?.includes(input.to))
        throw new LinkRequestError(409, 'needs-approval', `${input.to} isn’t approved for Main yet.`, { kind: 'owner', owner: 'owner.near', accountId: 'main.near' })
      const why = opts.broken?.[input.to]
      if (why) throw new LinkRequestError(400, 'to', why)
      const intentId = `i${(n += 1)}`
      intents.set(intentId, { to: input.to, expiresAt: now + (opts.ttlMs ?? 300_000), polls: 0 })
      return { intentId, expiresAt: now + (opts.ttlMs ?? 300_000), review: review(input.to, input.amount) }
    },
    async executeSend(intentId: string) {
      calls.push(`execute ${intentId}`)
      if (opts.pausedAfter !== undefined && executed >= opts.pausedAfter) throw new LinkRequestError(503, 'paused', 'Withdrawals are paused right now.')
      const i = intents.get(intentId)
      if (!i || i.expiresAt <= now) throw new LinkRequestError(409, 'nothing-open', 'That send isn’t waiting any more: it ran, or its review expired. Review it again.')
      executed += 1
      return { started: true }
    },
    async sendStatus(intentId: string): Promise<WebSendStatus> {
      const i = intents.get(intentId)
      if (!i) throw new Error('unknown intent')
      i.polls += 1
      calls.push(`status ${intentId}`)
      if (i.polls < 2) return { status: 'executing', message: null, hashes: [] }
      const end = opts.ending?.[i.to] ?? 'done'
      return end === 'done' ? { status: 'done', message: null, hashes: [`tx-${intentId}`] } : { status: end, message: `The send to ${i.to} failed.`, hashes: [] }
    },
  }
  return { fake, calls, advance: (ms: number) => (now += ms), now: () => now }
}

const lines = [
  { to: 'alice.near', amount: '1' },
  { to: 'bob.near', amount: '2' },
  { to: 'carol.near', amount: '3' },
]

describe('reviewing the lines', () => {
  it('each line is ready, needs approval (and says how), or can’t be sent (and says why)', async () => {
    const a = api({ unapproved: ['bob.near'], broken: { 'carol.near': 'carol.near doesn’t exist on mainnet.' } })
    const states = await reviewLines(a.fake, WALLET, 'near', lines, () => undefined)
    expect(states[0]).toMatchObject({ kind: 'ready', intentId: 'i1', review: { to: 'alice.near', amount: '1' } })
    expect(states[1]).toEqual({ kind: 'approval', approval: { kind: 'owner', owner: 'owner.near', accountId: 'main.near' }, message: 'bob.near isn’t approved for Main yet.' })
    expect(states[2]).toEqual({ kind: 'error', message: 'carol.near doesn’t exist on mainnet.' })
    // Exactly what each line says: its destination and its exact amount, from this wallet.
    expect(a.calls).toEqual(['review alice.near 1', 'review bob.near 2', 'review carol.near 3'])
  })
})

describe('sending the reviewed lines', () => {
  const run = async (a: ReturnType<typeof api>, states: LineState[], shouldStop = () => false) =>
    sendLines(a.fake, WALLET, 'near', lines, states, () => undefined, {
      now: a.now,
      sleep: async (ms) => void a.advance(ms),
      shouldStop,
    })

  it('one after another: the next send starts only once the one before it is done (a wallet’s sends never race for its key)', async () => {
    const a = api()
    const states = await reviewLines(a.fake, WALLET, 'near', lines, () => undefined)
    a.calls.length = 0
    const done = await run(a, states)
    expect(done.map((s) => s.kind)).toEqual(['sent', 'sent', 'sent'])
    expect(done[0]).toEqual({ kind: 'sent', hashes: ['tx-i1'] })
    expect(a.calls).toEqual(['execute i1', 'status i1', 'status i1', 'execute i2', 'status i2', 'status i2', 'execute i3', 'status i3', 'status i3'])
  })

  it('a review that expired meanwhile is reviewed again, same destination and amount, before it is sent', async () => {
    const a = api({ ttlMs: 10_000 })
    const states = await reviewLines(a.fake, WALLET, 'near', lines.slice(0, 1), () => undefined)
    a.advance(60_000)
    a.calls.length = 0
    const done = await sendLines(a.fake, WALLET, 'near', lines.slice(0, 1), states, () => undefined, {
      now: a.now,
      sleep: async (ms) => void a.advance(ms),
      shouldStop: () => false,
    })
    expect(done).toEqual([{ kind: 'sent', hashes: ['tx-i2'] }])
    expect(a.calls[0]).toBe('review alice.near 1')
    expect(a.calls[1]).toBe('execute i2')
  })

  it('a failed send is reported as failed (never retried); the next line still goes', async () => {
    const a = api({ ending: { 'bob.near': 'failed' } })
    const states = await reviewLines(a.fake, WALLET, 'near', lines, () => undefined)
    const done = await run(a, states)
    expect(done.map((s) => s.kind)).toEqual(['sent', 'failed', 'sent'])
    expect(done[1]).toEqual({ kind: 'failed', message: 'The send to bob.near failed.' })
    expect(a.calls.filter((c) => c.startsWith('execute'))).toEqual(['execute i1', 'execute i2', 'execute i3'])
  })

  it('withdrawals paused: nothing more starts; the lines not sent say so', async () => {
    const a = api({ pausedAfter: 1 })
    const states = await reviewLines(a.fake, WALLET, 'near', lines, () => undefined)
    const done = await run(a, states)
    expect(done[0]).toEqual({ kind: 'sent', hashes: ['tx-i1'] })
    expect(done[1]).toEqual({ kind: 'failed', message: 'Withdrawals are paused right now.' })
    expect(done[2]).toEqual({ kind: 'failed', message: 'Not sent: the batch stopped before this line.' })
    expect(a.calls.filter((c) => c.startsWith('execute'))).toEqual(['execute i1', 'execute i2'])
  })

  it('Stop: the send under way finishes, nothing after it starts', async () => {
    const a = api()
    const states = await reviewLines(a.fake, WALLET, 'near', lines, () => undefined)
    let started = 0
    const done = await run(a, states, () => started++ >= 1)
    expect(done.map((s) => s.kind)).toEqual(['sent', 'failed', 'failed'])
    expect(done[1]).toEqual({ kind: 'failed', message: 'Not sent: the batch stopped before this line.' })
  })

  it('only a batch whose every line is ready is sent: a line needing approval stops it before anything goes', async () => {
    const a = api({ unapproved: ['bob.near'] })
    const states = await reviewLines(a.fake, WALLET, 'near', lines, () => undefined)
    await expect(run(a, states)).rejects.toThrow('Every line must be ready before the batch is sent')
    expect(a.calls.some((c) => c.startsWith('execute'))).toBe(false)
  })
})

describe('Consolidate: one line from each of several NEARKITS wallets, into one destination', () => {
  const into = [
    { from: { walletId: 'srv-1', label: 'Main', accountId: 'main.near' }, to: 'dest.near', amount: '5' },
    { from: { walletId: 'srv-2', label: 'Degen', accountId: 'degen.near' }, to: 'dest.near', amount: '7' },
  ]

  it('reviews and sends each line from its own wallet, one after another, under the same custody rule', async () => {
    const a = api()
    const asked: string[] = []
    const spy: SendsApi = { ...a.fake, reviewSend: (input) => (asked.push(`${input.walletId} ${input.token} ${input.amount}→${input.to}`), a.fake.reviewSend(input)) }
    const states = await reviewLines(spy, '', 'sing.near', into, () => undefined)
    expect(states.map((s) => s.kind)).toEqual(['ready', 'ready'])
    a.calls.length = 0
    const done = await sendLines(spy, '', 'sing.near', into, states, () => undefined, { now: a.now, sleep: async (ms) => void a.advance(ms), shouldStop: () => false })
    expect(done.map((s) => s.kind)).toEqual(['sent', 'sent'])
    expect(asked).toEqual(['srv-1 sing.near 5→dest.near', 'srv-2 sing.near 7→dest.near'])
    expect(a.calls).toEqual(['execute i1', 'status i1', 'status i1', 'execute i2', 'status i2', 'status i2'])
  })

  it('a destination one of the wallets may not send to yet blocks the whole run until it is approved', async () => {
    const a = api({ unapproved: ['dest.near'] })
    const states = await reviewLines(a.fake, '', 'sing.near', into, () => undefined)
    expect(states.map((s) => s.kind)).toEqual(['approval', 'approval'])
    await expect(sendLines(a.fake, '', 'sing.near', into, states, () => undefined, { now: a.now, sleep: async () => undefined, shouldStop: () => false })).rejects.toThrow(
      'Every line must be ready before the batch is sent',
    )
  })
})
