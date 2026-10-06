import { AccountText } from '@/components/domain/Account'
import { GasReserveLine } from '@/components/domain/GasReserve'
import { Figures } from '@/components/ui/Figures'
import { Tag } from '@/components/ui/Indicators'
import { Line, Lines } from '@/components/ui/Panel'
import { cn } from '@/lib/cn'
import { formatUnits, formatUnitsUp, groupDigits as g } from '@/lib/amounts'
import { formatNumber, formatPct } from '@/lib/format'
import { ROUTE_SOURCE_LABEL } from '@/services/routing/select'
import type { FeeDisclosure, OperationPlan, PlannedAction, TokenRef } from '@/types/operations'

const near = (yocto: string) => formatUnits(BigInt(yocto), 24, { maxFraction: 6, group: true })

/** What each value-carrying action does, in words: who it registers or pays, and how much. */
function actionLine(a: PlannedAction, receiverId: string, token: TokenRef): string | null {
  // A NEAR swap sends wNEAR after wrapping it in the same transaction.
  const tokens = (raw: unknown) => `${formatUnits(BigInt(String(raw)), token.decimals, { group: true })} ${token.contract === null ? 'wNEAR' : token.symbol}`
  if (a.kind === 'transfer') return `Sends ${near(a.deposit)} NEAR to ${receiverId}`
  if (a.method === 'storage_deposit') return `Registers ${String(a.args.account_id)} on ${receiverId}: ${near(a.deposit)} NEAR`
  if (a.method === 'tokens_storage_deposit') {
    const tokens = Array.isArray(a.args.tokens) ? a.args.tokens.length : 0
    return `Registers ${String(a.args.user)} with ${receiverId} for ${tokens} ${tokens === 1 ? 'token' : 'tokens'}: ${near(a.deposit)} NEAR`
  }
  if (a.method === 'near_deposit') return `Wraps ${near(a.deposit)} NEAR into wNEAR`
  if (a.method === 'ft_transfer_call') return `Sends ${tokens(a.args.amount)} to ${String(a.args.receiver_id)} for the swap`
  if (a.method === 'ft_transfer') return `Transfers ${tokens(a.args.amount)} to ${String(a.args.receiver_id)}`
  return null
}

/** A token by symbol with its contract in full, so a copied symbol can't pass for the real token. */
function TokenId({ token }: { token: TokenRef }) {
  return (
    <span className="flex flex-col items-end">
      <span>{token.symbol}</span>
      <span className="text-[11px] text-fg-3">{token.contract ? <AccountText id={token.contract} full /> : 'native NEAR'}</span>
    </span>
  )
}

const pct = (bps: number) => `${formatNumber(bps / 100, 2, 2)}%`

/** Swap estimates to 6 decimals, truncated toward zero so a minimum is never overstated. */
const estimate = (raw: string, decimals: number) => formatUnits(BigInt(raw), decimals, { maxFraction: 6, group: true })

function FeeLines({ fee, demo }: { fee: FeeDisclosure; demo: boolean }) {
  return (
    <>
      <Line label={`${fee.label} (${pct(fee.bps)})`} emphasis>
        {fee.charged || demo ? `${g(fee.amount.display)} ${fee.token.symbol}` : 'Not charged'}
      </Line>
      {fee.charged && fee.received && <Line label={`NEARKITS receives (${pct(fee.received.bps)})`}>{`${g(fee.received.amount.display)} ${fee.token.symbol}`}</Line>}
      {fee.charged && fee.routerShare && (
        <Line label={`${fee.routerShare.party} keeps (${pct(fee.routerShare.bps)})`}>{`${g(fee.routerShare.amount.display)} ${fee.token.symbol}`}</Line>
      )}
      {fee.routerFee && <Line label={`${fee.routerFee.party} fee (${pct(fee.routerFee.bps)})`}>{`${g(fee.routerFee.amount.display)} ${fee.token.symbol}`}</Line>}
      {fee.charged && fee.recipient && (
        <Line label="Fee account" mono>
          {fee.recipient}
        </Line>
      )}
      {fee.note && (
        <p className="pt-1 text-xs text-fg-3">
          <Figures>{fee.note}</Figures>
        </p>
      )}
    </>
  )
}

/**
 * The exact plan the user is about to sign: every recipient and amount as it will
 * be sent, the network, the signer, storage deposits, the fee and its split.
 * Nothing here is recomputed; it renders the plan the service built.
 */
export function PlanReview({ plan, networkLabel }: { plan: OperationPlan; networkLabel: string }) {
  const sym = plan.token.symbol
  const storage = BigInt(plan.totals.storage.raw) > 0n
  const upfront = BigInt(plan.totals.upfrontNear.raw) > 0n
  const multiSigner = plan.signers.length > 1
  const swap = plan.swap

  return (
    <div className="flex flex-col gap-4">
      <Lines>
        <Line label="Network" mono={false}>
          <Tag tone={plan.mode === 'demo' ? 'solid' : plan.network === 'mainnet' ? 'warn' : 'neutral'}>{plan.mode === 'demo' ? 'Demo · simulated' : networkLabel}</Tag>
        </Line>
        <Line label={multiSigner ? 'Signers' : 'From'}>
          {multiSigner ? `${plan.signers.length} accounts, one approval each` : <AccountText id={plan.signers[0] ?? ''} className="text-fg-2" full />}
        </Line>
        {swap ? (
          <>
            <Line label="You pay" emphasis>{`${g(swap.amountIn.display)} ${swap.tokenIn.symbol}`}</Line>
            <Line label="Pay token" mono={false}>
              <TokenId token={swap.tokenIn} />
            </Line>
            <Line label="Receive token" mono={false}>
              <TokenId token={swap.tokenOut} />
            </Line>
            <Line label="Expected">{`${estimate(swap.expectedOut.raw, swap.tokenOut.decimals)} ${swap.tokenOut.symbol}`}</Line>
            <Line label="Minimum received" emphasis>{`${estimate(swap.minOut.raw, swap.tokenOut.decimals)} ${swap.tokenOut.symbol}`}</Line>
            <Line label="Slippage limit">{`${formatNumber(swap.slippagePct, 1, 2)}%`}</Line>
            <Line label="Price impact (est.)">{swap.priceImpactPct === null ? 'Unknown' : formatPct(swap.priceImpactPct, { signed: false })}</Line>
            <Line label="Route">{`${swap.route.join(' → ')}${swap.source ? ` · ${ROUTE_SOURCE_LABEL[swap.source]}` : ''}`}</Line>
            {swap.routeTokens && swap.routeTokens.length > 2 && (
              <Line label="Route tokens" mono={false}>
                <span className="flex flex-col items-end text-[11px] text-fg-3">
                  {swap.routeTokens.map((t) => (
                    <AccountText key={t.id} id={t.contract ?? t.id} full />
                  ))}
                </span>
              </Line>
            )}
          </>
        ) : (
          <>
            <Line label="Token">{plan.token.contract ? `${sym} · ${plan.token.contract}` : sym}</Line>
            <Line label="Total" emphasis>{`${g(plan.totals.amount.display)} ${sym}`}</Line>
            <Line label={plan.kind === 'consolidate' ? 'Sources' : plan.kind === 'multi-trade' ? 'Wallets' : 'Recipients'}>{String(plan.lines.length)}</Line>
          </>
        )}
        {storage && <Line label="Storage deposits">{`${g(plan.totals.storage.display)} NEAR`}</Line>}
        {upfront && <GasReserveLine value={`≈ ${formatUnitsUp(BigInt(plan.totals.upfrontNear.raw), 24, 4, { group: true })} NEAR`} />}
        <Line label="Transactions">{`${plan.transactions.length} in ${plan.groups.length} ${plan.groups.length === 1 ? 'approval' : 'approvals'}`}</Line>
        {plan.fee ? <FeeLines fee={plan.fee} demo={plan.mode === 'demo'} /> : !swap && <Line label="NEARKITS fee">None on transfers</Line>}
      </Lines>

      {plan.warnings.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-sm border border-warn/40 bg-warn/[0.06] px-3 py-2" aria-label="Warnings">
          {plan.warnings.map((w) => (
            <li key={w} className="text-xs text-warn">
              <Figures>{w}</Figures>
            </li>
          ))}
        </ul>
      )}

      {plan.lines.length > 0 && (
        <ol
          className="max-h-64 divide-y divide-line-soft overflow-y-auto rounded-sm border border-line-soft"
          aria-label={plan.kind === 'consolidate' ? 'Sources' : plan.kind === 'multi-trade' ? 'Wallets' : 'Recipients'}
        >
          {plan.lines.map((line, i) => (
            <li key={line.id} className="flex items-start gap-3 px-3 py-2">
              <span className="num w-6 shrink-0 pt-px text-xs text-fg-4">{String(i + 1).padStart(2, '0')}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-fg">{line.label === line.accountId ? <AccountText id={line.accountId} full /> : line.label}</span>
                {line.label !== line.accountId && <AccountText id={line.accountId} className="block text-xs text-fg-3" full />}
                {(line.storageDeposit || line.notes.length > 0) && (
                  <span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-fg-3">
                    {line.storageDeposit && <Figures>{`Registers with the token contract: ${g(line.storageDeposit.display)} NEAR`}</Figures>}
                    {line.notes.map((n) => (
                      <span key={n}>
                        <Figures>{n}</Figures>
                      </span>
                    ))}
                  </span>
                )}
              </span>
              <span className={cn('num shrink-0 text-right text-sm', 'text-fg')}>
                {g(line.amount.display)} <span className="font-sans text-xs text-fg-3">{sym}</span>
              </span>
            </li>
          ))}
        </ol>
      )}

      <details className="group rounded-sm border border-line-soft">
        <summary className="cursor-pointer select-none px-3 py-2 text-xs text-fg-3 hover:text-fg-2">
          <Figures>{`Transaction details · ${plan.transactions.length} ${plan.transactions.length === 1 ? 'transaction' : 'transactions'}`}</Figures>
        </summary>
        <ol className="divide-y divide-line-soft border-t border-line-soft">
          {plan.transactions.map((tx) => (
            <li key={tx.index} className="flex flex-col gap-0.5 px-3 py-2 text-xs">
              <span className="text-fg-2">
                <Figures>{tx.label}</Figures>
              </span>
              <span className="text-fg-3">
                Signer <AccountText id={tx.signerId} className="text-fg-2" full /> → <AccountText id={tx.receiverId} className="text-fg-2" full />
              </span>
              <span className="text-fg-3">
                <Figures>{`${tx.actions.length} ${tx.actions.length === 1 ? 'action' : 'actions'}: ${[...new Set(tx.actions.map((a) => (a.kind === 'transfer' ? 'Transfer' : a.method)))].join(', ')}`}</Figures>
              </span>
              <ul className="flex flex-col gap-0.5 text-fg-3">
                {tx.actions.map((a, i) => {
                  const text = actionLine(a, tx.receiverId, plan.token)
                  return text ? (
                    <li key={i} className="break-all">
                      <Figures>{text}</Figures>
                    </li>
                  ) : null
                })}
              </ul>
            </li>
          ))}
        </ol>
      </details>
    </div>
  )
}
