import type { BridgeChainId } from '@/config/bridge'
import { cn } from '@/lib/cn'

/**
 * The source chains' own marks, for Bridge & Buy: Solana, Ethereum, BNB Chain, each on its brand
 * color, round like every token glyph. The paths are the chains' public logos as the CC0
 * cryptocurrency-icons set draws them (npm cryptocurrency-icons 0.18.1, svg/color); Solana's
 * three bars carry Solana's own purple-to-green gradient. Decorative: the chain's name is always
 * printed beside it.
 */

const SOLANA_BARS =
  'M9.925 19.687a.59.59 0 01.415-.17h14.366a.29.29 0 01.207.497l-2.838 2.815a.59.59 0 01-.415.171H7.294a.291.291 0 01-.207-.498l2.838-2.815zm0-10.517A.59.59 0 0110.34 9h14.366c.261 0 .392.314.207.498l-2.838 2.815a.59.59 0 01-.415.17H7.294a.291.291 0 01-.207-.497L9.925 9.17zm12.15 5.225a.59.59 0 00-.415-.17H7.294a.291.291 0 00-.207.498l2.838 2.815c.11.109.26.17.415.17h14.366a.291.291 0 00.207-.498l-2.838-2.815z'

const BNB =
  'M12.116 14.404L16 10.52l3.886 3.886 2.26-2.26L16 6l-6.144 6.144 2.26 2.26zM6 16l2.26-2.26L10.52 16l-2.26 2.26L6 16zm6.116 1.596L16 21.48l3.886-3.886 2.26 2.259L16 26l-6.144-6.144-.003-.003 2.263-2.257zM21.48 16l2.26-2.26L26 16l-2.26 2.26L21.48 16zm-3.188-.002h.002V16L16 18.294l-2.291-2.29-.004-.004.004-.003.401-.402.195-.195L16 13.706l2.293 2.293z'

export function ChainMark({ chain, size = 20, className }: { chain: BridgeChainId; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" className={cn('shrink-0', className)}>
      {chain === 'sol' && (
        <>
          <defs>
            <linearGradient id="nk-sol" x1="7" y1="23" x2="25" y2="9" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#9945FF" />
              <stop offset="1" stopColor="#14F195" />
            </linearGradient>
          </defs>
          <circle cx="16" cy="16" r="16" fill="#0E0E14" />
          <path d={SOLANA_BARS} fill="url(#nk-sol)" />
        </>
      )}
      {chain === 'eth' && (
        <>
          <circle cx="16" cy="16" r="16" fill="#627EEA" />
          <g fill="#FFF">
            <path fillOpacity=".602" d="M16.498 4v8.87l7.497 3.35z" />
            <path d="M16.498 4L9 16.22l7.498-3.35z" />
            <path fillOpacity=".602" d="M16.498 21.968v6.027L24 17.616z" />
            <path d="M16.498 27.995v-6.028L9 17.616z" />
            <path fillOpacity=".2" d="M16.498 20.573l7.497-4.353-7.497-3.348z" />
            <path fillOpacity=".602" d="M9 16.22l7.498 4.353v-7.701z" />
          </g>
        </>
      )}
      {chain === 'bsc' && (
        <>
          <circle cx="16" cy="16" r="16" fill="#F3BA2F" />
          <path fill="#FFF" d={BNB} />
        </>
      )}
    </svg>
  )
}
