import { Page, PageHeader, RequireWallet } from '@/components/page/Page'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Dialog'
import { useNearKitSignIn } from '@/features/wallets/useNearKitSignIn'
import { Wallets } from '@/features/wallets/Wallets'
import { useCapabilities } from '@/services/queries'

export default function WalletsPage() {
  const caps = useCapabilities()
  // The bot's /web link lands here: whose account it opens is confirmed before the page signs in.
  const signIn = useNearKitSignIn()
  const who = signIn.pending ? `${signIn.pending.userName}${signIn.pending.userHandle ? ` (@${signIn.pending.userHandle})` : ''}` : ''
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
      <Modal
        open={signIn.pending !== null}
        onClose={signIn.cancel}
        size="sm"
        title="Sign in to NEARKITS web?"
        description={`This link opens the NEARKITS wallets of the Telegram account ${who}.`}
        footer={
          <>
            <Button variant="ghost" onClick={signIn.cancel}>
              Not my account
            </Button>
            <Button variant="primary" loading={signIn.signingIn} onClick={signIn.confirm}>
              Sign in
            </Button>
          </>
        }
      >
        <p className="text-sm leading-6 text-fg-2">
          Continue only if you asked the NEARKITS bot for this link yourself, with /web. A link someone else sent would show their wallets here, and anything you deposit would be
          theirs.
        </p>
        {signIn.current && signIn.current.token !== signIn.pending?.token && (
          <p className="mt-3 text-sm leading-6 text-fg-3">
            You’re signed in as {signIn.current.userName}
            {signIn.current.userHandle ? ` (@${signIn.current.userHandle})` : ''}: signing in here signs that session out.
          </p>
        )}
      </Modal>
    </Page>
  )
}
