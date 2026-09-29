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

  it('reads mainnet settings, keeping the fee account a plain, replaceable setting', () => {
    const { config, issues } = loadConfig({
      TELEGRAM_BOT_TOKEN: TOKEN,
      NEAR_NETWORK: 'mainnet',
      NEARKIT_FEE_RECIPIENT: 'fees.example.near',
      NEARKIT_WEB_URL: 'http://localhost:5199/',
      NEARKIT_API_ALLOWED_ORIGINS: 'http://localhost:5199, http://localhost:5200',
      BUYBOT_ENABLED: 'false',
    })
    expect(issues).toEqual([])
    expect(config.network.id).toBe('mainnet')
    expect(config.env.feeRecipient).toBe('fees.example.near')
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

  it('allows running the API without a bot token (the bot just stays off)', () => {
    const { config, issues } = loadConfig({})
    expect(config.telegramToken).toBeNull()
    expect(issues).toEqual([])
  })
})
