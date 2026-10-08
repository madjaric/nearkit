import { Link } from 'react-router'
import { useBridgeAvailability } from './useBridge'

/**
 * Under a $KITS buy that needs more NEAR than the wallet holds: the way in for someone holding
 * SOL, ETH or BNB instead. A link to Bridge & Buy, nothing more: no bridge starts until the user
 * reviews and confirms it there.
 */
export function NeedNear({ className }: { className?: string }) {
  if (!useBridgeAvailability().ok) return null
  return (
    <p className={className ?? 'text-xs text-fg-3'}>
      Need NEAR?{' '}
      <Link to="/bridge" className="font-semibold text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent">
        Bridge &amp; Buy $KITS
      </Link>{' '}
      from SOL, ETH or BNB.
    </p>
  )
}
