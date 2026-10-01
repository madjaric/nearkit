import { useLocation, useSearchParams } from 'react-router'
import { Page, PageHeader, RequireWallet } from '@/components/page/Page'
import { ExecutionTag } from '@/components/domain/Status'
import { MultiTrade } from '@/features/multi/MultiTrade'

export default function MultiTradePage() {
  const [params] = useSearchParams()
  const location = useLocation()
  return (
    <Page>
      <PageHeader
        title="Multi Trade"
        status={<ExecutionTag trading />}
        description="One order across many wallets. Pick a preset or wallets, split the total equally or by hand, and review every leg before it runs."
      />
      <RequireWallet feature="Multi Trade" nearkit>
        <MultiTrade
          key={location.search}
          initialSide={params.get('side') === 'sell' ? 'sell' : 'buy'}
          initialPresetId={params.get('preset')}
          initialTokenId={params.get('token')}
        />
      </RequireWallet>
    </Page>
  )
}
