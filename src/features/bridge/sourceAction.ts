import type { SourceSide } from './useSourceSide'

/**
 * What the sending-wallet section (SourceFields.tsx's SourceAction) shows, from the source side alone:
 * the wallets that registered themselves on this page, the one connected, or the address typed in.
 * Never a guess about the browser: Telegram's in-app browser is simply one where none registers.
 */
export type SourceActionState =
  | { kind: 'connected'; name: string; address: string }
  /** The user enters the address they send from; their wallet app sends, outside this page. */
  | { kind: 'address' }
  | { kind: 'connect'; wallets: number }
  /** No wallet registered itself on this page (Telegram's in-app browser has none). */
  | { kind: 'none' }

export function sourceActionState(side: Pick<SourceSide, 'source' | 'manual'>): SourceActionState {
  const { source, manual } = side
  if (source.connection) return { kind: 'connected', name: source.connection.name, address: source.connection.address }
  if (manual) return { kind: 'address' }
  return source.wallets.length ? { kind: 'connect', wallets: source.wallets.length } : { kind: 'none' }
}
