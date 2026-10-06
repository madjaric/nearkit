import { useParams } from 'react-router'
import { Page, PageHeader } from '@/components/page/Page'
import { TokenDetail } from '@/features/token/TokenDetail'

export default function TokenPage() {
  const { id = '' } = useParams()
  return (
    <Page>
      <PageHeader
        title="Token"
        description="Its market: price, market cap, liquidity and volume from the sources that have them, real price history, and recent trades. Buy, Sell and Send open NEARKITS’ own flows."
      />
      <TokenDetail key={id} tokenId={id} />
    </Page>
  )
}
