/**
 * Telegram HTML formatting (parse_mode: HTML). Every piece of text that comes
 * from outside NearKit (token names and symbols from chain metadata, account
 * IDs, user input) goes through `esc`, so it can't inject tags or links.
 */

// C0/C1 controls except tab and newline, plus bidi overrides that can disguise text.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]/g

export function esc(text: string): string {
  return text.replace(CONTROL, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export const bold = (text: string) => `<b>${esc(text)}</b>`
export const italic = (text: string) => `<i>${esc(text)}</i>`
export const code = (text: string) => `<code>${esc(text)}</code>`

/** A link for http(s) URLs; anything else degrades to plain escaped text. */
export function link(url: string, text: string): string {
  if (!/^https?:\/\//i.test(url)) return esc(text)
  return `<a href="${esc(url).replace(/"/g, '&quot;')}">${esc(text)}</a>`
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/** Long implicit accounts (64 hex chars) and other long IDs, shortened in the middle. */
export function shortAccount(accountId: string, max = 24): string {
  return accountId.length <= max ? accountId : `${accountId.slice(0, 6)}…${accountId.slice(-4)}`
}

/** One trimmed line of user input, without control characters. */
export function plainText(input: string, max: number): string {
  return input.replace(CONTROL, '').replace(/\s+/g, ' ').trim().slice(0, max)
}
