import { Wallet as WalletIcon } from 'lucide-react'
import { ChainMark } from '@/components/brand/ChainMark'
import { Button } from '@/components/ui/Button'
import { AmountInput, Field, Input } from '@/components/ui/Form'
import { Led } from '@/components/ui/Indicators'
import { BRIDGE_CHAINS, type BridgeChain, type BridgeChainId } from '@/config/bridge'
import { cn } from '@/lib/cn'
import { truncateMiddle } from '@/lib/format'
import { rawText } from './format'
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
              {w.wallet.icon ? <img src={w.wallet.icon} alt="" width={16} height={16} className="size-4 rounded-sm" /> : <WalletIcon size={14} aria-hidden="true" />}
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
