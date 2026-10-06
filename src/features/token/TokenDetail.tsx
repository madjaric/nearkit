import { ExternalLink } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Link } from 'react-router'
import { CandleChart } from '@/components/chart/CandleChart'
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
import { ReadoutSlot, ReadoutStrip } from '@/components/ui/Readout'
import { NATIVE_TOKEN_ID } from '@/config/networks'
import { cn } from '@/lib/cn'
import { formatUnits, formatUnitsShown } from '@/lib/amounts'
import { formatAccount, formatAgo, formatAmount, formatCompact, formatDateTime, formatUsdCompact, formatUsdPrice } from '@/lib/format'
import { useNow, useTokenHead } from '@/lib/hooks'
import { canExecute, executesViaNearKit } from '@/lib/wallets'
import { describeError } from '@/services/errors'
import { CHART_RANGES } from '@/services/near/candles'
import { explorerTokenUrl, explorerTxUrl } from '@/services/near/explorer'
import {
  useCapabilities,
  useHoldings,
  useImportToken,
  usePriceHistory,
  useTokenActivity,
  useTokenLookup,
  useTokenMarket,
  useTokens,
  useTotalSupply,
  useWallets,
} from '@/services/queries'
import { useTradeDrawer } from '@/state/contexts'
import type { ChartRange, Holding, MarketFigure, Token } from '@/types/domain'
import { axisTime, chartView } from './chartView'
import { livePrices, recordPrice, subscribeLivePrices } from './livePrices'
import { SendTokenButton } from './SendToken'

/**
 * A token's screen: its market figures (price, 24h change, market cap, FDV, liquidity, volume),
 * each from a source that has it or saying why it's missing; a chart of real market prices
 * (a history source's candles, then the live price); its recent trades; the user's balance; and
 * Buy, Sell and Send through the flows NearKit already has. Four things are kept apart here:
 * that the token exists on chain, that it has a market, that Rhea can route a given trade (the
 * quote decides that, in the ticket), and that it is in the user's own token list.
 */

const RANGES: readonly ChartRange[] = ['1H', '4H', '1D', '1W', '1M', 'ALL']
const rangeLabel = (r: ChartRange) => (r === 'ALL' ? 'All' : r)
const rangeText = (r: ChartRange) => (r === 'ALL' ? 'all its history' : `last ${r}`)

/** The token for a route id: listed, else read on chain by its contract (nothing saved). */
export function TokenDetail({ tokenId }: { tokenId: string }) {
  const tokens = useTokens()
  const listed = tokens.data?.find((t) => t.id === tokenId) ?? null
  const lookup = useTokenLookup(tokens.data && !listed && tokenId !== NATIVE_TOKEN_ID ? tokenId : null)
  const token: Token | null = listed ?? lookup.data ?? null
  const loading = tokens.isPending || lookup.isFetching
  useTokenHead(loading ? 'loading' : !token ? 'missing' : listed ? 'listed' : 'unlisted', token?.symbol, token?.name)
  if (loading)
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
          {lookup.error ? describeError(lookup.error).message : `NEARKITS can't find a token named ${tokenId}.`}
        </EmptyState>
      </Panel>
    )
  return <TokenScreen token={token} inList={listed !== null} />
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

const valueOf = (f: MarketFigure | undefined): number | null => (f && (f.state === 'known' || f.state === 'stale') ? f.value : null)

/** The line under a figure: its source and age, or that it's missing (the full reason is its title, and in Details). */
function figureSub(f: MarketFigure | undefined, now: number): { text: string; title?: string } {
  if (!f) return { text: '' }
  if (f.state === 'known') return { text: `${f.source} · ${formatAgo(f.at, now)}` }
  if (f.state === 'stale') return { text: `${f.source} · stale, ${formatAgo(f.at, now)}`, title: f.reason }
  if (f.state === 'unavailable') return { text: 'Unavailable', title: f.reason }
  return { text: 'Not applicable', title: f.reason }
}

/** A parenthetical in a source's name is detail for Details, not for a card's caption. */
const shortSource = (source: string) => source.replace(/\s*\([^)]*\)\s*$/, '')

/**
 * The caption of a figure's card: where it comes from and how old it is, or that it's missing.
 * On a narrow card the age takes its own line, and every card of the row does, so their values
 * stay level. The source in full, and why a figure is stale or missing, is the title, and in Details.
 */
function FigureCaption({ figure, now }: { figure: MarketFigure | undefined; now: number }) {
  if (!figure) return null
  if (figure.state === 'unavailable' || figure.state === 'not-applicable')
    return (
      <span title={figure.reason}>
        {figure.state === 'unavailable' ? 'Unavailable' : 'Not applicable'}
        <span aria-hidden="true" className="block @[9.5rem]:hidden">
          &nbsp;
        </span>
      </span>
    )
  const stale = figure.state === 'stale'
  return (
    <span title={stale ? `${figure.source}: ${figure.reason}` : figure.source}>
      {shortSource(figure.source)}
      <span aria-hidden="true" className="hidden @[9.5rem]:inline">
        {' · '}
      </span>
      <span className={cn('block @[9.5rem]:inline', stale && 'text-warn')}>{stale ? `stale, ${formatAgo(figure.at, now)}` : formatAgo(figure.at, now)}</span>
    </span>
  )
}

/** The figure's whole story, for Details. */
function figureNote(f: MarketFigure | undefined, now: number): string {
  if (!f) return '…'
  if (f.state === 'known') return `${f.source}, updated ${formatAgo(f.at, now)}`
  if (f.state === 'stale') return `${f.source}, last updated ${formatAgo(f.at, now)}; ${f.reason}`
  if (f.state === 'unavailable') return `Unavailable: ${f.reason}`
  return `Not applicable: ${f.reason}`
}

const candleLabel = (sec: number) => (sec % 3600 === 0 ? `${sec / 3600}-hour` : `${sec / 60}-minute`)

function TokenScreen({ token, inList }: { token: Token; inList: boolean }) {
  const caps = useCapabilities()
  const { openTrade } = useTradeDrawer()
  const now = useNow(1000)
  const [range, setRange] = useState<ChartRange>('1H')
  const market = useTokenMarket(token.id)
  const history = usePriceHistory(token.id, range)
  const supply = useTotalSupply(token.isNative ? null : token.id)
  const activity = useTokenActivity(token.id)
  const importer = useImportToken()
  const { data: wallets = [] } = useWallets()
  const { data: holdings = [] } = useHoldings()
  const live = useSyncExternalStore(
    subscribeLivePrices,
    () => livePrices(token.id),
    () => livePrices(token.id),
  )

  const m = market.data
  const price = m?.priceUsd
  const priceValue = valueOf(price)
  // Each price a source reports is one observation, at the time it reported it: the live end of the line.
  useEffect(() => {
    if (price && (price.state === 'known' || price.state === 'stale')) recordPrice(token.id, price.value, price.at)
  }, [token.id, price])

  const native = token.id === NATIVE_TOKEN_ID
  // A refresh that fails keeps the history already read (its error is said below the chart); only with none at all is the line the observed one.
  const view = history.data === undefined && !history.isError ? null : chartView(range, now, history.data ?? null, live)
  // The history source's own candles in this window (none made up): drawn as candles; without them, the line of observed prices.
  const windowStart = now - CHART_RANGES[range].windowMs
  const h = view?.source === 'history' ? history.data : undefined
  const candles = h ? h.candles.filter((c) => c.t + h.candleSec * 1000 > windowStart && c.t <= now) : []
  const volumeText = (v: number) => (h?.volumeUnit === 'USD' ? formatUsdCompact(v, 1) : h?.volumeUnit === 'NEAR' ? `${formatCompact(v)} NEAR` : formatCompact(v))
  const byId = new Map(wallets.map((w) => [w.id, w]))
  const held = holdings.filter((h) => h.tokenId === token.id && h.amount > 0)
  const rows = held.flatMap((h) => {
    const wallet = byId.get(h.walletId)
    return wallet ? [{ holding: h, wallet }] : []
  })
  const nearkitWallets = wallets.some(executesViaNearKit)
  const pair = m?.pair ?? null

  const noPrice =
    price && (price.state === 'unavailable' || price.state === 'not-applicable')
      ? price.reason
      : market.isError
        ? 'The market sources aren’t answering; NEARKITS asks again shortly.'
        : ''

  const chartNote = (): string => {
    if (!view) return ''
    const first = view.points[0]
    const h = history.data
    if (view.source === 'history' && h) {
      const start = now - CHART_RANGES[range].windowMs
      const began =
        h.since !== null && h.since > start
          ? ` This market began ${formatDateTime(h.since)}.`
          : range === 'ALL' && first
            ? ` The earliest history ${h.source.name} keeps for it starts ${formatDateTime(first.t)}.`
            : view.partial && first
              ? ` This window has data from ${formatDateTime(first.t)}.`
              : ''
      if (h.candles.length === 0 && h.source.name !== 'CoinGecko' && h.points.filter((p) => p.t >= start).length === 0)
        return `No trades on ${h.source.market} in this window: the line shows only the prices this page has seen${first ? `, since ${formatDateTime(first.t)}` : ''}.`
      if (h.candles.length === 0) return `${h.source.market}: prices from ${h.source.name}, then the live price this page sees. Nothing between two prices is filled in.${began}`
      return candles.length > 0
        ? `${h.source.market}: ${candleLabel(h.candleSec)} candles (open, high, low, close${h.volumeUnit ? `, volume in ${h.volumeUnit}` : ''}) from ${h.source.name}; the dashed line is the live price. A candle exists only for a period with trades; gaps aren’t filled in.${began}`
        : `${h.source.market}: ${candleLabel(h.candleSec)} candle closes from ${h.source.name}, then the live price. A candle exists only for a period with trades; gaps aren’t filled in.${began}`
    }
    return `History unavailable: no market-history source indexes ${token.symbol}${native ? '' : ' yet (no DEX pool on GeckoTerminal or DEX Screener, and not listed on CoinGecko)'}. The line shows only the prices this page has seen${first ? `, since ${formatDateTime(first.t)}` : ''}: that is when this page started watching, not when the market began.`
  }

  const chartEmpty = (): string => {
    if (!view) return ''
    const only = view.points[0]
    if (history.data && view.source === 'history') {
      if (only) return `One candle with trades in this window: ${formatUsdPrice(only.usd)} at ${formatDateTime(only.t)}. Nothing to draw a line through yet.`
      return `No trades in this window on ${history.data.source.market}.`
    }
    if (only) return `One price so far: ${formatUsdPrice(only.usd)} at ${formatDateTime(only.t)}. The line starts with the next one.`
    return priceValue !== null ? 'No price points in this window yet.' : 'Price unavailable: nothing to draw.'
  }

  const figures: { key: string; label: ReactNode; figure: MarketFigure | undefined; format: (v: number) => string }[] = [
    { key: 'mcap', label: 'Market cap', figure: m?.marketCapUsd, format: (v) => formatUsdCompact(v, 2) },
    {
      key: 'fdv',
      label: (
        <>
          FDV <InfoTip term="fdv" />
        </>
      ),
      figure: m?.fdvUsd,
      format: (v) => formatUsdCompact(v, 2),
    },
    { key: 'liq', label: 'Liquidity', figure: m?.liquidityUsd, format: (v) => formatUsdCompact(v, 2) },
    { key: 'vol', label: '24h volume', figure: m?.volume24hUsd, format: (v) => formatUsdCompact(v, 2) },
  ]

  return (
    <div className="flex flex-col gap-4">
      <Panel className="@container flex flex-col gap-4 p-4 sm:p-5">
        {/* Name and price sit side by side where the panel has room; on a phone the price goes under the name, aligned with it. */}
        <div className="flex flex-col gap-3 @[34rem]:flex-row @[34rem]:items-start @[34rem]:justify-between @[34rem]:gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <TokenGlyph symbol={token.symbol} tokenId={token.id} size={32} />
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-lg font-semibold text-fg">
                {token.symbol}
                {token.status === 'prelaunch' && <Tag tone="warn">Pre-launch</Tag>}
              </h2>
              <p className="truncate text-sm text-fg-3">
                {token.name}
                {token.contract && (
                  <>
                    <span aria-hidden="true"> · </span>
                    <span className="num text-xs text-fg-4">{token.contract}</span>
                  </>
                )}
              </p>
            </div>
          </div>
          <div className="min-w-0 @[34rem]:max-w-[55%] @[34rem]:text-right" aria-live="polite">
            {market.isPending ? (
              <Skeleton className="h-8 w-36 @[34rem]:ml-auto" />
            ) : priceValue !== null ? (
              <p className="num text-2xl text-fg" aria-label={`${token.symbol} price`}>
                {formatUsdPrice(priceValue)}
              </p>
            ) : (
              <p className="text-lg text-fg-3">Price unavailable</p>
            )}
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-fg-3 @[34rem]:justify-end">
              {valueOf(m?.change24hPct) !== null && (
                <>
                  <Pct value={valueOf(m?.change24hPct) as number} /> <span>24h</span> <span aria-hidden="true">·</span>
                </>
              )}
              {price && priceValue !== null ? <span title={figureSub(price, now).title}>{figureSub(price, now).text}</span> : <span>{market.isPending ? '' : noPrice}</span>}
            </p>
          </div>
        </div>

        {pair && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
            <span>
              Market: <span className="text-fg-2">{`${pair.baseSymbol}/${pair.quoteSymbol} on ${pair.dex}`}</span>
            </span>
            {pair.txns24h && (
              <>
                <span aria-hidden="true">·</span>
                <Figures>{`${pair.txns24h.buys} buys / ${pair.txns24h.sells} sells in 24h`}</Figures>
              </>
            )}
            {pair.createdAt !== null && (
              <>
                <span aria-hidden="true">·</span>
                <span>since {formatDateTime(pair.createdAt)}</span>
              </>
            )}
            {pair.url && (
              <>
                <span aria-hidden="true">·</span>
                <a href={pair.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-fg-2 hover:text-fg">
                  DEX Screener <ExternalLink size={11} aria-hidden="true" />
                </a>
              </>
            )}
          </p>
        )}

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
              With NEARKITS wallets:{' '}
              <Link className="text-fg-2 underline-offset-2 hover:underline" to={`/multi-trade?side=buy&token=${encodeURIComponent(token.id)}`}>
                Multi buy
              </Link>{' '}
              ·{' '}
              <Link className="text-fg-2 underline-offset-2 hover:underline" to={`/multi-trade?side=sell&token=${encodeURIComponent(token.id)}`}>
                Multi sell
              </Link>
            </span>
          )}
          {/* The user's own list is just that: being in it changes nothing about the token's market or whether Rhea routes it. */}
          {!inList && token.contract && (
            <span className="ml-auto flex items-center gap-2 text-xs text-fg-3">
              <span>Not in your token list</span>
              <Button size="xs" variant="ghost" loading={importer.isPending} disabled={importer.isPending} onClick={() => importer.mutate(token.contract as string)}>
                Add {token.symbol}
              </Button>
            </span>
          )}
        </div>
        {importer.isError && (
          <p className="text-xs text-neg" role="alert">
            {describeError(importer.error).message}
          </p>
        )}
      </Panel>

      {/* The market's figures, as the page's stat cards: on the canvas like the Dashboard's, never inside the panel above. */}
      <ReadoutStrip>
        {figures.map((f) => {
          const v = valueOf(f.figure)
          return (
            <ReadoutSlot
              key={f.key}
              legend={f.label}
              loading={market.isPending}
              value={v !== null ? f.format(v) : <span className="text-fg-3">—</span>}
              sub={<FigureCaption figure={f.figure} now={now} />}
            />
          )
        })}
      </ReadoutStrip>

      <Panel>
        <PanelHeader
          title="Price"
          actions={<Segmented label="Chart window" size="sm" value={range} onChange={setRange} options={RANGES.map((r) => ({ value: r, label: rangeLabel(r) }))} />}
        />
        <div className="flex flex-col gap-2 p-4">
          {!view ? (
            <Skeleton className="h-[300px] w-full" />
          ) : candles.length > 0 && h ? (
            <CandleChart
              key={range}
              candles={candles}
              start={windowStart}
              end={now}
              candleSec={h.candleSec}
              live={priceValue}
              label={`${token.symbol} price, ${rangeText(range)}`}
              formatPrice={formatUsdPrice}
              formatTime={formatDateTime}
              formatAxis={axisTime(range)}
              formatVolume={volumeText}
              height={300}
            />
          ) : view.points.length >= 2 ? (
            <ValueTrace
              key={range}
              points={view.points.map((p) => ({ t: p.t, v: p.usd }))}
              timeScale
              label={`${token.symbol} price, ${rangeText(range)}`}
              formatValue={formatUsdPrice}
              formatTick={formatUsdPrice}
              formatTime={formatDateTime}
              formatAxis={axisTime(range)}
              height={220}
            />
          ) : (
            <p className="py-16 text-center text-sm text-fg-3">
              <Figures>{chartEmpty()}</Figures>
            </p>
          )}
          {history.isError && (
            <p className="text-xs text-warn" role="alert">
              {history.data
                ? `The last refresh of this history failed (${describeError(history.error).message}): what was read before stays. NEARKITS asks again shortly.`
                : `Price history can’t be read right now (${describeError(history.error).message}). NEARKITS asks again shortly.`}
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
          <p className="px-4 py-6 text-center text-sm text-fg-3">Recent trades can’t be read right now. NEARKITS asks again shortly.</p>
        ) : !activity.data || activity.data.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-fg-3">No recent trading activity available.</p>
        ) : (
          <ul className="divide-y divide-line-soft" aria-label={`Recent ${token.symbol} trades`}>
            {activity.data.slice(0, 25).map((t) => (
              <li
                key={`${t.hash}-${t.account}-${t.side}`}
                className="grid grid-cols-[3rem_auto_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 px-4 py-2 text-sm sm:grid-cols-[3rem_9rem_minmax(0,1fr)_minmax(0,9rem)_4.5rem]"
              >
                <span className={t.side === 'buy' ? 'keycap text-2xs text-accent' : 'keycap text-2xs text-neg'}>{t.side === 'buy' ? 'Buy' : 'Sell'}</span>
                <span className="num whitespace-nowrap text-fg">{`${formatUnitsShown(BigInt(t.near), 24, 4)} NEAR`}</span>
                <span className="num truncate text-right text-fg-2 sm:text-left">{`${formatUnitsShown(BigInt(t.amount), token.decimals, 2)} ${token.symbol}`}</span>
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
        <div className="grid grid-cols-1 gap-x-8 gap-y-2 p-4 md:grid-cols-2 [&_dt]:shrink-0">
          <Lines>
            <Line label="Your balance" emphasis>
              <Figures>{held.length ? `${totalOf(held, native ? 24 : token.decimals)} ${token.symbol}` : `0 ${token.symbol}`}</Figures>
            </Line>
            <Line label="Contract">
              {token.contract ? (
                <span className="flex items-center justify-end gap-1">
                  <span className="num text-fg-2 sm:hidden" title={token.contract}>
                    {formatAccount(token.contract, 22)}
                  </span>
                  <AccountText id={token.contract} className="hidden text-fg-2 sm:inline" />
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
            {!supply.data && m?.supply.total !== null && m?.supply.total !== undefined && (
              <Line label="Total supply">
                <Figures>{`${formatCompact(m.supply.total, 2)} (${m.supply.source ?? 'source'})`}</Figures>
              </Line>
            )}
            {m?.supply.circulating !== null && m?.supply.circulating !== undefined && (
              <Line label="Circulating supply">
                <Figures>{`${formatCompact(m.supply.circulating, 2)} (${m.supply.source ?? 'source'})`}</Figures>
              </Line>
            )}
            {!inList && token.contract && <Line label="Your list">Not in it. Adding it keeps it in your lists and tickets; it changes nothing else.</Line>}
          </Lines>
          <Lines>
            <Line label="Price">{figureNote(m?.priceUsd, now)}</Line>
            <Line label="24h change">{figureNote(m?.change24hPct, now)}</Line>
            <Line label="Market cap">{figureNote(m?.marketCapUsd, now)}</Line>
            <Line label="FDV">{figureNote(m?.fdvUsd, now)}</Line>
            <Line label="Liquidity">{figureNote(m?.liquidityUsd, now)}</Line>
            <Line label="24h volume">{figureNote(m?.volume24hUsd, now)}</Line>
            {pair && (
              <Line label="Market">
                <span className="num break-all text-fg-2">{`${pair.id} · ${pair.dex}`}</span>
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
                  <CopyButton value={wallet.accountId} label={`Copy ${wallet.label} account`} className="size-5" />
                  {!canExecute(wallet) && <Tag tone="soon">Watch only</Tag>}
                  {executesViaNearKit(wallet) && <Tag>NEARKITS</Tag>}
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
