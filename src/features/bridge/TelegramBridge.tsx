import { useQuery } from '@tanstack/react-query'
import { useMemo, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { ENV } from '@/config/env'
import { createBridgeClient } from '@/services/bridge'
import { LinkRequestError } from '@/services/telegramLink'
import { NearBridgeForm } from './NearBridgeForm'
import { NearOrderView } from './NearOrderView'
import { BridgeClientContext, useBridgeAvailability, useBridgeClient } from './useBridge'

/**
 * The Bridge to NEAR inside Telegram (NEARKITS' Mini App, opened by the bot's Connect wallet): the
 * /bridge-near form and order view, on the same server routes, for the user's own NEARKITS wallets.
 * Every request carries the launch data Telegram signed for NEARKITS' bot, and the server checks it
 * (the page itself never decides who the user is). The user's own Solana or EVM wallet sends, where
 * one registers itself on this page; Telegram's own browser has none, and the form says so and takes
 * the address the user sends from instead (SourceAction).
 * Once an order exists the page can be closed: the bot messages the user as it moves.
 */

export default function TelegramBridge({ initData, onBack }: { initData: string; onBack: () => void }) {
  const client = useMemo(() => createBridgeClient({ apiUrl: ENV.apiUrl, session: () => null, telegram: () => initData }), [initData])
  return (
    <BridgeClientContext.Provider value={client}>
      <Body onBack={onBack} />
    </BridgeClientContext.Provider>
  )
}

function Body({ onBack }: { onBack: () => void }) {
  const availability = useBridgeAvailability()
  const client = useBridgeClient()
  const wallets = useQuery({ queryKey: ['bridge', 'telegram-wallets'], queryFn: () => client.wallets(), enabled: availability.ok, retry: false, staleTime: 60_000 })
  const [orderId, setOrderId] = useState<string | null>(null)

  const back = (
    <Button variant="ghost" size="lg" block onClick={onBack}>
      Back to NEARKITS bot
    </Button>
  )
  if (!availability.ok)
    return (
      <Frame>
        <p className="text-sm leading-6 text-fg-2">The Bridge runs on NEAR mainnet, with NEARKITS’ server. This build can’t bridge.</p>
        {back}
      </Frame>
    )
  const signedOut = wallets.error instanceof LinkRequestError && wallets.error.status === 401
  if (wallets.error)
    return (
      <Frame>
        <p role="alert" className="rounded-sm border border-neg/40 bg-neg/8 px-3 py-2.5 text-sm leading-5 text-fg">
          {signedOut ? 'Telegram’s sign-in for this page ended. Open Bridge from the NEARKITS bot again.' : (wallets.error as Error).message}
        </p>
        {!signedOut && (
          <Button variant="secondary" size="lg" block onClick={() => void wallets.refetch()}>
            Try again
          </Button>
        )}
        {back}
      </Frame>
    )
  return (
    <Frame>
      {orderId ? (
        <>
          <NearOrderView id={orderId} onNew={() => setOrderId(null)} inTelegram={{ back: onBack }} />
          <p className="text-xs leading-5 text-fg-3">You can close this page: NEARKITS’ bot messages you when the deposit is seen and when the NEAR is in your wallet.</p>
        </>
      ) : (
        <NearBridgeForm onStarted={setOrderId} miniApp={{ wallets: wallets.data ?? [], loading: wallets.isPending }} />
      )}
      {back}
    </Frame>
  )
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Bridge to NEAR</h1>
        <p className="text-sm leading-6 text-fg-2">SOL, ETH or BNB into your NEARKITS wallet, through NEAR Intents.</p>
      </div>
      {children}
    </div>
  )
}
