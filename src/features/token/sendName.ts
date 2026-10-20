/**
 * A Send button's accessible name. It contains the visible label (WCAG 2.5.3, label in name), so a
 * user who speaks what they see reaches it, and it names the token: a label that already does
 * ("Send $KITS") is the name as written; a bare "Send" gets the token's symbol after it.
 */
export function sendButtonName(label: string, symbol: string): string {
  return label.toLowerCase().includes(symbol.toLowerCase()) ? label : `${label} ${symbol}`
}
