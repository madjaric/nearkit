import { useState, type ReactNode } from 'react'
import { SlippageControl } from '@/components/domain/TradeControls'
import { Page, PageHeader } from '@/components/page/Page'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Dialog'
import { Figures } from '@/components/ui/Figures'
import { Switch } from '@/components/ui/Form'
import { InfoTip } from '@/components/ui/Help'
import { ComingSoon, Led, Tag } from '@/components/ui/Indicators'
import { Line, Lines, Panel, PanelHeader } from '@/components/ui/Panel'
import { useToast } from '@/components/ui/toast-context'
import { GAS_RESERVE_NEAR, NEARKIT_FEE_LABEL, NEARKIT_FEE_RECEIVED_LABEL, RHEA_APP_FEE_SHARE_LABEL } from '@/lib/fees'
import { useCapabilities, useDisconnect, useResetDemo, useSession } from '@/services/queries'
import { useConnectPrompt, useSettings } from '@/state/contexts'

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 px-4 py-4 md:flex-row md:items-start md:justify-between md:gap-8">
      <div className="min-w-0 md:max-w-sm">
        <p className="text-sm text-fg">{label}</p>
        {hint && <p className="mt-0.5 text-xs text-fg-3">{hint}</p>}
      </div>
      <div className="w-full md:w-[340px] md:shrink-0">{children}</div>
    </div>
  )
}

function NetworkPanel() {
  const caps = useCapabilities()
  if (caps.mode === 'demo') {
    return (
      <Panel>
        <PanelHeader title="Network" />
        <div className="divide-y divide-line-soft">
          <Row label="Network" hint="Prices, balances and history are demo data.">
            <p className="flex items-center gap-2 pt-1 text-sm text-fg-2">
              <Led tone="idle" /> NEAR · demo data
            </p>
          </Row>
          <Row label="Real network" hint="The demo never touches a network: nothing here is signed or sent.">
            <p className="pt-1 text-sm text-fg-3">Not in the demo</p>
          </Row>
        </div>
      </Panel>
    )
  }
  const exec = caps.execution
  return (
    <Panel>
      <PanelHeader title="Network" actions={<Tag tone="neutral">{caps.networkLabel}</Tag>} />
      <div className="divide-y divide-line-soft">
        <Row label="Network" hint="This site runs on one network. Testnet and mainnet never mix in one page.">
          <p className="flex items-center gap-2 pt-1 text-sm text-fg">
            <Led tone="on" /> NEAR {caps.networkLabel.toLowerCase()}
          </p>
        </Row>
        <Row label="Execution" hint="Value-moving actions sign in your wallet and are confirmed on chain.">
          <p className={exec.enabled ? 'flex items-start gap-2 pt-1 text-sm text-fg-2' : 'flex items-start gap-2 pt-1 text-sm text-warn'}>
            <Led tone={exec.enabled ? 'on' : 'warn'} className="mt-[7px]" />
            <Figures>{exec.enabled ? 'Enabled: you sign every transaction in your wallet.' : (exec.reason ?? 'Disabled in this build.')}</Figures>
          </p>
        </Row>
        <Row label="RPC endpoints" hint="Where NearKit reads balances and checks transactions, in failover order.">
          <ol className="flex flex-col gap-1 pt-1">
            {caps.rpcUrls.map((url, i) => (
              <li key={url} className="num truncate text-xs text-fg-2" title={url}>
                <span className="text-fg-4">{i === 0 ? 'primary' : `fallback ${i}`}</span> {url}
              </li>
            ))}
          </ol>
        </Row>
        {caps.explorerUrl && (
          <Row label="Explorer" hint="Every transaction links here.">
            <a href={caps.explorerUrl} target="_blank" rel="noopener noreferrer" className="num pt-1 text-sm text-fg-2 underline decoration-fg-4 underline-offset-2 hover:text-fg">
              {caps.explorerUrl.replace(/^https:\/\//, '')}
            </a>
          </Row>
        )}
      </div>
    </Panel>
  )
}

function FeesPanel() {
  const caps = useCapabilities()
  const t = caps.execution.trading
  return (
    <Panel>
      <PanelHeader title="Fees" />
      <div className="p-4">
        <Lines>
          <Line label="NearKit fee" mono={false}>
            <span className="num text-fg">{NEARKIT_FEE_LABEL}</span> per trade
          </Line>
          {caps.mode === 'near' && t.feeCharged && (
            <>
              <Line label="Of which" mono={false}>
                NearKit receives <span className="num text-fg">{NEARKIT_FEE_RECEIVED_LABEL}</span>, Rhea keeps <span className="num text-fg">{RHEA_APP_FEE_SHARE_LABEL}</span>
              </Line>
              <Line label="Rhea protocol fee" mono={false}>
                <span className="num text-fg">0.10%</span> on every swap, Rhea’s own
              </Line>
              <Line label="Fee account" mono={Boolean(t.feeRecipient)}>
                {t.feeRecipient ?? <span className="text-warn">Not configured: trades are blocked</span>}
              </Line>
            </>
          )}
          <Line label="Transfers" mono={false}>
            No NearKit fee on Batch Send, Split or Consolidate
          </Line>
          <Line label="Network fees" mono={false}>
            Paid to NEAR. Gas is bought upfront and mostly refunded
          </Line>
          <Line label="Storage deposits" mono={false}>
            Paid to token contracts for first-time holders
          </Line>
        </Lines>
        <p className="mt-3 border-t border-line-soft pt-3 text-xs text-fg-3">
          {caps.mode === 'demo'
            ? 'The demo charges no fee.'
            : t.feeCharged
              ? 'The fee is collected inside the swap by Rhea’s aggregator, never as a separate transfer. Every review shows the exact amount before you sign.'
              : `No fee is charged on ${caps.networkLabel.toLowerCase()}. On mainnet it is collected inside the swap by Rhea’s aggregator.`}
        </p>
      </div>
    </Panel>
  )
}

export default function SettingsPage() {
  const caps = useCapabilities()
  const demo = caps.mode === 'demo'
  const { settings, update, reset } = useSettings()
  const { data: session } = useSession()
  const { promptConnect } = useConnectPrompt()
  const disconnect = useDisconnect()
  const resetDemo = useResetDemo()
  const toast = useToast()
  const [confirmReset, setConfirmReset] = useState(false)

  return (
    <Page>
      <PageHeader
        title="Settings"
        description={
          demo
            ? 'Session preferences. The demo keeps nothing after a refresh.'
            : `Preferences for this session. Accounts, presets, imported tokens and drafts are saved in this browser for ${caps.networkLabel.toLowerCase()}.`
        }
      />

      <div className="flex max-w-[920px] flex-col gap-4">
        <Panel>
          <PanelHeader title="Trading" actions={<Tag tone="accent">Live in this session</Tag>} />
          <div className="divide-y divide-line-soft">
            <Row label="Default slippage" hint="Pre-filled on every trade ticket; each ticket can still change it.">
              <SlippageControl hideLabel value={settings.defaultSlippage} onChange={(v) => update({ defaultSlippage: v })} />
            </Row>
            <Row label="Two-step confirmation" hint="The first press arms a trade and the second fires it. Turn off for one-click trades.">
              <Switch
                checked={settings.twoStepConfirm}
                onChange={(v) => update({ twoStepConfirm: v })}
                label={settings.twoStepConfirm ? 'Arm, then confirm' : 'One click'}
                ariaLabel="Two-step confirmation"
              />
            </Row>
            <Row
              label={
                <span className="flex items-center gap-1.5">
                  Gas reserve <InfoTip term="gasReserve" />
                </span>
              }
              hint="MAX leaves this much NEAR in each wallet for gas and storage."
            >
              <p className="pt-1 text-sm text-fg-2">
                <Figures>{`${GAS_RESERVE_NEAR} NEAR per wallet`}</Figures>
              </p>
            </Row>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Display" />
          <div className="divide-y divide-line-soft">
            <Row label="Hide small balances" hint="Starts the Positions view with balances under $1 hidden.">
              <Switch checked={settings.hideDust} onChange={(v) => update({ hideDust: v })} label={settings.hideDust ? 'Hidden' : 'Shown'} ariaLabel="Hide small balances" />
            </Row>
            <Row label="Theme" hint="NearKit is designed dark-first for long sessions.">
              <p className="pt-1 text-sm text-fg-2">Dark</p>
            </Row>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Account" />
          <div className="divide-y divide-line-soft">
            <Row
              label="Connected wallet"
              hint={
                demo
                  ? 'The demo runs on a sample account.'
                  : session?.walletName
                    ? `Signed in through ${session.walletName}. NearKit never sees your keys.`
                    : 'Connect a NEAR wallet. NearKit never sees your keys.'
              }
            >
              {session ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <Led tone={session.issue ? 'warn' : 'on'} />
                    <span className="num truncate text-sm text-fg">{session.accountId}</span>
                  </span>
                  <Button
                    size="sm"
                    variant="danger"
                    loading={disconnect.isPending}
                    onClick={() => disconnect.mutate(undefined, { onSuccess: () => toast.push({ title: 'Disconnected' }) })}
                  >
                    Disconnect
                  </Button>
                </div>
              ) : (
                <Button size="sm" variant="primary" onClick={promptConnect}>
                  Connect wallet
                </Button>
              )}
            </Row>
            <Row label="Telegram" hint="Link the NearKit bot to this account with a one-time code.">
              <div className="flex items-center gap-2">
                <Button size="sm" variant="secondary" disabled>
                  Generate link code
                </Button>
                <ComingSoon />
              </div>
            </Row>
          </div>
        </Panel>

        <NetworkPanel />

        <FeesPanel />

        <Panel>
          <PanelHeader title={demo ? 'Demo data' : 'Preferences'} />
          <div className="divide-y divide-line-soft">
            {demo && (
              <Row label="Reset demo state" hint="Restores the seeded wallets, orders, presets and rules, and clears simulated activity.">
                <Button size="sm" variant="secondary" onClick={() => setConfirmReset(true)}>
                  Reset demo data
                </Button>
              </Row>
            )}
            <Row label="Reset preferences" hint="Slippage, confirmation and display back to their defaults.">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  reset()
                  toast.push({ title: 'Preferences reset' })
                }}
              >
                Reset preferences
              </Button>
            </Row>
          </div>
        </Panel>
      </div>

      <Modal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        size="sm"
        title="Reset demo data?"
        description="Everything you created in this session is cleared."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={resetDemo.isPending}
              onClick={() =>
                resetDemo.mutate(undefined, {
                  onSuccess: () => {
                    setConfirmReset(false)
                    toast.push({ tone: 'accent', title: 'Demo data restored' })
                  },
                })
              }
            >
              Reset
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-2">Presets, orders, DCA plans, copy rules, sniper configs and simulated activity return to the seeded demo.</p>
      </Modal>
    </Page>
  )
}
