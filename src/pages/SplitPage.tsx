import { Page, PageHeader, RequireWallet } from '@/components/page/Page'
import { ExecutionTag } from '@/components/domain/Status'
import { Split } from '@/features/split/Split'

export default function SplitPage() {
  return (
    <Page>
      <PageHeader title="Split" status={<ExecutionTag />} description="Distribute tokens from one wallet across many, in equal shares or by custom percentage." />
      <RequireWallet feature="Split" nearkit>
        <Split />
      </RequireWallet>
    </Page>
  )
}
