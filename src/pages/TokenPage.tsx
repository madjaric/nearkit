import { useParams } from 'react-router'
import { Page, PageHeader } from '@/components/page/Page'
import { TokenDetail } from '@/features/token/TokenDetail'

export default function TokenPage() {
  const { id = '' } = useParams()
  return (
    <Page>
      <PageHeader title="Token" description="The live price, the prices that exist for it, and your balance. Buy, Sell and Send open NearKit’s own flows." />
      <TokenDetail key={id} tokenId={id} />
    </Page>
  )
}
