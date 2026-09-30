import { describe, expect, it } from 'vitest'
import { telegramApprovalDigest, type TelegramApprovalRequest } from './telegramApproval'

const request: TelegramApprovalRequest = {
  id: 'Req_abc-123',
  kind: 'destination',
  network: 'mainnet',
  accountId: '9'.repeat(64),
  target: 'alice.near',
  expiresAt: 1_790_000_000_000,
}

describe('the digest a Telegram approval is bound to', () => {
  it('is pinned: approvals already given are re-verified with it for as long as they are used', async () => {
    expect(await telegramApprovalDigest(request)).toBe('vVmfsy7_EOvYV1bUzufrNWV66n0fl92XVUcTOHa02CY')
  })

  it('fits a Telegram start parameter: 43 base64url characters', async () => {
    expect(await telegramApprovalDigest(request)).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('changes with every field, so it names exactly one request', async () => {
    const base = await telegramApprovalDigest(request)
    const variants: Partial<TelegramApprovalRequest>[] = [
      { id: 'Req_abc-124' },
      { kind: 'bind-owner' },
      { network: 'testnet' },
      { accountId: '8'.repeat(64) },
      { target: 'bob.near' },
      { expiresAt: request.expiresAt + 1 },
    ]
    for (const v of variants) expect(await telegramApprovalDigest({ ...request, ...v })).not.toBe(base)
  })
})
