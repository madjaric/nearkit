import { describe, expect, it } from 'vitest'
import { hexDecode } from '@/lib/encoding'
import { TELEGRAM_LAUNCH_KEYS, verifyTelegramLaunch } from './telegram'
import { telegramSigner } from './testing'

/**
 * aiogram's test vector for Telegram's third-party validation (aiogram/tests/test_utils/
 * test_web_app_signature.py): bot 42, signed with aiogram's own test key. An independent
 * implementation's vector, so the check string here is built the way Telegram specifies.
 */
const AIOGRAM = {
  botId: 42,
  publicKey: hexDecode('4112765021341e5415e772cd65903f6b94e3ea1c2ab669e6d3e18ee2db00da61') as Uint8Array,
  initData:
    'auth_date=1650385342&user=%7B%22id%22%3A42%2C%22first_name%22%3A%22Test%22%7D&query_id=test&hash=123&signature=JQ0JR2tjC65yq_jNZV0wuJVX6J-SWPMV0mprUXG34g-NvxL4RcF1Rz5n4VVo00VRghEUBf5t___uoeb1-jU_Cw',
}

describe('Mini App launch data, checked with Telegram’s signature (third-party validation)', () => {
  it('accepts an independent implementation’s signed vector, whatever the hash field says', async () => {
    expect(await verifyTelegramLaunch(AIOGRAM.initData, { botId: 42, publicKey: AIOGRAM.publicKey })).toEqual({ userId: 42, startParam: '', authDate: 1_650_385_342 })
  })

  it('refuses it for another bot, under another key, or with a byte of the signature changed', async () => {
    expect(await verifyTelegramLaunch(AIOGRAM.initData, { botId: 43, publicKey: AIOGRAM.publicKey })).toBeNull()
    expect(await verifyTelegramLaunch(AIOGRAM.initData, { botId: 42, publicKey: hexDecode(TELEGRAM_LAUNCH_KEYS.production) as Uint8Array })).toBeNull()
    expect(await verifyTelegramLaunch(AIOGRAM.initData.replace('jU_Cw', 'j1U_w'), { botId: 42, publicKey: AIOGRAM.publicKey })).toBeNull()
  })

  it('names the user who opened the Mini App and the start parameter Telegram signed into it', async () => {
    const tg = await telegramSigner(7_000_001)
    const initData = await tg.launch({ userId: 55, startParam: 'abc_DEF-123', authDate: 1_790_000_000 })
    expect(await verifyTelegramLaunch(initData, tg.check)).toEqual({ userId: 55, startParam: 'abc_DEF-123', authDate: 1_790_000_000 })
  })

  it('refuses launch data changed after Telegram signed it: another user, another start parameter, a later date', async () => {
    const tg = await telegramSigner(7_000_001)
    const initData = await tg.launch({ userId: 55, startParam: 'abc', authDate: 1_790_000_000 })
    const params = new URLSearchParams(initData)
    for (const [k, v] of [
      ['user', JSON.stringify({ id: 56, first_name: 'Eve' })],
      ['start_param', 'abd'],
      ['auth_date', '1790000001'],
    ] as const) {
      const changed = new URLSearchParams(params)
      changed.set(k, v)
      expect(await verifyTelegramLaunch(changed.toString(), tg.check)).toBeNull()
    }
  })

  it('refuses what is ambiguous or incomplete: no signature, a field twice, no user, an oversized payload', async () => {
    const tg = await telegramSigner(7_000_001)
    const initData = await tg.launch({ userId: 55, startParam: 'abc', authDate: 1_790_000_000 })
    const params = new URLSearchParams(initData)
    const unsigned = new URLSearchParams(params)
    unsigned.delete('signature')
    expect(await verifyTelegramLaunch(unsigned.toString(), tg.check)).toBeNull()
    expect(await verifyTelegramLaunch(`${initData}&start_param=xyz`, tg.check)).toBeNull()
    expect(await verifyTelegramLaunch(await tg.launch({ userId: 55, startParam: 'abc', authDate: 1_790_000_000, user: null }), tg.check)).toBeNull()
    expect(await verifyTelegramLaunch(`${initData}&pad=${'x'.repeat(5000)}`, tg.check)).toBeNull()
  })

  it('uses Telegram’s published production and test keys', () => {
    expect(TELEGRAM_LAUNCH_KEYS).toEqual({
      production: 'e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d',
      test: '40055058a4ee38156a06562e52eece92a771bcd8346a8c4615cb7376eddf72ec',
    })
  })
})
