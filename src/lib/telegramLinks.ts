import { ENV } from '@/config/env'

/** The NearKit bot this build names (VITE_TELEGRAM_BOT), for links into Telegram. */
export const BOT_NAME = ENV.telegramBot ? `@${ENV.telegramBot}` : 'the NEARKITS bot'
export const BOT_URL = ENV.telegramBot ? `https://t.me/${ENV.telegramBot}` : null
/** `/start web`: the bot answers with a one-time link that signs this page in to NearKit web. */
export const WEB_SIGN_IN_URL = ENV.telegramBot ? `https://t.me/${ENV.telegramBot}?start=web` : null

/**
 * A Mini App approval link the API sent, or null: only this bot's own Mini App, opened with a
 * request digest (base64url of SHA-256), is ever a link target here.
 */
export function approvalLink(url: unknown, bot: string | null = ENV.telegramBot): string | null {
  if (typeof url !== 'string' || !bot) return null
  return url.startsWith(`https://t.me/${bot}?startapp=`) && /^[A-Za-z0-9_-]{43}$/.test(url.slice(`https://t.me/${bot}?startapp=`.length)) ? url : null
}
