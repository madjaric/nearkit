import { useState } from 'react'
import { Wallet as WalletIcon } from 'lucide-react'
import { ChainMark } from '@/components/brand/ChainMark'
import { Button } from '@/components/ui/Button'
import { AmountInput, Field, Input } from '@/components/ui/Form'
import { Led } from '@/components/ui/Indicators'
import { BRIDGE_CHAINS, type BridgeChain, type BridgeChainId } from '@/config/bridge'
import { cn } from '@/lib/cn'
import { truncateMiddle } from '@/lib/format'
import { rawText } from './format'
import { sourceActionState } from './sourceAction'
import type { SourceSide } from './useSourceSide'
import type { SourceWallet, useSourceWallet } from './useSourceWallet'

/**
 * The source side of both bridge products (Bridge & Buy $KITS and the plain Bridge to NEAR), shared
 * so they send the same way: the chain the user holds (SOL, ETH, BNB), the wallet that sends (a
 * Solana or EVM wallet in this browser, or any other wallet whose address the user pastes), and how
 * much. The state and the send itself are useSourceSide.ts's. Nothing here holds keys or funds.
 */

const chainTitle = (c: BridgeChain) => `${c.symbol} · ${c.name}`

type Source = ReturnType<typeof useSourceWallet>

/** SOL, ETH or BNB: one button each, dimmed while NEAR Intents isn't taking it. */
export function ChainPicker({ chainId, offered, onPick }: { chainId: BridgeChainId; offered: readonly BridgeChainId[] | null; onPick: (id: BridgeChainId) => void }) {
  return (
    <div role="radiogroup" aria-label="Source chain" className="grid grid-cols-3 gap-2">
      {BRIDGE_CHAINS.map((c) => {
        const on = c.id === chainId
        const down = offered !== null && !offered.includes(c.id)
        return (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={chainTitle(c)}
            onClick={() => onPick(c.id)}
            className={cn(
              'flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors sm:px-3',
              on ? 'border-accent/70 bg-accent/8' : 'border-line bg-well hover:border-line-strong',
              down && 'opacity-50',
            )}
          >
            <ChainMark chain={c.id} size={24} />
            <span className="min-w-0">
              <span className={cn('block text-sm font-semibold leading-5', on ? 'text-fg' : 'text-fg-2')}>{c.symbol}</span>
              <span className="hidden truncate text-2xs text-fg-3 min-[420px]:block">{c.name}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** "You send": the amount, the wallet's balance with MAX (what the chain's own fee leaves), and why it can't be sent. */
export function SendAmountField({ chain, side }: { chain: BridgeChain; side: SourceSide }) {
  const { balance, insufficient, precision, leavesNoFee, amountText, setAmountText } = side
  return (
    <Field
      label="You send"
      aside={
        balance !== null ? (
          <span className="flex items-center gap-1.5">
            Balance{' '}
            <span className="num text-fg-2">
              {rawText(balance, chain.decimals)} {chain.symbol}
            </span>
            <button
              type="button"
              className="rounded-sm px-1 text-2xs font-semibold uppercase tracking-[0.08em] text-accent hover:bg-accent/10"
              onClick={() => {
                const max = balance - chain.maxReserve
                if (max > 0n) setAmountText(rawText(max, chain.decimals, chain.decimals).replace(/,/g, ''))
              }}
            >
              Max
            </button>
          </span>
        ) : null
      }
      error={insufficient ? `Your wallet holds ${rawText(balance as bigint, chain.decimals)} ${chain.symbol}.` : (precision ?? undefined)}
      warning={leavesNoFee ? `Leaves less than ${rawText(chain.maxReserve, chain.decimals)} ${chain.symbol} for ${chain.name}’s own network fee.` : undefined}
    >
      {({ id, describedBy, invalid }) => (
        <AmountInput
          id={id}
          size="lg"
          placeholder="0.00"
          value={amountText}
          onValueChange={setAmountText}
          unit={chain.symbol}
          aria-describedby={describedBy}
          aria-invalid={invalid}
        />
      )}
    </Field>
  )
}

export function SourceStatus({ source, chain, manual }: { source: Source; chain: BridgeChain; manual: boolean }) {
  if (source.connection)
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-3">
        <Led tone="on" />
        <span className="truncate">{source.connection.name}</span>
        <span className="num text-fg-2" title={source.connection.address}>
          {truncateMiddle(source.connection.address, 6, 4)}
        </span>
        <button type="button" onClick={source.disconnect} className="text-fg-3 underline decoration-fg-4 underline-offset-2 hover:text-fg">
          Change
        </button>
      </span>
    )
  return <span className="text-xs text-fg-3">{manual ? `Sending from another ${chain.name} wallet` : `${chain.name} wallet not connected`}</span>
}

export function SourceConnect({ chain, side }: { chain: BridgeChain; side: SourceSide }) {
  const { source, manual, setManual, manualAddress, setManualAddress, manualError } = side
  if (source.connection) return source.error ? <p className="text-xs text-warn">{source.error}</p> : null
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line-soft bg-well/50 p-3">
      {source.wallets.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {source.wallets.map((w: SourceWallet) => (
            <Button key={w.wallet.id} size="sm" variant="secondary" loading={source.busy} onClick={() => source.connect(w)}>
              <WalletGlyph wallet={w} />
              Connect {w.wallet.name}
            </Button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-fg-3">
          No {chain.name} wallet found in this browser. {chain.family === 'solana' ? 'Phantom, Solflare or Backpack' : 'MetaMask, Rabby or any EVM wallet'} connects here, or send
          from any wallet below.
        </p>
      )}
      {source.error && <p className="text-xs text-warn">{source.error}</p>}
      <label className="flex items-center gap-2 text-xs text-fg-2">
        <input type="checkbox" className="accent-[var(--color-accent)]" checked={manual} onChange={(e) => setManual(e.target.checked)} />
        Send from another wallet (paste its {chain.name} address)
      </label>
      {manual && (
        <Field label={`Your ${chain.name} address`} hint="It sends the amount, and any refund goes back to it." error={manualError ?? undefined}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              mono
              inputSize="sm"
              spellCheck={false}
              autoComplete="off"
              placeholder={chain.family === 'solana' ? 'Solana address' : '0x…'}
              value={manualAddress}
              onChange={(e) => setManualAddress(e.target.value)}
              aria-describedby={describedBy}
              aria-invalid={invalid}
            />
          )}
        </Field>
      )}
    </div>
  )
}

function WalletGlyph({ wallet: w }: { wallet: SourceWallet }) {
  return w.wallet.icon ? <img src={w.wallet.icon} alt="" width={16} height={16} className="size-4 rounded-sm" /> : <WalletIcon size={14} aria-hidden="true" />
}

const KNOWN_WALLETS: Record<BridgeChain['family'], string> = {
  solana: 'Phantom, Solflare and Backpack connect',
  evm: 'MetaMask, Rabby and other EVM wallets connect',
}

const either = (names: string[]) => (names.length <= 2 ? names.join(' or ') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`)

const LINK = 'self-start text-xs font-semibold text-fg-2 underline decoration-fg-4 underline-offset-2 hover:text-fg'

/**
 * The sending wallet, right above the action that needs it (Bridge to NEAR). It connects only a wallet
 * that registered itself on this page (the Wallet Standard for Solana, EIP-6963 for EVM: useSourceWallet.ts);
 * where none did, as in Telegram's in-app browser, it says so, with no Connect key that can't work, and
 * takes the address the user sends from instead: Bridge to NEAR then shows the deposit address their
 * wallet app sends to. Connecting shares an address only: nothing is sent, no order or deposit address made.
 */
export function SourceAction({ chain, side, inTelegram }: { chain: BridgeChain; side: SourceSide; inTelegram: boolean }) {
  const { source, setManual } = side
  const [choosing, setChoosing] = useState(false)
  const state = sourceActionState(side)
  const error = source.error ? (
    <p role="alert" className="text-xs leading-5 text-warn">
      {source.error}
    </p>
  ) : null

  let body
  if (state.kind === 'connected')
    body = (
      <>
        <div className="flex items-center gap-2.5">
          <Led tone="on" />
          <p className="min-w-0 flex-1 text-xs leading-5 text-fg-3">
            Sending from <span className="font-semibold text-fg-2">{state.name}</span>
            <span className="num block truncate text-sm text-fg" title={state.address}>
              {truncateMiddle(state.address, 6, 4)}
            </span>
          </p>
          <Button size="sm" variant="ghost" onClick={source.disconnect}>
            Disconnect
          </Button>
        </div>
        {error}
      </>
    )
  else if (state.kind === 'connect') {
    const only = source.wallets.length === 1 ? (source.wallets[0] as SourceWallet) : null
    body = (
      <>
        <Button
          variant="primary"
          size="lg"
          block
          loading={source.busy}
          icon={<WalletIcon size={16} aria-hidden="true" />}
          aria-expanded={only ? undefined : choosing}
          onClick={() => (only ? void source.connect(only) : setChoosing((c) => !c))}
        >
          {`Connect ${chain.name} Wallet`}
        </Button>
        {!only && choosing && (
          <div role="group" aria-label={`${chain.name} wallets`} className="flex flex-col gap-2">
            {source.wallets.map((w: SourceWallet) => (
              <Button key={w.wallet.id} variant="secondary" block loading={source.busy} icon={<WalletGlyph wallet={w} />} onClick={() => void source.connect(w)}>
                {w.wallet.name}
              </Button>
            ))}
          </div>
        )}
        <p className="text-xs leading-5 text-fg-3">
          {only ? `Opens ${only.wallet.name} to approve the connection.` : `Choose ${either(source.wallets.map((w: SourceWallet) => w.wallet.name))}.`} It shares your address only:
          nothing is sent, and no deposit address is made until you start the bridge.
        </p>
        {error}
        <button type="button" className={LINK} onClick={() => setManual(true)}>
          Send from another wallet instead
        </button>
      </>
    )
  } else if (state.kind === 'none')
    body = (
      <>
        <p className="text-sm font-semibold text-fg">{inTelegram ? `No ${chain.name} wallet in Telegram` : `No ${chain.name} wallet in this browser`}</p>
        <p className="text-xs leading-5 text-fg-3">
          {inTelegram ? `Telegram’s in-app browser has no ${chain.name} wallet this page can connect to.` : `This browser has no ${chain.name} wallet this page can connect to.`}{' '}
          {KNOWN_WALLETS[chain.family]} only from a browser or app where they’re installed. You can still bridge: enter the address you send from, then send the amount from your
          wallet app to the deposit address Bridge to NEAR shows.
        </p>
        <Button variant="primary" size="lg" block onClick={() => setManual(true)}>
          {`Enter my ${chain.name} address`}
        </Button>
        {inTelegram && <p className="text-xs leading-5 text-fg-3">Or, in the NEARKITS bot: 🌉 Bridge to NEAR, then ✍️ Send manually.</p>}
        {error}
      </>
    )
  else body = <AddressEntry chain={chain} side={side} />

  return (
    <section aria-label={`Your ${chain.name} wallet`} className="flex flex-col gap-2.5 rounded-md border border-line bg-well/50 p-3">
      {body}
    </section>
  )
}

/** The address the user sends from, typed in: their wallet app sends the amount, refunds go back to it. */
function AddressEntry({ chain, side }: { chain: BridgeChain; side: SourceSide }) {
  const { source, setManual, manualAddress, setManualAddress, manualError, sourceAddress } = side
  return (
    <>
      <Field label={`Your ${chain.name} address`} hint="Your wallet app sends the amount from it, and any refund goes back to it." error={manualError ?? undefined}>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            mono
            inputSize="sm"
            spellCheck={false}
            autoComplete="off"
            // Opened by a tap on "Enter my … address": the field the user asked for.
            autoFocus
            placeholder={chain.family === 'solana' ? 'Solana address' : '0x…'}
            value={manualAddress}
            onChange={(e) => setManualAddress(e.target.value)}
            aria-describedby={describedBy}
            aria-invalid={invalid}
          />
        )}
      </Field>
      {sourceAddress && <p className="text-xs leading-5 text-fg-3">Bridge to NEAR shows the deposit address to send exactly the amount to, from this address.</p>}
      {source.wallets.length > 0 && (
        <button type="button" className={LINK} onClick={() => setManual(false)}>
          Connect a wallet instead
        </button>
      )}
    </>
  )
}
