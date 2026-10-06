import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Dialog'
import { Figures } from '@/components/ui/Figures'
import { Table, Td, Th, Tr } from '@/components/ui/Table'
import { NEAR_DECIMALS } from '@/config/networks'
import { formatUnits } from '@/lib/amounts'
import { cn } from '@/lib/cn'
import { formatAccount } from '@/lib/format'
import { useServices } from '@/services/context'
import { explorerTxUrl } from '@/services/near/explorer'
import { useCapabilities } from '@/services/queries'
import type { Wallet } from '@/types/domain'
import { reviewLines, sendLines, type LineState, type SendLine } from './nearkitSends'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** One line's status, in a word or a sentence; an address that needs approval links to where it is approved. */
function LineStatus({ state, to }: { state: LineState; to: string }) {
  const caps = useCapabilities()
  switch (state.kind) {
    case 'reviewing':
      return <span className="text-fg-3">Checking…</span>
    case 'ready':
      return <span className="text-fg-2">Ready</span>
    case 'sending':
      return <span className="text-fg-2">Sending…</span>
    case 'sent': {
      const hash = state.hashes[state.hashes.length - 1]
      return hash && caps.explorerUrl ? (
        <a href={explorerTxUrl({ explorerUrl: caps.explorerUrl }, hash)} target="_blank" rel="noreferrer noopener" className="text-pos underline">
          Sent
        </a>
      ) : (
        <span className="text-pos">Sent</span>
      )
    }
    case 'approval':
      return (
        <span className="flex flex-col gap-0.5">
          <span className="text-warn">Needs approval</span>
          {state.approval?.kind === 'owner' ? (
            <a
              href={`/recover#approve=${encodeURIComponent(state.approval.accountId)}&to=${encodeURIComponent(to)}`}
              target="_blank"
              rel="noreferrer noopener"
              className="text-accent underline"
            >
              {`Approve with ${formatAccount(state.approval.owner)}`}
            </a>
          ) : state.approval?.kind === 'telegram' ? (
            <a href={state.approval.url} target="_blank" rel="noreferrer noopener" className="text-accent underline">
              Approve in Telegram
            </a>
          ) : null}
        </span>
      )
    case 'error':
    case 'failed':
      return <span className="break-words text-neg">{state.message}</span>
  }
}

/**
 * Split or Batch Send from a NearKit wallet (`wallet`), or Consolidate from several into one
 * destination (`into`, each line naming its wallet): every line reviewed by NearKit's server first
 * (the custody rule decides who may receive), then sent one after another once every line is ready.
 * NearKit's server signs; nothing is signed in this browser. See nearkitSends.ts.
 */
export function NearKitSendsModal({
  title,
  confirmLabel,
  wallet,
  into,
  asset,
  symbol,
  decimals,
  lines,
  onClose,
}: {
  title: string
  confirmLabel: string
  /** 'near' or the token's contract. */
  asset: string
  symbol: string
  decimals: number
  lines: SendLine[]
  onClose: () => void
} & ({ wallet: Wallet; into?: undefined } | { into: { label: string; accountId: string }; wallet?: undefined })) {
  const s = useServices()
  const qc = useQueryClient()
  const [states, setStates] = useState<LineState[]>(() => lines.map(() => ({ kind: 'reviewing' })))
  const [phase, setPhase] = useState<'review' | 'sending' | 'done'>('review')
  const [round, setRound] = useState(0)
  const [stopping, setStopping] = useState(false)
  const stop = useRef(false)
  const walletId = wallet?.nearkitId ?? ''

  // Review (again, on `round`): the lines are fixed for this window's life.
  useEffect(() => {
    let live = true
    void reviewLines(s.nearkit, walletId, asset, lines, (i, state) => {
      if (live) setStates((cur) => cur.map((c, j) => (j === i ? state : c)))
    })
    return () => {
      live = false
    }
  }, [round]) // eslint-disable-line react-hooks/exhaustive-deps

  const onLine = (i: number, state: LineState) => setStates((cur) => cur.map((c, j) => (j === i ? state : c)))
  const reviewAgain = () => {
    setStates(lines.map(() => ({ kind: 'reviewing' })))
    setRound((r) => r + 1)
  }
  const send = async () => {
    stop.current = false
    setStopping(false)
    setPhase('sending')
    try {
      await sendLines(s.nearkit, walletId, asset, lines, states, onLine, { now: Date.now, sleep, shouldStop: () => stop.current })
    } finally {
      setPhase('done')
      void qc.invalidateQueries({ queryKey: ['wallets'] })
      void qc.invalidateQueries({ queryKey: ['portfolio'] })
    }
  }

  const ready = states.every((st) => st.kind === 'ready')
  const reviewing = states.some((st) => st.kind === 'reviewing')
  const needs = states.filter((st) => st.kind === 'approval').length
  const blocked = states.filter((st) => st.kind === 'error').length
  const sent = states.filter((st) => st.kind === 'sent').length
  const fees = states.reduce((sum, st) => (st.kind === 'ready' ? sum + BigInt(st.review.feeNear) : sum), 0n)
  // Lines that name their own wallet (Consolidate, or a Manual batch across NearKit wallets) show it; a batch's lines show where they go.
  const perLine = lines.some((l) => l.from)
  const senders = new Set(lines.map((l) => l.from?.walletId)).size

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={phase !== 'sending'}
      size="lg"
      title={title}
      description={
        wallet
          ? perLine
            ? `From ${senders} NearKit wallets · NearKit’s server signs and sends each line from its own wallet; nothing is signed in this browser.`
            : `From ${wallet.label} · NearKit’s server signs and sends each line; nothing is signed in this browser.`
          : `Into ${into.label} (${formatAccount(into.accountId)}) · NearKit’s server sends from each NearKit wallet, with that wallet’s own key; nothing is signed in this browser.`
      }
      footer={
        phase === 'review' ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            {(needs > 0 || blocked > 0) && !reviewing && (
              <Button variant="secondary" onClick={reviewAgain}>
                Review again
              </Button>
            )}
            <Button variant="primary" disabled={!ready} loading={reviewing} onClick={() => void send()}>
              {confirmLabel}
            </Button>
          </>
        ) : phase === 'sending' ? (
          <Button
            variant="secondary"
            disabled={stopping}
            onClick={() => {
              stop.current = true
              setStopping(true)
            }}
          >
            {stopping ? 'Stopping after this send…' : 'Stop after this send'}
          </Button>
        ) : (
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3">
        {needs > 0 && phase === 'review' && (
          <p role="alert" className="text-sm text-fg-2">
            {wallet
              ? perLine
                ? `${needs} ${needs === 1 ? 'address isn’t' : 'addresses aren’t'} approved yet for the wallet sending to it. A NearKit wallet sends only to its owner wallet and to addresses approved for it: approve each once (the link opens in a new tab), then review again.`
                : `${needs} ${needs === 1 ? 'address isn’t' : 'addresses aren’t'} approved for ${wallet.label} yet. A NearKit wallet sends only to its owner wallet and to addresses approved for it: approve each once (the link opens in a new tab), then review again.`
              : `${into.label} isn’t approved yet for ${needs} of these NearKit wallets. A NearKit wallet sends only to its owner wallet and to addresses approved for it: approve it once for each (the links open in a new tab), then review again.`}
          </p>
        )}
        {phase === 'done' && (
          <p role="status" className="text-sm text-fg">
            <Figures>{`Sent ${sent} of ${lines.length}.`}</Figures>
          </p>
        )}
        <div className="max-h-[50dvh] overflow-y-auto">
          <Table label={title}>
            <thead className="sticky top-0 bg-panel">
              <tr>
                {perLine && <Th>From</Th>}
                {wallet && <Th>To</Th>}
                <Th align="right">Amount</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, i) => (
                <Tr key={`${line.to}-${i}`}>
                  {perLine && (
                    <Td className="whitespace-normal">
                      {line.from && (
                        <>
                          <span className="block text-xs text-fg-2">{line.from.label}</span>
                          <span className="num block text-xs text-fg">{formatAccount(line.from.accountId)}</span>
                        </>
                      )}
                    </Td>
                  )}
                  {wallet && (
                    <Td className="whitespace-normal">
                      {line.label && line.label !== line.to && <span className="block text-xs text-fg-2">{line.label}</span>}
                      <span className="num block break-all text-xs text-fg">{line.to}</span>
                    </Td>
                  )}
                  <Td align="right" mono className="whitespace-nowrap text-fg">{`${line.amount} ${symbol}`}</Td>
                  <Td className={cn('text-xs')}>{states[i] && <LineStatus state={states[i]} to={line.to} />}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </div>
        {phase === 'review' && fees > 0n && (
          <p className="text-xs text-fg-3">
            <Figures>{`Network fees about ${formatUnits(fees, NEAR_DECIMALS, { maxFraction: 6 })} NEAR, paid by ${wallet && !perLine ? wallet.label : 'each wallet that sends'}. Amounts are in ${symbol} (${decimals} decimals).`}</Figures>
          </p>
        )}
      </div>
    </Modal>
  )
}
