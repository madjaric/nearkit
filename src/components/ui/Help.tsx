import { Info } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { GLOSSARY, type GlossaryKey } from '@/lib/glossary'
import { Tip, type Placement } from './Floating'

/** Small info key that explains a term. */
export function InfoTip({ term, children, placement = 'top', className }: { term?: GlossaryKey; children?: ReactNode; placement?: Placement; className?: string }) {
  const entry = term ? GLOSSARY[term] : null
  const content = children ?? entry?.text
  return (
    <Tip content={content} placement={placement}>
      <button
        type="button"
        aria-label={entry ? `What is ${entry.term.toLowerCase()}?` : 'More information'}
        className={cn('inline-grid size-4 place-items-center rounded-xs text-fg-4 transition-colors hover:text-fg-2 focus-visible:text-fg-2', className)}
      >
        <Info size={12} strokeWidth={2} aria-hidden="true" />
      </button>
    </Tip>
  )
}

/** Inline term with a dotted underline; hover or focus shows the glossary definition. */
export function Term({ term, children }: { term: GlossaryKey; children?: ReactNode }) {
  return (
    <Tip content={GLOSSARY[term].text} focusable className="cursor-help underline decoration-fg-4 decoration-dotted underline-offset-[3px]">
      {children ?? GLOSSARY[term].term}
    </Tip>
  )
}
