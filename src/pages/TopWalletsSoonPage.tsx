import { Link } from 'react-router'
import { Page, PageHeader } from '@/components/page/Page'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Panel } from '@/components/ui/Panel'

/**
 * Top Wallets while it is paused (config/paused.ts): /top-wallets and every wallet's page under it open
 * this screen. It reads no wallet data and shows no ranking; Launch Radar stays one click away.
 */
export default function TopWalletsSoonPage() {
  return (
    <Page>
      <PageHeader title="Top Wallets" description="NEAR wallets ranked by verifiable trading performance." />
      <Panel>
        <EmptyState
          title="Top Wallets is coming soon"
          action={
            <>
              <Link to="/launch-radar" className="inline-flex">
                <Button size="sm" variant="secondary" tabIndex={-1}>
                  Open Launch Radar
                </Button>
              </Link>
              <Link to="/tools" className="inline-flex">
                <Button size="sm" variant="ghost" tabIndex={-1}>
                  All Tools
                </Button>
              </Link>
            </>
          }
        >
          Wallet rankings open here once NEARKITS’ swap index holds enough history to rank wallets fairly. Until then, no ranking or wallet analysis is shown.
        </EmptyState>
        <ul className="grid gap-x-6 gap-y-1.5 border-t border-line-soft px-5 py-4 text-xs leading-5 text-fg-3 sm:grid-cols-3">
          <li>Realized PnL from indexed swaps, at average cost</li>
          <li>Win rate and data coverage, with the method shown</li>
          <li>Follow a wallet and see what it buys</li>
        </ul>
      </Panel>
    </Page>
  )
}
