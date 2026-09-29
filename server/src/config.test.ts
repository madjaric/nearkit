import { describe, expect, it } from 'vitest'
import { loadConfig } from './config'

const TOKEN = '1234567890:AAH-abcdefghijklmnopqrstuvwxyz_0123456'

describe('server config', () => {
  it('defaults to testnet, the public beta web app and a local API', () => {
    const { config, issues } = loadConfig({ TELEGRAM_BOT_TOKEN: TOKEN })
    expect(issues).toEqual([])
    expect(config.network.id).toBe('testnet')
    expect(config.webUrl).toBe('https://nearkit.vercel.app')
    expect(config.linkRecipient).toBe('nearkit.vercel.app')
    expect(config.api).toMatchObject({ host: '127.0.0.1', port: 8787, publicUrl: 'http://localhost:8787', allowedOrigins: ['https://nearkit.vercel.app'] })
    expect(config.dbPath).toMatch(/nearkit-testnet\.sqlite$/)
    // Buy alerts follow mainnet by default (read-only), even while trading is the testnet beta.
    expect(config.buybot).toMatchObject({ enabled: true, dataUrl: 'https://tx.main.fastnear.com' })
    expect(config.buybot.network.id).toBe('mainnet')
    expect(config.env.feeRecipient).toBeNull()
    expect(config.telegramApiUrl).toBe('https://api.telegram.org')
  })

  it('lets buy alerts follow mainnet while trading stays on the testnet beta', () => {
    const { config, issues } = loadConfig({ NEAR_NETWORK: 'testnet', BUYBOT_NETWORK: 'mainnet', BUYBOT_RPC_URL: '' })
    expect(issues).toEqual([])
    expect(config.network.id).toBe('testnet')
    expect(config.buybot.network.id).toBe('mainnet')
    expect(config.buybot.network.rpcUrls[0]).toBe('https://free.rpc.fastnear.com')
    expect(config.buybot.dataUrl).toBe('https://tx.main.fastnear.com')
    expect(loadConfig({ BUYBOT_NETWORK: 'devnet' }).issues.map((i) => i.key)).toEqual(['BUYBOT_NETWORK'])
    expect(loadConfig({ BUYBOT_NETWORK: 'testnet' }).config.buybot.dataUrl).toBe('https://tx.test.fastnear.com')
  })

  it('accepts a self-hosted Bot API server, https or local', () => {
    expect(loadConfig({ TELEGRAM_API_URL: 'http://localhost:8081/' }).config.telegramApiUrl).toBe('http://localhost:8081')
    expect(loadConfig({ TELEGRAM_API_URL: 'http://bots.example' }).issues.map((i) => i.key)).toEqual(['TELEGRAM_API_URL'])
  })

  it('reads mainnet settings with the production fee account (no other is accepted there)', () => {
    const { config, issues } = loadConfig({
      TELEGRAM_BOT_TOKEN: TOKEN,
      NEAR_NETWORK: 'mainnet',
      NEARKIT_FEE_RECIPIENT: 'nearkitfee.near',
      NEARKIT_WEB_URL: 'http://localhost:5199/',
      NEARKIT_API_ALLOWED_ORIGINS: 'http://localhost:5199, http://localhost:5200',
      BUYBOT_ENABLED: 'false',
    })
    expect(issues).toEqual([])
    expect(config.network.id).toBe('mainnet')
    expect(config.env.feeRecipient).toBe('nearkitfee.near')
    expect(config.webUrl).toBe('http://localhost:5199')
    expect(config.linkRecipient).toBe('localhost')
    expect(config.api.allowedOrigins).toEqual(['http://localhost:5199', 'http://localhost:5200'])
    expect(config.buybot.enabled).toBe(false)
    expect(config.buybot.dataUrl).toBe('https://tx.main.fastnear.com')
  })

  it('reports problems by server variable name, and never echoes the token', () => {
    const { issues } = loadConfig({
      TELEGRAM_BOT_TOKEN: 'not-a-token',
      NEAR_NETWORK: 'devnet',
      NEARKIT_FEE_RECIPIENT: 'fees.testnet',
      NEARKIT_WEB_URL: 'http://example.com',
      NEARKIT_API_PORT: '99999',
    })
    const keys = issues.map((i) => i.key)
    expect(keys).toEqual(expect.arrayContaining(['TELEGRAM_BOT_TOKEN', 'NEAR_NETWORK', 'NEARKIT_WEB_URL', 'NEARKIT_API_PORT']))
    expect(JSON.stringify(issues)).not.toContain('not-a-token')
  })

  it('refuses a fee account from the other network', () => {
    const { issues } = loadConfig({ TELEGRAM_BOT_TOKEN: TOKEN, NEAR_NETWORK: 'mainnet', NEARKIT_FEE_RECIPIENT: 'fees.testnet' })
    expect(issues.map((i) => i.key)).toContain('NEARKIT_FEE_RECIPIENT')
  })

  it('listens on the PORT a host assigns (Railway), unless NEARKIT_API_PORT says otherwise', () => {
    expect(loadConfig({ PORT: '4321' }).config.api.port).toBe(4321)
    expect(loadConfig({ PORT: '4321', NEARKIT_API_PORT: '8800' }).config.api.port).toBe(8800)
    expect(loadConfig({ PORT: 'eighty' }).issues.map((i) => i.key)).toEqual(['PORT'])
  })

  it('allows running the API without a bot token (the bot just stays off)', () => {
    const { config, issues } = loadConfig({})
    expect(config.telegramToken).toBeNull()
    expect(issues).toEqual([])
  })
})

describe('the bot', () => {
  it('can be pinned to one bot username; a token of another bot is caught at start', () => {
    expect(loadConfig({ TELEGRAM_BOT_USERNAME: '@NearKitBot' }).config.telegramBotUsername).toBe('NearKitBot')
    expect(loadConfig({ TELEGRAM_BOT_USERNAME: 'not a bot' }).issues.map((i) => i.key)).toEqual(['TELEGRAM_BOT_USERNAME'])
  })
})

describe('trading wallets (custody)', () => {
  const KEK = Buffer.alloc(32, 7).toString('base64')
  const AUTH = Buffer.alloc(32, 9).toString('base64')
  const PG = 'postgres://nearkit:secret@db.internal:5432/nearkit'
  const keys = (issues: { key: string }[]) => issues.map((i) => i.key).sort()

  it('run on testnet with the signer in this process (a 32-byte KEK), or the signer service; off without either', () => {
    const on = loadConfig({ NEAR_NETWORK: 'testnet', NEARKIT_WALLET_KEK: KEK }).config.custody
    expect(on).toMatchObject({ enabled: true, reason: null, signer: { kind: 'in-process' } })
    expect(on.signer?.kind === 'in-process' && on.signer.kek.equals(Buffer.alloc(32, 7))).toBe(true)
    const remote = loadConfig({ NEAR_NETWORK: 'testnet', NEARKIT_SIGNER_URL: 'http://127.0.0.1:8790', NEARKIT_SIGNER_AUTH_KEY: AUTH }).config.custody
    expect(remote).toMatchObject({ enabled: true, signer: { kind: 'remote', url: 'http://127.0.0.1:8790' } })
    expect(loadConfig({ NEAR_NETWORK: 'testnet' }).config.custody).toMatchObject({ enabled: false, signer: null, reason: expect.stringMatching(/NEARKIT_WALLET_KEK/) })
  })

  it('stay off on mainnet until the owner’s switch, whatever else is configured', () => {
    const { config, issues } = loadConfig({ NEAR_NETWORK: 'mainnet', NEARKIT_SIGNER_URL: 'https://signer.internal', NEARKIT_SIGNER_AUTH_KEY: AUTH, NEARKIT_DATABASE_URL: PG })
    expect(issues).toEqual([])
    expect(config.custody).toMatchObject({ enabled: false, signer: null, reason: expect.stringMatching(/until the owner turns them on/) })
  })

  it('refuse to start on mainnet with the switch on and anything missing: signer service, PostgreSQL, the production fee account, TLS', () => {
    expect(keys(loadConfig({ NEAR_NETWORK: 'mainnet', NEARKIT_MAINNET_CUSTODY: 'enabled' }).issues)).toEqual([
      'NEARKIT_DATABASE_URL',
      'NEARKIT_FEE_RECIPIENT',
      'NEARKIT_SIGNER_URL',
    ])
    const plain = loadConfig({
      NEAR_NETWORK: 'mainnet',
      NEARKIT_MAINNET_CUSTODY: 'enabled',
      NEARKIT_SIGNER_URL: 'http://localhost:8790',
      NEARKIT_SIGNER_AUTH_KEY: AUTH,
      NEARKIT_DATABASE_URL: PG,
      NEARKIT_FEE_RECIPIENT: 'nearkitfee.near',
    })
    expect(keys(plain.issues)).toEqual(['NEARKIT_SIGNER_URL'])
    const ready = loadConfig({
      NEAR_NETWORK: 'mainnet',
      NEARKIT_MAINNET_CUSTODY: 'enabled',
      NEARKIT_SIGNER_URL: 'https://signer.internal',
      NEARKIT_SIGNER_AUTH_KEY: AUTH,
      NEARKIT_DATABASE_URL: PG,
      NEARKIT_FEE_RECIPIENT: 'nearkitfee.near',
    })
    expect(ready.issues).toEqual([])
    expect(ready.config.custody).toMatchObject({ enabled: true, signer: { kind: 'remote', url: 'https://signer.internal' } })
  })

  it('on mainnet with the switch on, owner signatures must name the real https web app', () => {
    const base = {
      NEAR_NETWORK: 'mainnet',
      NEARKIT_MAINNET_CUSTODY: 'enabled',
      NEARKIT_SIGNER_URL: 'https://signer.internal',
      NEARKIT_SIGNER_AUTH_KEY: AUTH,
      NEARKIT_DATABASE_URL: PG,
      NEARKIT_FEE_RECIPIENT: 'nearkitfee.near',
    }
    expect(keys(loadConfig({ ...base, NEARKIT_WEB_URL: 'http://localhost:5199' }).issues)).toEqual(['NEARKIT_WEB_URL'])
    expect(loadConfig({ ...base, NEARKIT_WEB_URL: 'https://nearkit.app' }).issues).toEqual([])
  })

  it('refuse a KEK in the app’s environment on mainnet, and any fee account but the production one', () => {
    expect(keys(loadConfig({ NEAR_NETWORK: 'mainnet', NEARKIT_WALLET_KEK: KEK }).issues)).toEqual(['NEARKIT_WALLET_KEK'])
    expect(loadConfig({ NEAR_NETWORK: 'mainnet', NEARKIT_FEE_RECIPIENT: 'testone.near' }).issues).toEqual([
      { key: 'NEARKIT_FEE_RECIPIENT', message: expect.stringMatching(/test account/) },
    ])
    expect(loadConfig({ NEAR_NETWORK: 'mainnet', NEARKIT_FEE_RECIPIENT: 'someone.near' }).issues).toEqual([
      { key: 'NEARKIT_FEE_RECIPIENT', message: expect.stringMatching(/must be nearkitfee\.near/) },
    ])
    expect(loadConfig({ NEAR_NETWORK: 'mainnet', NEARKIT_FEE_RECIPIENT: 'nearkitfee.near' }).issues).toEqual([])
  })

  it('refuse a malformed key without ever repeating it', () => {
    const bad = 'c2hvcnQta2V5LXNob3J0LWtleQ=='
    const { config, issues } = loadConfig({ NEAR_NETWORK: 'testnet', NEARKIT_WALLET_KEK: bad, NEARKIT_SIGNER_URL: 'https://signer.test', NEARKIT_SIGNER_AUTH_KEY: bad })
    expect(keys(issues)).toEqual(['NEARKIT_SIGNER_AUTH_KEY', 'NEARKIT_WALLET_KEK'])
    expect(JSON.stringify(issues)).not.toContain(bad)
    expect(config.custody.enabled).toBe(false)
  })
})
