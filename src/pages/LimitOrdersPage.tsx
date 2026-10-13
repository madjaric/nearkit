import { Page, PageGrid, PageHeader, RequireWallet } from '@/components/page/Page'
import { Tag } from '@/components/ui/Indicators'
import { LimitOrderForm } from '@/features/automation/live/LimitOrderForm'
import { LiveAutomation } from '@/features/automation/live/LiveAutomation'
import { useAutomationLive } from '@/features/automation/live/queries'
import { useRuleWording } from '@/lib/modeCopy'
import { OrderForm } from '@/features/orders/OrderForm'
import { OrdersPanel } from '@/features/orders/OrdersPanel'

export default function LimitOrdersPage() {
  const wording = useRuleWording()
  // NEARKITS' server runs limit orders for this user (real services, a NEARKITS session, switched on).
  const live = useAutomationLive('limit')
  if (live)
    return (
      <Page>
        <PageHeader
          title="Limit Orders"
          status={<Tag tone="accent">Live · NEARKITS wallets</Tag>}
          description="Limit buy, limit sell, take profit and stop loss in NEAR per token, watched and executed by NEARKITS’ server from your NEARKITS wallets."
        />
        <LiveAutomation kind="limit" title="Your orders" form={(onCreated) => <LimitOrderForm onCreated={onCreated} />} />
      </Page>
    )
  return (
    <Page>
      <PageHeader
        title="Limit Orders"
        status={<Tag tone="neutral">{wording.demo ? 'Not monitored' : 'Drafts only · not monitored'}</Tag>}
        description="Buy or sell when the price reaches your trigger. Take profit and stop loss close positions automatically once execution is live."
      />
      <RequireWallet feature="Limit Orders">
        <PageGrid aside={<OrderForm />} asideWidth={380} asideFirst>
          <OrdersPanel />
        </PageGrid>
      </RequireWallet>
    </Page>
  )
}
