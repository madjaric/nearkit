import { useState, type ReactNode } from 'react'
import { PageGrid } from '@/components/page/Page'
import type { StrategyKind } from '@/lib/automation/config'
import { AutomationNotice, PauseAllButton, StrategiesPanel, StrategyDetailPanel } from './parts'

/**
 * A server-backed automation page's body: NEARKITS' switch and limits, the form that creates one,
 * the user's list of that kind with its controls, and the detail of the one picked.
 */
export function LiveAutomation({ kind, title, form }: { kind: StrategyKind; title: string; form: (onCreated: (id: string) => void) => ReactNode }) {
  const [selected, setSelected] = useState<string | null>(null)
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-72">
          <AutomationNotice />
        </div>
        <PauseAllButton />
      </div>
      <PageGrid aside={form(setSelected)} asideWidth={400} asideFirst>
        <StrategiesPanel kind={kind} title={title} selected={selected} onSelect={setSelected} />
        {selected && <StrategyDetailPanel key={selected} id={selected} onClose={() => setSelected(null)} />}
      </PageGrid>
    </>
  )
}
