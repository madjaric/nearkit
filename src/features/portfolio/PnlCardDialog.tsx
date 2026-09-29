import { Download, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Dialog'
import { Checkbox } from '@/components/ui/Form'
import { drawPnlCard, loadCardFonts, type PnlCard } from './pnlCard'

/**
 * Preview and export of a PnL card. The image shows exactly the figures on screen,
 * says when they are partial, and leaves the account off unless the user adds it.
 */
export function PnlCardDialog({ card, accounts, onClose }: { card: PnlCard; accounts: string[]; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [showAccount, setShowAccount] = useState(false)
  const [drawn, setDrawn] = useState(false)
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
  const account = showAccount && accounts.length ? (accounts.length === 1 ? (accounts[0] ?? null) : `${accounts.length} accounts`) : null
  const canCopy = typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function'

  useEffect(() => {
    let alive = true
    void loadCardFonts().then(() => {
      if (!alive || !canvas.current) return
      drawPnlCard(canvas.current, card, account)
      setDrawn(true)
    })
    return () => {
      alive = false
    }
  }, [card, account])

  const png = () => new Promise<Blob | null>((resolve) => (canvas.current ? canvas.current.toBlob(resolve, 'image/png') : resolve(null)))

  const download = async () => {
    const blob = await png()
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `nearkit-pnl-${card.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const copyImage = async () => {
    try {
      const blob = await png()
      if (!blob) throw new Error('No image')
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      setCopy('copied')
    } catch {
      setCopy('failed')
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Share PnL card"
      description="An image of these figures. Partial figures say so on the card."
      footer={
        <>
          {canCopy && (
            <Button variant="ghost" icon={<Copy size={14} />} disabled={!drawn} onClick={() => void copyImage()}>
              {copy === 'copied' ? 'Copied' : copy === 'failed' ? 'Copy failed' : 'Copy image'}
            </Button>
          )}
          <Button variant="primary" icon={<Download size={14} />} disabled={!drawn} onClick={() => void download()}>
            Download PNG
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <canvas
          ref={canvas}
          role="img"
          aria-label={`PnL card${card.demo ? ' (demo data)' : ''}: ${card.title}, ${card.scope}, ${card.headline.label} ${card.headline.value}${card.partial ? `. ${card.partial}` : ''}`}
          className="aspect-[1200/630] h-auto w-full min-w-0 max-w-full rounded-sm border border-line-soft bg-canvas"
        />
        {accounts.length > 0 && (
          <Checkbox
            label={accounts.length === 1 ? `Show ${accounts[0]} on the card` : `Show the number of accounts on the card`}
            checked={showAccount}
            onChange={(e) => {
              setShowAccount(e.target.checked)
              setCopy('idle')
            }}
          />
        )}
      </div>
    </Modal>
  )
}
