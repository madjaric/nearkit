import { useState } from 'react'
import { LogoMark } from '@/components/brand/Brand'
import { KITS_CONTRACT } from '@/config/kit'
import { cn } from '@/lib/cn'
import { isImageSource } from '@/lib/imageSource'
import { useCapabilities, useTokens } from '@/services/queries'

const SIZE = { 18: 'size-[18px] text-[9px]', 20: 'size-5 text-[10px]', 24: 'size-6 text-[11px]', 28: 'size-7 text-xs', 32: 'size-8 text-sm' } as const

/**
 * A token's icon: the one in its own NEP-148 metadata (`icon`, already read with the token list, so
 * nothing more is requested), lazily, without a referrer, on the same round tile as the fallback: its
 * initial, also when the image is missing or fails to load. $KITS (its one contract, or a build's
 * stand-in) uses the NEARKITS mark. `icon` overrides the token list's (a token not in it yet).
 */
export function TokenGlyph({
  symbol,
  tokenId,
  icon,
  size = 24,
  className,
}: {
  symbol: string
  tokenId?: string
  icon?: string | null
  size?: keyof typeof SIZE
  className?: string
}) {
  const { kitContract } = useCapabilities()
  const { data: tokens } = useTokens()
  const [failed, setFailed] = useState<string | null>(null)
  if (tokenId !== undefined && (tokenId === KITS_CONTRACT || tokenId === kitContract)) return <LogoMark size={size} className={className} />
  const listed = icon === undefined && tokenId !== undefined ? tokens?.find((t) => t.id === tokenId)?.icon : icon
  const src = isImageSource(listed) && listed !== failed ? listed : null
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid shrink-0 place-items-center overflow-hidden rounded-full border border-line bg-raised font-mono font-semibold leading-none text-fg-2',
        SIZE[size],
        className,
      )}
    >
      {src ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setFailed(src)}
          className="size-full object-cover"
        />
      ) : (
        symbol.slice(0, 1)
      )}
    </span>
  )
}
