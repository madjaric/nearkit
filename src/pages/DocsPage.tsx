import type { ReactNode } from 'react'
import { Page, PageHeader } from '@/components/page/Page'
import { ComingSoon, Kbd, Led, Tag } from '@/components/ui/Indicators'
import { Panel } from '@/components/ui/Panel'
import { Table, Td, Th, Tr } from '@/components/ui/Table'
import { GAS_RESERVE_NEAR, NEARKIT_FEE_LABEL, NEARKIT_FEE_RECEIVED_LABEL, RHEA_APP_FEE_SHARE_LABEL, STORAGE_DEPOSIT_NEAR } from '@/lib/fees'
import { GLOSSARY } from '@/lib/glossary'
import { useCapabilities } from '@/services/queries'

const SECTIONS = [
  { id: 'status', title: 'What works' },
  { id: 'fees', title: 'Fees' },
  { id: 'wallet-tools', title: 'Multi-wallet tools' },
  { id: 'automation', title: 'Automation' },
  { id: 'scanner', title: 'Scanner indicators' },
  { id: 'keyboard', title: 'Keyboard' },
  { id: 'glossary', title: 'Glossary' },
]

type AreaState = 'live' | 'local' | 'drafts' | 'untracked' | 'soon'

/** Feature status in real mode; the demo simulates every live flow. */
const STATUS: [string, AreaState][] = [
  ['Wallet connection (NEAR Connect)', 'live'],
  ['Balances and token discovery', 'live'],
  ['Batch send, Split, Consolidate', 'live'],
  ['Swap and quick trade (Rhea)', 'live'],
  ['Multi buy and multi sell', 'live'],
  ['Transaction history', 'live'],
  ['Scanner', 'live'],
  ['Positions', 'live'],
  ['PnL and cost basis', 'untracked'],
  ['Wallet presets, watch accounts', 'local'],
  ['Limit, take-profit and stop-loss orders', 'drafts'],
  ['DCA, Copy trade, Sniper', 'drafts'],
  ['Telegram bot', 'soon'],
  ['$KIT', 'soon'],
]

function statusCopy(state: AreaState, demo: boolean, network: string) {
  switch (state) {
    case 'live':
      return demo ? { lamp: 'on' as const, text: 'Full flow, simulated result' } : { lamp: 'on' as const, text: `Live on ${network}` }
    case 'local':
      return { lamp: 'idle' as const, text: demo ? 'Demo data' : 'Saved in this browser' }
    case 'drafts':
      return { lamp: 'idle' as const, text: demo ? 'Saved in standby, nothing runs' : 'Drafts saved, nothing runs' }
    case 'untracked':
      return demo ? { lamp: 'idle' as const, text: 'Demo history' } : { lamp: 'off' as const, text: 'Not tracked yet' }
    default:
      return { lamp: 'off' as const, text: 'Not built yet' }
  }
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-16">
      <h2 id={`${id}-h`} className="mb-3 text-md font-semibold text-fg" style={{ fontStretch: '108%' }}>
        {title}
      </h2>
      <div className="flex flex-col gap-3 text-sm leading-6 text-fg-2">{children}</div>
    </section>
  )
}

export default function DocsPage() {
  const caps = useCapabilities()
  const demo = caps.mode === 'demo'
  const network = caps.networkLabel.toLowerCase()
  return (
    <Page>
      <PageHeader title="Documentation" description="How NearKit works, what runs for real and what doesn't yet, and the terms used across the app." />
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav aria-label="On this page" className="lg:sticky lg:top-16">
          <ol className="flex flex-wrap gap-x-4 gap-y-1 lg:flex-col">
            {SECTIONS.map((s, i) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="flex items-center gap-2 py-1 text-sm text-fg-3 no-underline hover:text-fg">
                  <span className="num text-[11px] text-fg-4">{String(i + 1).padStart(2, '0')}</span>
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <Panel className="max-w-[860px]">
          <div className="flex flex-col gap-10 px-5 py-6 sm:px-8 sm:py-8">
            <p className="max-w-[68ch] text-base leading-7 text-fg-2">
              NearKit is a trading terminal and wallet toolkit for NEAR: trade, split and gather tokens across many wallets, automate entries, and read contracts before you buy.{' '}
              {demo
                ? 'This build is the demo: sample data, and nothing is signed or sent.'
                : `This build runs on NEAR ${network}. You sign every transaction in your own wallet, and NearKit reports success only after the chain confirms it.`}
            </p>

            <Section id="status" title="What works">
              <Table label="Feature status">
                <thead>
                  <tr>
                    <Th>Area</Th>
                    <Th>Interface</Th>
                    <Th>Execution</Th>
                  </tr>
                </thead>
                <tbody>
                  {STATUS.map(([area, state]) => {
                    const s = statusCopy(state, demo, network)
                    return (
                      <Tr key={area}>
                        <Td className="whitespace-normal text-fg">{area}</Td>
                        <Td>{state === 'soon' ? <ComingSoon /> : <Tag tone="neutral">Ready</Tag>}</Td>
                        <Td className="whitespace-normal">
                          <span className="flex items-center gap-2 text-fg-2">
                            <Led tone={s.lamp} />
                            {s.text}
                          </span>
                        </Td>
                      </Tr>
                    )
                  })}
                </tbody>
              </Table>
            </Section>

            <Section id="fees" title="Fees">
              <p>
                On mainnet NearKit charges <span className="num text-fg">{NEARKIT_FEE_LABEL}</span> on each trade. It is collected inside the swap by Rhea’s aggregator as an app
                fee, never as a separate transfer: of the <span className="num text-fg">{NEARKIT_FEE_LABEL}</span>, NearKit receives{' '}
                <span className="num text-fg">{NEARKIT_FEE_RECEIVED_LABEL}</span> and Rhea keeps <span className="num text-fg">{RHEA_APP_FEE_SHARE_LABEL}</span>. Rhea also charges
                its own <span className="num text-fg">0.10%</span> protocol fee on every swap. The fee comes out of the first NEAR, USDC or USDT the route touches, which is usually
                the NEAR side. Every review shows the exact amount before you sign.
              </p>
              <p>Batch send, Split and Consolidate carry no NearKit fee. Testnet trades are not charged, and the demo charges nothing.</p>
              <p>
                Network fees are paid to NEAR per transaction; gas is bought upfront and mostly refunded. Token contracts may charge a one-time storage deposit (often{' '}
                <span className="num text-fg">{STORAGE_DEPOSIT_NEAR} NEAR</span>, read from each contract) the first time an account holds their token. MAX leaves{' '}
                <span className="num text-fg">{GAS_RESERVE_NEAR} NEAR</span> in a wallet for gas.
              </p>
            </Section>

            <Section id="wallet-tools" title="Multi-wallet tools">
              <p>
                <span className="text-fg">Multi Trade</span> fans one buy or sell across selected wallets, split equally or by hand. Wallets that can't cover their share are
                flagged and skipped, never silently resized.
              </p>
              <p>
                <span className="text-fg">Split</span> distributes one wallet's tokens to many recipients by equal shares or custom percentages that must total exactly 100%.{' '}
                <span className="text-fg">Consolidate</span> does the reverse. <span className="text-fg">Batch send</span> reads a pasted list (
                <span className="num">account,amount</span> per line), rejects anything ambiguous such as thousands separators, and skips duplicates.
              </p>
              <p>
                <span className="text-fg">Presets</span> are saved wallet groups (MAIN, TRADING, SNIPERS, TEST) that any multi-wallet tool can load in one click.
              </p>
            </Section>

            <Section id="automation" title="Automation">
              <p>
                DCA plans, copy-trade rules, sniper configs and limit orders can all be created and managed now. They are saved as drafts in this browser (in standby in the demo):
                nothing watches prices or wallets, and nothing executes. That needs a keeper service NearKit doesn’t run yet.
              </p>
            </Section>

            <Section id="scanner" title="Scanner indicators">
              <p>
                The scanner never labels a token safe or unsafe. In real mode every figure says how NearKit knows it: <span className="text-fg">verified</span> (read from the chain
                by NearKit), <span className="text-fg">derived</span> (from NearBlocks or Rhea, which can lag), or <span className="text-fg">unknown</span> (public data can’t say,
                such as whether a contract can mint). The demo grades sample contracts like this:
              </p>
              <Table label="Scanner grading">
                <thead>
                  <tr>
                    <Th>Indicator</Th>
                    <Th>Elevated</Th>
                    <Th>High</Th>
                  </tr>
                </thead>
                <tbody>
                  <Tr>
                    <Td className="text-fg">Top 10 concentration</Td>
                    <Td mono>40–60%</Td>
                    <Td mono>60%+</Td>
                  </Tr>
                  <Tr>
                    <Td className="text-fg">Creator holdings</Td>
                    <Td mono>5–15%</Td>
                    <Td mono>15%+</Td>
                  </Tr>
                  <Tr>
                    <Td className="text-fg">Liquidity</Td>
                    <Td mono>under $100K</Td>
                    <Td mono>under $25K</Td>
                  </Tr>
                  <Tr>
                    <Td className="text-fg">Mint, transfer restrictions, verification</Td>
                    <Td className="text-fg-3">—</Td>
                    <Td className="whitespace-normal">Mint enabled, pausable or allowlisted transfers, unverified source</Td>
                  </Tr>
                </tbody>
              </Table>
              <p>Demo scans use sample contracts on a .sample.near namespace, so no real project is shown with invented data.</p>
            </Section>

            <Section id="keyboard" title="Keyboard">
              <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-2">
                <dt>
                  <Kbd>/</Kbd>
                </dt>
                <dd>Focus search. Type a symbol, a contract, or a command such as /split.</dd>
                <dt>
                  <Kbd>Esc</Kbd>
                </dt>
                <dd>Close menus and dialogs; disarm an armed trade.</dd>
                <dt className="flex gap-1">
                  <Kbd>←</Kbd>
                  <Kbd>→</Kbd>
                </dt>
                <dd>Move between options in Buy/Sell and other key groups, walk a chart's crosshair, or move a PnL cursor (Shift moves a week).</dd>
              </dl>
            </Section>

            <Section id="glossary" title="Glossary">
              <dl className="divide-y divide-line-soft">
                {Object.values(GLOSSARY).map((g) => (
                  <div key={g.term} className="grid grid-cols-1 gap-1 py-2.5 sm:grid-cols-[180px_1fr] sm:gap-6">
                    <dt className="text-fg">{g.term}</dt>
                    <dd>{g.text}</dd>
                  </div>
                ))}
              </dl>
            </Section>
          </div>
        </Panel>
      </div>
    </Page>
  )
}
