import { ExternalLink } from 'lucide-react'
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { PriceChartPanel } from '@/components/chart/PriceChartPanel'
import { AccountText } from '@/components/domain/Account'
import { TokenGlyph } from '@/components/domain/TokenGlyph'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/Copy'
import { EmptyState } from '@/components/ui/EmptyState'
import { Figures } from '@/components/ui/Figures'
import { InfoTip } from '@/components/ui/Help'
import { Skeleton, Tag } from '@/components/ui/Indicators'
import { Pct } from '@/components/ui/Num'
import { Line, Lines, Panel, PanelHeader } from '@/components/ui/Panel'
import { ReadoutSlot, ReadoutStrip } from '@/components/ui/Readout'
import { NATIVE_TOKEN_ID } from '@/config/networks'
import { CANDLE_INTERVAL_SEC, CANDLE_INTERVALS, defaultInterval, INTERVAL_LABEL, INTERVAL_TEXT, parseInterval, SOURCE_INTERVALS, type CandleInterval } from '@/lib/chart/intervals'
import { normalizeCandles } from '@/lib/chart/ohlc'
import { cn } from '@/lib/cn'
import { formatUnits, formatUnitsShown } from '@/lib/amounts'
import { formatAccount, formatAgo, formatAmount, formatCompact, formatDateTime, formatUsdCompact, formatUsdPrice } from '@/lib/format'
import { useNow, useTokenHead } from '@/lib/hooks'
import { canExecute, executesViaNearKit } from '@/lib/wallets'
import { describeError } from '@/services/errors'
import { explorerTokenUrl, explorerTxUrl } from '@/services/near/explorer'
import {
  useCapabilities,
  useHoldings,
  useImportToken,
  useTokenActivity,
  useTokenCandles,
  useTokenLookup,
  useTokenMarket,
  useTokens,
  useTotalSupply,
  useWallets,
} from '@/services/queries'
import { useTradeDrawer } from '@/state/contexts'
import type { Candle, Holding, MarketFigure, PricePoint, Token } from '@/types/domain'
import { linePoints } from './chartView'
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

const EMPTY_CANDLES: readonly Candle[] = Object.freeze([])
const EMPTY_POINTS: readonly PricePoint[] = Object.freeze([])

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

function TokenScreen({ token, inList }: { token: Token; inList: boolean }) {
  const caps = useCapabilities()
  const { openTrade } = useTradeDrawer()
  const now = useNow(1000)
  const [params, setParams] = useSearchParams()
  const market = useTokenMarket(token.id)
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
  const pair = m?.pair ?? null
  const byId = new Map(wallets.map((w) => [w.id, w]))
  const held = holdings.filter((h) => h.tokenId === token.id && h.amount > 0)
  const rows = held.flatMap((h) => {
    const wallet = byId.get(h.walletId)
    return wallet ? [{ holding: h, wallet }] : []
  })
  const nearkitWallets = wallets.some(executesViaNearKit)

  const noPrice =
    price && (price.state === 'unavailable' || price.state === 'not-applicable')
      ? price.reason
      : market.isError
        ? 'The market sources aren’t answering; NEARKITS asks again shortly.'
        : ''

  // The chart, as on Launch Radar: candles at an interval, as much history as one read of the source holds.
  // The interval: the one in the address, else the market's age decides (a token waits for its market to know it).
  const chosen = parseInterval(params.get('interval'))
  const age = pair?.createdAt != null && market.dataUpdatedAt > 0 ? market.dataUpdatedAt - pair.createdAt : null
  const interval = chosen ?? defaultInterval(age)
  const history = useTokenCandles(token.id, interval, native || chosen !== null || !market.isPending)
  const onInterval = (i: CandleInterval) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p)
        n.set('interval', i)
        return n
      },
      { replace: true },
    )
  // undefined: not read yet; null: no source has this token's history (the line is the prices this page has seen).
  const tc = history.data
  const read = useMemo(() => (tc?.kind === 'candles' ? normalizeCandles(tc.candles) : null), [tc])
  const candles = read?.candles ?? EMPTY_CANDLES
  const dropped = read ? (read.dropped.invalid ?? 0) + (read.dropped.time ?? 0) + (read.dropped.duplicate ?? 0) : 0
  const lineSource = tc === null ? EMPTY_POINTS : tc?.kind === 'line' ? tc.points : null
  const line = useMemo(() => (lineSource ? linePoints(lineSource, live, now) : null), [lineSource, live, now])
  const isLine = line !== null
  const offered = tc ? tc.supported.includes(interval) : true
  // What each source has: an interval it doesn't have stays in the control, disabled, saying so.
  const supported = tc ? tc.supported : native ? SOURCE_INTERVALS.Coinbase : pair ? SOURCE_INTERVALS.GeckoTerminal : null
  const sourceName = tc ? tc.source.name : native ? 'Coinbase' : 'GeckoTerminal'
  // Why there is no history at all: the demo simulates prices; a network without market prices has none; else no source indexes the token.
  const noHistory =
    caps.mode === 'demo'
      ? 'The demo simulates prices only: it has no market history'
      : price?.state === 'not-applicable'
        ? price.reason.replace(/.$/, '')
        : `No market-history source has ${token.symbol}${native ? '' : ' (no DEX pool on GeckoTerminal or DEX Screener, and not listed on CoinGecko)'}`
  const unavailable =
    tc === null
      ? Object.fromEntries(CANDLE_INTERVALS.map((i) => [i, `${noHistory}, so there are no candles to choose from.`]))
      : supported
        ? Object.fromEntries(
            CANDLE_INTERVALS.filter((i) => !supported.includes(i)).map((i) => [
              i,
              `${sourceName} has no ${INTERVAL_TEXT[i]} ${tc?.kind === 'line' ? 'prices' : 'candles'} for ${token.symbol}.`,
            ]),
          )
        : undefined
  const volumeText = (v: number) => (tc?.volumeUnit === 'USD' ? formatUsdCompact(v, 1) : tc?.volumeUnit === 'NEAR' ? `${formatCompact(v)} NEAR` : formatCompact(v))
  const shownLine = line && line.length >= 2 ? line : EMPTY_POINTS
  const first = isLine ? shownLine[0] : candles[0]

  const chartEmpty = (): string => {
    if (tc && !offered)
      return `${tc.source.name} has no ${INTERVAL_TEXT[interval]} ${tc.kind === 'line' ? 'prices' : 'candles'} for ${tc.source.market}. Choose ${tc.supported.map((i) => INTERVAL_LABEL[i]).join(', ')}.`
    if (tc?.kind === 'candles') return `No ${INTERVAL_TEXT[interval]} candles for ${token.symbol} on ${tc.source.market} yet: a period without trades has no candle.`
    if (tc?.kind === 'line') return `No ${INTERVAL_TEXT[interval]} prices for ${token.symbol} from ${tc.source.name} yet.`
    const only = line?.[0]
    if (only) return `One price so far: ${formatUsdPrice(only.usd)} at ${formatDateTime(only.t)}. The line starts with the next one.`
    return priceValue !== null ? 'No price seen yet.' : 'Price unavailable: nothing to draw.'
  }

  const chartNote = (): string | undefined => {
    if (tc === undefined || (tc && !offered)) return undefined
    if (tc === null) return first ? `${noHistory}: the line shows only the prices this page has seen, since ${formatDateTime(first.t)}, not the market’s history.` : `${noHistory}.`
    if (tc.kind === 'line')
      return `${tc.source.market}: ${INTERVAL_TEXT[interval]} prices from ${tc.source.name} (it has no candles for this token), then the live price this page sees. Nothing between two prices is filled in. Drag to pan, scroll or pinch to zoom.`
    const n = candles.length
    return `${tc.source.market}: ${INTERVAL_TEXT[interval]} candles (open, high, low, close${tc.volumeUnit ? `, volume in ${tc.volumeUnit}` : ''}) from ${tc.source.name}${first ? `: ${n} from ${formatDateTime(first.t)}` : ''}; the dashed line is the live price. A period without trades has no candle; nothing is filled in.${tc.since !== null ? ` This market began ${formatDateTime(tc.since)}.` : ''}${dropped > 0 ? ` ${dropped} malformed candle${dropped === 1 ? '' : 's'} left out.` : ''} Drag to pan, scroll or pinch to zoom.`
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

      <PriceChartPanel
        interval={interval}
        onInterval={onInterval}
        unavailable={unavailable}
        chartKey={isLine ? 'line' : 'candles'}
        chart={{
          ...(isLine ? { line: shownLine } : { candles: offered ? candles : EMPTY_CANDLES }),
          intervalSec: CANDLE_INTERVAL_SEC[interval],
          status: tc === undefined ? (history.isError ? 'error' : 'loading') : 'ready',
          empty: chartEmpty(),
          error: history.isError ? `Price history can’t be read right now (${describeError(history.error).message}). NEARKITS asks again shortly.` : undefined,
          onRetry: () => void history.refetch(),
          // With no source the line ends at the live price itself: no second line for it.
          livePrice: tc === null ? null : priceValue,
          formatPrice: formatUsdPrice,
          formatVolume: volumeText,
          label: `${token.symbol} price in USD, ${tc === null ? 'prices seen on this page' : tc?.kind === 'line' ? `${INTERVAL_TEXT[interval]} prices` : `${INTERVAL_TEXT[interval]} candles`}`,
          viewKey: `${token.id}:${interval}`,
        }}
        alert={
          history.isError && tc !== undefined
            ? `The last refresh failed (${describeError(history.error).message}): what was read before stays. NEARKITS asks again shortly.`
            : undefined
        }
        note={chartNote()}
      />

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
