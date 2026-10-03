import { describe, expect, it } from 'vitest'
import { telegramApprovalDigest } from '@/lib/telegramApproval'
import { readTelegramLaunch, telegramLaunchContext, telegramRequestProblem, type TelegramRequestView } from './telegramApproval'

const DIGEST = 'vVmfsy7_EOvYV1bUzufrNWV66n0fl92XVUcTOHa02CY'
const initData = (startParam: string) => new URLSearchParams({ auth_date: '1790000000', start_param: startParam, user: '{"id":101}', signature: 'x', hash: 'y' }).toString()
const hashOf = (data: string) => `#${new URLSearchParams({ tgWebAppData: data, tgWebAppVersion: '8.0', tgWebAppPlatform: 'ios' }).toString()}`

describe('the launch Telegram hands NearKit’s Mini App', () => {
  it('is read from the address Telegram opened: its signed data, and the link’s start parameter in it', () => {
    const data = initData(DIGEST)
    expect(readTelegramLaunch(hashOf(data), '')).toEqual({ initData: data, startParam: DIGEST })
  })

  it('is nothing outside Telegram, or without a request’s digest', () => {
    expect(readTelegramLaunch('', '')).toBeNull()
    expect(readTelegramLaunch('#wallet=abc', '')).toBeNull()
    expect(readTelegramLaunch(hashOf(initData('short')), '')).toBeNull()
  })
})

describe('where the Mini App was opened from', () => {
  it('outside Telegram: no launch data in the address', () => {
    expect(telegramLaunchContext('', '')).toEqual({ kind: 'outside' })
    expect(telegramLaunchContext('#wallet=abc', '?tgWebAppStartParam=' + DIGEST)).toEqual({ kind: 'outside' })
  })

  it('a direct open from Telegram: signed launch data, but no request to approve in it', () => {
    const data = new URLSearchParams({ auth_date: '1790000000', user: '{"id":101}', signature: 'x', hash: 'y' }).toString()
    expect(telegramLaunchContext(hashOf(data), '')).toEqual({ kind: 'direct', initData: data })
    // A start parameter that is not a request's digest is not an approval either.
    expect(telegramLaunchContext(hashOf(initData('short')), '')).toEqual({ kind: 'direct', initData: initData('short') })
    expect(telegramLaunchContext(hashOf(initData('ref_12345')), '')).toEqual({ kind: 'direct', initData: initData('ref_12345') })
  })

  it('an approval: the request’s digest as the start parameter Telegram signed, or the direct-link parameter', () => {
    const data = initData(DIGEST)
    expect(telegramLaunchContext(hashOf(data), '')).toEqual({ kind: 'approval', launch: { initData: data, startParam: DIGEST } })
    const plain = new URLSearchParams({ auth_date: '1790000000', user: '{"id":101}', signature: 'x', hash: 'y' }).toString()
    expect(telegramLaunchContext(hashOf(plain), `?tgWebAppStartParam=${DIGEST}`)).toEqual({ kind: 'approval', launch: { initData: plain, startParam: DIGEST } })
  })

  it('the approval launch is exactly what readTelegramLaunch reads: nothing changed for the signer', () => {
    const data = initData(DIGEST)
    const context = telegramLaunchContext(hashOf(data), '')
    expect(context.kind === 'approval' ? context.launch : null).toEqual(readTelegramLaunch(hashOf(data), ''))
  })
})

describe('what the page offers to approve', () => {
  const request: TelegramRequestView = {
    id: 'Req_abc-123',
    digest: DIGEST,
    kind: 'destination',
    network: 'mainnet',
    accountId: '9'.repeat(64),
    target: 'alice.near',
    expiresAt: 1_790_000_000_000,
  }

  it('is exactly the request the link names: it hashes to the start parameter Telegram signed', async () => {
    expect(await telegramApprovalDigest(request)).toBe(DIGEST)
    expect(await telegramRequestProblem(request, { digest: DIGEST, network: 'mainnet' })).toBeNull()
  })

  it('is refused if the server shows anything else: another address, wallet or network', async () => {
    expect(await telegramRequestProblem({ ...request, target: 'mallory.near' }, { digest: DIGEST, network: 'mainnet' })).toMatch(/doesn’t match/)
    expect(await telegramRequestProblem({ ...request, accountId: '8'.repeat(64) }, { digest: DIGEST, network: 'mainnet' })).toMatch(/doesn’t match/)
    expect(await telegramRequestProblem(request, { digest: DIGEST, network: 'testnet' })).toMatch(/testnet/)
  })
})
