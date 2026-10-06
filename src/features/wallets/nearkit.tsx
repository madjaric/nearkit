import { ChevronDown, ChevronUp, LogOut, Pencil, Plus, Send, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { AccountText } from '@/components/domain/Account'
import { OwnWalletPicker } from '@/components/domain/OwnWalletPicker'
import { ApproveDestinationStep } from '@/features/recover/ApproveDestination'
import { Button, IconButton } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/Copy'
import { Modal } from '@/components/ui/Dialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { Figures } from '@/components/ui/Figures'
import { Field, Input, Select } from '@/components/ui/Form'
import { Skeleton, Tag } from '@/components/ui/Indicators'
import { Usd } from '@/components/ui/Num'
import { Line, Lines, Panel, PanelHeader } from '@/components/ui/Panel'
import { Table, Td, Th, Tr } from '@/components/ui/Table'
import { useToast } from '@/components/ui/toast-context'
import { isKitToken } from '@/config/kit'
import { NATIVE_TOKEN_ID, NEAR_DECIMALS } from '@/config/networks'
import { formatUnits } from '@/lib/amounts'
import { formatAccount, formatAmount } from '@/lib/format'
import { rankTokenList } from '@/lib/tokenRanking'
import { WALLET_DUST_NEAR } from '@/lib/walletDust'
import { approvalLink, BOT_NAME, WEB_SIGN_IN_URL } from '@/lib/telegramLinks'
import { accountIdError } from '@/lib/validation'
import { describeError } from '@/services/errors'
import { explorerTxUrl } from '@/services/near/explorer'
import { newCreateKey, type NearKitWebWallet, type SendApproval, type WebLegStatus } from '@/services/nearkitWeb'
import { LinkRequestError } from '@/services/telegramLink'
import { sendTargets } from '@/services/postTradeRefresh'
import { useCapabilities, useNearKitMutations, useNearKitSession, useNearKitWallets, useSendStatus, useTokens } from '@/services/queries'
import type { Wallet, WalletSnapshot } from '@/types/domain'

/**
 * The signed-in Telegram user's NearKit wallets on NearKit web: sign in from the bot's /web
 * link, see them, create and rename them, and send from one. NearKit's server executes each
 * wallet's own trades and sends with its key, which only NearKit's signer holds: nothing here
 * signs, and nothing needs Telegram.
 */

/** A link that looks like a key (the app's buttons are keys; links to Telegram open a new tab). */
export function TelegramLink({ href, children, variant = 'secondary' }: { href: string; children: string; variant?: 'primary' | 'secondary' }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="inline-flex">
      <Button variant={variant} tabIndex={-1}>
        {children}
      </Button>
    </a>
  )
}

/** How to sign in: the bot sends a one-time link. */
export function NearKitSignIn({ title = 'Sign in with Telegram to use your NEARKITS wallets' }: { title?: string }) {
  return (
    <EmptyState
      title={title}
      action={
        WEB_SIGN_IN_URL ? (
          <TelegramLink href={WEB_SIGN_IN_URL} variant="primary">
            Sign in with Telegram
          </TelegramLink>
        ) : null
      }
    >
      {`Open ${BOT_NAME} and send /web: it replies with a one-time link that opens this page signed in. No browser wallet and no /link needed.`}
    </EmptyState>
  )
}

const ownerText = (owner: string | null) => (owner ? `Owner ${formatAccount(owner, 24)}` : 'Controlled in Telegram')

/** The NearKit wallets panel: executable right here, by NearKit's server. */
export function NearKitWalletsPanel({ snapshots }: { snapshots: readonly WalletSnapshot[] }) {
  const toast = useToast()
  const session = useNearKitSession()
  const list = useNearKitWallets()
  const { logout, reorder } = useNearKitMutations()
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<NearKitWebWallet | null>(null)
  const [deleting, setDeleting] = useState<NearKitWebWallet | null>(null)
  const [sending, setSending] = useState<Wallet | null>(null)
  // An order being saved: shown at once, until the server's list replaces it.
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null)
  const listed = list.data?.wallets ?? []
  const wallets = pendingOrder ? pendingOrder.flatMap((id) => listed.filter((w) => w.id === id)) : listed
  const limit = list.data?.limit ?? 10
  const snapshotOf = (w: NearKitWebWallet) => snapshots.find((s) => s.accountId === w.accountId)
  /** Moves a wallet up or down the list; only the order changes (NearKit's server keeps it). */
  const move = (index: number, delta: -1 | 1) => {
    const ids = wallets.map((w) => w.id)
    const to = index + delta
    if (to < 0 || to >= ids.length) return
    ;[ids[index], ids[to]] = [ids[to] as string, ids[index] as string]
    setPendingOrder(ids)
    reorder.mutate(ids, {
      onError: (e) => toast.push({ tone: 'neg', title: 'The order wasn’t saved', detail: describeError(e).message }),
      onSettled: () => setPendingOrder(null),
    })
  }
  /** Up, down and delete: NearKit wallets only (connected and watch-only accounts never get these). */
  const manage = (w: NearKitWebWallet, i: number) => (
    <>
      <IconButton label={`Move ${w.name} up`} size="sm" disabled={i === 0 || reorder.isPending} onClick={() => move(i, -1)}>
        <ChevronUp size={14} />
      </IconButton>
      <IconButton label={`Move ${w.name} down`} size="sm" disabled={i === wallets.length - 1 || reorder.isPending} onClick={() => move(i, 1)}>
        <ChevronDown size={14} />
      </IconButton>
      <IconButton label={`Delete ${w.name}`} size="sm" tone="danger" onClick={() => setDeleting(w)}>
        <Trash2 size={14} />
      </IconButton>
    </>
  )

  return (
    <Panel>
      <PanelHeader
        title="NEARKITS wallets"
        meta={session && list.data ? `${wallets.length} of ${limit}` : undefined}
        actions={
          session ? (
            <>
              <Button size="sm" variant="primary" icon={<Plus size={14} />} disabled={!list.data?.canCreate} onClick={() => setCreating(true)}>
                Create wallet
              </Button>
              <IconButton
                label={`Sign out ${session.userName} from NEARKITS web`}
                size="sm"
                disabled={logout.isPending}
                onClick={() =>
                  logout.mutate(undefined, {
                    onSuccess: () => toast.push({ title: 'Signed out of NEARKITS web', detail: 'Your NEARKITS wallets are unchanged. Sign in again from Telegram: /web.' }),
                  })
                }
              >
                <LogOut size={14} />
              </IconButton>
            </>
          ) : null
        }
      />
      {!session ? (
        <NearKitSignIn />
      ) : list.isPending ? (
        <div className="p-4">
          <Skeleton className="h-32 w-full" />
        </div>
      ) : list.isError ? (
        <EmptyState
          title="Your NEARKITS wallets can’t be listed right now"
          action={
            <Button variant="secondary" onClick={() => void list.refetch()}>
              Try again
            </Button>
          }
        >
          {describeError(list.error).message}
        </EmptyState>
      ) : wallets.length === 0 ? (
        <EmptyState
          title="No NEARKITS wallets yet"
          action={
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
              Create wallet
            </Button>
          }
        >
          A NEARKITS wallet trades, joins a Multi Buy and sends without a browser wallet: NEARKITS executes each one with the wallet’s own key, which only its signer holds.
        </EmptyState>
      ) : (
        <div className="@container">
          <p className="border-b border-line-soft px-4 py-2 text-xs text-fg-3">
            Trade, Multi Buy, Multi Sell and Send right here: NEARKITS executes each wallet’s own transactions with that wallet’s key. No wallet prompt.
          </p>
          <div className="hidden @[48rem]:block">
            <Table label="NEARKITS wallets" minWidth={760}>
              <thead>
                <tr>
                  <Th>Wallet</Th>
                  <Th>Account</Th>
                  <Th align="right">NEAR</Th>
                  <Th align="right">Tokens</Th>
                  <Th align="right">Value</Th>
                  <Th>Control</Th>
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {wallets.map((w, i) => {
                  const s = snapshotOf(w)
                  const tokens = s ? s.holdings.filter((h) => h.amount > 0 && h.tokenId !== NATIVE_TOKEN_ID).length : null
                  return (
                    <Tr key={w.id}>
                      <Td>
                        <span className="flex items-center gap-2 text-fg">
                          {w.name}
                          {w.frozen && (
                            <Tag tone="warn" title="Frozen by NEARKITS for your protection: it doesn't trade or send.">
                              Frozen
                            </Tag>
                          )}
                        </span>
                      </Td>
                      <Td>
                        <span className="flex items-center gap-1">
                          <AccountText id={w.accountId} className="text-fg-2" />
                          <CopyButton value={w.accountId} label={`Copy ${w.name} address`} />
                        </span>
                      </Td>
                      <Td align="right" mono className="text-fg-2">
                        {s ? formatAmount(s.nearBalance, 2) : '—'}
                      </Td>
                      <Td align="right" mono className={tokens ? 'text-fg-2' : 'text-fg-4'}>
                        {tokens ?? '—'}
                      </Td>
                      <Td align="right">{s ? <Usd value={s.valueUsd} className="text-fg" /> : <span className="text-fg-4">—</span>}</Td>
                      <Td>
                        <span className="text-xs text-fg-3">{ownerText(w.owner)}</span>
                      </Td>
                      <Td align="right">
                        <span className="flex items-center justify-end gap-1">
                          <Button size="xs" variant="ghost" icon={<Send size={12} />} disabled={!s || w.frozen} onClick={() => s && setSending(s)}>
                            Send
                          </Button>
                          <IconButton label={`Rename ${w.name}`} size="sm" onClick={() => setRenaming(w)}>
                            <Pencil size={14} />
                          </IconButton>
                          {manage(w, i)}
                        </span>
                      </Td>
                    </Tr>
                  )
                })}
              </tbody>
            </Table>
          </div>
          <ul className="divide-y divide-line-soft @[48rem]:hidden" aria-label="NEARKITS wallets">
            {wallets.map((w, i) => {
              const s = snapshotOf(w)
              return (
                <li key={w.id} className="flex items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm text-fg">
                      {w.name} {w.frozen && <Tag tone="warn">Frozen</Tag>}
                    </p>
                    <p className="flex items-center gap-1">
                      <AccountText id={w.accountId} className="text-xs text-fg-3" />
                      <CopyButton value={w.accountId} label={`Copy ${w.name} address`} className="size-5" />
                    </p>
                    <p className="mt-0.5 text-[11px] text-fg-4">{ownerText(w.owner)}</p>
                    <div className="mt-1 flex items-center gap-1">{manage(w, i)}</div>
                  </div>
                  <div className="flex items-start gap-1">
                    <div className="text-right">
                      {s ? <Usd value={s.valueUsd} className="text-sm text-fg" /> : <span className="text-fg-4">—</span>}
                      <p className="num text-xs text-fg-3">{s ? `${formatAmount(s.nearBalance, 2)} NEAR` : '—'}</p>
                    </div>
                    <IconButton label={`Send from ${w.name}`} size="sm" disabled={!s || w.frozen} onClick={() => s && setSending(s)}>
                      <Send size={14} />
                    </IconButton>
                    <IconButton label={`Rename ${w.name}`} size="sm" onClick={() => setRenaming(w)}>
                      <Pencil size={14} />
                    </IconButton>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}
      <CreateWalletModal open={creating} onClose={() => setCreating(false)} />
      <RenameWalletModal wallet={renaming} onClose={() => setRenaming(null)} />
      <DeleteWalletModal wallet={deleting} snapshot={deleting ? snapshotOf(deleting) : undefined} onClose={() => setDeleting(null)} />
      <NearKitSendModal wallet={sending} onClose={() => setSending(null)} />
    </Panel>
  )
}

// ─── delete ─────────────────────────────────────────────────────────────────

/**
 * Deleting a NEARKITS wallet: one that holds nothing of value, the bot's own way (src/lib/walletDust.ts):
 * never funded, or only NEAR dust (under 0.05 NEAR, what sending everything out leaves behind), and no
 * tokens. NEARKITS' server reads the chain; a never-funded wallet's key is erased (the signer reads the
 * chain again first), a dust wallet's key stays sealed; the slot is free again. A wallet holding 0.05 NEAR
 * or more, any token, a send on its way or a live Volume Bot stays.
 */
function DeleteWalletModal({ wallet, snapshot, onClose }: { wallet: NearKitWebWallet | null; snapshot: WalletSnapshot | undefined; onClose: () => void }) {
  const toast = useToast()
  const { remove } = useNearKitMutations()
  // What this page knows; NEARKITS' server decides from the chain, now.
  const tokens = Boolean(snapshot?.holdings.some((h) => h.tokenId !== NATIVE_TOKEN_ID && h.amount > 0))
  const nearBalance = snapshot?.nearBalance ?? 0
  const holds = tokens || nearBalance >= WALLET_DUST_NEAR
  const dust = !holds && nearBalance > 0 ? nearBalance : 0
  const close = () => {
    remove.reset()
    onClose()
  }
  return (
    <Modal open={wallet !== null} onClose={close} size="sm" title={`Delete ${wallet?.name ?? 'NEARKITS wallet'}?`}>
      {wallet && (
        <div className="flex flex-col gap-4">
          <p className="flex items-center gap-1 text-sm text-fg-2">
            <AccountText id={wallet.accountId} className="text-fg" />
          </p>
          {holds ? (
            <p role="alert" className="text-sm text-fg-2">
              {tokens
                ? `${wallet.name} holds tokens, so it can’t be deleted: tokens are never treated as dust. Send or sell them first.`
                : `${wallet.name} holds ${WALLET_DUST_NEAR} NEAR or more, so it can’t be deleted. Send its NEAR out first: what sending everything leaves behind is dust (under ${WALLET_DUST_NEAR} NEAR), and a wallet holding only dust can be deleted.`}
            </p>
          ) : (
            <p className="text-sm text-fg-2">
              {dust > 0 ? (
                <Figures>{`${wallet.name} holds only dust: ${formatAmount(dust, 6)} NEAR, under ${WALLET_DUST_NEAR} NEAR. Deleting it leaves that dust on chain; NEARKITS keeps the wallet’s key sealed rather than erasing it. Its slot is free for a new wallet.`}</Figures>
              ) : (
                `A wallet holding nothing (under ${WALLET_DUST_NEAR} NEAR of dust, and no tokens) can be deleted: NEARKITS checks the chain and frees its slot for a new wallet.`
              )}
            </p>
          )}
          {remove.isError && (
            <p role="alert" className="text-sm text-neg">
              {describeError(remove.error).message}
            </p>
          )}
          <div className="flex flex-col-reverse gap-2 border-t border-line-soft pt-4 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={close}>
              {holds ? 'Close' : 'Keep it'}
            </Button>
            {!holds && (
              <Button
                variant="danger"
                icon={<Trash2 size={14} />}
                loading={remove.isPending}
                onClick={() =>
                  remove.mutate(wallet.id, {
                    onSuccess: ({ dustYocto }) => {
                      const left = BigInt(dustYocto)
                      toast.push({
                        title: `${wallet.name} deleted`,
                        detail:
                          left > 0n
                            ? `It held only dust (${formatUnits(left, NEAR_DECIMALS, { maxFraction: 6 })} NEAR), left on chain. Its slot is free for a new wallet.`
                            : 'It held nothing, so nothing was lost. Its slot is free for a new wallet.',
                      })
                      close()
                    },
                  })
                }
              >
                Delete wallet
              </Button>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}

// ─── create ─────────────────────────────────────────────────────────────────

export function CreateWalletModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} size="sm" title="Create a NEARKITS wallet" description="A new wallet of your own, ready to trade once it holds NEAR.">
      {open && <CreateWalletForm onClose={onClose} />}
    </Modal>
  )
}

function CreateWalletForm({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const { create } = useNearKitMutations()
  const [name, setName] = useState('')
  // One key for this Create: a double submit, or a retry after a lost answer, makes one wallet.
  const [createKey] = useState(newCreateKey)
  const error = create.error ? describeError(create.error).message : null
  const submit = () =>
    create.mutate(
      { name: name.trim(), createKey },
      {
        onSuccess: (w) => {
          onClose()
          toast.push({
            tone: 'accent',
            title: `${w.name} created`,
            detail: `Its address is ${formatAccount(w.accountId)}. Deposit NEAR to it to trade. Telegram has a notice too.`,
          })
        },
      },
    )
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <Field label="Name" hint="Optional, up to 24 characters. Without one it’s named by its number, like Wallet 3." error={error ?? undefined}>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            value={name}
            maxLength={24}
            onChange={(e) => setName(e.target.value)}
            placeholder="Degen 1"
            aria-describedby={describedBy}
            aria-invalid={invalid}
            autoFocus
          />
        )}
      </Field>
      <p className="text-xs text-fg-3">
        NEARKITS creates the wallet and keeps its key in its signer: the key never reaches this page. It trades as soon as it holds NEAR, here or in Telegram. Up to 10 NEARKITS
        wallets at once.
      </p>
      <div className="flex flex-col-reverse gap-2 border-t border-line-soft pt-4 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={create.isPending}>
          Create wallet
        </Button>
      </div>
    </form>
  )
}

// ─── rename ─────────────────────────────────────────────────────────────────

export function RenameWalletModal({ wallet, onClose }: { wallet: NearKitWebWallet | null; onClose: () => void }) {
  return (
    <Modal
      open={wallet !== null}
      onClose={onClose}
      size="sm"
      title={`Rename ${wallet?.name ?? 'wallet'}`}
      description="Only the name changes: the address, key and owner stay the same."
    >
      {wallet && <RenameWalletForm key={wallet.id} wallet={wallet} onClose={onClose} />}
    </Modal>
  )
}

function RenameWalletForm({ wallet, onClose }: { wallet: NearKitWebWallet; onClose: () => void }) {
  const toast = useToast()
  const { rename } = useNearKitMutations()
  const [name, setName] = useState(wallet.name)
  const error = rename.error ? describeError(rename.error).message : null
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        rename.mutate(
          { walletId: wallet.id, name: name.trim() },
          {
            onSuccess: (w) => {
              onClose()
              toast.push({ title: `Renamed to ${w.name}` })
            },
          },
        )
      }}
    >
      <Field label="Name" hint="Up to 24 characters. Empty restores the default name." error={error ?? undefined}>
        {({ id, describedBy, invalid }) => (
          <Input id={id} value={name} maxLength={24} onChange={(e) => setName(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} autoFocus />
        )}
      </Field>
      <div className="flex flex-col-reverse gap-2 border-t border-line-soft pt-4 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={rename.isPending}>
          Save name
        </Button>
      </div>
    </form>
  )
}

// ─── send ───────────────────────────────────────────────────────────────────

/**
 * Send from a NearKit wallet, right here: NearKit's server reviews it (balance, destination,
 * fee), and on Send executes it with the wallet's own key. The custody rules hold: it goes only
 * to the wallet's owner or an address approved for it (the signer enforces that), and nothing
 * moves while NearKit has withdrawals paused.
 */
export function NearKitSendModal({ wallet, tokenId, onClose }: { wallet: Wallet | WalletSnapshot | null; tokenId?: string; onClose: () => void }) {
  return (
    <Modal
      open={wallet !== null}
      onClose={onClose}
      size="sm"
      title={`Send from ${wallet?.label ?? 'NEARKITS wallet'}`}
      description="Reviewed, then sent by NEARKITS from this wallet. No wallet prompt."
    >
      {wallet && <SendForm key={`${wallet.id}:${tokenId ?? ''}`} wallet={wallet} tokenId={tokenId} onClose={onClose} />}
    </Modal>
  )
}

const SEND_STATUS: Record<WebLegStatus, string> = {
  quoted: 'Starting',
  requoted: 'Something changed: review it again',
  executing: 'Sending',
  processing: 'Processing: waiting for the NEAR network',
  done: 'Sent',
  failed: 'Failed',
  cancelled: 'Cancelled',
  expired: 'The review expired: review it again',
}

function SendForm({ wallet, tokenId, onClose }: { wallet: Wallet | WalletSnapshot; tokenId?: string; onClose: () => void }) {
  const caps = useCapabilities()
  const { data: tokens = [] } = useTokens()
  const { reviewSend, executeSend } = useNearKitMutations()
  const holdings = 'holdings' in wallet ? wallet.holdings : []
  const held = holdings.filter((h) => h.amount > 0)
  // What this wallet holds, in NEARKITS' one token order ($KIT, NEAR, the rest by value).
  const heldIds = [NATIVE_TOKEN_ID, ...held.map((h) => h.tokenId).filter((id) => id !== NATIVE_TOKEN_ID)]
  const ranked = rankTokenList(
    tokens.filter((t) => heldIds.includes(t.id)),
    { held: new Map(held.map((h) => [h.tokenId, h.amount])), kitId: tokens.find((t) => isKitToken(t.id))?.id ?? null },
  ).map((t) => t.id)
  const assets = [...ranked, ...heldIds.filter((id) => !ranked.includes(id))]
  if (tokenId && !assets.includes(tokenId)) assets.push(tokenId)
  const [asset, setAsset] = useState(tokenId ?? NATIVE_TOKEN_ID)
  const [amount, setAmount] = useState('')
  // MAX: NearKit's server works out the most this wallet can send (for NEAR, the network fee stays).
  const [max, setMax] = useState(false)
  const [to, setTo] = useState('')
  const [touched, setTouched] = useState(false)
  const [sending, setSending] = useState<string | null>(null)
  /** "Approve & continue": the owner approval of this destination, inside Send. */
  const [approving, setApproving] = useState<{ wallet: string; destination: string } | null>(null)
  /** A Telegram approval opened in a new tab: Continue reviews the send again once it's approved. */
  const [telegramOpened, setTelegramOpened] = useState(false)
  // The user's own NearKit wallets: a shortcut for the destination, nothing more.
  const { data: own } = useNearKitWallets()
  // The wallet and the destination, for the token sent: their balances reconcile once the send finishes.
  const status = useSendStatus(sending, reviewSend.data ? sendTargets(reviewSend.data.review.asset, [{ from: wallet.accountId, to: reviewSend.data.review.to }]) : undefined)
  const symbolOf = (id: string) => (id === NATIVE_TOKEN_ID ? 'NEAR' : (tokens.find((t) => t.id === id)?.symbol ?? formatAccount(id, 20)))
  const balance = held.find((h) => h.tokenId === asset)
  const toError = touched ? accountIdError(to) : null
  const amountError = touched && !max && !(Number(amount) > 0) ? 'Enter an amount above 0' : null
  const reviewError =
    reviewSend.error instanceof LinkRequestError ? reviewSend.error : reviewSend.error ? new LinkRequestError(0, 'error', describeError(reviewSend.error).message) : null
  const approval = reviewError?.code === 'needs-approval' ? (reviewError.detail as SendApproval | null) : null
  const paused = reviewError?.code === 'paused' || (executeSend.error instanceof LinkRequestError && executeSend.error.code === 'paused')
  const r = reviewSend.data
  const back = () => {
    reviewSend.reset()
    executeSend.reset()
    setSending(null)
  }

  // Sent, or sending: the status as NearKit's server reports it.
  if (sending) {
    const s = status.data
    const finished = s?.status === 'done' || s?.status === 'failed' || s?.status === 'requoted' || s?.status === 'expired' || s?.status === 'cancelled'
    return (
      <div className="flex flex-col gap-4">
        <p className={s?.status === 'failed' ? 'text-sm text-neg' : s?.status === 'done' ? 'text-sm text-fg' : 'text-sm text-fg-2'} aria-live="polite">
          {s ? SEND_STATUS[s.status] : 'Sending'}
        </p>
        {s?.message && <p className="text-sm text-neg">{s.message}</p>}
        {s?.hashes.length ? (
          <p className="text-xs text-fg-3">
            {s.hashes.map((h) => (
              <a
                key={h}
                href={caps.explorerUrl ? explorerTxUrl({ explorerUrl: caps.explorerUrl }, h) : undefined}
                target="_blank"
                rel="noreferrer noopener"
                className="num mr-2 underline"
              >
                {`${h.slice(0, 6)}…${h.slice(-4)}`}
              </a>
            ))}
          </p>
        ) : null}
        <div className="flex flex-col-reverse gap-2 border-t border-line-soft pt-4 sm:flex-row sm:justify-end">
          {finished && s?.status !== 'done' && (
            <Button variant="ghost" onClick={back}>
              Back
            </Button>
          )}
          <Button variant={finished ? 'primary' : 'ghost'} onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    )
  }

  // Reviewed: what NearKit will send, and Send.
  // The same send, reviewed again (after an approval, the review goes through).
  const review = () => {
    if (!wallet.nearkitId) return
    reviewSend.mutate({ walletId: wallet.nearkitId, token: asset, amount: max ? 'max' : amount.trim(), to: to.trim() })
  }

  if (approving) {
    return (
      <ApproveDestinationStep
        wallet={approving.wallet}
        destination={approving.destination}
        onApproved={() => {
          setApproving(null)
          review()
        }}
        onBack={() => setApproving(null)}
      />
    )
  }

  if (r) {
    const fee = formatUnits(BigInt(r.review.feeNear), NEAR_DECIMALS, { maxFraction: 6 })
    return (
      <div className="flex flex-col gap-4">
        <Lines>
          <Line label="From">{`${r.review.from} · ${formatAccount(r.review.accountId)}`}</Line>
          <Line label="Amount" emphasis>
            <Figures>{`${formatUnits(BigInt(r.review.amount), r.review.decimals, { maxFraction: 8, group: true })} ${r.review.symbol}`}</Figures>
          </Line>
          <Line label="To">
            <span className="num">{r.review.to}</span>
            {r.review.linked ? ' · your linked wallet' : r.review.sibling ? ` · your NEARKITS wallet ${r.review.sibling} (same owner: no approval needed)` : ''}
          </Line>
          <Line label="Network fee (est.)">
            <Figures>{`${fee} NEAR`}</Figures>
          </Line>
          {r.review.registration !== null && (
            <Line label="Registration">
              <Figures>{`${formatUnits(BigInt(r.review.registration), NEAR_DECIMALS, { maxFraction: 5 })} NEAR`}</Figures>
            </Line>
          )}
        </Lines>
        {r.review.fresh && <p className="text-xs text-warn">{`This address has never been used on ${caps.networkLabel.toLowerCase()}. Check it carefully.`}</p>}
        <p className="text-xs text-fg-3">Check the address: transfers can’t be undone.</p>
        {executeSend.error && (
          <p role="alert" className="text-sm text-neg">
            {paused ? 'Withdrawals are paused by NEARKITS right now. Nothing was sent.' : describeError(executeSend.error).message}
          </p>
        )}
        <div className="flex flex-col-reverse gap-2 border-t border-line-soft pt-4 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={back}>
            Back
          </Button>
          <Button variant="primary" loading={executeSend.isPending} disabled={paused} onClick={() => executeSend.mutate(r.intentId, { onSuccess: () => setSending(r.intentId) })}>
            Send
          </Button>
        </div>
      </div>
    )
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        setTouched(true)
        if (accountIdError(to) || (!max && !(Number(amount) > 0)) || !wallet.nearkitId) return
        review()
      }}
    >
      {paused && (
        <p role="alert" className="rounded-sm border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
          Withdrawals are paused by NEARKITS right now: nothing can be sent until NEARKITS resumes them. Your funds stay where they are.
        </p>
      )}
      <Field label="Asset">
        {({ id }) => (
          <Select
            id={id}
            value={asset}
            onChange={(e) => {
              setAsset(e.target.value)
              setMax(false)
              reviewSend.reset()
            }}
          >
            {assets.map((a) => (
              <option key={a} value={a}>
                {symbolOf(a)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field
        label="Amount"
        error={amountError ?? undefined}
        hint={max ? (asset === NATIVE_TOKEN_ID ? 'The most it can send: a little NEAR stays for the network fee.' : 'Its whole balance.') : undefined}
        aside={
          <>
            {balance && <span className="num text-2xs text-fg-3">{`Balance ${formatAmount(balance.amount, 2)}`}</span>}
            <button type="button" aria-pressed={max} className="keycap text-2xs text-fg-3 hover:text-fg aria-pressed:text-accent" onClick={() => setMax((m) => !m)}>
              MAX
            </button>
          </>
        }
      >
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            mono
            inputMode="decimal"
            value={max ? 'MAX' : amount}
            onChange={(e) => {
              setMax(false)
              setAmount(e.target.value.replace(/^MAX/, ''))
            }}
            placeholder="0.00"
            aria-describedby={describedBy}
            aria-invalid={invalid}
          />
        )}
      </Field>
      <Field
        label="To"
        error={toError ?? undefined}
        hint={`A ${caps.networkLabel.toLowerCase()} account`}
        aside={
          <OwnWalletPicker
            wallets={(own?.wallets ?? []).map((w) => ({ accountId: w.accountId, name: w.name }))}
            value={to}
            exclude={wallet.accountId}
            onPick={(accountId) => {
              setTo(accountId)
              setTelegramOpened(false)
              if (approval) reviewSend.reset()
            }}
          />
        }
      >
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            mono
            value={to}
            onChange={(e) => {
              setTo(e.target.value)
              setTelegramOpened(false)
              if (approval) reviewSend.reset()
            }}
            placeholder={caps.network === 'mainnet' ? 'name.near' : 'name.testnet'}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="none"
            aria-describedby={describedBy}
            aria-invalid={invalid}
          />
        )}
      </Field>
      {approval ? (
        <div className="flex flex-col gap-2 rounded-sm border border-line px-3 py-2.5">
          <p className="text-sm text-fg">{reviewError?.message}</p>
          <p className="text-xs text-fg-3">
            {approval.kind === 'owner'
              ? `Approve & continue: ${formatAccount(approval.owner)}, the owner wallet, signs the approval here, once; then the send is reviewed again. The approval is the custody safeguard: nobody who gets into this account can send funds to a new address alone.`
              : telegramOpened
                ? 'Approve it in NEARKITS’ Telegram mini app (opened in a new tab), then Continue: the send is reviewed again.'
                : 'This wallet has no owner wallet, so its Telegram account approves a new address once, in NEARKITS’ mini app. The approval is the custody safeguard: nobody who gets into this account can send funds to a new address alone.'}
          </p>
        </div>
      ) : (
        reviewError &&
        !paused && (
          <p role="alert" className="text-sm text-neg">
            {reviewError.message}
          </p>
        )
      )}
      <div className="flex flex-col-reverse gap-2 border-t border-line-soft pt-4 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {approval?.kind === 'owner' ? (
          // Not approved yet: one way forward, approving it (no competing Review).
          <Button type="button" variant="primary" onClick={() => setApproving({ wallet: approval.accountId, destination: to.trim() })}>
            Approve & continue
          </Button>
        ) : approval?.kind === 'telegram' && approvalLink(approval.url) && !telegramOpened ? (
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              const link = approvalLink(approval.url)
              if (link) window.open(link, '_blank', 'noopener,noreferrer')
              setTelegramOpened(true)
            }}
          >
            Approve in Telegram
          </Button>
        ) : (
          <Button type="submit" variant="primary" loading={reviewSend.isPending}>
            {approval?.kind === 'telegram' ? 'Continue' : 'Review'}
          </Button>
        )}
      </div>
    </form>
  )
}
