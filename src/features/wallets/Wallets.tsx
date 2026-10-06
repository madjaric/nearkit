import { CopyPlus, Pencil, Plus, Send, Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { AccountText } from '@/components/domain/Account'
import { Button, IconButton } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/Copy'
import { Modal } from '@/components/ui/Dialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { Figures } from '@/components/ui/Figures'
import { Tip } from '@/components/ui/Floating'
import { InfoTip } from '@/components/ui/Help'
import { ComingSoon, Skeleton, Tag } from '@/components/ui/Indicators'
import { Usd } from '@/components/ui/Num'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { ReadoutSlot, ReadoutStrip } from '@/components/ui/Readout'
import { Table, Td, Th, Tr } from '@/components/ui/Table'
import { useToast } from '@/components/ui/toast-context'
import { isComingSoon } from '@/config/release'
import { formatAgo, formatAmount, formatUsd } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import { canExecute, executableWallets, executesViaNearKit, signsInBrowser } from '@/lib/wallets'
import { useServices } from '@/services/context'
import { useAccountMutations, useCapabilities, usePresetMutations, usePresets, useSession, useWalletSnapshots } from '@/services/queries'
import { describeError } from '@/services/errors'
import { useConnectPrompt } from '@/state/contexts'
import type { WalletPreset, WalletSnapshot } from '@/types/domain'
import { AddAccountModal } from './AddAccountModal'
import { NearKitWalletsPanel } from './nearkit'
import { PresetModal } from './PresetModal'

/** Main, then whether this wallet can sign now (real mode). */
function AccessTags({ wallet, real }: { wallet: WalletSnapshot; real: boolean }) {
  return (
    <>
      {wallet.isMain && <Tag tone="neutral">Main</Tag>}
      {real && !canExecute(wallet) && (
        <Tag tone="soon" title="Shows balances, positions and activity, and can receive. It never trades or sends: connect it in your wallet to use it.">
          Watch only
        </Tag>
      )}
    </>
  )
}

export function Wallets() {
  const caps = useCapabilities()
  const { nearkit } = useServices()
  const { data: session } = useSession()
  const { promptConnect } = useConnectPrompt()
  const navigate = useNavigate()
  const toast = useToast()
  const now = useNow(60_000)
  const snapshots = useWalletSnapshots()
  const presets = usePresets()
  const { duplicate, remove } = usePresetMutations()
  const accounts = useAccountMutations()
  const [editing, setEditing] = useState<{ preset: WalletPreset | null } | null>(null)
  const [deleting, setDeleting] = useState<WalletPreset | null>(null)
  const [adding, setAdding] = useState(false)
  const real = caps.mode === 'near'
  const removeAccount = (w: WalletSnapshot) =>
    accounts.remove.mutate(w.id, {
      onSuccess: () => toast.push({ title: `${w.label} removed`, detail: 'It no longer appears in NEARKITS. Nothing changed on chain.' }),
      onError: (e) => toast.push({ tone: 'neg', title: 'Not removed', detail: describeError(e).message }),
    })

  const wallets = snapshots.data ?? []
  const list = presets.data ?? []
  const byId = new Map(wallets.map((w) => [w.id, w]))
  // The totals are the portfolio's: executable wallets only. A watched wallet's balance stays in its own row.
  const portfolio = executableWallets(wallets)
  const totalNear = portfolio.reduce((s, w) => s + w.nearBalance, 0)
  const valued = portfolio.filter((w) => w.valueUsd !== null)
  const totalValue = valued.length ? valued.reduce((s, w) => s + (w.valueUsd ?? 0), 0) : null

  const presetNear = (p: WalletPreset) => p.walletIds.reduce((s, id) => s + (byId.get(id)?.nearBalance ?? 0), 0)
  const presetNames = (walletId: string) => list.filter((p) => p.walletIds.includes(walletId)).map((p) => p.name)
  /**
   * Send from an account of the connected wallet: the send flow it already has (Batch Send, from
   * this account), signed in that wallet. Never NearKit's custody send, and never a watched account.
   */
  const sendFrom = (w: WalletSnapshot) => navigate(`/batch-send?from=${encodeURIComponent(w.id)}`)
  const custody = wallets.filter(executesViaNearKit)
  const connected = wallets.filter(signsInBrowser)
  const watched = wallets.filter((w) => !canExecute(w))

  /** One table of wallets (the demo's, the connected ones, or the watched ones). */
  const walletTable = (rows: WalletSnapshot[], title: string, action: ReactNode, empty: ReactNode) => (
    <Panel>
      <PanelHeader title={title} meta={rows.length} actions={action} />
      {snapshots.isPending ? (
        <div className="p-4">
          <Skeleton className="h-40 w-full" />
        </div>
      ) : rows.length === 0 ? (
        empty
      ) : (
        <div className="@container">
          <div className="hidden @[48rem]:block">
            <Table label={title} minWidth={760}>
              <thead>
                <tr>
                  <Th>Wallet</Th>
                  <Th>Account</Th>
                  <Th align="right">NEAR</Th>
                  <Th align="right">Tokens</Th>
                  <Th align="right">Value</Th>
                  <Th>Presets</Th>
                  {real && (
                    <Th>
                      <span className="sr-only">Actions</span>
                    </Th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => {
                  const names = presetNames(w.id)
                  const tokens = w.holdings.filter((h) => h.amount > 0 && h.tokenId !== 'near').length
                  return (
                    <Tr key={w.id}>
                      <Td>
                        <span className="flex items-center gap-2 text-fg">
                          {w.label}
                          <AccessTags wallet={w} real={real} />
                        </span>
                      </Td>
                      <Td>
                        <span className="flex items-center gap-1">
                          <AccountText id={w.accountId} className="text-fg-2" />
                          <CopyButton value={w.accountId} label={`Copy ${w.label} account`} />
                        </span>
                      </Td>
                      <Td align="right" mono className="text-fg-2">
                        {formatAmount(w.nearBalance, 2)}
                      </Td>
                      <Td align="right" mono className={tokens ? 'text-fg-2' : 'text-fg-4'}>
                        {tokens}
                      </Td>
                      <Td align="right">
                        <Usd value={w.valueUsd} className="text-fg" />
                      </Td>
                      <Td>
                        <span className="flex flex-wrap gap-1">{names.length ? names.map((n) => <Tag key={n}>{n}</Tag>) : <span className="text-xs text-fg-4">None</span>}</span>
                      </Td>
                      {real && (
                        <Td align="right">
                          <span className="flex items-center justify-end gap-1">
                            {signsInBrowser(w) && (
                              <Button
                                size="xs"
                                variant="ghost"
                                icon={<Send size={12} />}
                                aria-label={`Send from ${w.label}: you sign in your wallet`}
                                title="You sign in your wallet"
                                onClick={() => sendFrom(w)}
                              >
                                Send
                              </Button>
                            )}
                            {!canExecute(w) && (
                              <IconButton label={`Remove ${w.label}`} size="sm" tone="danger" disabled={accounts.remove.isPending} onClick={() => removeAccount(w)}>
                                <Trash2 size={14} />
                              </IconButton>
                            )}
                          </span>
                        </Td>
                      )}
                    </Tr>
                  )
                })}
              </tbody>
            </Table>
          </div>
          <ul className="divide-y divide-line-soft @[48rem]:hidden" aria-label={title}>
            {rows.map((w) => (
              <li key={w.id} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm text-fg">
                    {w.label} <AccessTags wallet={w} real={real} />
                  </p>
                  <p className="flex items-center gap-1">
                    <AccountText id={w.accountId} className="text-xs text-fg-3" />
                    <CopyButton value={w.accountId} label={`Copy ${w.label} account`} className="size-5" />
                  </p>
                  <p className="mt-1 flex flex-wrap gap-1">
                    {presetNames(w.id).map((n) => (
                      <Tag key={n}>{n}</Tag>
                    ))}
                  </p>
                </div>
                <div className="flex items-start gap-1">
                  <div className="text-right">
                    <Usd value={w.valueUsd} className="text-sm text-fg" />
                    <p className="num text-xs text-fg-3">{formatAmount(w.nearBalance, 2)} NEAR</p>
                  </div>
                  {real && signsInBrowser(w) && (
                    <IconButton label={`Send from ${w.label}: you sign in your wallet`} size="sm" onClick={() => sendFrom(w)}>
                      <Send size={14} />
                    </IconButton>
                  )}
                  {real && !canExecute(w) && (
                    <IconButton label={`Remove ${w.label}`} size="sm" tone="danger" disabled={accounts.remove.isPending} onClick={() => removeAccount(w)}>
                      <Trash2 size={14} />
                    </IconButton>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  )

  const presetsPanel = (
    <Panel>
      <PanelHeader
        title={
          <span className="flex items-center gap-1.5">
            Presets <InfoTip term="preset" />
          </span>
        }
        meta={list.length}
        actions={
          <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setEditing({ preset: null })}>
            Create preset
          </Button>
        }
      />
      {presets.isPending ? (
        <div className="p-4">
          <Skeleton className="h-32 w-full" />
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          title="No presets"
          action={
            <Button variant="primary" onClick={() => setEditing({ preset: null })}>
              Create preset
            </Button>
          }
        >
          Group wallets once, then apply the group to Multi Trade, Split or Sniper in one click.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line-soft" aria-label="Presets">
          {list.map((p) => (
            <li key={p.id} className="grid grid-cols-1 gap-3 px-4 py-3 md:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto] md:items-center">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="keycap truncate text-sm text-fg">{p.name}</span>
                <span className="truncate text-xs text-fg-3">{p.note || 'No note'}</span>
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-1">
                  {p.walletIds.slice(0, 6).map((id) => (
                    <span key={id} className="rounded-xs border border-line px-1.5 py-0.5 text-[11px] text-fg-2">
                      {byId.get(id)?.label ?? id}
                    </span>
                  ))}
                  {p.walletIds.length > 6 && <span className="text-[11px] text-fg-3">+{p.walletIds.length - 6} more</span>}
                </div>
                <p className="text-xs text-fg-3">
                  <Figures>{`${p.walletIds.length} ${p.walletIds.length === 1 ? 'wallet' : 'wallets'} · ${formatAmount(presetNear(p), 2)} NEAR · updated ${formatAgo(p.updatedAt, now)}`}</Figures>
                </p>
              </div>
              <div className="flex items-center gap-1 md:justify-end">
                <Button size="sm" variant="outline" disabled={isComingSoon('/multi-trade')} onClick={() => navigate(`/multi-trade?preset=${encodeURIComponent(p.id)}`)}>
                  Use
                </Button>
                {isComingSoon('/multi-trade') && <Tag tone="soon">Soon</Tag>}
                <IconButton label={`Edit ${p.name}`} size="sm" onClick={() => setEditing({ preset: p })}>
                  <Pencil size={14} />
                </IconButton>
                <IconButton
                  label={`Duplicate ${p.name}`}
                  size="sm"
                  disabled={duplicate.isPending}
                  onClick={() => duplicate.mutate(p.id, { onSuccess: (copy) => toast.push({ tone: 'accent', title: `${p.name} duplicated`, detail: `Saved as ${copy.name}.` }) })}
                >
                  <CopyPlus size={14} />
                </IconButton>
                <IconButton label={`Delete ${p.name}`} size="sm" tone="danger" onClick={() => setDeleting(p)}>
                  <Trash2 size={14} />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )

  return (
    <>
      <ReadoutStrip cols="grid-cols-2 lg:grid-cols-4">
        <ReadoutSlot
          legend="Wallets"
          loading={snapshots.isPending}
          value={wallets.length}
          sub={
            real
              ? `${nearkit.available ? `${custody.length} NEARKITS · ` : ''}${connected.length} connected · ${watched.length} watch-only`
              : `1 main · ${Math.max(0, wallets.length - 1)} NEARKITS-managed`
          }
        />
        <ReadoutSlot
          legend="NEAR across wallets"
          loading={snapshots.isPending}
          value={formatAmount(totalNear, 2)}
          unit="NEAR"
          sub={watched.length ? `across ${portfolio.length} executable · ${watched.length} watch-only not counted` : `across ${wallets.length} wallets`}
        />
        <ReadoutSlot
          legend="Value"
          loading={snapshots.isPending}
          value={totalValue === null ? <span className="text-fg-4">—</span> : formatUsd(totalValue)}
          sub={totalValue === null ? 'no USD prices on testnet' : caps.mode === 'demo' ? 'all tokens, demo prices' : 'all tokens, Rhea prices'}
        />
        <ReadoutSlot legend="Presets" loading={presets.isPending} value={list.length} sub="saved wallet groups" />
      </ReadoutStrip>

      {real ? (
        <>
          {nearkit.available && <NearKitWalletsPanel snapshots={custody} />}
          {walletTable(
            connected,
            'Connected wallets',
            null,
            <EmptyState
              title="No wallet connected"
              action={
                <Button variant="secondary" onClick={promptConnect}>
                  Connect wallet
                </Button>
              }
            >
              Accounts of a wallet you connect here sign their own trades and sends, in that wallet.
            </EmptyState>,
          )}
          {session &&
            walletTable(
              watched,
              'Watch / Follow',
              <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
                Add account
              </Button>,
              <EmptyState title="Not watching any account">
                Add any NEAR account to follow its balances, positions and activity. A watched account never trades or sends, and never joins a Multi Buy.
              </EmptyState>,
            )}
          {presetsPanel}
        </>
      ) : (
        <>
          {presetsPanel}
          {walletTable(
            wallets,
            'Wallets',
            <Tip content="The demo's wallets are sample accounts. With a real wallet, NEARKITS lists the accounts you connect and any you add to watch.">
              <span className="flex items-center gap-2">
                <Button size="sm" variant="secondary" icon={<Plus size={14} />} disabled>
                  Add wallet
                </Button>
                <ComingSoon label="Demo" />
              </span>
            </Tip>,
            null,
          )}
        </>
      )}

      <PresetModal
        open={editing !== null}
        preset={editing?.preset ?? null}
        wallets={wallets}
        onClose={() => setEditing(null)}
        onSaved={(saved, created) => {
          setEditing(null)
          toast.push({
            tone: 'accent',
            title: created ? `Preset ${saved.name} created` : `Preset ${saved.name} saved`,
            detail: `${saved.walletIds.length} wallets. ${real ? 'Saved in this browser.' : 'Stored for this session.'}`,
          })
        }}
      />

      {real && (
        <AddAccountModal
          open={adding}
          onClose={() => setAdding(false)}
          onAdded={(w) => {
            setAdding(false)
            toast.push({ tone: 'accent', title: `${w.label} added`, detail: `${w.accountId} is watch-only: balances show here, and it can receive.` })
          }}
        />
      )}

      <Modal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        size="sm"
        title={`Delete ${deleting?.name ?? 'preset'}?`}
        description="The wallets stay as they are; only the group is removed."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Keep preset
            </Button>
            <Button
              variant="sell"
              loading={remove.isPending}
              onClick={() =>
                deleting &&
                remove.mutate(deleting.id, {
                  onSuccess: () => {
                    toast.push({ title: `Preset ${deleting.name} deleted` })
                    setDeleting(null)
                  },
                })
              }
            >
              Delete preset
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-2">
          {deleting?.walletIds.length} {deleting?.walletIds.length === 1 ? 'wallet' : 'wallets'} in this preset. Tools that were using it fall back to a manual selection.
        </p>
      </Modal>
    </>
  )
}
