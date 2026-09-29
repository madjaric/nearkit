import { useMutation, useQuery } from '@tanstack/react-query'
import { Eye, EyeOff, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router'
import { LogoMark } from '@/components/brand/Brand'
import { Page, PageHeader } from '@/components/page/Page'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/Copy'
import { ComingSoon, Skeleton, Tag } from '@/components/ui/Indicators'
import { Line, Lines, Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { Table, Td, Th, Tr } from '@/components/ui/Table'
import { BOT_COMMANDS } from '@/config/botCommands'
import { ENV } from '@/config/env'
import { TELEGRAM_BOT_LIVE } from '@/config/release'
import { base64Decode } from '@/lib/encoding'
import { formatDuration } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import { useServices } from '@/services/context'
import { describeError } from '@/services/errors'
import { useCapabilities, useSession } from '@/services/queries'
import { confirmLink, describeLink, describeRecovery, exportRecovery, readLinkCode, readRecoverCode, type LinkDescription, type RecoveryDescription } from '@/services/telegramLink'
import { useConnectPrompt } from '@/state/contexts'

const BOT_URL = ENV.telegramBot ? `https://t.me/${ENV.telegramBot}` : null
const BOT_NAME = ENV.telegramBot ? `@${ENV.telegramBot}` : 'the NearKit bot'

function BotButton({ label = `Open ${BOT_NAME}` }: { label?: string }) {
  if (!BOT_URL) return null
  return (
    <a href={BOT_URL} target="_blank" rel="noreferrer noopener" className="inline-flex">
      <Button variant="secondary" size="lg" tabIndex={-1}>
        {label}
      </Button>
    </a>
  )
}

/** The web half of `/link`: show who asked, have the wallet sign, send the signature. */
function LinkPanel({ code, apiUrl }: { code: string; apiUrl: string }) {
  const caps = useCapabilities()
  const services = useServices()
  const { data: session } = useSession()
  const { promptConnect } = useConnectPrompt()
  const now = useNow(1000)
  const described = useQuery({ queryKey: ['telegram-link', code], queryFn: () => describeLink(apiUrl, code), retry: false, staleTime: Infinity })

  const link = useMutation({
    mutationFn: async (d: LinkDescription) => {
      const nonce = base64Decode(d.nonce)
      if (!nonce || nonce.length !== 32) throw new Error('This link request is malformed. Ask the bot for a new link with /link.')
      const signed = await services.wallets.signMessage({ message: d.message, recipient: d.recipient, nonce })
      return confirmLink(apiUrl, { code, accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature })
    },
    // The code is used up: drop it from the address bar so a reload doesn't retry it.
    onSuccess: () => window.history.replaceState(null, '', window.location.pathname),
  })

  const header = <PanelHeader title="Link Telegram" actions={<Tag tone="neutral">{caps.networkLabel}</Tag>} />

  if (described.isPending) {
    return (
      <Panel>
        {header}
        <PanelBody className="flex flex-col gap-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </PanelBody>
      </Panel>
    )
  }
  if (described.isError) {
    return (
      <Panel>
        {header}
        <PanelBody className="flex flex-col gap-3">
          <p className="text-sm text-neg" role="alert">
            {describeError(described.error).message}
          </p>
          <BotButton />
        </PanelBody>
      </Panel>
    )
  }

  const d = described.data
  const who = d.telegram.username ? `@${d.telegram.username}` : d.telegram.name
  const left = d.expiresAt - now
  const wrongNetwork = d.network !== caps.network

  if (link.isSuccess) {
    return (
      <Panel>
        {header}
        <PanelBody className="flex flex-col gap-3">
          <p className="text-sm text-fg" role="status">
            Linked <span className="num text-accent">{link.data.accountId}</span> to Telegram <span className="text-fg">{who}</span>.
          </p>
          <p className="text-sm text-fg-3">The bot has sent you a confirmation. You can unlink it any time with /unlink.</p>
          <BotButton label="Back to Telegram" />
        </PanelBody>
      </Panel>
    )
  }

  return (
    <Panel>
      {header}
      <PanelBody className="flex flex-col gap-4">
        <Lines>
          <Line label="Telegram account">{who}</Line>
          <Line label="Network">{d.network}</Line>
          <Line label="Link expires in">{left > 0 ? formatDuration(left) : 'expired'}</Line>
          {session && <Line label="NEAR account">{session.accountId}</Line>}
        </Lines>

        <div className="flex gap-2.5 rounded-sm border border-warn/40 bg-warn/8 px-3 py-2.5 text-xs leading-5 text-fg-2">
          <ShieldCheck size={15} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
          <p>
            Only continue if <span className="text-fg">you</span> asked {BOT_NAME} for this link from {who}. Your wallet signs a message, not a transaction: it is free and moves no
            funds. NearKit never asks for a seed phrase or private key.
          </p>
        </div>

        <div>
          <p className="mb-1.5 text-2xs uppercase tracking-legend text-fg-3">Your wallet will sign</p>
          <pre className="num whitespace-pre-wrap break-words rounded-sm border border-line-soft bg-well px-3 py-2 text-xs leading-5 text-fg-2">{d.message}</pre>
        </div>

        {wrongNetwork ? (
          <p className="text-sm text-neg" role="alert">
            This link is for {d.network}, but this NearKit runs on {caps.networkLabel.toLowerCase()}. Open the link in the {d.network} NearKit.
          </p>
        ) : left <= 0 ? (
          <p className="text-sm text-neg" role="alert">
            This link expired. Send /link to {BOT_NAME} for a new one.
          </p>
        ) : !session ? (
          <Button variant="primary" size="lg" block onClick={promptConnect}>
            Connect wallet to link
          </Button>
        ) : (
          <Button variant="primary" size="lg" block loading={link.isPending} disabled={link.isPending} onClick={() => link.mutate(d)}>
            Sign and link {session.accountId}
          </Button>
        )}
        {link.isError && (
          <p className="text-sm text-neg" role="alert">
            {describeError(link.error).message}
          </p>
        )}
      </PanelBody>
    </Panel>
  )
}

/**
 * Exporting a NearKit wallet's key: the page names the wallet and who asked, the
 * linked wallet signs a message (free, moves nothing), and the key is shown once,
 * masked until revealed. It lives in this component's memory only: never in storage,
 * the URL or the query cache, and it is dropped when the page closes.
 */
function RecoveryPanel({ code, apiUrl }: { code: string; apiUrl: string }) {
  const caps = useCapabilities()
  const services = useServices()
  const { data: session } = useSession()
  const { promptConnect } = useConnectPrompt()
  const now = useNow(1000)
  const [revealed, setRevealed] = useState(false)
  const described = useQuery({ queryKey: ['telegram-recovery', code], queryFn: () => describeRecovery(apiUrl, code), retry: false, staleTime: Infinity, gcTime: 0 })
  const exported = useMutation({
    mutationFn: async (d: RecoveryDescription) => {
      const nonce = base64Decode(d.nonce)
      if (!nonce || nonce.length !== 32) throw new Error('This export request is malformed. Ask the bot for a new link in 🔐 Recovery.')
      const signed = await services.wallets.signMessage({ message: d.message, recipient: d.recipient, nonce })
      return exportRecovery(apiUrl, { code, accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature })
    },
    gcTime: 0,
  })
  const reset = exported.reset
  // Leaving the page drops the key from memory.
  useEffect(() => () => reset(), [reset])

  const header = <PanelHeader title="Export NearKit wallet key" actions={<Tag tone="neutral">{caps.networkLabel}</Tag>} />

  if (described.isPending) {
    return (
      <Panel>
        {header}
        <PanelBody className="flex flex-col gap-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </PanelBody>
      </Panel>
    )
  }
  if (described.isError && !exported.isSuccess) {
    return (
      <Panel>
        {header}
        <PanelBody className="flex flex-col gap-3">
          <p className="text-sm text-neg" role="alert">
            {describeError(described.error).message}
          </p>
          <BotButton />
        </PanelBody>
      </Panel>
    )
  }

  if (exported.isSuccess) {
    const key = exported.data.secretKey
    return (
      <Panel>
        {header}
        <PanelBody className="flex flex-col gap-4">
          <div className="flex gap-2.5 rounded-sm border border-neg/40 bg-neg/8 px-3 py-2.5 text-xs leading-5 text-fg-2">
            <ShieldAlert size={15} className="mt-0.5 shrink-0 text-neg" aria-hidden="true" />
            <p>
              Anyone who has this key controls <span className="num text-fg">{exported.data.accountId}</span> and everything in it. Don’t share it, screenshot it or paste it into a
              chat. NearKit never asks for it.
            </p>
          </div>
          <div>
            <p className="mb-1.5 text-2xs uppercase tracking-legend text-fg-3">Private key</p>
            <div className="flex items-start gap-2 rounded-sm border border-line-soft bg-well px-3 py-2">
              <code className="num min-w-0 flex-1 break-all text-xs leading-5 text-fg" aria-label={revealed ? 'Private key' : 'Private key, hidden'}>
                {revealed ? key : `ed25519:${'•'.repeat(32)}`}
              </code>
              <button
                type="button"
                onClick={() => setRevealed((r) => !r)}
                aria-label={revealed ? 'Hide the key' : 'Show the key'}
                className="inline-grid size-6 shrink-0 place-items-center rounded-xs text-fg-4 transition-colors hover:bg-raised hover:text-fg-2"
              >
                {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
              <CopyButton value={key} label="Copy the key" />
            </div>
          </div>
          <p className="text-xs leading-5 text-fg-3">
            To use it, import it in a NEAR wallet app (for example Meteor or MyNearWallet: import an account with a private key). Then close this page: the key is not stored
            anywhere here.
          </p>
          <Button
            variant="secondary"
            size="lg"
            block
            onClick={() => {
              setRevealed(false)
              reset()
            }}
          >
            Done: hide the key
          </Button>
        </PanelBody>
      </Panel>
    )
  }

  const d = described.data
  if (!d) return null
  const who = d.telegram.username ? `@${d.telegram.username}` : d.telegram.name
  const left = d.expiresAt - now
  const wrongNetwork = d.network !== caps.network
  const canSign = session ? d.accounts.includes(session.accountId) : false

  return (
    <Panel>
      {header}
      <PanelBody className="flex flex-col gap-4">
        <Lines>
          <Line label="NearKit wallet">
            <span className="num break-all">{d.wallet}</span>
          </Line>
          <Line label="Telegram account">{who}</Line>
          <Line label="Network">{d.network}</Line>
          <Line label="Sign with">{d.accounts.join(', ')}</Line>
          <Line label="Link expires in">{left > 0 ? formatDuration(left) : 'expired'}</Line>
        </Lines>

        <div className="flex gap-2.5 rounded-sm border border-warn/40 bg-warn/8 px-3 py-2.5 text-xs leading-5 text-fg-2">
          <ShieldCheck size={15} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
          <p>
            Only continue if <span className="text-fg">you</span> asked {BOT_NAME} for this export, on a device you trust. Your wallet signs a message, not a transaction: it is
            free and moves no funds. The key then appears on this screen once.
          </p>
        </div>

        <div>
          <p className="mb-1.5 text-2xs uppercase tracking-legend text-fg-3">Your wallet will sign</p>
          <pre className="num whitespace-pre-wrap break-words rounded-sm border border-line-soft bg-well px-3 py-2 text-xs leading-5 text-fg-2">{d.message}</pre>
        </div>

        {wrongNetwork ? (
          <p className="text-sm text-neg" role="alert">
            This link is for {d.network}, but this NearKit runs on {caps.networkLabel.toLowerCase()}. Open the link in the {d.network} NearKit.
          </p>
        ) : left <= 0 ? (
          <p className="text-sm text-neg" role="alert">
            This link expired. Ask {BOT_NAME} for a new one in 🔐 Recovery.
          </p>
        ) : !session || !canSign ? (
          <>
            {session && !canSign && (
              <p className="text-sm text-fg-2">
                {session.accountId} is not linked to this Telegram account. Connect {d.accounts.join(' or ')}.
              </p>
            )}
            <Button variant="primary" size="lg" block onClick={promptConnect}>
              Connect {d.accounts[0] ?? 'your linked wallet'}
            </Button>
          </>
        ) : (
          <Button variant="primary" size="lg" block loading={exported.isPending} disabled={exported.isPending} onClick={() => exported.mutate(d)}>
            Sign and show the key
          </Button>
        )}
        {exported.isError && (
          <p className="text-sm text-neg" role="alert">
            {describeError(exported.error).message}
          </p>
        )}
      </PanelBody>
    </Panel>
  )
}

function ConnectPanel() {
  return (
    <Panel>
      <PanelHeader
        title={
          <span className="flex items-center gap-2 normal-case tracking-normal">
            <LogoMark size={18} />
            <span className="text-sm text-fg">{BOT_NAME}</span>
          </span>
        }
        actions={TELEGRAM_BOT_LIVE ? null : <ComingSoon />}
      />
      <ol className="divide-y divide-line-soft">
        {[
          [`Open ${BOT_NAME} in Telegram and send /start.`, 'It explains what it can do and never asks for keys.'],
          ['Send /link.', 'The bot answers with a one-time link to this page. It works once, for 10 minutes.'],
          ['Sign the message in your wallet.', 'NearKit checks the signature and that it comes from a full-access key of your account. Nothing is sent or spent.'],
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
      <div className="flex flex-wrap items-center gap-3 border-t border-line-soft px-4 py-3.5">
        {TELEGRAM_BOT_LIVE ? (
          <BotButton />
        ) : (
          <p className="text-xs text-fg-3">The bot is built, but no NearKit bot server is connected to this build yet, so linking isn’t available here.</p>
        )}
      </div>
    </Panel>
  )
}

export default function TelegramPage() {
  const location = useLocation()
  const code = readLinkCode(location.hash)
  // Read once, then dropped from the address bar and history: the code is single-use.
  const [recoverCode] = useState(() => readRecoverCode(window.location.hash))
  useEffect(() => {
    if (recoverCode) window.history.replaceState(window.history.state, '', window.location.pathname)
  }, [recoverCode])
  return (
    <Page>
      <PageHeader
        title="Telegram"
        status={TELEGRAM_BOT_LIVE ? undefined : <ComingSoon />}
        description="Link your NEAR account to the NearKit bot. Trades prepared in Telegram are signed here, in your own wallet: the bot never holds keys."
      />

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[440px_minmax(0,1fr)]">
        {recoverCode && TELEGRAM_BOT_LIVE && ENV.apiUrl ? (
          <RecoveryPanel code={recoverCode} apiUrl={ENV.apiUrl} />
        ) : code && TELEGRAM_BOT_LIVE && ENV.apiUrl ? (
          <LinkPanel code={code} apiUrl={ENV.apiUrl} />
        ) : (
          <ConnectPanel />
        )}

        <Panel>
          <PanelHeader title="Commands" meta={BOT_COMMANDS.length} />
          <Table label="Bot commands" minWidth={520}>
            <thead>
              <tr>
                <Th>Command</Th>
                <Th>What it does</Th>
                <Th>Where</Th>
              </tr>
            </thead>
            <tbody>
              {BOT_COMMANDS.map((c) => (
                <Tr key={c.name}>
                  <Td>
                    <span className="num text-fg">/{c.name}</span> {c.usage && <span className="num text-xs text-fg-3">{c.usage}</span>}
                  </Td>
                  <Td className="whitespace-normal text-fg-2">{c.description}</Td>
                  <Td className="text-xs text-fg-3">{c.scope === 'private' ? 'Private chat' : c.scope === 'group' ? 'Groups' : 'Anywhere'}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      </div>
    </Page>
  )
}
