import { useSearchParams } from 'react-router'
import { Page, PageHeader } from '@/components/page/Page'
import { Tag } from '@/components/ui/Indicators'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { bridgeChain, type BridgeChainId } from '@/config/bridge'
import { BRIDGE_FEE_LABEL, NEARKIT_FEE_LABEL } from '@/lib/fees'
import { BridgeForm, RouteLine } from '@/features/bridge/BridgeForm'
import { OrderView } from '@/features/bridge/OrderView'
import { RecentOrders } from '@/features/bridge/RecentOrders'
import { useBridgeAvailability, useBridgeOrders } from '@/features/bridge/useBridge'

/**
 * Bridge & Buy $KITS: bring SOL, ETH or BNB to NEAR and buy $KITS, as one flow. NEARKITS is the
 * interface; NEAR Intents moves the funds across chains; the user's own wallets sign. `?order=`
 * shows one order (a reload or Activity finds it again); `?from=sol|eth|bsc` picks the source.
 */

const STEPS = [
  { title: 'Send from your wallet', text: 'Your Solana or EVM wallet sends SOL, ETH or BNB to the deposit address of a live NEAR Intents quote. NEARKITS never holds it.' },
  { title: 'NEAR Intents brings it to NEAR', text: 'Its solvers swap it to NEAR and deliver it to the NEAR wallet you chose. If it can’t complete, your address is refunded.' },
  {
    title: 'NEARKITS buys $KITS',
    text: 'With the NEAR that arrived, at the price then and never below the least $KITS you accepted. A connected NEAR wallet signs this step itself.',
  },
]

export default function BridgePage() {
  const availability = useBridgeAvailability()
  const [params, setParams] = useSearchParams()
  const orderId = params.get('order')
  const from = params.get('from')
  const initialChain = from && bridgeChain(from) ? (from as BridgeChainId) : undefined
  const { orders: all } = useBridgeOrders(availability.ok)
  const orders = all.filter((o) => o.product !== 'bridge')

  return (
    <Page>
      <PageHeader
        title="Bridge & Buy"
        status={<Tag tone="neutral">NEAR Intents</Tag>}
        description="Bring SOL, ETH or BNB to NEAR and buy $KITS in one flow: NEAR Intents moves it across chains, NEARKITS buys $KITS (kits.nearlytrade.near) with the NEAR."
      />
      {!availability.ok ? (
        <Unavailable reason={availability.reason} />
      ) : orderId ? (
        <OrderView key={orderId} id={orderId} onNew={() => setParams({})} />
      ) : (
        <BridgeForm initialChain={initialChain} onStarted={(id) => setParams({ order: id })} />
      )}
      {availability.ok && <RecentOrders orders={orders} current={orderId} onOpen={(id) => setParams({ order: id })} />}
      <Panel aria-labelledby="bb-how">
        <PanelHeader id="bb-how" title="How Bridge & Buy works" />
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
          Fees: NEARKITS {BRIDGE_FEE_LABEL} and NEAR Intents’ own share on the bridge, taken from what you send; NEARKITS’ {NEARKIT_FEE_LABEL} trading fee and $KITS’ own buy tax on
          the purchase. Each is shown before you confirm.
        </p>
      </Panel>
    </Page>
  )
}

function Unavailable({ reason }: { reason: 'demo' | 'testnet' | 'no-server' }) {
  const text =
    reason === 'demo'
      ? 'This preview reads nothing from NEAR Intents, so it shows no quote: NEARKITS never makes up a price. On nearkits.com, Bridge & Buy quotes live.'
      : reason === 'testnet'
        ? 'Bridge & Buy runs on NEAR mainnet, where $KITS trades.'
        : 'This NEARKITS build isn’t connected to NEARKITS’ server, which asks NEAR Intents for every quote.'
  return (
    <Panel aria-label="Bridge & Buy">
      <PanelHeader title="Bridge & Buy $KITS" actions={<Tag tone="neutral">{reason === 'demo' ? 'Preview' : reason === 'testnet' ? 'Mainnet only' : 'Not connected'}</Tag>} />
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        <RouteLine chain={bridgeChain('sol') as NonNullable<ReturnType<typeof bridgeChain>>} />
        <p className="max-w-[70ch] text-sm leading-6 text-fg-2">{text}</p>
      </div>
    </Panel>
  )
}
