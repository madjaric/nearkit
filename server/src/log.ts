/**
 * Structured logging with redaction. Every line passes through `redact` after it
 * is serialized, so a secret can't slip out through an error message, a URL or a
 * nested field. The Telegram API puts the bot token in every request URL; that
 * is why anything shaped like a bot token is removed even if unconfigured.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const BOT_TOKEN = /\b\d{5,16}:[A-Za-z0-9_-]{30,}\b/g

export function redact(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret.trim().length < 8) continue
    out = out.split(secret).join('[REDACTED]')
  }
  return out.replace(BOT_TOKEN, '[REDACTED]')
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
}

function plain(value: unknown): unknown {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (typeof value === 'bigint') return value.toString()
  return value
}

export function createLogger({
  level = 'info',
  secrets = [],
  sink = (line: string) => process.stdout.write(line + '\n'),
  now = () => new Date(),
}: {
  level?: LogLevel
  secrets?: readonly string[]
  sink?: (line: string) => void
  now?: () => Date
} = {}): Logger {
  const write = (lvl: LogLevel, msg: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[lvl] < ORDER[level]) return
    const entry: Record<string, unknown> = { t: now().toISOString(), level: lvl, msg }
    for (const [k, v] of Object.entries(fields)) entry[k] = plain(v)
    let line: string
    try {
      line = JSON.stringify(entry, (_k, v: unknown) => plain(v))
    } catch {
      line = JSON.stringify({ t: entry.t, level: lvl, msg, note: 'fields could not be serialized' })
    }
    sink(redact(line, secrets))
  }
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  }
}

/** A logger that drops everything: for tests. */
export const silentLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
