import { ENV } from '@/config/env'

/** The NearKit bot this build names (VITE_TELEGRAM_BOT), for links into Telegram. */
export const BOT_NAME = ENV.telegramBot ? `@${ENV.telegramBot}` : 'the NEARKITS bot'
export const BOT_URL = ENV.telegramBot ? `https://t.me/${ENV.telegramBot}` : null
/** `/start web`: the bot answers with a one-time link that signs this page in to NearKit web. */
export const WEB_SIGN_IN_URL = ENV.telegramBot ? `https://t.me/${ENV.telegramBot}?start=web` : null
