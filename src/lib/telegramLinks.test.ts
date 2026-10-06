import { describe, expect, it } from 'vitest'
import { approvalLink } from './telegramLinks'

/** A Mini App approval link comes from the API: only this bot's own Mini App link is ever opened. */
describe('approval links', () => {
  const digest = 'A'.repeat(43)
  it('opens this bot’s Mini App with a request digest, nothing else', () => {
    expect(approvalLink(`https://t.me/NearKitBot?startapp=${digest}`, 'NearKitBot')).toBe(`https://t.me/NearKitBot?startapp=${digest}`)
    for (const url of [
      'javascript:alert(1)',
      `https://t.me/OtherBot?startapp=${digest}`,
      `https://evil.example/?startapp=${digest}`,
      `https://t.me/NearKitBot?startapp=${digest}&x=1`,
      `http://t.me/NearKitBot?startapp=${digest}`,
      null,
    ])
      expect(approvalLink(url, 'NearKitBot'), String(url)).toBeNull()
    expect(approvalLink(`https://t.me/NearKitBot?startapp=${digest}`, null)).toBeNull()
  })
})
