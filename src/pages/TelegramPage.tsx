import type { ReactNode } from 'react'
import { LogoMark } from '@/components/brand/Brand'
import { Page, PageHeader } from '@/components/page/Page'
import { Button } from '@/components/ui/Button'
import { ComingSoon, Tag } from '@/components/ui/Indicators'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { Table, Td, Th, Tr } from '@/components/ui/Table'
import { useToast } from '@/components/ui/toast-context'
import { cn } from '@/lib/cn'

const COMMANDS = [
  { cmd: '/buy', args: '<token> <amount>', does: 'Buy a token with NEAR from your default wallet', example: '/buy BLACKDRAGON 5' },
  { cmd: '/sell', args: '<token> <percent>', does: 'Sell part or all of a position', example: '/sell SHITZU 50%' },
  { cmd: '/positions', args: '', does: 'Positions with value and PnL', example: '/positions' },
  { cmd: '/split', args: '<token> <amount> <preset>', does: 'Split tokens across a wallet preset', example: '/split KIT 1000000 TRADING' },
  { cmd: '/wallets', args: '', does: 'Wallets and balances; set the default wallet', example: '/wallets' },
  { cmd: '/orders', args: '', does: 'Open orders, each with a cancel key', example: '/orders' },
]

function Out({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end">
      <p className="num max-w-[85%] rounded-md rounded-br-xs bg-raised px-3 py-2 text-sm text-fg">{children}</p>
    </div>
  )
}

function In({ children, keys }: { children: ReactNode; keys?: string[] }) {
  return (
    <div className="flex max-w-[92%] flex-col gap-1.5">
      <div className="rounded-md rounded-bl-xs border border-line bg-well px-3 py-2.5 text-sm leading-5 text-fg-2">{children}</div>
      {keys && (
        <div className={cn('grid gap-1', keys.length > 2 ? 'grid-cols-3' : 'grid-cols-2')}>
          {keys.map((k) => (
            <span key={k} className="keycap grid h-7 place-items-center rounded-xs border border-line text-[10.5px] text-fg-3">
              {k}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export default function TelegramPage() {
  const toast = useToast()
  return (
    <Page>
      <PageHeader title="Telegram" status={<ComingSoon />} description="Use NearKit tools directly from Telegram, on the same account and wallets." />

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[420px_minmax(0,1fr)]">
        <Panel>
          <PanelHeader
            title={
              <span className="flex items-center gap-2 normal-case tracking-normal">
                <LogoMark size={18} />
                <span className="text-sm text-fg">NearKit bot</span>
              </span>
            }
            actions={<Tag tone="neutral">Illustrative</Tag>}
          />
          <div className="flex flex-col gap-3 p-4" aria-label="Example conversation with the NearKit bot">
            <Out>/buy BLACKDRAGON 5</Out>
            <In keys={['Confirm', 'Wallet', 'Cancel']}>
              Buy with <span className="num text-fg">5.00 NEAR</span> from Main?
              <br />
              Est. <span className="num text-fg">≈ 1.76M BLACKDRAGON</span> · fee <span className="num">0.10 NEAR</span> · slippage <span className="num">1%</span>
            </In>
            <Out>/positions</Out>
            <In>
              <span className="num grid grid-cols-[1fr_auto_auto] gap-x-4 text-xs leading-5">
                {[
                  ['NEAR', '$32.6K', '+17.8%', 'text-pos'],
                  ['BLACKDRAGON', '$8.30K', '−14.4%', 'text-neg'],
                  ['SHITZU', '$3.37K', '+6.6%', 'text-pos'],
                  ['KIT', '$902', '+30.6%', 'text-pos'],
                ].map(([sym, value, pnl, tone]) => (
                  <span key={sym} className="contents">
                    <span className="text-fg">{sym}</span>
                    <span className="text-right">{value}</span>
                    <span className={cn('text-right', tone)}>{pnl}</span>
                  </span>
                ))}
              </span>
            </In>
            <Out>/split KIT 1000000 TRADING</Out>
            <In keys={['Confirm split', 'Cancel']}>
              Split <span className="num text-fg">1,000,000 KIT</span> from Main across <span className="text-fg">TRADING</span> (<span className="num">4</span> wallets, equal)?
            </In>
            <p className="pt-1 text-center text-[11px] text-fg-4">Demo figures. The bot is not live.</p>
          </div>
        </Panel>

        <div className="flex min-w-0 flex-col gap-4">
          <Panel>
            <PanelHeader title="Commands" meta={COMMANDS.length} />
            <Table label="Bot commands" minWidth={560}>
              <thead>
                <tr>
                  <Th>Command</Th>
                  <Th>What it does</Th>
                  <Th>Example</Th>
                </tr>
              </thead>
              <tbody>
                {COMMANDS.map((c) => (
                  <Tr key={c.cmd}>
                    <Td>
                      <span className="num text-fg">{c.cmd}</span> <span className="num text-xs text-fg-3">{c.args}</span>
                    </Td>
                    <Td className="whitespace-normal text-fg-2">{c.does}</Td>
                    <Td mono className="whitespace-normal text-xs text-fg-3">
                      {c.example}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Panel>

          <Panel>
            <PanelHeader title="Same account" />
            <ol className="divide-y divide-line-soft">
              {[
                ['Open the NearKit bot in Telegram.', 'Start it from the button below once it is live.'],
                ['Link it with a one-time code.', 'Generate the code in Settings; no keys ever go through chat.'],
                ['Trade from chat.', 'Orders, splits and positions stay in sync with this terminal.'],
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
              <Button
                variant="primary"
                size="lg"
                onClick={() => toast.push({ title: 'The Telegram bot is not live yet', detail: 'This button is a placeholder until the bot ships.' })}
              >
                Open Telegram bot
              </Button>
              <ComingSoon />
            </div>
          </Panel>
        </div>
      </div>
    </Page>
  )
}
