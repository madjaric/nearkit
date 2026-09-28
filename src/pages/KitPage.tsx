import { ExternalLink } from 'lucide-react'
import { LogoMark } from '@/components/brand/Brand'
import { Page, PageHeader } from '@/components/page/Page'
import { Button } from '@/components/ui/Button'
import { ComingSoon, Led } from '@/components/ui/Indicators'
import { Line, Lines, Panel, PanelHeader } from '@/components/ui/Panel'
import { useToast } from '@/components/ui/toast-context'

const UTILITY = [
  { title: 'Fee benefits', text: 'Reduced NearKit fees for $KIT holders. Terms are published before launch.' },
  { title: 'Advanced tool access', text: 'Holder access to advanced multi-wallet and intelligence tools.' },
  { title: 'Higher limits', text: 'Larger wallet groups, batch sizes and rule counts.' },
  { title: 'Premium automation features', text: 'Extended DCA, copy trading and sniper options.' },
]

export default function KitPage() {
  const toast = useToast()
  const placeholder = (what: string) => toast.push({ title: `${what} opens at launch`, detail: '$KIT has not launched. This button is a placeholder until then.' })

  return (
    <Page>
      <PageHeader title="$KIT" status={<ComingSoon label="Not launched" />} description="The NearKit token." />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Panel>
          <div className="flex flex-col gap-6 p-5 sm:flex-row sm:items-start sm:p-6">
            <LogoMark size={56} className="shrink-0" />
            <div className="flex min-w-0 flex-col gap-4">
              <div>
                <h2 className="text-xl font-semibold leading-7 text-fg" style={{ fontStretch: '110%' }}>
                  NearKit Token
                </h2>
                <p className="num mt-0.5 text-md text-fg-2">$KIT</p>
              </div>
              <p className="max-w-[60ch] text-base leading-6 text-fg-2">
                $KIT powers the NearKit ecosystem. It launches separately through Nearly; NearKit is a trading toolkit, not a launchpad.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" size="lg" onClick={() => placeholder('Trading $KIT')}>
                  Trade $KIT
                </Button>
                <Button variant="secondary" size="lg" iconRight={<ExternalLink size={14} />} onClick={() => placeholder('The Nearly page')}>
                  View on Nearly
                </Button>
                <ComingSoon className="ml-1" />
              </div>
            </div>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Token facts" />
          <div className="p-4">
            <Lines>
              <Line label="Status" mono={false}>
                <span className="flex items-center justify-end gap-2">
                  <Led tone="off" /> Not launched
                </span>
              </Line>
              <Line label="Launch venue" mono={false}>
                Nearly
              </Line>
              <Line label="Contract" mono={false}>
                Not deployed
              </Line>
              <Line label="Price" mono={false}>
                Published at launch
              </Line>
              <Line label="Market cap" mono={false}>
                Published at launch
              </Line>
              <Line label="Supply" mono={false}>
                Published at launch
              </Line>
            </Lines>
            <p className="mt-3 border-t border-line-soft pt-3 text-xs text-fg-3">
              NearKit shows no $KIT price, supply or market figures before launch. The KIT position elsewhere in this preview is demo data for layout, not $KIT market data.
            </p>
          </div>
        </Panel>
      </div>

      <Panel>
        <PanelHeader title="Planned utility" />
        <ul className="divide-y divide-line-soft">
          {UTILITY.map((u) => (
            <li key={u.title} className="flex flex-col gap-1 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-6">
              <span className="w-56 shrink-0 text-sm font-medium text-fg">{u.title}</span>
              <span className="flex-1 text-sm text-fg-3">{u.text}</span>
              <ComingSoon />
            </li>
          ))}
        </ul>
      </Panel>
    </Page>
  )
}
