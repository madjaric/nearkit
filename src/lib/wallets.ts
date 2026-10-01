import type { Wallet, WalletPreset } from '@/types/domain'

/**
 * The three kinds of wallet NearKit shows, and what each may do:
 * - `nearkit`: a NearKit wallet (custody) of the signed-in Telegram user. It trades, sells and
 *   sends through NearKit's server; every value-moving action is confirmed in Telegram.
 * - `external`: an account of the wallet connected in this browser. Its own wallet signs.
 * - `watch`: observed only (balances, positions, activity). It never trades, sends, joins a
 *   Multi Buy or Multi Sell, or an executable preset.
 *
 * The services refuse a watch wallet before anything is quoted or signed, and NearKit's server
 * accepts only NearKit wallets the signed-in user owns: these helpers keep the UI in line, they
 * are not the enforcement.
 */

export type WalletSource = NonNullable<Wallet['source']>

/** A `watch` access always wins: nothing a client claims lifts it. */
export function sourceOf(w: Pick<Wallet, 'source' | 'access'>): WalletSource {
  if (w.access === 'watch' || w.source === 'watch') return 'watch'
  return w.source ?? 'external'
}

export const canExecute = (w: Pick<Wallet, 'source' | 'access'>) => sourceOf(w) !== 'watch'

/** Signed right here by the connected wallet (or the demo simulator). */
export const signsInBrowser = (w: Pick<Wallet, 'source' | 'access'>) => sourceOf(w) === 'external'

/** Executed by NearKit's server, after the user confirms in Telegram. */
export const executesViaNearKit = (w: Pick<Wallet, 'source' | 'access'>) => sourceOf(w) === 'nearkit'

/** A preset's members that can run now, and the ones left out (watch-only, or no longer listed). */
export function presetMembers(
  preset: Pick<WalletPreset, 'walletIds'>,
  wallets: readonly Wallet[],
): { executable: Wallet[]; excluded: { id: string; reason: 'watch' | 'missing' }[] } {
  const executable: Wallet[] = []
  const excluded: { id: string; reason: 'watch' | 'missing' }[] = []
  for (const id of preset.walletIds) {
    const w = wallets.find((x) => x.id === id)
    if (!w) excluded.push({ id, reason: 'missing' })
    else if (!canExecute(w)) excluded.push({ id, reason: 'watch' })
    else executable.push(w)
  }
  return { executable, excluded }
}
