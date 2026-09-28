import { Page, PageHeader, RequireWallet } from '@/components/page/Page'
import { ExecutionTag } from '@/components/domain/Status'
import { BatchSend } from '@/features/batch/BatchSend'

export default function BatchSendPage() {
  return (
    <Page>
      <PageHeader title="Batch Send" status={<ExecutionTag />} description="Send one token to many recipients from a single list. Every line is checked before anything is sent." />
      <RequireWallet feature="Batch Send">
        <BatchSend />
      </RequireWallet>
    </Page>
  )
}
