import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { ChartRange, CopyRuleInput, DcaInput, MultiTradeRequest, OrderInput, PnlRange, PresetInput, QuoteRequest, SniperInput, TokenId, TransferRequest } from '@/types/domain'
import { useEffect, useSyncExternalStore } from 'react'
import type { Holding, Session } from '@/types/domain'
import type { OperationPlan, OperationProgress } from '@/types/operations'
import { useServices } from './context'
import { inFlight } from './inFlight'
import { reconnectAs } from './ownerConnect'
import type { NearKitWalletList, NearKitWebSession, WebLegStatus, WebSendInput, WebSendStatus, WebTradeGroup, WebTradeInput } from './nearkitWeb'
import { NATIVE_TOKEN_ID } from '@/config/networks'
import type { NearKitServices as Services } from './types'
import {
  createRefreshStatus,
  refreshTargets,
  refreshUntilMoved,
  settledWithChanges,
  snapshotOf,
  type BalanceSnapshot,
  type RefreshStatus,
  type RefreshTargets,
} from './postTradeRefresh'

/**
 * Data hooks. Components only use these; they never see which service
 * implementation answers. Keys live here so invalidation stays consistent.
 */
export const qk = {
  session: ['session'] as const,
  walletOptions: ['wallet-options'] as const,
  ownerControl: ['owner-control'] as const,
  tokens: ['tokens'] as const,
  tokenLookup: (contract: string | null) => ['token-lookup', contract] as const,
  nearPrice: ['market', 'near'] as const,
  wallets: ['wallets'] as const,
  snapshots: ['wallets', 'snapshots'] as const,
  holdings: ['wallets', 'holdings'] as const,
  presets: ['presets'] as const,
  summary: ['portfolio', 'summary'] as const,
  positions: ['portfolio', 'positions'] as const,
  history: (days: number) => ['portfolio', 'history', days] as const,
  pnl: (range: PnlRange) => ['portfolio', 'pnl', range] as const,
  activity: ['portfolio', 'activity'] as const,
  orders: ['orders'] as const,
  quote: (req: QuoteRequest | null) => ['quote', req] as const,
  multiQuote: (req: MultiTradeRequest | null) => ['multi-quote', req] as const,
  scan: (query: string) => ['scan', query] as const,
  scanSuggestions: ['scan-suggestions'] as const,
  dca: ['automation', 'dca'] as const,
  copy: ['automation', 'copy'] as const,
  sniper: ['automation', 'sniper'] as const,
  nearkitWallets: (token: string | null) => ['wallets', 'nearkit', token] as const,
  volumeBots: (token: string | null) => ['nearkit', 'bots', token] as const,
  volumeBot: (token: string | null, botId: string | null) => ['nearkit', 'bots', token, botId] as const,
  tokenPrice: (id: string | null) => ['market', 'price', id] as const,
  priceHistory: (id: string | null, range: ChartRange) => ['market', 'history', id, range] as const,
  totalSupply: (id: string | null) => ['token-supply', id] as const,
  tokenActivity: (id: string | null) => ['market', 'activity', id] as const,
  tokenMarket: (id: string | null) => ['market', 'data', id] as const,
  tradeGroup: (groupId: string | null) => ['nearkit', 'trade', groupId] as const,
  sendStatus: (intentId: string | null) => ['nearkit', 'send', intentId] as const,
}

/** Real data refreshes less often than the demo: free public infrastructure has rate limits. */
export function useLiveInterval(): number {
  return useServices().mode === 'demo' ? 10_000 : 30_000
}
export const QUOTE_REFRESH = 15_000

export function useCapabilities() {
  return useServices().capabilities
}

// ─── session ────────────────────────────────────────────────────────────────

export function useSession() {
  const s = useServices()
  return useQuery({ queryKey: qk.session, queryFn: () => s.wallets.getSession(), staleTime: Infinity })
}

export function useWalletOptions(enabled: boolean) {
  const s = useServices()
  return useQuery({ queryKey: qk.walletOptions, queryFn: () => s.wallets.listWalletOptions(), enabled, staleTime: 60_000, retry: 1 })
}

export function useConnect() {
  const s = useServices()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (walletId?: string) => s.wallets.connect(walletId),
    onSuccess: () => qc.invalidateQueries(),
  })
}

/** Can the connected wallet sign for `owner` right now (Recover)? Read again for every new wallet session; never while none. */
export function useOwnerControl(owner: string, session: Session | null) {
  const s = useServices()
  return useQuery({
    queryKey: [...qk.ownerControl, owner, session?.connectedAt ?? null, session?.accountId ?? null],
    queryFn: () => s.wallets.ownerControl(owner),
    enabled: session !== null,
    staleTime: 15_000,
    retry: false,
  })
}

/** Recover's "Connect <owner>": sign out, connect, then check the wallet against the owner (ownerConnect.ts). The session changes either way. */
export function useReconnectAs() {
  const s = useServices()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ walletId, owner }: { walletId: string; owner: string }) => reconnectAs(s.wallets, walletId, owner),
    onSettled: () => qc.invalidateQueries(),
  })
}

export function useDisconnect() {
  const s = useServices()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => s.wallets.disconnect(),
    onSuccess: () => qc.invalidateQueries(),
  })
}

export function useResetDemo() {
  const s = useServices()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      s.resetDemo?.()
    },
    onSuccess: () => qc.invalidateQueries(),
  })
}

// ─── NearKit wallets (NearKit web) ─────────────────────────────────────────

/** The NearKit web session (signed in from the bot's /web link), or null. */
export function useNearKitSession(): NearKitWebSession | null {
  const { nearkit } = useServices()
  return useSyncExternalStore(nearkit.subscribe, nearkit.session, nearkit.session)
}

/** The signed-in user's NearKit wallets, as the server lists them; null data when signed out. */
export function useNearKitWallets() {
  const s = useServices()
  const session = useNearKitSession()
  return useQuery({
    queryKey: qk.nearkitWallets(session?.token ?? null),
    queryFn: () => s.nearkit.wallets(),
    enabled: s.nearkit.available && session !== null,
    retry: 1,
  })
}

export function useNearKitMutations() {
  const s = useServices()
  const qc = useQueryClient()
  // A session starting or ending changes which wallets exist everywhere.
  const everything = () => qc.invalidateQueries()
  const walletsChanged = () => Promise.all([qc.invalidateQueries({ queryKey: ['wallets'] }), qc.invalidateQueries({ queryKey: ['portfolio'] })])
  return {
    login: useMutation({ mutationFn: (code: string) => s.nearkit.login(code), onSuccess: everything }),
    logout: useMutation({ mutationFn: () => s.nearkit.logout(), onSuccess: everything }),
    create: useMutation({ mutationFn: ({ name, createKey }: { name: string; createKey: string }) => s.nearkit.createWallet(name, createKey), onSuccess: walletsChanged }),
    rename: useMutation({ mutationFn: ({ walletId, name }: { walletId: string; name: string }) => s.nearkit.renameWallet(walletId, name), onSuccess: walletsChanged }),
    /** Deletes a NearKit wallet that was never funded; every list of wallets and the portfolio read again. */
    remove: useMutation({ mutationFn: (walletId: string) => s.nearkit.deleteWallet(walletId), onSuccess: walletsChanged }),
    /** The order the user lists their NearKit wallets in, kept by NearKit's server (shown at once, then read again everywhere). */
    reorder: useMutation({
      mutationFn: (walletIds: readonly string[]) => s.nearkit.orderWallets(walletIds),
      onSuccess: (wallets) => {
        qc.setQueryData<NearKitWalletList>(qk.nearkitWallets(s.nearkit.session()?.token ?? null), (old) => (old ? { ...old, wallets } : old))
        return walletsChanged()
      },
    }),
    /** The server's quote for each wallet, for the review. Nothing is signed. */
    prepareTrade: useMutation({ mutationFn: (input: WebTradeInput) => s.nearkit.prepareTrade(input) }),
    /** Runs the confirmed quotes: NearKit's server executes each wallet's own trade. */
    executeTrade: useMutation({
      mutationFn: ({ groupId, intentIds }: { groupId: string; intentIds: readonly string[] }) => s.nearkit.executeTrade(groupId, intentIds),
      onMutate: ({ groupId }) => {
        const g = qc.getQueryData<WebTradeGroup>(qk.tradeGroup(groupId))
        if (g) noteServerRun(qc, groupId, { accounts: g.legs.map((l) => l.accountId), tokens: [NATIVE_TOKEN_ID, g.token] })
      },
    }),
    cancelTrade: useMutation({ mutationFn: (groupId: string) => s.nearkit.cancelTrade(groupId) }),
    /** The server's review of a send; nothing is sent. */
    reviewSend: useMutation({ mutationFn: (input: WebSendInput) => s.nearkit.reviewSend(input) }),
    executeSend: useMutation({ mutationFn: (intentId: string) => s.nearkit.executeSend(intentId) }),
  }
}

/** A leg is running: started and not finished (a quote waiting for the user isn't). */
export const runningLeg = (status: WebLegStatus) => status === 'executing' || status === 'processing'

/**
 * A trade's legs from the server. `live`: polled while any confirmed leg hasn't finished (each
 * wallet's status as it executes); balances refresh as each one finishes.
 */
export function useTradeGroup(groupId: string | null, live = false) {
  const s = useServices()
  const qc = useQueryClient()
  return useQuery({
    queryKey: qk.tradeGroup(groupId),
    queryFn: async (): Promise<WebTradeGroup> => {
      const before = qc.getQueryData<WebTradeGroup>(qk.tradeGroup(groupId))
      const group = await s.nearkit.tradeStatus(groupId as string)
      const finished = (g: WebTradeGroup | undefined) => g?.legs.filter((l) => l.status === 'done' || l.status === 'failed').length ?? 0
      if (finished(group) > finished(before)) {
        const targets = { accounts: group.legs.map((l) => l.accountId), tokens: [NATIVE_TOKEN_ID, group.token] }
        // Every leg settled: reconcile against the balances before the run; until then, show each as it lands.
        if (!group.legs.some((l) => runningLeg(l.status))) finishServerRun(s, qc, group.groupId, targets)
        else {
          s.execution.forgetBalances(targets.accounts)
          s.execution.trackBalances(targets.accounts, targets.tokens)
          void refetchBalances(qc)
        }
      }
      return group
    },
    enabled: groupId !== null,
    refetchInterval: (q) => (live && (!q.state.data || q.state.data.legs.some((l) => runningLeg(l.status) || l.status === 'quoted')) ? 1_500 : false),
    retry: 1,
  })
}

/**
 * A send's status, polled while it runs; when it finishes, balances reconcile (the sending wallet and
 * the destination, for the token sent: `targets`, noted when the send starts).
 */
export function useSendStatus(intentId: string | null, targets?: RefreshTargets) {
  const s = useServices()
  const qc = useQueryClient()
  const targetsKey = targets ? `${targets.accounts.join(',')}|${targets.tokens.join(',')}` : ''
  useEffect(() => {
    if (intentId !== null && targets && !serverRuns.has(intentId) && !qc.getQueryData(qk.sendStatus(intentId))) noteServerRun(qc, intentId, targets)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentId, targetsKey, qc])
  return useQuery({
    queryKey: qk.sendStatus(intentId),
    queryFn: async (): Promise<WebSendStatus> => {
      const r = await s.nearkit.sendStatus(intentId as string)
      if (r.status === 'done' || r.status === 'failed') finishServerRun(s, qc, intentId as string, targets ?? { accounts: [], tokens: [NATIVE_TOKEN_ID] })
      return r
    },
    enabled: intentId !== null,
    refetchInterval: (q) => (!q.state.data || q.state.data.status === 'quoted' || runningLeg(q.state.data.status) ? 1_500 : false),
    retry: 1,
  })
}

// ─── market ─────────────────────────────────────────────────────────────────

export function useTokens() {
  const s = useServices()
  const interval = useLiveInterval()
  return useQuery({ queryKey: qk.tokens, queryFn: () => s.tokens.listTokens(), refetchInterval: interval })
}

/** Reads a pasted contract that is in no list yet (null: nothing to look up). Saves nothing. */
export function useTokenLookup(contract: string | null) {
  const s = useServices()
  return useQuery({
    queryKey: qk.tokenLookup(contract),
    queryFn: () => s.tokens.lookupToken(contract as string),
    enabled: contract !== null,
    retry: false,
    staleTime: 60_000,
  })
}

export function useImportToken() {
  const s = useServices()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (contract: string) => s.tokens.importToken(contract),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: qk.tokens }), qc.invalidateQueries({ queryKey: qk.holdings })]),
  })
}

/** How often a token screen asks for the live price (its sources cache it for up to a minute). */
export const PRICE_POLL_MS = 15_000

/** One token's live price, polled; null data when no source reports one. */
export function useTokenPrice(id: TokenId | null) {
  const s = useServices()
  return useQuery({
    queryKey: qk.tokenPrice(id),
    queryFn: () => s.tokens.getPrice(id as TokenId),
    enabled: id !== null,
    refetchInterval: s.mode === 'demo' ? 5_000 : PRICE_POLL_MS,
    retry: 1,
  })
}

/** The price history a source has for this window (null data: no source for this token). */
export function usePriceHistory(id: TokenId | null, range: ChartRange) {
  const s = useServices()
  return useQuery({ queryKey: qk.priceHistory(id, range), queryFn: () => s.tokens.getPriceHistory(id as TokenId, range), enabled: id !== null, refetchInterval: 60_000, retry: 1 })
}

/** How often a token screen asks for new trades. */
export const ACTIVITY_POLL_MS = 20_000

/** A token's recent buys and sells against NEAR, refreshed; null data: no source for this token. */
export function useTokenActivity(id: TokenId | null) {
  const s = useServices()
  return useQuery({ queryKey: qk.tokenActivity(id), queryFn: () => s.tokens.getActivity(id as TokenId), enabled: id !== null, refetchInterval: ACTIVITY_POLL_MS, retry: 1 })
}

export function useTotalSupply(id: TokenId | null) {
  const s = useServices()
  return useQuery({ queryKey: qk.totalSupply(id), queryFn: () => s.tokens.getTotalSupply(id as TokenId), enabled: id !== null, staleTime: 5 * 60_000, retry: 1 })
}

/** How often a token screen asks for its market figures (their sources cache them for 20 s). */
export const MARKET_POLL_MS = 20_000

/** A token's market figures, polled; each says where it comes from or why it's missing. */
export function useTokenMarket(id: TokenId | null) {
  const s = useServices()
  return useQuery({ queryKey: qk.tokenMarket(id), queryFn: () => s.tokens.getMarketData(id as TokenId), enabled: id !== null, refetchInterval: MARKET_POLL_MS, retry: 1 })
}

export function useNearPrice() {
  const s = useServices()
  const interval = useLiveInterval()
  return useQuery({ queryKey: qk.nearPrice, queryFn: () => s.tokens.getNearPrice(), refetchInterval: interval })
}

export function useScan(query: string) {
  const s = useServices()
  return useQuery({
    queryKey: qk.scan(query),
    queryFn: () => s.tokens.scan(query),
    enabled: query.trim().length > 0,
    staleTime: 60_000,
    retry: false,
  })
}

export function useScanSuggestions() {
  const s = useServices()
  return useQuery({ queryKey: qk.scanSuggestions, queryFn: () => s.tokens.scanSuggestions(), staleTime: Infinity })
}

// ─── wallets ────────────────────────────────────────────────────────────────

export function useWallets() {
  const s = useServices()
  return useQuery({ queryKey: qk.wallets, queryFn: () => s.wallets.listWallets() })
}

export function useWalletSnapshots() {
  const s = useServices()
  const interval = useLiveInterval()
  return useQuery({ queryKey: qk.snapshots, queryFn: () => s.wallets.listSnapshots(), refetchInterval: interval })
}

export function useHoldings() {
  const s = useServices()
  const interval = useLiveInterval()
  return useQuery({ queryKey: qk.holdings, queryFn: () => s.wallets.listHoldings(), refetchInterval: interval })
}

export function useAccountMutations() {
  const s = useServices()
  const qc = useQueryClient()
  // The account book changes which wallets are watch-only: wallet views and the portfolio both re-read.
  const onSuccess = () => Promise.all([qc.invalidateQueries({ queryKey: ['wallets'] }), qc.invalidateQueries({ queryKey: ['portfolio'] })])
  return {
    add: useMutation({ mutationFn: (input: { accountId: string; label?: string }) => s.wallets.addAccount(input), onSuccess }),
    remove: useMutation({ mutationFn: (id: string) => s.wallets.removeAccount(id), onSuccess }),
  }
}

export function usePresets() {
  const s = useServices()
  return useQuery({ queryKey: qk.presets, queryFn: () => s.wallets.listPresets() })
}

export function usePresetMutations() {
  const s = useServices()
  const qc = useQueryClient()
  const onSuccess = () => qc.invalidateQueries({ queryKey: qk.presets })
  return {
    create: useMutation({ mutationFn: (input: PresetInput) => s.wallets.createPreset(input), onSuccess }),
    update: useMutation({ mutationFn: ({ id, input }: { id: string; input: PresetInput }) => s.wallets.updatePreset(id, input), onSuccess }),
    duplicate: useMutation({ mutationFn: (id: string) => s.wallets.duplicatePreset(id), onSuccess }),
    remove: useMutation({ mutationFn: (id: string) => s.wallets.deletePreset(id), onSuccess }),
  }
}

// ─── operations ─────────────────────────────────────────────────────────────

/** Plan builders for the operation modal. They return exact plans; nothing is signed here. */
export function usePlanners() {
  const s = useServices()
  return {
    transfer: (request: TransferRequest) => s.transfers.prepare(request),
    swap: (request: QuoteRequest) => s.trading.prepareSwap(request),
    multi: (request: MultiTradeRequest) => s.trading.prepareMulti(request),
  }
}

/** The post-trade balance refresh's status: "Updating balances…" in the top bar and the operation dialog. */
export const balanceRefresh = createRefreshStatus()

/** What every portfolio view reads: wallets, balances, positions, the summary, activity. */
async function refetchBalances(qc: QueryClient, everywhere = false) {
  // Every view, also the ones not on screen (the Dashboard after a Consolidate): none shows the old balances as current when opened.
  const refetchType = everywhere ? 'all' : 'active'
  await Promise.all([
    qc.invalidateQueries({ queryKey: ['wallets'], refetchType }),
    qc.invalidateQueries({ queryKey: qk.summary, refetchType }),
    qc.invalidateQueries({ queryKey: qk.positions, refetchType }),
    qc.invalidateQueries({ queryKey: ['portfolio'] }),
    qc.invalidateQueries({ queryKey: qk.tokens }),
  ])
}

/**
 * Brings balances up to date after something moved them, without a page reload: the accounts'
 * cached balances are dropped, the tokens they moved are read on chain directly (the indexer may lag),
 * and the views refresh on a bounded schedule until the chain shows the change (every `expected`
 * balance, for a run across several wallets), then once more for gas refunds. "Updating balances…"
 * shows meanwhile (BalanceRefreshStatus); the operation's own result never waits for it.
 */
export function reconcileBalances(s: Pick<Services, 'execution'>, qc: QueryClient, targets: RefreshTargets, before: BalanceSnapshot, expected?: readonly string[]): void {
  s.execution.trackBalances(targets.accounts, targets.tokens)
  const refresh = async (everywhere = false) => {
    s.execution.forgetBalances(targets.accounts)
    await refetchBalances(qc, everywhere)
  }
  void balanceRefresh
    .track((cancelled) =>
      refreshUntilMoved({
        before,
        expected,
        refresh: () => refresh(),
        read: () => snapshotOf(qc.getQueryData<Holding[]>(qk.holdings), targets),
        followUp: () => refresh(true),
        cancelled,
      }),
    )
    .then((outcome) => (outcome === 'unchanged' ? refresh(true) : undefined))
}

/** Balances before a run on NEARKITS' server, by the run's id: reconciled against when it finishes. */
const serverRuns = new Map<string, { targets: RefreshTargets; before: BalanceSnapshot }>()

function noteServerRun(qc: QueryClient, id: string, targets: RefreshTargets) {
  serverRuns.set(id, { targets, before: snapshotOf(qc.getQueryData<Holding[]>(qk.holdings), targets) })
}

function finishServerRun(s: Pick<Services, 'execution'>, qc: QueryClient, id: string, fallback: RefreshTargets) {
  const run = serverRuns.get(id)
  serverRuns.delete(id)
  reconcileBalances(s, qc, run?.targets ?? fallback, run?.before ?? new Map())
}

export function useBalanceRefresh(): RefreshStatus {
  return useSyncExternalStore(balanceRefresh.subscribe, balanceRefresh.get, balanceRefresh.get)
}

/**
 * Run (or continue) a plan. When it settles, the affected balances and activity refresh
 * without a page reload. After a real operation that may have changed balances the
 * refresh runs in the background on a bounded schedule until the traded tokens show the
 * change (postTradeRefresh.ts); the result itself never waits for it.
 */
export function useExecution() {
  const s = useServices()
  const qc = useQueryClient()
  return async (plan: OperationPlan, prior: OperationProgress | null, onProgress: (p: OperationProgress) => void) => {
    const targets = refreshTargets(plan)
    const before = snapshotOf(qc.getQueryData<Holding[]>(qk.holdings), targets)
    let result: OperationProgress | null = null
    // Listed while it goes (a slow network can keep it going after its dialog closed): the same trade can't be sent again meanwhile.
    const release = inFlight.add(plan)
    try {
      result = await s.execution.run(plan, prior, onProgress)
      return result
    } finally {
      release()
      if (plan.mode === 'near' && settledWithChanges(result)) reconcileBalances(s, qc, targets, before)
      else void refetchBalances(qc)
    }
  }
}

// ─── portfolio ──────────────────────────────────────────────────────────────

export function useSummary() {
  const s = useServices()
  const interval = useLiveInterval()
  return useQuery({ queryKey: qk.summary, queryFn: () => s.portfolio.getSummary(), refetchInterval: interval })
}

export function usePositions() {
  const s = useServices()
  const interval = useLiveInterval()
  return useQuery({ queryKey: qk.positions, queryFn: () => s.portfolio.listPositions(), refetchInterval: interval })
}

export function useValueHistory(days: number) {
  const s = useServices()
  return useQuery({ queryKey: qk.history(days), queryFn: () => s.portfolio.getValueHistory(days), placeholderData: keepPreviousData })
}

export function usePnl(range: PnlRange) {
  const s = useServices()
  return useQuery({ queryKey: qk.pnl(range), queryFn: () => s.portfolio.getPnl(range), placeholderData: keepPreviousData })
}

export function useActivity(limit = 20) {
  const s = useServices()
  return useQuery({ queryKey: [...qk.activity, limit], queryFn: () => s.portfolio.listActivity(limit) })
}

// ─── trading ────────────────────────────────────────────────────────────────

const positiveText = (text: string) => /^[0-9]*\.?[0-9]*$/.test(text) && Number(text) > 0

export function useQuote(request: QuoteRequest | null) {
  const s = useServices()
  return useQuery({
    queryKey: qk.quote(request),
    queryFn: () => s.trading.quote(request as QuoteRequest),
    enabled: request !== null && positiveText(request.amountIn),
    placeholderData: keepPreviousData,
    refetchInterval: QUOTE_REFRESH,
    retry: false,
  })
}

export function useMultiQuote(request: MultiTradeRequest | null) {
  const s = useServices()
  return useQuery({
    queryKey: qk.multiQuote(request),
    queryFn: () => s.trading.quoteMulti(request as MultiTradeRequest),
    enabled: request !== null && request.legs.some((l) => positiveText(l.amountIn)),
    placeholderData: keepPreviousData,
    refetchInterval: QUOTE_REFRESH,
    retry: false,
  })
}

export function useOrders() {
  const s = useServices()
  return useQuery({ queryKey: qk.orders, queryFn: () => s.trading.listOrders() })
}

export function useOrderMutations() {
  const s = useServices()
  const qc = useQueryClient()
  const onSuccess = () =>
    Promise.all([qc.invalidateQueries({ queryKey: qk.orders }), qc.invalidateQueries({ queryKey: qk.summary }), qc.invalidateQueries({ queryKey: qk.activity })])
  return {
    create: useMutation({ mutationFn: (input: OrderInput) => s.trading.createOrder(input), onSuccess }),
    cancel: useMutation({ mutationFn: (id: string) => s.trading.cancelOrder(id), onSuccess }),
  }
}

// ─── automation ─────────────────────────────────────────────────────────────

export function useDcaPlans() {
  const s = useServices()
  return useQuery({ queryKey: qk.dca, queryFn: () => s.automation.listDcaPlans() })
}

export function useCopyRules() {
  const s = useServices()
  return useQuery({ queryKey: qk.copy, queryFn: () => s.automation.listCopyRules() })
}

export function useSniperConfigs() {
  const s = useServices()
  return useQuery({ queryKey: qk.sniper, queryFn: () => s.automation.listSniperConfigs() })
}

export function useAutomationMutations() {
  const s = useServices()
  const qc = useQueryClient()
  const after = (key: readonly unknown[]) => () => Promise.all([qc.invalidateQueries({ queryKey: key }), qc.invalidateQueries({ queryKey: qk.activity })])
  return {
    createDca: useMutation({ mutationFn: (input: DcaInput) => s.automation.createDcaPlan(input), onSuccess: after(qk.dca) }),
    deleteDca: useMutation({ mutationFn: (id: string) => s.automation.deleteDcaPlan(id), onSuccess: after(qk.dca) }),
    createCopy: useMutation({ mutationFn: (input: CopyRuleInput) => s.automation.createCopyRule(input), onSuccess: after(qk.copy) }),
    deleteCopy: useMutation({ mutationFn: (id: string) => s.automation.deleteCopyRule(id), onSuccess: after(qk.copy) }),
    createSniper: useMutation({ mutationFn: (input: SniperInput) => s.automation.createSniperConfig(input), onSuccess: after(qk.sniper) }),
    deleteSniper: useMutation({ mutationFn: (id: string) => s.automation.deleteSniperConfig(id), onSuccess: after(qk.sniper) }),
  }
}

// ─── derived helpers ────────────────────────────────────────────────────────

/** Display balance of one token in one wallet, from the holdings query. */
export function useBalance(walletId: string | undefined, tokenId: TokenId | undefined): number {
  const { data } = useHoldings()
  if (!walletId || !tokenId || !data) return 0
  return data.find((h) => h.walletId === walletId && h.tokenId === tokenId)?.amount ?? 0
}

/** Exact raw balance string when the service knows it (real mode), else null. */
export function useRawBalance(walletId: string | undefined, tokenId: TokenId | undefined): string | null {
  const { data } = useHoldings()
  if (!walletId || !tokenId || !data) return null
  return data.find((h) => h.walletId === walletId && h.tokenId === tokenId)?.raw ?? null
}
