import { Page, PageHeader, RequireWallet } from '@/components/page/Page'
import { useNearKitSignIn } from '@/features/wallets/useNearKitSignIn'
import { Wallets } from '@/features/wallets/Wallets'
import { useCapabilities } from '@/services/queries'

export default function WalletsPage() {
  const caps = useCapabilities()
  // The bot's /web link lands here: sign in before the page decides what to show.
  useNearKitSignIn()
  return (
    <Page>
      <PageHeader
        title="Wallets & Presets"
        description={
          caps.mode === 'demo'
            ? 'Your main account and NEARKITS-managed wallets, plus the saved groups you trade them in.'
            : 'Your NEARKITS wallets, the accounts you connect and any you watch, plus the saved groups you trade them in.'
        }
      />
      <RequireWallet feature="Wallets" nearkit>
        <Wallets />
      </RequireWallet>
    </Page>
  )
}
