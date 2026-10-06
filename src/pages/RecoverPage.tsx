import { useMutation, useQueries, useQuery } from '@tanstack/react-query'
import { Eye, EyeOff, KeyRound, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Page, PageHeader } from '@/components/page/Page'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/Copy'
import { Checkbox, Field, Input } from '@/components/ui/Form'
import { Tag } from '@/components/ui/Indicators'
import { Line, Lines, Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { ENV } from '@/config/env'
import { createExportKeyPair, openExport } from '@/lib/exportCrypto'
import { accountIdError } from '@/lib/validation'
import { describeError } from '@/services/errors'
import { useCapabilities, useSession } from '@/services/queries'
import { exportStore, type StoredExport } from '@/services/exportStore'
import {
  approveDestination,
  cancelExport,
  collectExport,
  exportStatus,
  listOwnerWallets,
  readRecoverHash,
  requestChallenge,
  requestExport,
  type OwnerChallenge,
  type RecoverTarget,
} from '@/services/recovery'
import { useConnectPrompt } from '@/state/contexts'
import { OwnerMessage, OwnerSignButton } from '@/features/recover/ownerSign'
import { heldExportLine } from '@/features/recover/heldExport'
import { useOwnerSign } from '@/features/recover/useOwnerSign'

/**
 * Keeping NearKit wallets yours, without Telegram. Everything here is authorized by the
 * wallet each NearKit wallet was created with (its owner) signing a one-time message
 * that NearKit's signer wrote. This page checks the message before the wallet signs it.
 * A key export is held by NEARKITS (24 hours by default) while the wallet's Telegram account
 * is told; it can release it sooner or cancel it. This browser keeps the export's own key
 * (not extractable) until then, and shows where each of its exports stands. The exported key
 * arrives sealed to that key; it lives in this component's memory while shown and is never
 * stored, logged or put in the address bar.
 */

function Notice({ tone, children }: { tone: 'warn' | 'neg'; children: React.ReactNode }) {
  const Icon = tone === 'neg' ? ShieldAlert : ShieldCheck
  return (
    <div className={`flex gap-2.5 rounded-sm border px-3 py-2.5 text-xs leading-5 text-fg-2 ${tone === 'neg' ? 'border-neg/40 bg-neg/8' : 'border-warn/40 bg-warn/8'}`}>
      <Icon size={15} className={`mt-0.5 shrink-0 ${tone === 'neg' ? 'text-neg' : 'text-warn'}`} aria-hidden="true" />
      <p>{children}</p>
    </div>
  )
}

function Failure({ error }: { error: unknown }) {
  return (
    <p className="text-sm text-neg" role="alert">
      {describeError(error).message}
    </p>
  )
}

function ListPanel({ apiUrl, onExport }: { apiUrl: string; onExport: (wallet: string) => void }) {
  const caps = useCapabilities()
  const { data: session } = useSession()
  const { promptConnect } = useConnectPrompt()
  const sign = useOwnerSign()
  // The owner to list: the connected account, unless named here. Whoever is named, the wallet must
  // sign with a full-access key of that account (checked before it signs, and by NearKit's signer).
  const [ownerInput, setOwnerInput] = useState('')
  const named = ownerInput.trim()
  const owner = named || session?.accountId || ''
  const ownerError = named ? accountIdError(named) : null
  const list = useMutation({
    mutationFn: async (owner: string) => {
      const c = await requestChallenge(apiUrl, { kind: 'owner-session', owner })
      const signed = await sign(c, { owner })
      return listOwnerWallets(apiUrl, { challengeId: c.id, publicKey: signed.publicKey, signature: signed.signature })
    },
  })
  return (
    <Panel>
      <PanelHeader title="Your NEARKITS wallets" actions={<Tag tone="neutral">{caps.networkLabel}</Tag>} />
      <PanelBody className="flex flex-col gap-4">
        <p className="text-sm text-fg-2">
          Connect the wallet you linked when you created your NEARKITS wallets (their owner) and sign a message: NEARKITS shows which NEARKITS wallets answer to it. Signing is free
          and moves nothing. Telegram is not needed.
        </p>
        {!session ? (
          <Button variant="primary" size="lg" block onClick={promptConnect}>
            Connect your wallet
          </Button>
        ) : (
          <>
            <Field
              label="Owner account"
              error={ownerError ?? undefined}
              hint="Usually the account connected here. If your wallet app shows another account but holds the owner’s own key, name the owner."
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  mono
                  value={ownerInput}
                  placeholder={session.accountId}
                  onChange={(e) => {
                    setOwnerInput(e.target.value)
                    list.reset()
                  }}
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="none"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                />
              )}
            </Field>
            <Button variant="primary" size="lg" block loading={list.isPending} disabled={list.isPending || ownerError !== null || !owner} onClick={() => list.mutate(owner)}>
              <span className="break-all">Sign to show the NEARKITS wallets of {owner}</span>
            </Button>
          </>
        )}
        {list.isError && <Failure error={list.error} />}
        {list.isSuccess &&
          (list.data.wallets.length === 0 ? (
            <p className="break-words text-sm text-fg-2">
              {`No NEARKITS wallet answers to ${list.data.ownerAccount} on this network. A NEARKITS wallet answers to the wallet it was created with (its owner): if ${list.data.ownerAccount} is itself a NEARKITS wallet (its exported key imported into a wallet app, say), connect its owner instead.`}
            </p>
          ) : (
            <ul className="divide-y divide-line-soft rounded-sm border border-line-soft">
              {list.data.wallets.map((w) => (
                <li key={w.accountId} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-fg">{w.name}</p>
                    <p className="num truncate text-xs text-fg-3">{w.accountId}</p>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => onExport(w.accountId)}>
                    <KeyRound size={13} aria-hidden="true" /> Export key
                  </Button>
                </li>
              ))}
            </ul>
          ))}
      </PanelBody>
    </Panel>
  )
}

/** The exported key on screen: hidden until asked, copied on request, gone from memory when done. */
function RevealKey({ wallet, secret, onDone }: { wallet: string; secret: string; onDone: () => void }) {
  const caps = useCapabilities()
  const [revealed, setRevealed] = useState(false)
  return (
    <Panel>
      <PanelHeader title="Export NEARKITS wallet key" actions={<Tag tone="neutral">{caps.networkLabel}</Tag>} />
      <PanelBody className="flex flex-col gap-4">
        <Notice tone="neg">
          Anyone who has this key controls <span className="num text-fg">{wallet}</span> and everything in it. Don’t share it, screenshot it or paste it into a chat. NEARKITS never
          asks for it.
        </Notice>
        <div>
          <p className="mb-1.5 text-2xs uppercase tracking-legend text-fg-3">Private key</p>
          <div className="flex items-start gap-2 rounded-sm border border-line-soft bg-well px-3 py-2">
            <code className="num min-w-0 flex-1 break-all text-xs leading-5 text-fg" aria-label={revealed ? 'Private key' : 'Private key, hidden'}>
              {revealed ? secret : `ed25519:${'•'.repeat(32)}`}
            </code>
            <button
              type="button"
              onClick={() => setRevealed((r) => !r)}
              aria-label={revealed ? 'Hide the key' : 'Show the key'}
              className="inline-grid size-6 shrink-0 place-items-center rounded-xs text-fg-4 transition-colors hover:bg-raised hover:text-fg-2"
            >
              {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
            <CopyButton value={secret} label="Copy the key" />
          </div>
        </div>
        <p className="text-xs leading-5 text-fg-3">
          Import it in a NEAR wallet app (for example Meteor or MyNearWallet: import an account with a private key). Then close this page: the key is not stored anywhere here.
        </p>
        <Button
          variant="secondary"
          size="lg"
          block
          onClick={() => {
            setRevealed(false)
            onDone()
          }}
        >
          Done: hide the key
        </Button>
      </PanelBody>
    </Panel>
  )
}

/**
 * Asking for an export: a plain warning first, then the owner wallet signs NEARKITS' request
 * (checked here before it signs, including the hold it states). NEARKITS holds the export and
 * tells the wallet's Telegram account; this browser keeps the export's own key meanwhile.
 */
function RequestExport({ apiUrl, wallet, onRequested, onBack }: { apiUrl: string; wallet: string; onRequested: () => void; onBack: () => void }) {
  const caps = useCapabilities()
  const sign = useOwnerSign()
  // This browser's key for this export: its private half can't leave the browser (not extractable).
  const browser = useRef<Awaited<ReturnType<typeof createExportKeyPair>> | null>(null)
  const [understood, setUnderstood] = useState(false)
  const prepare = useMutation({
    mutationFn: async () => {
      browser.current = await createExportKeyPair()
      return requestChallenge(apiUrl, { kind: 'export', accountId: wallet, recipientKey: browser.current.publicKey })
    },
  })
  const request = useMutation({
    mutationFn: async (c: OwnerChallenge) => {
      const key = browser.current
      if (!key) throw new Error('Start again.')
      const signed = await sign(c, { wallet, recipientKey: key.publicKey })
      const held = await requestExport(apiUrl, { challengeId: c.id, publicKey: signed.publicKey, signature: signed.signature })
      await exportStore.save({
        exportId: held.exportId,
        network: caps.network ?? '',
        accountId: wallet,
        ownerAccount: held.ownerAccount,
        browserKey: held.browserKey,
        releaseAt: held.releaseAt,
        expiresAt: held.expiresAt,
        createdAt: Date.now(),
        privateKey: key.privateKey,
      })
      return held
    },
    onSuccess: onRequested,
  })
  const c = prepare.data
  return (
    <Panel>
      <PanelHeader title="Export NEARKITS wallet key" actions={<Tag tone="neutral">{caps.networkLabel}</Tag>} />
      <PanelBody className="flex flex-col gap-4">
        <Lines>
          <Line label="NEARKITS wallet">
            <span className="num break-all">{wallet}</span>
          </Line>
          {c && (
            <Line label="Sign with">
              <span className="num break-all">{c.ownerAccount}</span>
            </Line>
          )}
          <Line label="Network">{caps.networkLabel}</Line>
        </Lines>
        <Notice tone="neg">
          This releases the wallet’s private key. Anyone who has it controls this NEARKITS wallet and everything in it, for good: NEARKITS can’t take it back. Only continue on a
          device you trust, for a key you want to hold yourself.
        </Notice>
        <Notice tone="warn">
          Every export is held. NEARKITS keeps it for 24 hours and tells this wallet’s Telegram account at once: one tap there releases it sooner, another cancels it. Then the key
          is sealed to this browser and shown here once; nothing in between can read it.
        </Notice>
        {!c ? (
          <>
            <Checkbox checked={understood} onChange={(e) => setUnderstood(e.target.checked)} label="I understand: anyone with this key controls the wallet." />
            <Button variant="primary" size="lg" block loading={prepare.isPending} disabled={prepare.isPending || !understood} onClick={() => prepare.mutate()}>
              Prepare the export
            </Button>
          </>
        ) : (
          <>
            <OwnerMessage text={c.message} />
            <OwnerSignButton owner={c.ownerAccount} wallet={wallet} label="Sign to request the export" pending={request.isPending} onSign={() => request.mutate(c)} />
          </>
        )}
        {prepare.isError && <Failure error={prepare.error} />}
        {request.isError && <Failure error={request.error} />}
        <Button variant="ghost" size="sm" onClick={onBack}>
          All my NEARKITS wallets
        </Button>
      </PanelBody>
    </Panel>
  )
}

/** An export this browser asked for: held, ready to show, or over. The page asks NEARKITS where it stands every few seconds. */
function HeldExportPanel({ apiUrl, record, onForget, onBack }: { apiUrl: string; record: StoredExport; onForget: () => void; onBack: () => void }) {
  const caps = useCapabilities()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  const status = useQuery({
    queryKey: ['nearkits-export', record.exportId],
    queryFn: () => exportStatus(apiUrl, record.exportId),
    refetchInterval: (q) => (q.state.data && q.state.data.status !== 'held' && q.state.data.status !== 'ready' ? false : 5_000),
  })
  const [secret, setSecret] = useState<string | null>(null)
  const collect = useMutation({
    mutationFn: async () => {
      const out = await collectExport(apiUrl, record.exportId)
      const key = await openExport(record.privateKey, out.sealed, { challengeId: record.exportId, network: record.network, accountId: record.accountId })
      // Collected: this browser no longer needs its key for this export.
      await exportStore.remove(record.exportId)
      return key
    },
    onSuccess: setSecret,
    gcTime: 0,
  })
  const cancel = useMutation({ mutationFn: () => cancelExport(apiUrl, record.exportId), onSuccess: () => void status.refetch() })
  const forget = async () => {
    await exportStore.remove(record.exportId)
    onForget()
  }
  if (secret)
    return (
      <RevealKey
        wallet={record.accountId}
        secret={secret}
        onDone={() => {
          setSecret(null)
          collect.reset()
          onForget()
        }}
      />
    )
  const view = status.data
  const line = view ? heldExportLine(view, now) : null
  const open = view?.status === 'held' || view?.status === 'ready'
  return (
    <Panel>
      <PanelHeader title="Export NEARKITS wallet key" actions={<Tag tone={line?.tone ?? 'neutral'}>{line?.label ?? caps.networkLabel}</Tag>} />
      <PanelBody className="flex flex-col gap-4">
        <Lines>
          <Line label="NEARKITS wallet">
            <span className="num break-all">{record.accountId}</span>
          </Line>
          <Line label="Owner wallet">
            <span className="num break-all">{record.ownerAccount}</span>
          </Line>
          <Line label="This browser’s key">
            <span className="num">{record.browserKey}</span>
          </Line>
          <Line label="Network">{caps.networkLabel}</Line>
        </Lines>
        {line ? (
          <p className="text-sm leading-6 text-fg-2" role="status">
            {line.text}
          </p>
        ) : status.isPending ? (
          <p className="text-sm text-fg-3">Checking the export…</p>
        ) : null}
        {open && !exportStore.persistent && (
          <Notice tone="warn">This browser can’t keep the export’s key once this page closes (a private window, perhaps): keep this page open until the key is shown.</Notice>
        )}
        {status.isError && <Failure error={status.error} />}
        {view?.status === 'ready' && (
          <Button variant="primary" size="lg" block loading={collect.isPending} disabled={collect.isPending} onClick={() => collect.mutate()}>
            Collect the key
          </Button>
        )}
        {collect.isError && <Failure error={collect.error} />}
        {open && (
          <Button variant="ghost" size="sm" loading={cancel.isPending} disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            Cancel this export
          </Button>
        )}
        {cancel.isError && <Failure error={cancel.error} />}
        {(!open && view) || status.isError ? (
          <Button variant="secondary" size="lg" block onClick={() => void forget()}>
            Forget it and start again
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={onBack}>
          All my NEARKITS wallets
        </Button>
      </PanelBody>
    </Panel>
  )
}

/** A wallet's export: the one this browser already asked for (it outlives the page), or a new request. */
function ExportPanel({ apiUrl, wallet, onBack }: { apiUrl: string; wallet: string; onBack: () => void }) {
  const caps = useCapabilities()
  const network = caps.network ?? ''
  const stored = useQuery({ queryKey: ['nearkits-stored-export', network, wallet], queryFn: () => exportStore.ofWallet(network, wallet), gcTime: 0 })
  if (stored.isPending) return null
  if (stored.data) return <HeldExportPanel apiUrl={apiUrl} record={stored.data} onForget={() => void stored.refetch()} onBack={onBack} />
  return <RequestExport apiUrl={apiUrl} wallet={wallet} onRequested={() => void stored.refetch()} onBack={onBack} />
}

/** Exports this browser asked for and still holds the key of, with where each stands: shown on the Recover page itself. */
function WaitingExports({ apiUrl, onOpen }: { apiUrl: string; onOpen: (wallet: string) => void }) {
  const caps = useCapabilities()
  const network = caps.network ?? ''
  const stored = useQuery({ queryKey: ['nearkits-stored-exports', network], queryFn: () => exportStore.list(network), gcTime: 0 })
  const rows = stored.data ?? []
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  const statuses = useQueries({
    queries: rows.map((r) => ({ queryKey: ['nearkits-export', r.exportId], queryFn: () => exportStatus(apiUrl, r.exportId), refetchInterval: 30_000 })),
  })
  if (rows.length === 0) return null
  return (
    <Panel>
      <PanelHeader title="Key exports from this browser" />
      <ul className="divide-y divide-line-soft">
        {rows.map((r, i) => {
          const view = statuses[i]?.data
          const line = view ? heldExportLine(view, now) : null
          return (
            <li key={r.exportId} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="num truncate text-sm text-fg">{r.accountId}</p>
                <p className="text-xs leading-5 text-fg-3">{line?.text ?? 'Checking…'}</p>
              </div>
              {line && <Tag tone={line.tone}>{line.label}</Tag>}
              <Button variant="secondary" size="sm" onClick={() => onOpen(r.accountId)}>
                Open
              </Button>
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}

function ApprovePanel({ apiUrl, wallet, destination }: { apiUrl: string; wallet: string; destination: string }) {
  const caps = useCapabilities()
  const sign = useOwnerSign()
  const prepare = useMutation({ mutationFn: () => requestChallenge(apiUrl, { kind: 'approve-destination', accountId: wallet, destination }) })
  const approved = useMutation({
    mutationFn: async (c: OwnerChallenge) => {
      const signed = await sign(c, { wallet, destination })
      return approveDestination(apiUrl, { challengeId: c.id, publicKey: signed.publicKey, signature: signed.signature })
    },
  })
  const c = prepare.data
  return (
    <Panel>
      <PanelHeader title="Approve a withdrawal destination" actions={<Tag tone="neutral">{caps.networkLabel}</Tag>} />
      <PanelBody className="flex flex-col gap-4">
        <Lines>
          <Line label="From NEARKITS wallet">
            <span className="num break-all">{wallet}</span>
          </Line>
          <Line label="Destination">
            <span className="num break-all text-fg">{destination}</span>
          </Line>
          {c && (
            <Line label="Sign with">
              <span className="num break-all">{c.ownerAccount}</span>
            </Line>
          )}
        </Lines>
        {approved.isSuccess ? (
          <p className="text-sm text-fg" role="status">
            Approved. Go back to where you started the send and review it again: Review on NEARKITS web, or Continue in Telegram.
          </p>
        ) : (
          <>
            <Notice tone="warn">
              Only approve a destination you asked for yourself. Withdrawals from this NEARKITS wallet go only to its owner wallet and to destinations it approved: someone who got
              into your Telegram can’t send your funds anywhere else.
            </Notice>
            {!c ? (
              <Button variant="primary" size="lg" block loading={prepare.isPending} disabled={prepare.isPending} onClick={() => prepare.mutate()}>
                Prepare the approval
              </Button>
            ) : (
              <>
                <OwnerMessage text={c.message} />
                <OwnerSignButton owner={c.ownerAccount} wallet={wallet} label={`Sign to approve ${destination}`} pending={approved.isPending} onSign={() => approved.mutate(c)} />
              </>
            )}
          </>
        )}
        {prepare.isError && <Failure error={prepare.error} />}
        {approved.isError && <Failure error={approved.error} />}
      </PanelBody>
    </Panel>
  )
}

function HowPanel() {
  return (
    <Panel>
      <PanelHeader title="How recovery works" />
      <ol className="divide-y divide-line-soft">
        {[
          ['Your wallet is the owner.', 'Each NEARKITS wallet answers to the wallet you linked when you created it. Export, destinations and the backup key need its signature.'],
          ['No Telegram needed to ask.', 'This page works on its own: connect the owner wallet and sign.'],
          [
            'Every export waits 24 hours.',
            'NEARKITS holds every key export for 24 hours and tells the wallet’s Telegram account at once: one tap there releases it sooner, another cancels it. A site that tricked your wallet into signing gets nothing in that time.',
          ],
          ['The key stays between NEARKITS’ signer and you.', 'An exported key is sealed to this browser, shown once and never stored. NEARKITS never asks for your seed phrase.'],
        ].map(([title, text], i) => (
          <li key={title} className="flex items-start gap-4 px-4 py-3">
            <span className="num mt-0.5 text-xs text-fg-4">{String(i + 1).padStart(2, '0')}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-fg">{title}</p>
              <p className="text-xs text-fg-3">{text}</p>
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  )
}

export default function RecoverPage() {
  const [target, setTarget] = useState<RecoverTarget>(() => readRecoverHash(window.location.hash))
  const go = (t: RecoverTarget) => {
    setTarget(t)
    window.history.replaceState(window.history.state, '', t.kind === 'export' ? `${window.location.pathname}#wallet=${t.wallet}` : window.location.pathname)
  }
  const apiUrl = ENV.apiUrl
  return (
    <Page>
      <PageHeader
        title="Recover"
        description="Your NEARKITS wallets answer to your own wallet. Export a key (held 24 hours and announced in Telegram) or approve a withdrawal destination here with its signature."
      />
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[480px_minmax(0,1fr)]">
        {ENV.services !== 'near' || !apiUrl ? (
          <Panel>
            <PanelHeader title="Recover" />
            <PanelBody>
              <p className="text-sm text-fg-2">This NEARKITS build isn’t connected to a NEARKITS server, so there are no NEARKITS wallets to recover here.</p>
            </PanelBody>
          </Panel>
        ) : target.kind === 'export' ? (
          <ExportPanel key={target.wallet} apiUrl={apiUrl} wallet={target.wallet} onBack={() => go({ kind: 'list' })} />
        ) : target.kind === 'approve' ? (
          <ApprovePanel apiUrl={apiUrl} wallet={target.wallet} destination={target.destination} />
        ) : (
          <div className="flex flex-col gap-4">
            <WaitingExports apiUrl={apiUrl} onOpen={(wallet) => go({ kind: 'export', wallet })} />
            <ListPanel apiUrl={apiUrl} onExport={(wallet) => go({ kind: 'export', wallet })} />
          </div>
        )}
        <HowPanel />
      </div>
    </Page>
  )
}
