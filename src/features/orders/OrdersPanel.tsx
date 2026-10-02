import { useState } from 'react'
import { SimMark } from '@/components/domain/SimMark'
import { StatusLamp } from '@/components/domain/Status'
import { TokenGlyph } from '@/components/domain/TokenGlyph'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Figures } from '@/components/ui/Figures'
import { Tabs } from '@/components/ui/Form'
import { tabPanelProps } from '@/components/ui/tabs'
import { Skeleton, Tag } from '@/components/ui/Indicators'
import { Pct, Price } from '@/components/ui/Num'
import { Panel } from '@/components/ui/Panel'
import { Table, Td, Th, Tr } from '@/components/ui/Table'
import { useToast } from '@/components/ui/toast-context'
import { formatAgo, formatCompact, formatNumber, formatPrice, formatUntil } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import { useOrderMutations, useOrders, useTokens, useWallets } from '@/services/queries'
import type { LimitOrder } from '@/types/domain'

const TYPE_LABEL = { limit: 'Limit', 'take-profit': 'Take profit', 'stop-loss': 'Stop loss' } as const

export function OrdersPanel() {
  const orders = useOrders()
  const { data: tokens = [] } = useTokens()
  const { data: wallets = [] } = useWallets()
  const { cancel } = useOrderMutations()
  const toast = useToast()
  const now = useNow(30_000)
  const [tab, setTab] = useState<'open' | 'history'>('open')

  const all = orders.data ?? []
  const open = all.filter((o) => o.status === 'open')
  const history = all.filter((o) => o.status !== 'open')
  const list = tab === 'open' ? open : history
  const tokenOf = (o: LimitOrder) => tokens.find((t) => t.id === o.tokenId)
  const walletLabel = (id: string) => wallets.find((w) => w.id === id)?.label ?? id

  const amountText = (o: LimitOrder) => {
    const symbol = tokenOf(o)?.symbol ?? ''
    return o.side === 'buy' ? `${formatNumber(o.amount, 2, 2)} NEAR` : `${formatCompact(o.amount, 2)} ${symbol}`
  }
  const timing = (o: LimitOrder) => (o.status === 'open' ? (o.expiresAt ? formatUntil(o.expiresAt, now) : 'Never') : o.closedAt ? formatAgo(o.closedAt, now) : '—')

  const doCancel = (o: LimitOrder) =>
    cancel.mutate(o.id, {
      onSuccess: () => toast.push({ title: `${TYPE_LABEL[o.type]} ${o.side} cancelled`, detail: `${tokenOf(o)?.symbol ?? ''} at $${formatPrice(o.triggerPriceUsd)}` }),
      onError: (e) => toast.push({ tone: 'neg', title: 'Could not cancel', detail: e instanceof Error ? e.message : '' }),
    })

  return (
    <Panel>
      <div className="px-4 pt-2">
        <Tabs
          idBase="orders"
          label="Orders"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'open', label: 'Open orders', count: open.length },
            { value: 'history', label: 'History', count: history.length },
          ]}
        />
      </div>
      <div {...tabPanelProps('orders', tab)} className="outline-none">
        {orders.isPending ? (
          <div className="p-4">
            <Skeleton className="h-40 w-full" />
          </div>
        ) : list.length === 0 ? (
          <EmptyState title={tab === 'open' ? 'No open orders' : 'No past orders'}>
            {tab === 'open' ? 'Place a limit, take-profit or stop-loss order with the form.' : 'Filled, cancelled and expired orders collect here.'}
          </EmptyState>
        ) : (
          <div className="@container">
            <div className="hidden @[48rem]:block">
              <Table label={tab === 'open' ? 'Open orders' : 'Order history'} rows="double" minWidth={640}>
                <thead>
                  <tr>
                    <Th>Order</Th>
                    <Th align="right">Trigger</Th>
                    <Th align="right">Market</Th>
                    <Th align="right">Amount</Th>
                    <Th align="right">{tab === 'open' ? 'Expires' : 'Closed'}</Th>
                    <Th>Status</Th>
                    {tab === 'open' && (
                      <Th align="right">
                        <span className="sr-only">Actions</span>
                      </Th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {list.map((o) => {
                    const token = tokenOf(o)
                    const market = token?.market?.priceUsd ?? 0
                    const distance = market ? ((o.triggerPriceUsd - market) / market) * 100 : 0
                    return (
                      <Tr key={o.id}>
                        <Td>
                          <span className="flex items-center gap-2.5">
                            <TokenGlyph symbol={token?.symbol ?? '?'} tokenId={o.tokenId} size={24} />
                            <span className="flex flex-col gap-0.5">
                              <span className="font-medium text-fg">{token?.symbol}</span>
                              <span className="flex items-center gap-1.5 text-xs text-fg-3">
                                <Tag tone={o.side === 'buy' ? 'accent' : 'neg'}>{o.side}</Tag>
                                {TYPE_LABEL[o.type]}
                              </span>
                            </span>
                          </span>
                        </Td>
                        <Td align="right">
                          <Price value={o.triggerPriceUsd} className="text-fg" />
                          <div className="text-[11px] text-fg-3">
                            <Pct value={distance} colored={false} /> vs market
                          </div>
                        </Td>
                        <Td align="right">
                          <Price value={market} className="text-fg-2" />
                          {token?.status === 'prelaunch' && <SimMark />}
                        </Td>
                        <Td align="right">
                          <span className="num text-fg-2">{amountText(o)}</span>
                          <div className="text-[11px] text-fg-3">{walletLabel(o.walletId)}</div>
                        </Td>
                        <Td align="right" className="text-xs text-fg-3">
                          <Figures>{timing(o)}</Figures>
                        </Td>
                        <Td>
                          <StatusLamp status={o.status} />
                        </Td>
                        {tab === 'open' && (
                          <Td align="right">
                            <Button size="xs" variant="danger" onClick={() => doCancel(o)} disabled={cancel.isPending && cancel.variables === o.id}>
                              Cancel
                            </Button>
                          </Td>
                        )}
                      </Tr>
                    )
                  })}
                </tbody>
              </Table>
            </div>
            <ul className="divide-y divide-line-soft @[48rem]:hidden" aria-label={tab === 'open' ? 'Open orders' : 'Order history'}>
              {list.map((o) => {
                const token = tokenOf(o)
                const market = token?.market?.priceUsd ?? 0
                const distance = market ? ((o.triggerPriceUsd - market) / market) * 100 : 0
                return (
                  <li key={o.id} className="flex flex-col gap-2 px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        <Tag tone={o.side === 'buy' ? 'accent' : 'neg'}>{o.side}</Tag>
                        <span className="font-medium text-fg">{token?.symbol}</span>
                        <span className="text-xs text-fg-3">{TYPE_LABEL[o.type]}</span>
                      </span>
                      <StatusLamp status={o.status} />
                    </div>
                    <p className="text-xs text-fg-3">
                      at <Price value={o.triggerPriceUsd} className="text-fg-2" /> · <Pct value={distance} colored={false} /> from market · <Figures>{amountText(o)}</Figures>
                    </p>
                    <div className="flex items-center justify-between text-xs text-fg-3">
                      <span>
                        <Figures>{`${walletLabel(o.walletId)} · ${tab === 'open' ? (o.expiresAt ? `expires ${timing(o)}` : 'no expiry') : `closed ${timing(o)}`}`}</Figures>
                      </span>
                      {tab === 'open' && (
                        <Button size="xs" variant="danger" onClick={() => doCancel(o)}>
                          Cancel
                        </Button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>
    </Panel>
  )
}
