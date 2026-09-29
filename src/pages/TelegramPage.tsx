import { useMutation, useQuery } from '@tanstack/react-query'
import { ShieldCheck } from 'lucide-react'
import { useLocation } from 'react-router'
import { LogoMark } from '@/components/brand/Brand'
import { Page, PageHeader } from '@/components/page/Page'
import { Button } from '@/components/ui/Button'
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
import { confirmLink, describeLink, readLinkCode, type LinkDescription } from '@/services/telegramLink'
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
  return (
    <Page>
      <PageHeader
        title="Telegram"
        status={TELEGRAM_BOT_LIVE ? undefined : <ComingSoon />}
        description="Link your NEAR account to the NearKit bot. Trades prepared in Telegram are signed here, in your own wallet: the bot never holds keys."
      />

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[440px_minmax(0,1fr)]">
        {code && TELEGRAM_BOT_LIVE && ENV.apiUrl ? <LinkPanel code={code} apiUrl={ENV.apiUrl} /> : <ConnectPanel />}

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
