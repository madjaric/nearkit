import { base64Decode } from '@/lib/encoding'

/**
 * Launch data of NearKit's Telegram Mini App, checked with Telegram's own signature.
 *
 * When someone opens a Mini App, Telegram hands the page its launch data (`initData`): who
 * opened it, when, and the `startapp` parameter of the link. Since Bot API 8.0 Telegram also
 * signs that data with its Ed25519 key, for one bot, so a third party can check it without
 * the bot token (core.telegram.org/bots/webapps, "Validating data for Third-Party Use").
 * NearKit's signer uses exactly that: nothing in NearKit (its app, its bot token, its
 * database) can make such a signature, only Telegram, for the user who opened the Mini App.
 */

/** Telegram's public keys for Mini App launch data (hex), from Telegram's documentation. */
export const TELEGRAM_LAUNCH_KEYS = {
  production: 'e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d',
  test: '40055058a4ee38156a06562e52eece92a771bcd8346a8c4615cb7376eddf72ec',
} as const

export interface TelegramCheck {
  /** NearKit's bot: Telegram's signature names the bot, so another bot's Mini App never counts. */
  botId: number
  /** Telegram's Ed25519 public key (32 bytes). */
  publicKey: Uint8Array
}

export interface TelegramLaunch {
  /** The Telegram user who opened the Mini App. */
  userId: number
  /** The link's `startapp` parameter ('' when there was none). */
  startParam: string
  /** When it was opened, in seconds. */
  authDate: number
}

/** Launch data is a few hundred bytes; anything far larger is not Telegram's. */
const MAX_LAUNCH_DATA = 4096

/** The launch data, if Telegram signed exactly this for this bot; else null. */
export async function verifyTelegramLaunch(initData: string, check: TelegramCheck): Promise<TelegramLaunch | null> {
  if (typeof initData !== 'string' || initData.length === 0 || initData.length > MAX_LAUNCH_DATA) return null
  const params = new URLSearchParams(initData)
  const fields: [string, string][] = []
  const seen = new Set<string>()
  let signature: string | null = null
  for (const [k, v] of params) {
    // A field given twice could be read two ways: refuse rather than pick one.
    if (seen.has(k)) return null
    seen.add(k)
    if (k === 'signature') signature = v
    else if (k !== 'hash') fields.push([k, v])
  }
  const sig = signature ? base64Decode(signature) : null
  if (!sig || sig.length !== 64) return null
  fields.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const text = `${check.botId}:WebAppData\n${fields.map(([k, v]) => `${k}=${v}`).join('\n')}`
  let genuine = false
  try {
    const key = await crypto.subtle.importKey('raw', new Uint8Array(check.publicKey), { name: 'Ed25519' }, false, ['verify'])
    genuine = await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, new TextEncoder().encode(text))
  } catch {
    return null
  }
  if (!genuine) return null
  // Only now is what it says worth reading.
  let user: unknown
  try {
    user = JSON.parse(params.get('user') ?? '')
  } catch {
    return null
  }
  const userId = user && typeof user === 'object' ? (user as { id?: unknown }).id : undefined
  const authDate = Number(params.get('auth_date'))
  if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0) return null
  if (!Number.isSafeInteger(authDate) || authDate <= 0) return null
  return { userId, startParam: params.get('start_param') ?? '', authDate }
}
