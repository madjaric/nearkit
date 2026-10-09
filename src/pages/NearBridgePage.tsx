import { Link, useSearchParams } from 'react-router'
import { Page, PageHeader } from '@/components/page/Page'
import { Tag } from '@/components/ui/Indicators'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { bridgeChain, type BridgeChainId } from '@/config/bridge'
import { BRIDGE_FEE_LABEL } from '@/lib/fees'
import { NearBridgeForm, NearRouteLine } from '@/features/bridge/NearBridgeForm'
import { NearOrderView } from '@/features/bridge/NearOrderView'
import { RecentOrders } from '@/features/bridge/RecentOrders'
import { useBridgeAvailability, useBridgeOrders } from '@/features/bridge/useBridge'

/**
 * Bridge: SOL, ETH or BNB into NEAR, to fund NEARKITS wallets (gas, Multi Trade, Batch Send, any NEAR
 * activity) or any NEAR account. Nothing is bought: for $KITS there is Bridge & Buy (/bridge). NEAR
 * Intents moves the funds across chains; the user's own wallets sign. `?order=` shows one order (a
 * reload or Activity finds it again); `?from=sol|eth|bsc` picks the source.
 */

const STEPS = [
  { title: 'Send from your wallet', text: 'Your Solana or EVM wallet sends SOL, ETH or BNB to the deposit address of a live NEAR Intents quote. NEARKITS never holds it.' },
  {
    title: 'NEAR Intents brings it to NEAR',
    text: 'Its solvers swap it to NEAR and deliver it as wNEAR to the account you chose. If it can’t complete, your address is refunded.',
  },
  {
    title: 'It becomes spendable NEAR',
    text: 'In a NEARKITS wallet NEARKITS unwraps it to native NEAR; a connected wallet unwraps it with one signature. Then it’s there for gas, trading and transfers.',
  },
]

export default function NearBridgePage() {
  const availability = useBridgeAvailability()
  const [params, setParams] = useSearchParams()
  const orderId = params.get('order')
  const from = params.get('from')
  const initialChain = from && bridgeChain(from) ? (from as BridgeChainId) : undefined
  const { orders: all } = useBridgeOrders(availability.ok)
  const orders = all.filter((o) => o.product === 'bridge')

  return (
    <Page>
      <PageHeader
        title="Bridge"
        status={<Tag tone="neutral">NEAR Intents</Tag>}
        description="Move assets from other chains into NEAR: bring SOL, ETH or BNB to a NEARKITS wallet, your connected NEAR wallet or any NEAR account, for gas, trading and transfers. Nothing is bought."
      />
      {!availability.ok ? (
        <Unavailable reason={availability.reason} />
      ) : orderId ? (
        <NearOrderView key={orderId} id={orderId} onNew={() => setParams({})} />
      ) : (
        <NearBridgeForm initialChain={initialChain} onStarted={(id) => setParams({ order: id })} />
      )}
      {availability.ok && <RecentOrders title="Your Bridge orders" orders={orders} current={orderId} onOpen={(id) => setParams({ order: id })} />}
      <Panel aria-labelledby="br-how">
        <PanelHeader id="br-how" title="How the Bridge works" />
        <ol className="grid grid-cols-1 gap-px bg-line-soft md:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex flex-col gap-1.5 bg-panel p-4">
              <span className="num text-xs text-accent">{`0${i + 1}`}</span>
              <h3 className="text-sm font-semibold text-fg">{s.title}</h3>
              <p className="text-sm leading-6 text-fg-3">{s.text}</p>
            </li>
          ))}
        </ol>
        <p className="border-t border-line-soft px-4 py-3 text-xs leading-5 text-fg-3">
          Fees: NEARKITS {BRIDGE_FEE_LABEL} and NEAR Intents’ own share, taken from what you send; the source chain’s network fee, in your wallet; about 0.0005 NEAR for the unwrap,
          on NEAR. No trading fee: nothing is traded. Each is shown before you confirm. Want $KITS?{' '}
          <Link to="/bridge" className="font-semibold text-fg-2 underline decoration-fg-4 underline-offset-2 hover:text-fg">
            Bridge &amp; Buy $KITS
          </Link>
          .
        </p>
      </Panel>
    </Page>
  )
}

function Unavailable({ reason }: { reason: 'demo' | 'testnet' | 'no-server' }) {
  const text =
    reason === 'demo'
      ? 'This preview reads nothing from NEAR Intents, so it shows no quote: NEARKITS never makes up a price. On nearkits.com, the Bridge quotes live.'
      : reason === 'testnet'
        ? 'The Bridge runs on NEAR mainnet.'
        : 'This NEARKITS build isn’t connected to NEARKITS’ server, which asks NEAR Intents for every quote.'
  return (
    <Panel aria-label="Bridge">
      <PanelHeader title="Bridge to NEAR" actions={<Tag tone="neutral">{reason === 'demo' ? 'Preview' : reason === 'testnet' ? 'Mainnet only' : 'Not connected'}</Tag>} />
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        <NearRouteLine chain={bridgeChain('sol') as NonNullable<ReturnType<typeof bridgeChain>>} />
        <p className="max-w-[70ch] text-sm leading-6 text-fg-2">{text}</p>
      </div>
    </Panel>
  )
}
