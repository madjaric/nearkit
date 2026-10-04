import { useMutation } from '@tanstack/react-query'
import { Eye, EyeOff, KeyRound, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { WalletReturned } from '@/components/domain/WalletReturned'
import { Page, PageHeader } from '@/components/page/Page'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/Copy'
import { Tag } from '@/components/ui/Indicators'
import { Line, Lines, Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { ENV } from '@/config/env'
import { base64Decode } from '@/lib/encoding'
import { createExportKeyPair, openExport } from '@/lib/exportCrypto'
import { ownerControlProblem, ownerKeyNote } from '@/lib/ownerAccount'
import { useServices } from '@/services/context'
import { describeError } from '@/services/errors'
import { useCapabilities, useOwnerControl, useSession } from '@/services/queries'
import {
  approveDestination,
  challengeProblem,
  exportSealedKey,
  listOwnerWallets,
  readRecoverHash,
  requestChallenge,
  type OwnerChallenge,
  type RecoverTarget,
} from '@/services/recovery'
import { useConnectPrompt } from '@/state/contexts'

/**
 * Keeping NearKit wallets yours, without Telegram. Everything here is authorized by the
 * wallet each NearKit wallet was created with (its owner) signing a one-time message
 * that NearKit's signer wrote. This page checks the message before the wallet signs it.
 * An exported key arrives sealed to a key that exists only in this page; it lives in this
 * component's memory while shown and is never stored, logged or put in the address bar.
 */

type Signed = { accountId: string; publicKey: string; signature: string }

function useOwnerSign() {
  const services = useServices()
  const caps = useCapabilities()
  return async (c: OwnerChallenge, want: Omit<Parameters<typeof challengeProblem>[1], 'network' | 'recipient' | 'kind'>): Promise<Signed> => {
    if (!caps.network) throw new Error('This NearKit build is not on a NEAR network.')
    const problem = await challengeProblem(c, { ...want, kind: c.kind, network: caps.network, recipient: window.location.hostname })
    if (problem) throw new Error(problem)
    const nonce = base64Decode(c.nonce)
    if (!nonce || nonce.length !== 32) throw new Error('This request is malformed. Start again.')
    return services.wallets.signMessage({ message: c.message, recipient: c.recipient, nonce, accountId: c.ownerAccount })
  }
}

function Message({ text }: { text: string }) {
  return (
    <div>
      <p className="mb-1.5 text-2xs uppercase tracking-legend text-fg-3">Your wallet will sign</p>
      <pre className="num whitespace-pre-wrap break-words rounded-sm border border-line-soft bg-well px-3 py-2 text-xs leading-5 text-fg-2">{text}</pre>
    </div>
  )
}

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

/**
 * Connect the owner wallet, or sign with it once it can sign for the owner: the owner account
 * itself, or an account whose key is a full-access key of the owner on chain (said plainly; the key
 * that signs is checked again after). Connect signs the current wallet session out first, so the
 * wallet can show its account picker. `wallet`: the NearKit wallet this request is about.
 */
function SignButton({ owner, wallet, label, pending, onSign }: { owner: string; wallet?: string; label: string; pending: boolean; onSign: () => void }) {
  const { data: session } = useSession()
  const { connectOwner } = useConnectPrompt()
  const control = useOwnerControl(owner, session ?? null)
  const connect = (
    <Button variant="primary" size="lg" block onClick={() => connectOwner(owner, wallet)}>
      Connect {owner}
    </Button>
  )
  if (!session) return connect
  if (control.isPending)
    return (
      <Button variant="primary" size="lg" block loading disabled>
        Checking your wallet
      </Button>
    )
  const c = control.data
  if (!c?.ok)
    return (
      <>
        {c && c.reason !== 'none' && (
          <div>
            <p className="break-words text-sm text-fg-2">{ownerControlProblem(c, owner, wallet)}</p>
            <WalletReturned details={session.walletDetails} />
          </div>
        )}
        {c?.reason === 'unchecked' && (
          <Button variant="secondary" size="lg" block onClick={() => void control.refetch()}>
            Check again
          </Button>
        )}
        {connect}
      </>
    )
  return (
    <>
      {c.via === 'key' && <p className="break-words text-sm text-fg-2">{ownerKeyNote(c, owner)}</p>}
      <Button variant="primary" size="lg" block loading={pending} disabled={pending} onClick={onSign}>
        {label}
      </Button>
    </>
  )
}

function ListPanel({ apiUrl, onExport }: { apiUrl: string; onExport: (wallet: string) => void }) {
  const caps = useCapabilities()
  const { data: session } = useSession()
  const { promptConnect } = useConnectPrompt()
  const sign = useOwnerSign()
  const list = useMutation({
    mutationFn: async (owner: string) => {
      const c = await requestChallenge(apiUrl, { kind: 'owner-session', owner })
      const signed = await sign(c, { owner })
      return listOwnerWallets(apiUrl, { challengeId: c.id, publicKey: signed.publicKey, signature: signed.signature })
    },
  })
  return (
    <Panel>
      <PanelHeader title="Your NearKit wallets" actions={<Tag tone="neutral">{caps.networkLabel}</Tag>} />
      <PanelBody className="flex flex-col gap-4">
        <p className="text-sm text-fg-2">
          Connect the wallet you linked when you created your NearKit wallets (their owner) and sign a message: NearKit shows which NearKit wallets answer to it. Signing is free
          and moves nothing. Telegram is not needed.
        </p>
        {!session ? (
          <Button variant="primary" size="lg" block onClick={promptConnect}>
            Connect your wallet
          </Button>
        ) : (
          <Button variant="primary" size="lg" block loading={list.isPending} disabled={list.isPending} onClick={() => list.mutate(session.accountId)}>
            Sign to show the NearKit wallets of {session.accountId}
          </Button>
        )}
        {list.isError && <Failure error={list.error} />}
        {list.isSuccess &&
          (list.data.wallets.length === 0 ? (
            <p className="text-sm text-fg-2">No NearKit wallet answers to {list.data.ownerAccount} on this network.</p>
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

function ExportPanel({ apiUrl, wallet, onBack }: { apiUrl: string; wallet: string; onBack: () => void }) {
  const caps = useCapabilities()
  const sign = useOwnerSign()
  // This page's own key for this export: its private half can't leave the page (not extractable).
  const browser = useRef<Awaited<ReturnType<typeof createExportKeyPair>> | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [revealed, setRevealed] = useState(false)
  const prepare = useMutation({
    mutationFn: async () => {
      browser.current = await createExportKeyPair()
      return requestChallenge(apiUrl, { kind: 'export', accountId: wallet, recipientKey: browser.current.publicKey })
    },
  })
  const exported = useMutation({
    mutationFn: async (c: OwnerChallenge) => {
      const key = browser.current
      if (!key) throw new Error('Start again.')
      const signed = await sign(c, { wallet, recipientKey: key.publicKey })
      const out = await exportSealedKey(apiUrl, { challengeId: c.id, publicKey: signed.publicKey, signature: signed.signature })
      return openExport(key.privateKey, out.sealed, { challengeId: c.id, network: caps.network ?? '', accountId: wallet })
    },
    onSuccess: (key) => setSecret(key),
    gcTime: 0,
  })
  const reset = exported.reset
  // Leaving the page drops the key from memory.
  useEffect(
    () => () => {
      reset()
      browser.current = null
    },
    [reset],
  )
  const header = <PanelHeader title="Export NearKit wallet key" actions={<Tag tone="neutral">{caps.networkLabel}</Tag>} />

  if (secret) {
    return (
      <Panel>
        {header}
        <PanelBody className="flex flex-col gap-4">
          <Notice tone="neg">
            Anyone who has this key controls <span className="num text-fg">{wallet}</span> and everything in it. Don’t share it, screenshot it or paste it into a chat. NearKit
            never asks for it.
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
              setSecret(null)
              reset()
              prepare.reset()
              browser.current = null
              onBack()
            }}
          >
            Done: hide the key
          </Button>
        </PanelBody>
      </Panel>
    )
  }

  const c = prepare.data
  return (
    <Panel>
      {header}
      <PanelBody className="flex flex-col gap-4">
        <Lines>
          <Line label="NearKit wallet">
            <span className="num break-all">{wallet}</span>
          </Line>
          {c && (
            <Line label="Sign with">
              <span className="num break-all">{c.ownerAccount}</span>
            </Line>
          )}
          <Line label="Network">{caps.networkLabel}</Line>
        </Lines>
        <Notice tone="warn">
          Only continue on a device you trust. Your owner wallet signs a message, not a transaction: free, nothing moves. The key is sealed by NearKit’s signer to this page and
          shown here once; nothing in between can read it.
        </Notice>
        {!c ? (
          <Button variant="primary" size="lg" block loading={prepare.isPending} disabled={prepare.isPending} onClick={() => prepare.mutate()}>
            Prepare the export
          </Button>
        ) : (
          <>
            <Message text={c.message} />
            <SignButton owner={c.ownerAccount} wallet={wallet} label="Sign and show the key" pending={exported.isPending} onSign={() => exported.mutate(c)} />
          </>
        )}
        {prepare.isError && <Failure error={prepare.error} />}
        {exported.isError && <Failure error={exported.error} />}
        <Button variant="ghost" size="sm" onClick={onBack}>
          All my NearKit wallets
        </Button>
      </PanelBody>
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
          <Line label="From NearKit wallet">
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
            Approved. Go back to where you started the send and review it again: Review on NearKit web, or Continue in Telegram.
          </p>
        ) : (
          <>
            <Notice tone="warn">
              Only approve a destination you asked for yourself. Withdrawals from this NearKit wallet go only to its owner wallet and to destinations it approved: someone who got
              into your Telegram can’t send your funds anywhere else.
            </Notice>
            {!c ? (
              <Button variant="primary" size="lg" block loading={prepare.isPending} disabled={prepare.isPending} onClick={() => prepare.mutate()}>
                Prepare the approval
              </Button>
            ) : (
              <>
                <Message text={c.message} />
                <SignButton owner={c.ownerAccount} wallet={wallet} label={`Sign to approve ${destination}`} pending={approved.isPending} onSign={() => approved.mutate(c)} />
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
          ['Your wallet is the owner.', 'Each NearKit wallet answers to the wallet you linked when you created it. Export, destinations and the backup key need its signature.'],
          ['No Telegram needed.', 'This page works on its own: connect the owner wallet and sign. Telegram only hears afterwards that something happened.'],
          ['The key stays between NearKit’s signer and you.', 'An exported key is sealed to this page, shown once and never stored. NearKit never asks for your seed phrase.'],
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
        description="Your NearKit wallets answer to your own wallet. Export a key or approve a withdrawal destination here with its signature, with or without Telegram."
      />
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[480px_minmax(0,1fr)]">
        {ENV.services !== 'near' || !apiUrl ? (
          <Panel>
            <PanelHeader title="Recover" />
            <PanelBody>
              <p className="text-sm text-fg-2">This NearKit build isn’t connected to a NearKit server, so there are no NearKit wallets to recover here.</p>
            </PanelBody>
          </Panel>
        ) : target.kind === 'export' ? (
          <ExportPanel key={target.wallet} apiUrl={apiUrl} wallet={target.wallet} onBack={() => go({ kind: 'list' })} />
        ) : target.kind === 'approve' ? (
          <ApprovePanel apiUrl={apiUrl} wallet={target.wallet} destination={target.destination} />
        ) : (
          <ListPanel apiUrl={apiUrl} onExport={(wallet) => go({ kind: 'export', wallet })} />
        )}
        <HowPanel />
      </div>
    </Page>
  )
}
