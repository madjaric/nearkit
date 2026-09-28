import type { ReactNode } from 'react'
import { splitFigures } from '@/lib/figures'

/**
 * Caption text with its figures in the data face and its words in the UI face:
 * "5 wallets · 10.00 NEAR total" sets "5" and "10.00 NEAR" in mono. Text comes
 * back as one span, so a flex parent's gap never lands between the runs. A bare
 * number renders whole in mono; any other node passes through untouched, so
 * callers composing their own spans keep control.
 */
export function Figures({ children }: { children: ReactNode }) {
  if (typeof children === 'number') return <span className="num">{children}</span>
  if (typeof children !== 'string') return <>{children}</>
  return (
    <span>
      {splitFigures(children).map((run, i) =>
        run.figure ? (
          <span key={i} className="num">
            {run.text}
          </span>
        ) : (
          run.text
        ),
      )}
    </span>
  )
}
