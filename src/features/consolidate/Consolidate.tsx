import { useState } from 'react'
import { AccountText } from '@/components/domain/Account'
import { AllocationBar } from '@/components/domain/AllocationBar'
import { SimulationNote } from '@/components/domain/Status'
import { TokenSelect } from '@/components/domain/TokenSelect'
import { WalletSelect } from '@/components/domain/WalletSelect'
import { Button } from '@/components/ui/Button'
import { Figures } from '@/components/ui/Figures'
import { Checkbox, Field, Segmented } from '@/components/ui/Form'
import { InfoTip, Term } from '@/components/ui/Help'
import { Line, Lines, Panel, PanelHeader } from '@/components/ui/Panel'
import { Table, Td, Th, Tr } from '@/components/ui/Table'
import { cn } from '@/lib/cn'
import { NATIVE_TOKEN_ID } from '@/config/networks'
import { formatUnits } from '@/lib/amounts'
import { NETWORK_FEE_NEAR_PER_TX } from '@/lib/fees'
import { WALLET_DUST_NEAR } from '@/lib/walletDust'
import { nearSendUpfrontYocto } from '@/services/near/gas'
import { floorTo, formatAmount, formatNumber, toInputString } from '@/lib/format'
import { heldBalances } from '@/lib/tokenRanking'
import { useHoldings, usePlanners, useSession, useTokens, useWallets } from '@/services/queries'
import { NearKitSendsModal } from '../tools/NearKitSendsModal'
import { OperationModal } from '../tools/OperationModal'
import { consolidatePool, defaultConsolidateToken, defaultFamily, type SourceFamily } from './sources'

const NEAR = NATIVE_TOKEN_ID

export function Consolidate() {
  const { data: wallets = [] } = useWallets()
  const { data: holdings = [] } = useHoldings()
  const { data: tokens = [] } = useTokens()
  const { data: session } = useSession()
  const planners = usePlanners()
  const [pickedToken, setTokenId] = useState<string | null>(null)
  const [pickedDest, setDestId] = useState<string | null>(null)
  const [pickedFamily, setFamily] = useState<SourceFamily | null>(null)
  const destId = pickedDest ?? session?.walletId ?? wallets[0]?.id ?? ''
  // Every wallet that can act, except the destination: NearKit wallets (not frozen) and the connected
  // accounts; never a watch-only one. What they hold, summed, is what can be gathered: the picker
  // puts it first, and (after the demo's own $KIT) the page opens on the most valuable of it.
  const pool = consolidatePool(wallets, destId)
  const sourceIds = pool.all.map((w) => w.id)
  const held = heldBalances(holdings, sourceIds)
  const tokenId = pickedToken ?? (tokens.some((t) => t.id === 'kit') ? 'kit' : defaultConsolidateToken(tokens, held, tokens.find((t) => !t.isNative)?.id ?? NEAR))
  const [picked, setPicked] = useState<string[] | null>(null)
  const [hideEmpty, setHideEmpty] = useState(true)
  const [confirming, setConfirming] = useState(false)

  const token = tokens.find((t) => t.id === tokenId)
  const symbol = token?.symbol ?? ''
  const isNear = tokenId === NEAR
  const decimals = isNear ? 2 : 0
  const balance = (walletId: string) => holdings.find((h) => h.walletId === walletId && h.tokenId === tokenId)?.amount ?? 0
  const destination = wallets.find((w) => w.id === destId)
  // NEAR sources keep back exactly the gas their transfer into the destination holds, nothing more:
  // what stays after the refund is dust (src/lib/walletDust.ts), so an emptied wallet can be deleted.
  const nearHold = isNear ? nearSendUpfrontYocto(destination?.accountId) : 0n
  const movable = (walletId: string) => (isNear ? Math.max(0, floorTo(balance(walletId) - Number(formatUnits(nearHold, 24)), 4)) : balance(walletId))
  const movableText = (walletId: string): string => {
    const raw = holdings.find((h) => h.walletId === walletId && h.tokenId === tokenId)?.raw
    if (raw === undefined || !token) return toInputString(movable(walletId), isNear ? 4 : 6)
    const left = BigInt(raw) - nearHold
    return formatUnits(left > 0n ? left : 0n, token.decimals)
  }

  // One family per run, as in Multi Trade: NearKit wallets (NearKit's server sends for each, under
  // the custody rule) or the connected wallet's accounts (signed here).
  const family = pickedFamily ?? defaultFamily(pool, (id) => movable(id) > 0)
  const candidates = family === 'nearkit' ? pool.nearkit : pool.browser
  const funded = candidates.filter((w) => movable(w.id) > 0)
  const selectedIds = picked ?? funded.map((w) => w.id)
  const selected = funded.filter((w) => selectedIds.includes(w.id))
  const total = selected.reduce((s, w) => s + movable(w.id), 0)
  const shown = hideEmpty ? funded : candidates
  const allChecked = funded.length > 0 && selected.length === funded.length

  const toggle = (id: string) => {
    const set = new Set(selectedIds)
    if (set.has(id)) set.delete(id)
    else set.add(id)
    setPicked([...set])
  }

  const reset = () => setPicked(null)
  const issue = funded.length === 0 ? `No other wallet holds ${symbol}` : selected.length === 0 ? 'Select at least one wallet' : null

  const summary = (
    <Lines>
      <Line label="Moving" emphasis>
        {formatAmount(total, decimals)} {symbol}
      </Line>
      <Line label="From">
        {selected.length} {selected.length === 1 ? 'wallet' : 'wallets'}
      </Line>
      <Line label="Into">{destination?.label ?? '—'}</Line>
      <Line label={`${destination?.label ?? 'Destination'} after`}>
        {formatAmount(balance(destId) + total, decimals)} {symbol}
      </Line>
    </Lines>
  )

  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-4">
        <Panel>
          <PanelHeader title="Setup" />
          <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2">
            <Field label="Token">
              {({ id }) => (
                <TokenSelect
                  id={id}
                  label="Token"
                  size="md"
                  holdingsOf={sourceIds}
                  value={tokenId}
                  onChange={(t) => {
                    setTokenId(t)
                    reset()
                  }}
                />
              )}
            </Field>
            <Field label="Destination">
              {({ id }) => (
                <WalletSelect
                  id={id}
                  value={destId}
                  onChange={(d) => {
                    setDestId(d)
                    reset()
                  }}
                  wallets={wallets}
                />
              )}
            </Field>
          </div>
        </Panel>

        <Panel>
          <PanelHeader
            title="Source wallets"
            meta={`${selected.length} of ${funded.length} with ${symbol}`}
            actions={
              <>
                {pool.nearkit.length > 0 && pool.browser.length > 0 && (
                  <Segmented
                    label="Wallet source"
                    size="sm"
                    value={family}
                    onChange={(v) => {
                      setFamily(v)
                      reset()
                    }}
                    options={[
                      { value: 'nearkit', label: 'NEARKITS' },
                      { value: 'browser', label: 'Connected' },
                    ]}
                  />
                )}
                <Button size="xs" variant="ghost" onClick={() => setPicked(funded.map((w) => w.id))} disabled={allChecked}>
                  Select all
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setPicked([])} disabled={selected.length === 0}>
                  Deselect all
                </Button>
              </>
            }
          />
          <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5">
            <Checkbox checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} label={`Hide wallets without ${symbol}`} labelClassName="text-xs" />
            {isNear && (
              <span className="flex items-center gap-1 text-xs text-fg-3">
                <Figures>{`Moves all but each transfer’s gas: under ${WALLET_DUST_NEAR} NEAR stays`}</Figures> <InfoTip term="networkFee" />
              </span>
            )}
          </div>

          {shown.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-sm font-medium text-fg">No other wallet holds {symbol}</p>
              <p className="mt-1 text-sm text-fg-3">Pick another token, or show empty wallets to see the full list.</p>
            </div>
          ) : (
            <>
              <div className="hidden md:block">
                <Table label="Source wallets" rows="double">
                  <thead>
                    <tr>
                      <Th className="w-10">
                        <span className="sr-only">Include</span>
                      </Th>
                      <Th>Wallet</Th>
                      <Th align="right">Balance</Th>
                      <Th align="right">To move</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((w) => {
                      const canMove = movable(w.id) > 0
                      const on = canMove && selectedIds.includes(w.id)
                      return (
                        <Tr key={w.id} className={cn(!on && 'text-fg-4')}>
                          <Td>
                            <Checkbox checked={on} disabled={!canMove} onChange={() => toggle(w.id)} aria-label={`Include ${w.label}`} />
                          </Td>
                          <Td>
                            <div className="flex flex-col">
                              <span className={on ? 'text-fg' : 'text-fg-3'}>{w.label}</span>
                              <AccountText id={w.accountId} className="text-[11px] text-fg-4" />
                            </div>
                          </Td>
                          <Td align="right" mono className={balance(w.id) > 0 ? 'text-fg-2' : 'text-fg-4'}>
                            {formatAmount(balance(w.id), decimals)}
                          </Td>
                          <Td align="right" mono className={on ? 'text-fg' : 'text-fg-4'}>
                            {on ? formatAmount(movable(w.id), decimals) : canMove ? '—' : 'Empty'}
                          </Td>
                        </Tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-line">
                      <td />
                      <td className="legend px-3 py-3">Total</td>
                      <td />
                      <td className="num px-3 py-3 pr-4 text-right text-fg">
                        {formatAmount(total, decimals)} <span className="font-sans text-xs text-fg-3">{symbol}</span>
                      </td>
                    </tr>
                  </tfoot>
                </Table>
              </div>
              <ul className="divide-y divide-line-soft md:hidden" aria-label="Source wallets">
                {shown.map((w) => {
                  const canMove = movable(w.id) > 0
                  const on = canMove && selectedIds.includes(w.id)
                  return (
                    <li key={w.id} className="flex items-center justify-between gap-3 px-4 py-3">
                      <Checkbox
                        checked={on}
                        disabled={!canMove}
                        onChange={() => toggle(w.id)}
                        label={
                          <span className="flex flex-col">
                            <span className={on ? 'text-fg' : 'text-fg-3'}>{w.label}</span>
                            <AccountText id={w.accountId} className="text-[11px] text-fg-4" />
                          </span>
                        }
                      />
                      <span className={cn('num text-sm', on ? 'text-fg' : 'text-fg-4')}>{formatAmount(balance(w.id), decimals)}</span>
                    </li>
                  )
                })}
                <li className="flex items-center justify-between px-4 py-3">
                  <span className="legend">Total</span>
                  <span className="num text-sm text-fg">
                    {formatAmount(total, decimals)} {symbol}
                  </span>
                </li>
              </ul>
            </>
          )}
          {selected.length > 0 && (
            <div className="border-t border-line-soft px-4 py-3">
              <AllocationBar
                segments={selected.map((w) => ({ key: w.id, label: w.label, value: movable(w.id) }))}
                budget={total}
                state="balanced"
                unit={symbol}
                summary={`${selected.length} sources → ${destination?.label ?? ''}`}
              />
            </div>
          )}
        </Panel>
      </div>

      <div className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-16">
        <Panel>
          <PanelHeader title="Summary" />
          <div className="flex flex-col gap-4 p-4">
            {summary}
            <div className="border-t border-line-soft pt-3">
              <Lines>
                <Line label="Transfers">{selected.length}</Line>
                <Line label={<Term term="networkFee">Network fee (est.)</Term>}>{formatNumber(selected.length * NETWORK_FEE_NEAR_PER_TX, 4, 4)} NEAR</Line>
              </Lines>
            </div>
            {issue && <p className="text-xs text-neg">{issue}</p>}
            <div className="flex flex-col gap-2">
              <Button size="lg" block variant="primary" disabled={issue !== null} onClick={() => setConfirming(true)}>
                Consolidate
              </Button>
              <SimulationNote
                real={
                  family === 'nearkit'
                    ? `NEARKITS’ server sends from each NEARKITS wallet (no wallet prompt), into ${destination?.label ?? 'the destination'} only if it is that wallet’s owner wallet or an address approved for it.`
                    : undefined
                }
              />
            </div>
          </div>
        </Panel>
      </div>

      {confirming && destination && family === 'nearkit' && token && (
        <NearKitSendsModal
          title="Review consolidation"
          confirmLabel="Consolidate"
          into={{ label: destination.label, accountId: destination.accountId }}
          asset={tokenId}
          symbol={symbol}
          decimals={token.decimals}
          lines={selected.map((w) => ({
            to: destination.accountId,
            amount: isNear ? 'max' : movableText(w.id),
            from: { walletId: w.nearkitId ?? '', label: w.label, accountId: w.accountId },
          }))}
          onClose={() => setConfirming(false)}
        />
      )}
      {confirming && destination && family === 'browser' && (
        <OperationModal
          title="Review consolidation"
          confirmLabel="Consolidate"
          prepare={() =>
            planners.transfer({
              kind: 'consolidate',
              tokenId,
              destinationAccountId: destination.accountId,
              destinationLabel: destination.label,
              sources: selected.map((w) => ({ walletId: w.id, amount: movableText(w.id) })),
            })
          }
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  )
}
