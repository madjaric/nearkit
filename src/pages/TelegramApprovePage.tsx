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
  type TelegramLaunchContext,
  type TelegramRequestView,
} from '@/services/telegramApproval'

/**
 * NearKit's Telegram Mini App. Opened from the Approve button in the chat, it approves a
 * withdrawal address (or the first owner wallet) of a NearKit wallet with no owner wallet:
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

type View =
  | { step: 'loading' }
  | { step: 'home' }
  | { step: 'outside' }
  | { step: 'refused'; message: string }
  | { step: 'review'; request: TelegramRequestView; walletName: string | null; status: 'open' | 'used' | 'expired' | null; error?: string }
  | { step: 'sending'; request: TelegramRequestView; walletName: string | null }
  | { step: 'done'; request: TelegramRequestView }

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh justify-center bg-canvas px-4 py-6 text-fg">
      <div className="flex w-full max-w-md flex-col gap-5">
        <span className="flex items-center gap-2.5">
          <LogoMark size={20} />
          <Wordmark />
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

const title = (r: TelegramRequestView) => (r.kind === 'destination' ? 'Approve a withdrawal address' : 'Make an owner wallet')
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
    document.title = context.kind === 'approval' ? 'Approve · NearKit' : 'NearKit · Telegram'
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
      if (!apiUrl) return { step: 'refused', message: 'This NearKit build has no server to send approvals to.' }
      const r = await fetchTelegramRequest(apiUrl, launch.startParam)
      if (!r.request) return { step: 'refused', message: 'This request is unknown. Start again in Telegram.' }
      const problem = await telegramRequestProblem(r.request, { digest: launch.startParam, network: ENV.network })
      if (problem) return { step: 'refused', message: problem }
      return { step: 'review', request: r.request, walletName: r.walletName, status: r.status }
    }
    run()
      .then((v) => live && setView(v))
      .catch((e: unknown) => live && setView({ step: 'refused', message: describeError(e).message }))
    return () => {
      live = false
    }
  }, [apiUrl])

  const approve = async (request: TelegramRequestView, walletName: string | null) => {
    if (context.kind !== 'approval' || !apiUrl) return
    setView({ step: 'sending', request, walletName })
    try {
      await sendTelegramApproval(apiUrl, context.launch.initData)
      setView({ step: 'done', request })
      setTimeout(() => webApp()?.close(), 2500)
    } catch (e) {
      setView({ step: 'review', request, walletName, status: 'open', error: describeError(e).message })
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
        This app is used for secure NearKit wallet actions and approvals. When NearKit’s bot asks you to approve something, the Approve button in the chat opens it here.
        <span className="mt-5 block">
          <Button variant="secondary" size="lg" block onClick={backToBot}>
            Back to NearKit bot
          </Button>
        </span>
      </Landing>
    )
  if (view.step === 'outside')
    return (
      <Landing>
        This page is NearKit’s Telegram Mini App, where secure NearKit wallet actions and approvals are confirmed. Open it from NearKit’s bot in Telegram.
        {botLink && (
          <span className="mt-5 block">
            <a href={botLink} className={buttonClass({ variant: 'primary', size: 'lg', block: true })}>
              Open NearKit in Telegram
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
            ? `Approved. ${view.request.target} can now receive withdrawals from this NearKit wallet. Go back to the chat and tap Continue.`
            : `Approved. ${view.request.target} is now this NearKit wallet’s owner wallet.`}
        </Notice>
        <Button variant="secondary" size="lg" block onClick={() => webApp()?.close()}>
          Back to NearKit
        </Button>
      </Shell>
    )

  const { request, walletName } = view
  // As the signer saw it when the page loaded; an approval sent after that is refused by the signer anyway.
  const status = view.step === 'review' ? view.status : 'open'
  const expired = status === 'expired'
  return (
    <Shell>
      <h1 className="text-lg font-semibold">{title(request)}</h1>
      <p className="text-sm leading-6 text-fg-2">
        {request.kind === 'destination'
          ? 'This NearKit wallet has no owner wallet, so your Telegram account approves where it may send funds. Approve only an address you typed yourself.'
          : 'This NearKit wallet has no owner wallet yet. The wallet below becomes its owner for good: withdrawals then go only to it, or to addresses it approves.'}
      </p>
      <Field label={`NearKit wallet${walletName ? ` · ${walletName}` : ''}`}>{request.accountId}</Field>
      <Field label={request.kind === 'destination' ? 'Withdrawal address' : 'Owner wallet'}>{request.target}</Field>
      <Field label="Network">NEAR {request.network}</Field>
      {view.step === 'review' && view.error && <Notice tone="neg">{view.error}</Notice>}
      {status === 'used' ? (
        <Notice tone="ok">Already approved. Go back to the chat.</Notice>
      ) : expired ? (
        <Notice tone="neg">This request expired. Start again in Telegram.</Notice>
      ) : (
        <div className="flex flex-col gap-2">
          <Button variant="primary" size="lg" block loading={view.step === 'sending'} disabled={view.step === 'sending'} onClick={() => void approve(request, walletName)}>
            Approve
          </Button>
          <Button variant="ghost" size="lg" block onClick={() => webApp()?.close()}>
            Cancel
          </Button>
        </div>
      )}
      <p className="text-xs leading-5 text-fg-3">Telegram signs your approval for your account only. NearKit’s servers can’t approve anything without it.</p>
    </Shell>
  )
}
