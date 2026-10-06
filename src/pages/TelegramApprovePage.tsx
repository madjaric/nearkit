import { ShieldAlert, ShieldCheck } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { LogoMark, Wordmark } from '@/components/brand/Brand'
import { Button } from '@/components/ui/Button'
import { buttonClass } from '@/components/ui/buttonClass'
import { ENV } from '@/config/env'
import { describeError } from '@/services/errors'
import {
  fetchTelegramRequest,
  sendTelegramApproval,
  telegramLaunchContext,
  telegramRequestProblem,
  type ExportFacts,
  type TelegramLaunchContext,
  type TelegramRequestView,
} from '@/services/telegramApproval'

/**
 * NearKit's Telegram Mini App. Opened from the Approve button in the chat, it approves a
 * withdrawal address (or the first owner wallet) of a NearKit wallet with no owner wallet, or
 * (Release it now) releases a held key export sooner; cancelling stays in the chat's button:
 * it shows the request only if it is exactly what the link names (its digest is the start
 * parameter Telegram signed), and on Approve sends Telegram's signed launch data, which
 * NearKit's signer checks itself. Opened directly from the bot (its Open button), it is a
 * plain landing: nothing to approve, nothing wrong. Outside Telegram it says where to open it.
 */

/** Captured at load: Telegram puts its launch data in the address the page was opened with. */
const context: TelegramLaunchContext = typeof window === 'undefined' ? { kind: 'outside' } : telegramLaunchContext(window.location.hash, window.location.search)

interface TelegramWebApp {
  ready(): void
  expand(): void
  close(): void
}
const webApp = (): TelegramWebApp | null => (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp ?? null

/** Telegram's own script: fits the page to the chat, and lets it close itself. Optional: the page works without it. */
function useTelegramScript() {
  useEffect(() => {
    if (context.kind === 'outside' || document.querySelector('script[data-telegram-web-app]')) return
    const s = document.createElement('script')
    s.src = 'https://telegram.org/js/telegram-web-app.js'
    s.async = true
    s.dataset.telegramWebApp = ''
    s.onload = () => {
      webApp()?.ready()
      webApp()?.expand()
    }
    document.head.appendChild(s)
  }, [])
}

type Status = 'open' | 'used' | 'expired' | 'cancelled' | null
type Shown = { request: TelegramRequestView; walletName: string | null; facts: ExportFacts | null }
type View =
  | { step: 'loading' }
  | { step: 'home' }
  | { step: 'outside' }
  | { step: 'refused'; message: string }
  | ({ step: 'review'; status: Status; error?: string } & Shown)
  | ({ step: 'sending' } & Shown)
  | { step: 'done'; request: TelegramRequestView }

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh justify-center bg-canvas px-4 py-6 text-fg">
      <div className="flex w-full max-w-md flex-col gap-5">
        <span className="flex items-center gap-1.5">
          <LogoMark size={20} />
          <Wordmark height={13} />
        </span>
        {children}
      </div>
    </main>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-2xs uppercase tracking-legend text-fg-3">{label}</p>
      <div className="num break-all rounded-sm border border-line-soft bg-well px-3 py-2 text-sm text-fg">{children}</div>
    </div>
  )
}

function Notice({ tone, children }: { tone: 'ok' | 'neg'; children: ReactNode }) {
  const Icon = tone === 'neg' ? ShieldAlert : ShieldCheck
  return (
    <div
      className={`flex gap-2.5 rounded-sm border px-3 py-2.5 text-sm leading-5 ${tone === 'neg' ? 'border-neg/40 bg-neg/8' : 'border-pos/40 bg-pos/8'}`}
      role={tone === 'neg' ? 'alert' : 'status'}
    >
      <Icon size={16} className={`mt-0.5 shrink-0 ${tone === 'neg' ? 'text-neg' : 'text-pos'}`} aria-hidden="true" />
      <p>{children}</p>
    </div>
  )
}

const title = (r: TelegramRequestView) => (r.kind === 'destination' ? 'Approve a withdrawal address' : r.kind === 'export' ? 'Release a key export' : 'Make an owner wallet')
/** A time as the reader's clock shows it, with the date: an export is held for a day. */
const when = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const botLink = ENV.telegramBot ? `https://t.me/${ENV.telegramBot}` : null

/** Back to the chat: Telegram closes the Mini App; without its script, the bot's link. */
function backToBot() {
  const app = webApp()
  if (app) app.close()
  else if (botLink) window.location.assign(botLink)
}

function Landing({ children }: { children: ReactNode }) {
  return (
    <Shell>
      <h1 className="text-lg font-semibold">Telegram Mini App</h1>
      <p className="text-sm leading-6 text-fg-2">{children}</p>
    </Shell>
  )
}

export default function TelegramApprovePage() {
  useTelegramScript()
  useEffect(() => {
    document.title = context.kind === 'approval' ? 'Approve · NEARKITS' : 'NEARKITS · Telegram'
  }, [])
  const [view, setView] = useState<View>({ step: 'loading' })
  const apiUrl = ENV.apiUrl

  useEffect(() => {
    let live = true
    const run = async (): Promise<View> => {
      if (context.kind === 'outside') return { step: 'outside' }
      if (context.kind === 'direct') return { step: 'home' }
      // An approval: exactly the request the link names, or nothing.
      const { launch } = context
      if (!apiUrl) return { step: 'refused', message: 'This NEARKITS build has no server to send approvals to.' }
      const r = await fetchTelegramRequest(apiUrl, launch.startParam)
      if (!r.request) return { step: 'refused', message: 'This request is unknown. Start again in Telegram.' }
      const problem = await telegramRequestProblem(r.request, { digest: launch.startParam, network: ENV.network })
      if (problem) return { step: 'refused', message: problem }
      return { step: 'review', request: r.request, walletName: r.walletName, facts: r.export ?? null, status: r.status }
    }
    run()
      .then((v) => live && setView(v))
      .catch((e: unknown) => live && setView({ step: 'refused', message: describeError(e).message }))
    return () => {
      live = false
    }
  }, [apiUrl])

  const approve = async (shown: Shown) => {
    if (context.kind !== 'approval' || !apiUrl) return
    setView({ step: 'sending', ...shown })
    try {
      await sendTelegramApproval(apiUrl, context.launch.initData)
      setView({ step: 'done', request: shown.request })
      // A released export stays on screen: its "cancel it now" matters more than closing.
      if (shown.request.kind !== 'export') setTimeout(() => webApp()?.close(), 2500)
    } catch (e) {
      setView({ step: 'review', ...shown, status: 'open', error: describeError(e).message })
    }
  }

  if (view.step === 'loading')
    return (
      <Shell>
        <p className="text-sm text-fg-2">Reading the request…</p>
      </Shell>
    )
  if (view.step === 'home')
    return (
      <Landing>
        This app is used for secure NEARKITS wallet actions and approvals. When NEARKITS’ bot asks you to approve something, the Approve button in the chat opens it here.
        <span className="mt-5 block">
          <Button variant="secondary" size="lg" block onClick={backToBot}>
            Back to NEARKITS bot
          </Button>
        </span>
      </Landing>
    )
  if (view.step === 'outside')
    return (
      <Landing>
        This page is NEARKITS’ Telegram Mini App, where secure NEARKITS wallet actions and approvals are confirmed. Open it from NEARKITS’ bot in Telegram.
        {botLink && (
          <span className="mt-5 block">
            <a href={botLink} className={buttonClass({ variant: 'primary', size: 'lg', block: true })}>
              Open NEARKITS in Telegram
            </a>
          </span>
        )}
      </Landing>
    )
  if (view.step === 'refused')
    return (
      <Shell>
        <Notice tone="neg">{view.message}</Notice>
      </Shell>
    )
  if (view.step === 'done')
    return (
      <Shell>
        <h1 className="text-lg font-semibold">{title(view.request)}</h1>
        <Notice tone="ok">
          {view.request.kind === 'destination'
            ? `Approved. ${view.request.target} can now receive withdrawals from this NEARKITS wallet. Go back to the chat and tap Continue.`
            : view.request.kind === 'export'
              ? `Released. The browser with the key ${view.request.target} can collect this wallet’s private key now. If that wasn’t you, tap ❌ Cancel export in the chat at once.`
              : `Approved. ${view.request.target} is now this NEARKITS wallet’s owner wallet.`}
        </Notice>
        <Button variant="secondary" size="lg" block onClick={() => webApp()?.close()}>
          Back to NEARKITS
        </Button>
      </Shell>
    )

  const { request, walletName, facts } = view
  const shown: Shown = { request, walletName, facts }
  // As the signer saw it when the page loaded; an approval sent after that is refused by the signer anyway.
  const status = view.step === 'review' ? view.status : 'open'
  const isExport = request.kind === 'export'
  return (
    <Shell>
      <h1 className="text-lg font-semibold">{title(request)}</h1>
      <p className="text-sm leading-6 text-fg-2">
        {request.kind === 'destination'
          ? 'This NEARKITS wallet has no owner wallet, so your Telegram account approves where it may send funds. Approve only an address you typed yourself.'
          : isExport
            ? `Your owner wallet${facts ? ` ${facts.ownerAccount}` : ''} signed a request in NEARKITS web to export this wallet’s private key to the browser below. NEARKITS holds it${facts ? ` until ${when(facts.releaseAt)}` : ''}. Release it now only if you asked for it yourself and the browser key matches the one on your NEARKITS page. If it wasn’t you, close this and tap ❌ Cancel export in the chat.`
            : 'This NEARKITS wallet has no owner wallet yet. The wallet below becomes its owner for good: withdrawals then go only to it, or to addresses it approves.'}
      </p>
      <Field label={`NEARKITS wallet${walletName ? ` · ${walletName}` : ''}`}>{request.accountId}</Field>
      {isExport && facts && <Field label="Owner wallet">{facts.ownerAccount}</Field>}
      <Field label={request.kind === 'destination' ? 'Withdrawal address' : isExport ? 'Browser key' : 'Owner wallet'}>{request.target}</Field>
      {isExport && facts && <Field label="Released on its own">{when(facts.releaseAt)}</Field>}
      <Field label="Network">NEAR {request.network}</Field>
      {view.step === 'review' && view.error && <Notice tone="neg">{view.error}</Notice>}
      {status === 'used' ? (
        <Notice tone="ok">{isExport ? 'Already released. Go back to the chat.' : 'Already approved. Go back to the chat.'}</Notice>
      ) : status === 'cancelled' ? (
        <Notice tone="ok">This export was cancelled. Nothing will be released.</Notice>
      ) : status === 'expired' ? (
        <Notice tone="neg">{isExport ? 'This export expired. Nothing will be released.' : 'This request expired. Start again in Telegram.'}</Notice>
      ) : (
        <div className="flex flex-col gap-2">
          <Button variant="primary" size="lg" block loading={view.step === 'sending'} disabled={view.step === 'sending'} onClick={() => void approve(shown)}>
            {isExport ? 'Release the key now' : 'Approve'}
          </Button>
          <Button variant="ghost" size="lg" block onClick={() => webApp()?.close()}>
            {isExport ? 'Not me: close' : 'Cancel'}
          </Button>
        </div>
      )}
      <p className="text-xs leading-5 text-fg-3">
        {isExport
          ? 'Telegram signs your release for your account only. NEARKITS’ servers can’t release an export sooner without it, and the key never comes to Telegram.'
          : 'Telegram signs your approval for your account only. NEARKITS’ servers can’t approve anything without it.'}
      </p>
    </Shell>
  )
}
