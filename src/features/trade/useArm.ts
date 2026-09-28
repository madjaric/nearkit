import { useEffect, useState } from 'react'

export const ARM_MS = 4000

/**
 * Two-step fire: the first press arms, the second confirms. An armed key
 * disarms on its own after ARM_MS, on Escape, or when `disarm()` is called
 * because an input changed.
 */
export function useArm() {
  const [armedAt, setArmedAt] = useState<number | null>(null)
  const armed = armedAt !== null

  useEffect(() => {
    if (!armed) return
    const t = window.setTimeout(() => setArmedAt(null), ARM_MS)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setArmedAt(null)
    document.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(t)
      document.removeEventListener('keydown', onKey)
    }
  }, [armed])

  return {
    armed,
    armedAt,
    arm: () => setArmedAt(Date.now()),
    disarm: () => setArmedAt(null),
  }
}
