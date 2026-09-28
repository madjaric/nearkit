import { Page, PageHeader, RequireWallet } from '@/components/page/Page'
import { ExecutionTag } from '@/components/domain/Status'
import { Consolidate } from '@/features/consolidate/Consolidate'

export default function ConsolidatePage() {
  return (
    <Page>
      <PageHeader title="Consolidate" status={<ExecutionTag />} description="Gather a token from many wallets back into one. The reverse of Split." />
      <RequireWallet feature="Consolidate">
        <Consolidate />
      </RequireWallet>
    </Page>
  )
}
