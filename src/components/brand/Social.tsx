import { SOCIAL, SOCIAL_ACCOUNTS, type SocialAccount } from '@/config/social'
import { cn } from '@/lib/cn'

/**
 * NEARKITS' two official community accounts as links (src/config/social.ts): the Telegram community
 * and X. Each link names its account in words (its accessible name), opens in a new tab and carries
 * no tracking. `nav`: two equal keys for the sidebar and the phone drawer; `inline`: small text links
 * for a page that mentions the community in passing.
 */

/** Telegram's paper plane, as Telegram draws it. */
export function TelegramMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false" className={className} fill="currentColor">
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  )
}

/** X's mark, as X draws it. */
export function XMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false" className={className} fill="currentColor">
      <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
    </svg>
  )
}

const markOf = (a: SocialAccount, size: number) => (a === SOCIAL.x ? <XMark size={size - 2} /> : <TelegramMark size={size} />)
/** What the link says on screen: short, since its accessible name says the rest. */
const shortName = (a: SocialAccount) => (a === SOCIAL.x ? 'X' : 'Telegram')

export function SocialLinks({ variant, className }: { variant: 'nav' | 'icons' | 'inline'; className?: string }) {
  // The sidebar's footer row: the marks alone, each named for assistive tech and on hover.
  if (variant === 'icons')
    return (
      <ul aria-label="NEARKITS community" className={cn('flex items-center gap-0.5', className)}>
        {SOCIAL_ACCOUNTS.map((a) => (
          <li key={a.url}>
            <a
              href={a.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={a.label}
              title={a.label}
              className="grid size-7 place-items-center rounded-sm text-fg-3 transition-colors duration-100 hover:bg-raised hover:text-fg"
            >
              {markOf(a, 14)}
            </a>
          </li>
        ))}
      </ul>
    )
  if (variant === 'nav')
    return (
      <ul aria-label="NEARKITS community" className={cn('grid grid-cols-2 gap-1', className)}>
        {SOCIAL_ACCOUNTS.map((a) => (
          <li key={a.url}>
            <a
              href={a.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={a.label}
              title={a.label}
              className="flex h-9 items-center justify-center gap-2 rounded-md text-sm text-fg-2 transition-colors duration-100 hover:bg-raised/60 hover:text-fg"
            >
              {markOf(a, 15)}
              <span>{shortName(a)}</span>
            </a>
          </li>
        ))}
      </ul>
    )
  return (
    <p className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-3', className)}>
      <span>Community</span>
      {SOCIAL_ACCOUNTS.map((a) => (
        <a
          key={a.url}
          href={a.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={a.label}
          className="inline-flex items-center gap-1.5 text-fg-2 underline decoration-fg-4 underline-offset-2 hover:text-fg"
        >
          {markOf(a, 13)}
          {a === SOCIAL.x ? SOCIAL.x.handle : 'NEARKITS Community'}
        </a>
      ))}
    </p>
  )
}
