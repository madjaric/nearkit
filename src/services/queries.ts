import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CopyRuleInput, DcaInput, MultiTradeRequest, OrderInput, PnlRange, PresetInput, QuoteRequest, SniperInput, TokenId, TransferRequest } from '@/types/domain'
import { useSyncExternalStore } from 'react'
import type { Holding } from '@/types/domain'
import type { OperationPlan, OperationProgress } from '@/types/operations'
import { useServices } from './context'
import { createRefreshStatus, refreshTargets, refreshUntilMoved, settledWithChanges, snapshotOf, type RefreshStatus } from './postTradeRefresh'

/**
 * Data hooks. Components only use these; they never see which service
 * implementation answers. Keys live here so invalidation stays consistent.
 */
export const qk = {
  session: ['session'] as const,
  walletOptions: ['wallet-options'] as const,
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
  const onSuccess = () => qc.invalidateQueries({ queryKey: ['wallets'] })
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
    const refetch = async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ['wallets'] }), qc.invalidateQueries({ queryKey: ['portfolio'] }), qc.invalidateQueries({ queryKey: qk.tokens })])
    }
    try {
      result = await s.execution.run(plan, prior, onProgress)
      return result
    } finally {
      if (plan.mode === 'near' && settledWithChanges(result)) {
        void balanceRefresh.track((cancelled) =>
          refreshUntilMoved({
            before,
            refresh: async () => {
              s.execution.forgetBalances(targets.accounts)
              await refetch()
            },
            read: () => snapshotOf(qc.getQueryData<Holding[]>(qk.holdings), targets),
            cancelled,
          }),
        )
      } else {
        void refetch()
      }
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
