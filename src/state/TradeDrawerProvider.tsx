import { X } from 'lucide-react'
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { IconButton } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Dialog'
import { QuickTrade } from '@/features/trade/QuickTrade'
import { useMediaQuery } from '@/lib/hooks'
import { useTokens } from '@/services/queries'
import { TradeDrawerContext, type TradeIntent } from './contexts'

/** Any BUY / SELL key in the app opens the same ticket, prefilled, without leaving the page. */
export function TradeDrawerProvider({ children }: { children: ReactNode }) {
  const [intent, setIntent] = useState<(TradeIntent & { key: number }) | null>(null)
  const desktop = useMediaQuery('(min-width: 1024px)')
  const { data: tokens = [] } = useTokens()
  const openTrade = useCallback((next: TradeIntent) => setIntent({ ...next, key: Date.now() }), [])
  const api = useMemo(() => ({ openTrade }), [openTrade])
  const symbol = tokens.find((t) => t.id === intent?.tokenId)?.symbol

  return (
    <TradeDrawerContext.Provider value={api}>
      {children}
      <Sheet open={intent !== null} onClose={() => setIntent(null)} side={desktop ? 'right' : 'bottom'} label="Trade ticket">
        {intent && (
          <>
            <header className="flex h-12 shrink-0 items-center justify-between border-b border-line-soft px-4">
              <h2 className="text-xs font-semibold uppercase tracking-legend text-fg-2">Trade {symbol}</h2>
              <IconButton label="Close trade ticket" size="sm" onClick={() => setIntent(null)}>
                <X size={16} />
              </IconButton>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
              <QuickTrade key={intent.key} variant="bare" initialTokenId={intent.tokenId} initialSide={intent.side} />
            </div>
          </>
        )}
      </Sheet>
    </TradeDrawerContext.Provider>
  )
}
