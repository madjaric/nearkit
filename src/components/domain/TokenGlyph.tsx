import { LogoMark } from '@/components/brand/Brand'
import { cn } from '@/lib/cn'
import { useCapabilities } from '@/services/queries'

const SIZE = { 18: 'size-[18px] text-[9px]', 20: 'size-5 text-[10px]', 24: 'size-6 text-[11px]', 28: 'size-7 text-xs', 32: 'size-8 text-sm' } as const

/**
 * Token monogram. NearKit ships no third-party logos: each token gets a neutral
 * round tile with its initial. $KIT (the demo token, or the configured contract) uses the NearKit mark.
 */
export function TokenGlyph({ symbol, tokenId, size = 24, className }: { symbol: string; tokenId?: string; size?: keyof typeof SIZE; className?: string }) {
  const { kitContract } = useCapabilities()
  if (tokenId !== undefined && (tokenId === 'kit' || tokenId === kitContract)) return <LogoMark size={size} className={className} />
  return (
    <span
      aria-hidden="true"
      className={cn('grid shrink-0 place-items-center rounded-full border border-line bg-raised font-mono font-semibold leading-none text-fg-2', SIZE[size], className)}
    >
      {symbol.slice(0, 1)}
    </span>
  )
}
