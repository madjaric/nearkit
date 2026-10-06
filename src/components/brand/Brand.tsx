import { cn } from '@/lib/cn'

/**
 * The NEARKITS logo, from the official artwork (brand/nearkits-logo.jpg). The mark, an instrument
 * screen with a lime slash, is drawn as vector from the official file's measurements, so it is sharp
 * at any size (scripts/brand-images.mjs draws the icons from the same shape). The wordmark is the
 * official artwork itself. Beside a mark of size s, the logo sets the wordmark ≈0.65 s tall, ≈0.26 s away.
 */
export function LogoMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 145 145" aria-hidden="true" className={cn('shrink-0', className)}>
      <rect x="2.75" y="2.75" width="139.5" height="139.5" rx="21.25" fill="#0b0c0b" stroke="#5a6166" strokeWidth="5.5" />
      <path d="M32.04 106.22 L100.04 26.88 L114.16 38.98 L46.16 118.32 Z" fill="#b6fa39" />
    </svg>
  )
}

/** Width over height of the wordmark artwork (public/brand/nearkits-wordmark-*.png). */
const WORDMARK_RATIO = 853 / 96

/** The NEARKITS wordmark as the official logo sets it: NEAR in white, KITS in lime. */
export function Wordmark({ height = 14, className }: { height?: number; className?: string }) {
  const width = Math.round(height * WORDMARK_RATIO)
  return (
    <img
      src="/brand/nearkits-wordmark-480.png"
      srcSet="/brand/nearkits-wordmark-240.png 240w, /brand/nearkits-wordmark-480.png 480w, /brand/nearkits-wordmark-853.png 853w"
      sizes={`${width}px`}
      width={width}
      height={height}
      alt="NEARKITS"
      decoding="async"
      draggable={false}
      className={cn('block shrink-0 select-none', className)}
    />
  )
}
