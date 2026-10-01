import { ExternalLink } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Link } from 'react-router'
import { ValueTrace } from '@/components/chart/ValueTrace'
import { AccountText } from '@/components/domain/Account'
import { TokenGlyph } from '@/components/domain/TokenGlyph'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/Copy'
import { EmptyState } from '@/components/ui/EmptyState'
import { Figures } from '@/components/ui/Figures'
import { Segmented } from '@/components/ui/Form'
import { InfoTip } from '@/components/ui/Help'
import { Skeleton, Tag } from '@/components/ui/Indicators'
import { Pct } from '@/components/ui/Num'
import { Line, Lines, Panel, PanelHeader } from '@/components/ui/Panel'
import { NATIVE_TOKEN_ID } from '@/config/networks'
import { formatUnits } from '@/lib/amounts'
import { formatAccount, formatAgo, formatAmount, formatDateTime, formatUsdCompact, formatUsdPrice } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import { canExecute, executesViaNearKit } from '@/lib/wallets'
import { describeError } from '@/services/errors'
import { explorerTokenUrl, explorerTxUrl } from '@/services/near/explorer'
import { useCapabilities, useHoldings, usePriceHistory, useTokenActivity, useTokenLookup, useTokenPrice, useTokens, useTotalSupply, useWallets } from '@/services/queries'
import { useTradeDrawer } from '@/state/contexts'
import type { ChartRange, Holding, Token } from '@/types/domain'
import { RequestedToken } from '../trade/TelegramHandoff'
import { chartView } from './chartView'
import { livePrices, recordPrice, subscribeLivePrices } from './livePrices'
import { SendTokenButton } from './SendToken'

/**
 * A token's screen: its live price, a simple line of the prices that exist, the user's balance,
 * and Buy, Sell and Send through the flows NearKit already has. Only observed data: a price no
 * source reports is "Price unavailable", and a history no source has is not drawn.
 */

const RANGES: readonly ChartRange[] = ['1m', '5m', '15m', '1H', '4H', '1D']

/** The token for a route id: listed, else read on chain by its contract (nothing saved). */
export function TokenDetail({ tokenId }: { tokenId: string }) {
  const tokens = useTokens()
  const listed = tokens.data?.find((t) => t.id === tokenId) ?? null
  const lookup = useTokenLookup(tokens.data && !listed && tokenId !== NATIVE_TOKEN_ID ? tokenId : null)
  const token: Token | null = listed ?? lookup.data ?? null
  if (tokens.isPending || lookup.isFetching)
    return (
      <Panel className="p-5">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-4 h-56 w-full" />
      </Panel>
    )
  if (!token)
    return (
      <Panel>
        <EmptyState
          title="Token not found"
          action={
            <Link to="/positions" className="inline-flex">
              <Button variant="secondary" tabIndex={-1}>
                Positions
              </Button>
            </Link>
          }
        >
          {lookup.error ? describeError(lookup.error).message : `NearKit can't find a token named ${tokenId}.`}
        </EmptyState>
      </Panel>
    )
  return (
    <>
      {/* Found by its contract but in no list yet: added on request, like the swap does. */}
      {!listed && token.contract && <RequestedToken contract={token.contract} />}
      <TokenScreen token={token} />
    </>
  )
}

/** Exact total when every balance is known exactly; else the display sum. */
function totalOf(held: readonly Holding[], decimals: number): string {
  if (held.every((h) => h.raw !== undefined))
    return formatUnits(
      held.reduce((s, h) => s + BigInt(h.raw as string), 0n),
      decimals,
      { maxFraction: 6, group: true },
    )
  return formatAmount(
    held.reduce((s, h) => s + h.amount, 0),
    2,
  )
}

function TokenScreen({ token }: { token: Token }) {
  const caps = useCapabilities()
  const { openTrade } = useTradeDrawer()
  const now = useNow(1000)
  const [range, setRange] = useState<ChartRange>('1H')
  const price = useTokenPrice(token.id)
  const history = usePriceHistory(token.id, range)
  const supply = useTotalSupply(token.isNative ? null : token.id)
  const activity = useTokenActivity(token.id)
  const { data: wallets = [] } = useWallets()
  const { data: holdings = [] } = useHoldings()
  const live = useSyncExternalStore(
    subscribeLivePrices,
    () => livePrices(token.id),
    () => livePrices(token.id),
  )

  const q = price.data ?? null
  // Each price the source reports is one observation, at the time it reported it.
  useEffect(() => {
    if (q) recordPrice(token.id, q.priceUsd, q.updatedAt)
  }, [token.id, q])

  const native = token.id === NATIVE_TOKEN_ID
  const view = history.data === undefined ? null : chartView(range, now, history.data, live)
  const byId = new Map(wallets.map((w) => [w.id, w]))
  const held = holdings.filter((h) => h.tokenId === token.id && h.amount > 0)
  const rows = held.flatMap((h) => {
    const wallet = byId.get(h.walletId)
    return wallet ? [{ holding: h, wallet }] : []
  })
  const nearkitWallets = wallets.some(executesViaNearKit)
  const supplyUnits = supply.data ? Number(formatUnits(BigInt(supply.data), token.decimals)) : null
  const fdv = q && supplyUnits !== null && Number.isFinite(supplyUnits) ? supplyUnits * q.priceUsd : null
  const sourceName = native ? 'Coinbase' : 'Rhea’s price list'

  const unavailable = !caps.prices
    ? `${caps.networkLabel} has no market prices.`
    : price.isError
      ? 'The price source isn’t answering; NearKit asks again shortly.'
      : `No price source NearKit uses reports ${token.symbol} right now.`

  const chartNote = (): string => {
    if (!view) return ''
    const first = view.points[0]
    if (view.source === 'live')
      return `NearKit has no price history for ${token.symbol}: the line shows only the prices this page has seen${first ? `, since ${formatDateTime(first.t)}` : ''}. Nothing before that is drawn.`
    return `NEAR/USD history from Coinbase, then the live price.${view.partial && first ? ` This window has data from ${formatDateTime(first.t)}.` : ''}`
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel className="flex flex-col gap-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <TokenGlyph symbol={token.symbol} tokenId={token.id} size={32} />
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-lg font-semibold text-fg">
                {token.symbol}
                {token.status === 'prelaunch' && <Tag tone="warn">Pre-launch</Tag>}
              </h2>
              <p className="truncate text-sm text-fg-3">{token.name}</p>
            </div>
          </div>
          <div className="text-right" aria-live="polite">
            {price.isPending ? (
              <Skeleton className="ml-auto h-8 w-36" />
            ) : q ? (
              <p className="num text-2xl text-fg" aria-label={`${token.symbol} price`}>
                {formatUsdPrice(q.priceUsd)}
              </p>
            ) : (
              <p className="text-lg text-fg-3">Price unavailable</p>
            )}
            <p className="mt-0.5 flex items-center justify-end gap-1.5 text-xs text-fg-3">
              {q && q.change24hPct !== null && (
                <>
                  <Pct value={q.change24hPct} /> <span>24h</span> <span aria-hidden="true">·</span>
                </>
              )}
              <span>{q ? `${sourceName} · updated ${formatAgo(q.updatedAt, now)}` : price.isPending ? '' : unavailable}</span>
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {native ? (
            <p className="mr-auto text-xs text-fg-3">NEAR is the base currency: tokens are bought and sold against it.</p>
          ) : (
            <>
              <Button variant="primary" onClick={() => openTrade({ tokenId: token.id, side: 'buy' })}>
                Buy {token.symbol}
              </Button>
              <Button variant="sell" onClick={() => openTrade({ tokenId: token.id, side: 'sell' })}>
                Sell {token.symbol}
              </Button>
            </>
          )}
          <SendTokenButton token={token} label={`Send ${token.symbol}`} />
          {!native && nearkitWallets && (
            <span className="text-xs text-fg-3">
              With NearKit wallets:{' '}
              <Link className="text-fg-2 underline-offset-2 hover:underline" to={`/multi-trade?side=buy&token=${encodeURIComponent(token.id)}`}>
                Multi buy
              </Link>{' '}
              ·{' '}
              <Link className="text-fg-2 underline-offset-2 hover:underline" to={`/multi-trade?side=sell&token=${encodeURIComponent(token.id)}`}>
                Multi sell
              </Link>
            </span>
          )}
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Price" actions={<Segmented label="Chart window" size="sm" value={range} onChange={setRange} options={RANGES.map((r) => ({ value: r, label: r }))} />} />
        <div className="flex flex-col gap-2 p-4">
          {!view ? (
            <Skeleton className="h-[220px] w-full" />
          ) : view.points.length >= 2 ? (
            <ValueTrace
              key={range}
              points={view.points.map((p) => ({ t: p.t, v: p.usd }))}
              label={`${token.symbol} price, last ${range}`}
              formatValue={formatUsdPrice}
              formatTick={formatUsdPrice}
              formatTime={formatDateTime}
              height={220}
            />
          ) : (
            <p className="py-16 text-center text-sm text-fg-3">
              <Figures>
                {view.points[0]
                  ? `One price so far: ${formatUsdPrice(view.points[0].usd)} at ${formatDateTime(view.points[0].t)}. The line starts with the next one.`
                  : q
                    ? 'No price points in this window yet.'
                    : 'Price unavailable: nothing to draw.'}
              </Figures>
            </p>
          )}
          {view && view.points.length > 0 && <p className="text-xs text-fg-3">{chartNote()}</p>}
        </div>
      </Panel>

      <Panel>
        <PanelHeader
          title="Live activity"
          meta={activity.data?.length ? activity.data.length : undefined}
          actions={<span className="text-2xs text-fg-4">refreshes every 20 s</span>}
        />
        {activity.isPending ? (
          <div className="p-4">
            <Skeleton className="h-24 w-full" />
          </div>
        ) : activity.isError ? (
          <p className="px-4 py-6 text-center text-sm text-fg-3">Recent trades can’t be read right now. NearKit asks again shortly.</p>
        ) : !activity.data || activity.data.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-fg-3">No recent trading activity available.</p>
        ) : (
          <ul className="divide-y divide-line-soft" aria-label={`Recent ${token.symbol} trades`}>
            {activity.data.slice(0, 25).map((t) => (
              <li
                key={`${t.hash}-${t.account}-${t.side}`}
                className="grid grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2 text-sm sm:grid-cols-[3rem_9rem_minmax(0,1fr)_minmax(0,9rem)_4.5rem]"
              >
                <span className={t.side === 'buy' ? 'keycap text-2xs text-accent' : 'keycap text-2xs text-neg'}>{t.side === 'buy' ? 'Buy' : 'Sell'}</span>
                <span className="num text-fg">{`${formatUnits(BigInt(t.near), 24, { maxFraction: 4, group: true })} NEAR`}</span>
                <span className="num truncate text-fg-2">{`${formatUnits(BigInt(t.amount), token.decimals, { maxFraction: 2, group: true })} ${token.symbol}`}</span>
                <span className="num hidden truncate text-xs text-fg-3 sm:block" title={t.account}>
                  {formatAccount(t.account, 18)}
                </span>
                <span className="text-right text-xs text-fg-3">
                  {caps.explorerUrl ? (
                    <a
                      href={explorerTxUrl({ explorerUrl: caps.explorerUrl }, t.hash)}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="hover:text-fg"
                      title="Open the transaction"
                    >
                      {formatAgo(t.at, now)}
                    </a>
                  ) : (
                    formatAgo(t.at, now)
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="border-t border-line-soft px-4 py-2 text-[11px] text-fg-4">
          Trades against NEAR in the latest transactions of the token’s contract, read from the chain. Transfers and trades against other tokens aren’t listed.
        </p>
      </Panel>

      <Panel>
        <PanelHeader title="Details" />
        <div className="grid grid-cols-1 gap-x-8 gap-y-2 p-4 md:grid-cols-2">
          <Lines>
            <Line label="Your balance" emphasis>
              <Figures>{held.length ? `${totalOf(held, native ? 24 : token.decimals)} ${token.symbol}` : `0 ${token.symbol}`}</Figures>
            </Line>
            <Line
              label={
                <>
                  FDV <InfoTip term="fdv" />
                </>
              }
            >
              {fdv !== null ? formatUsdCompact(fdv, 2) : '—'}
            </Line>
            <Line label="Market cap">
              <span title="NearKit has no reliable circulating supply for this token, so no market cap is shown.">—</span>
            </Line>
            <Line label="24h volume">
              <span title="No price source NearKit uses reports a reliable 24h volume.">—</span>
            </Line>
          </Lines>
          <Lines>
            <Line label="Contract">
              {token.contract ? (
                <span className="flex items-center gap-1">
                  <AccountText id={token.contract} className="text-fg-2" />
                  <CopyButton value={token.contract} label={`Copy ${token.symbol} contract`} />
                  {caps.explorerUrl && (
                    <a
                      href={explorerTokenUrl({ explorerUrl: caps.explorerUrl }, token.contract)}
                      target="_blank"
                      rel="noreferrer noopener"
                      aria-label={`${token.symbol} on the explorer`}
                      className="text-fg-3 hover:text-fg"
                    >
                      <ExternalLink size={13} />
                    </a>
                  )}
                </span>
              ) : (
                <span className="text-fg-3">{native ? 'Native NEAR' : '—'}</span>
              )}
            </Line>
            <Line label="Decimals">{token.decimals}</Line>
            {supply.data && (
              <Line label="Total supply">
                <Figures>{formatUnits(BigInt(supply.data), token.decimals, { maxFraction: 2, group: true })}</Figures>
              </Line>
            )}
          </Lines>
        </div>
        {rows.length > 0 && (
          <ul className="divide-y divide-line-soft border-t border-line-soft" aria-label={`${token.symbol} by wallet`}>
            {rows.map(({ holding, wallet }) => (
              <li key={wallet.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="text-fg-2">{wallet.label}</span>
                  <AccountText id={wallet.accountId} className="text-xs text-fg-4" />
                  {!canExecute(wallet) && <Tag tone="soon">Watch only</Tag>}
                  {executesViaNearKit(wallet) && <Tag>NearKit</Tag>}
                </span>
                <span className="num text-fg-2">{formatAmount(holding.amount, 2)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}
