import { Page, PageGrid, PageHeader, RequireWallet } from '@/components/page/Page'
import { Tag } from '@/components/ui/Indicators'
import { useRuleWording } from '@/lib/modeCopy'
import { OrderForm } from '@/features/orders/OrderForm'
import { OrdersPanel } from '@/features/orders/OrdersPanel'

export default function LimitOrdersPage() {
  const wording = useRuleWording()
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
