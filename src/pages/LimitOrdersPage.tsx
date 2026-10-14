import { Page, PageGrid, PageHeader, RequireWallet } from '@/components/page/Page'
import { Tag } from '@/components/ui/Indicators'
import { LimitOrderForm } from '@/features/automation/live/LimitOrderForm'
import { LiveAutomationPage } from '@/features/automation/live/LiveAutomation'
import { useAutomationAccess } from '@/features/automation/live/queries'
import { useRuleWording } from '@/lib/modeCopy'
import { OrderForm } from '@/features/orders/OrderForm'
import { OrdersPanel } from '@/features/orders/OrdersPanel'

export default function LimitOrdersPage() {
  const wording = useRuleWording()
  // NEARKITS' server runs limit orders: live with a NEARKITS session, a sign-in without one (useAutomationAccess).
  const access = useAutomationAccess('limit')
  if (access !== 'held')
    return (
      <LiveAutomationPage
        access={access}
        kind="limit"
        feature="Limit Orders"
        description="Limit buy, limit sell, take profit and stop loss in NEAR per token, watched and executed by NEARKITS’ server from your NEARKITS wallets."
        listTitle="Your orders"
        form={(onCreated) => <LimitOrderForm onCreated={onCreated} />}
      />
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
