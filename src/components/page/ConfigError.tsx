import { Wordmark } from '@/components/brand/Brand'
import { Led } from '@/components/ui/Indicators'
import type { EnvIssue } from '@/config/env'

/**
 * Shown instead of the app when the build configuration is invalid. NearKit
 * never falls back silently: a wrong network, RPC or fee account must be fixed
 * by the operator before anything runs.
 */
export function ConfigError({ issues }: { issues: readonly EnvIssue[] }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-canvas px-4 py-10 text-fg">
      <div className="w-full max-w-[560px] rounded-md border border-line bg-panel">
        <header className="flex items-center justify-between gap-3 border-b border-line-soft px-5 py-4">
          <Wordmark />
          <span className="legend flex items-center gap-1.5 text-neg">
            <Led tone="neg" /> Configuration error
          </span>
        </header>
        <div className="flex flex-col gap-4 px-5 py-5">
          <p className="text-sm text-fg-2">NEARKITS stopped before loading because this build’s configuration is invalid. Nothing was read from or sent to any network.</p>
          <ul className="flex flex-col divide-y divide-line-soft rounded-sm border border-line" aria-label="Configuration problems">
            {issues.map((i) => (
              <li key={i.key} className="flex flex-col gap-0.5 px-3 py-2.5">
                <span className="num text-xs text-fg">{i.key}</span>
                <span className="text-sm text-fg-2">{i.message}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-fg-3">
            Fix the values in the environment (see <span className="num">.env.example</span>) and rebuild. Every variable is public; none of them is a secret.
          </p>
        </div>
      </div>
    </main>
  )
}
