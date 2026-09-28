import { Page, PageHeader, RequireWallet } from '@/components/page/Page'
import { Wallets } from '@/features/wallets/Wallets'
import { useCapabilities } from '@/services/queries'

export default function WalletsPage() {
  const caps = useCapabilities()
  return (
    <Page>
      <PageHeader
        title="Wallets & Presets"
        description={
          caps.mode === 'demo'
            ? 'Your main account and NearKit-managed wallets, plus the saved groups you trade them in.'
            : 'The accounts you connect and any you watch, plus the saved groups you trade them in.'
        }
      />
      <RequireWallet feature="Wallets">
        <Wallets />
      </RequireWallet>
    </Page>
  )
}
