import { describe, expect, it } from 'vitest'
import { parseUnits } from './amounts'
import { deletionVerdict, WALLET_DUST_NEAR, WALLET_DUST_YOCTO } from './walletDust'

const near = (text: string) => parseUnits(text, 24)
const view = (patch: Partial<Parameters<typeof deletionVerdict>[0]> = {}) =>
  deletionVerdict({ exists: true, nearYocto: 0n, lockedYocto: 0n, tokens: [], tokensKnown: true, ...patch })

describe('wallet dust: what may be deleted', () => {
  it('names 0.05 NEAR as the line', () => {
    expect(WALLET_DUST_NEAR).toBe(0.05)
    expect(WALLET_DUST_YOCTO).toBe(near('0.05'))
  })

  it('a wallet that never existed on chain, holding nothing, is deletable with nothing left behind', () => {
    expect(view({ exists: false })).toEqual({ ok: true, dustYocto: 0n })
  })

  it('0 NEAR, 0.0075 NEAR, 0.04 NEAR and 0.049999 NEAR are dust: deletable, and the dust is named', () => {
    for (const amount of ['0', '0.0075', '0.04', '0.049999']) expect(view({ nearYocto: near(amount) })).toEqual({ ok: true, dustYocto: near(amount) })
    expect(view({ nearYocto: WALLET_DUST_YOCTO - 1n })).toEqual({ ok: true, dustYocto: WALLET_DUST_YOCTO - 1n })
  })

  it('exactly 0.05 NEAR, and anything above, is a balance: not deletable', () => {
    expect(view({ nearYocto: near('0.05') })).toEqual({ ok: false, reason: 'near' })
    expect(view({ nearYocto: near('0.050001') })).toEqual({ ok: false, reason: 'near' })
    expect(view({ nearYocto: near('3') })).toEqual({ ok: false, reason: 'near' })
  })

  it('any token balance blocks deletion, even with no NEAR and even on an account that does not exist yet', () => {
    expect(view({ tokens: [{ contract: 'usdt.tether-token.near', raw: 1n }] })).toEqual({ ok: false, reason: 'tokens' })
    expect(view({ exists: false, tokens: [{ contract: 'meme.tkn.near', raw: 10n ** 18n }] })).toEqual({ ok: false, reason: 'tokens' })
  })

  it('a token list that could not be fully read blocks deletion (unknown is never empty)', () => {
    expect(view({ tokensKnown: false })).toEqual({ ok: false, reason: 'unknown' })
    expect(view({ exists: false, tokensKnown: false })).toEqual({ ok: false, reason: 'unknown' })
  })

  it('a balance that could not be read, or staked NEAR, blocks deletion', () => {
    expect(view({ exists: null })).toEqual({ ok: false, reason: 'unknown' })
    expect(view({ nearYocto: null })).toEqual({ ok: false, reason: 'unknown' })
    expect(view({ lockedYocto: 1n })).toEqual({ ok: false, reason: 'near' })
  })
})
