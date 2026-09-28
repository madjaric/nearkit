import { useState } from 'react'
import { useLocation, useSearchParams } from 'react-router'
import { AccountText } from '@/components/domain/Account'
import { SimMark } from '@/components/domain/SimMark'
import { TokenGlyph } from '@/components/domain/TokenGlyph'
import { Page, PageHeader } from '@/components/page/Page'
import { CopyButton } from '@/components/ui/Copy'
import { Led, Skeleton, Tag } from '@/components/ui/Indicators'
import { Amount, Pct, Price } from '@/components/ui/Num'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { ReadoutSlot, ReadoutStrip } from '@/components/ui/Readout'
import { Table, Td, Th, Tr } from '@/components/ui/Table'
import { SwapTicket } from '@/features/trade/SwapTicket'
import { cn } from '@/lib/cn'
import { NEARKIT_FEE_LABEL } from '@/lib/fees'
import { formatPrice, formatUsdCompact } from '@/lib/format'
import { NATIVE_TOKEN_ID } from '@/config/networks'
import { useDefaultTradeToken } from '@/features/trade/useDefaultToken'
import { useCapabilities, useHoldings, useSession, useTokens, useWallets } from '@/services/queries'
import type { TokenId, TokenListing } from '@/types/domain'

const NEAR = NATIVE_TOKEN_ID

function MarketPanel({ token }: { token: TokenListing }) {
  const caps = useCapabilities()
  const m = token.market
  return (
    <Panel>
      <PanelHeader
        title={
          <span className="flex items-center gap-2">
            <TokenGlyph symbol={token.symbol} tokenId={token.id} size={18} />
            {token.symbol} market
          </span>
        }
        actions={
          token.status === 'prelaunch' ? (
            <Tag tone="warn">Pre-launch</Tag>
          ) : (
            <Tag tone="neutral">{caps.mode === 'demo' ? 'Demo' : caps.prices ? 'Rhea prices' : 'No USD price'}</Tag>
          )
        }
      />
      <ReadoutStrip cols="grid-cols-2" className="rounded-none border-0">
        <ReadoutSlot
          legend="Price"
          value={
            m ? (
              <>
                <Price value={m.priceUsd} />
                {token.status === 'prelaunch' && <SimMark />}
              </>
            ) : (
              '—'
            )
          }
          sub={m ? <Pct value={m.change24hPct} /> : ''}
        />
        <ReadoutSlot legend="Price in NEAR" value={m ? formatPrice(m.priceNear) : '—'} sub="NEAR per token" />
        <ReadoutSlot
          legend="Liquidity"
          value={m && m.liquidityUsd !== null ? formatUsdCompact(m.liquidityUsd) : '—'}
          sub={caps.mode === 'demo' ? 'pool depth (demo)' : 'not reported by the price feed'}
        />
        <ReadoutSlot
          legend="24h volume"
          value={m && m.volume24hUsd !== null ? formatUsdCompact(m.volume24hUsd) : '—'}
          sub={caps.mode === 'demo' ? 'all venues (demo)' : 'not reported by the price feed'}
        />
      </ReadoutStrip>
      <div className="flex items-center justify-between gap-3 border-t border-line-soft px-4 py-2.5 text-xs">
        <span className="legend">Contract</span>
        {token.contract ? (
          <span className="flex min-w-0 items-center gap-1">
            <AccountText id={token.contract} className="text-fg-2" />
            <CopyButton value={token.contract} label="Copy contract" />
          </span>
        ) : (
          <span className="text-fg-3">Not deployed yet</span>
        )}
      </div>
    </Panel>
  )
}

function WalletBalances({ fromId, toId, walletId, onPick }: { fromId: TokenId; toId: TokenId; walletId: string; onPick: (id: string) => void }) {
  const { data: wallets = [], isPending } = useWallets()
  const { data: holdings = [] } = useHoldings()
  const { data: tokens = [] } = useTokens()
  const bal = (w: string, t: string) => holdings.find((h) => h.walletId === w && h.tokenId === t)?.amount ?? 0
  const cols = [...new Set([NEAR, fromId, toId])]
  const symbol = (id: string) => tokens.find((t) => t.id === id)?.symbol ?? ''

  return (
    <Panel>
      <PanelHeader title="Balances by wallet" meta={wallets.length || undefined} />
      {isPending ? (
        <div className="p-4">
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <div className="max-h-[26rem] overflow-y-auto">
          <Table label="Balances by wallet" rows="double">
            <thead className="sticky top-0 z-[1] bg-panel">
              <tr>
                <Th>Wallet</Th>
                {cols.map((c) => (
                  <Th key={c} align="right">
                    {symbol(c)}
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {wallets.map((w) => {
                const active = w.id === walletId
                return (
                  <Tr key={w.id} className={cn(active && 'bg-raised/70')}>
                    <Td>
                      <button type="button" aria-pressed={active} onClick={() => onPick(w.id)} className="flex items-center gap-2 text-left">
                        <Led tone={active ? 'on' : 'off'} />
                        <span className="flex flex-col">
                          <span className={cn('text-sm', active ? 'text-fg' : 'text-fg-2')}>{w.label}</span>
                          <AccountText id={w.accountId} className="text-[11px] text-fg-4" />
                        </span>
                      </button>
                    </Td>
                    {cols.map((c) => (
                      <Td key={c} align="right">
                        <Amount value={bal(w.id, c)} minDecimals={c === NEAR ? 2 : 0} className={bal(w.id, c) > 0 ? 'text-fg-2' : 'text-fg-4'} />
                      </Td>
                    ))}
                  </Tr>
                )
              })}
            </tbody>
          </Table>
        </div>
      )}
      <p className="border-t border-line-soft px-4 py-2.5 text-xs text-fg-3">Select a wallet to trade from it.</p>
    </Panel>
  )
}

function SwapScreen({ initialFrom, initialTo }: { initialFrom: TokenId; initialTo: TokenId }) {
  const caps = useCapabilities()
  const [pair, setPair] = useState({ from: initialFrom, to: initialTo })
  const { data: session } = useSession()
  // Trade from the connected account unless the user picks another wallet.
  const [picked, setWalletId] = useState<string | null>(null)
  const walletId = picked ?? session?.walletId ?? ''
  const { data: tokens = [] } = useTokens()
  const subjects = [pair.from, pair.to]
    .filter((id) => id !== NEAR)
    .map((id) => tokens.find((t) => t.id === id))
    .filter((t): t is TokenListing => Boolean(t))

  return (
    <Page>
      <PageHeader
        title="Swap"
        description={
          caps.mode === 'demo'
            ? `Trade any listed token. Every demo swap is priced through NEAR, with the ${NEARKIT_FEE_LABEL} NearKit fee shown on that NEAR leg.`
            : 'Trade any NEP-141 token through Rhea. The route is quoted again right before you sign, and every fee is shown in the review.'
        }
      />
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,480px)_minmax(0,1fr)]">
        <SwapTicket fromId={pair.from} toId={pair.to} onPairChange={(from, to) => setPair({ from, to })} walletId={walletId} onWalletChange={setWalletId} />
        <div className="flex min-w-0 flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
            {subjects.map((t) => (
              <MarketPanel key={t.id} token={t} />
            ))}
          </div>
          {session && <WalletBalances fromId={pair.from} toId={pair.to} walletId={walletId} onPick={setWalletId} />}
        </div>
      </div>
    </Page>
  )
}

export default function SwapPage() {
  const [params] = useSearchParams()
  const location = useLocation()
  const defaultToken = useDefaultTradeToken()
  const requested = params.get('to') ?? params.get('token')
  const token = requested ?? defaultToken
  const sell = params.get('side') === 'sell'
  // Remount on a new query (e.g. from search) so the ticket starts from the requested pair,
  // and once the default token resolves, so a slow token list never leaves it on NEAR → NEAR.
  return <SwapScreen key={`${location.search}|${requested ? '' : defaultToken}`} initialFrom={sell ? token : NEAR} initialTo={sell ? NEAR : token} />
}
