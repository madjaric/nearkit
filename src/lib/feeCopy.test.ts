import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { commandDoc } from '@/config/botCommands'
import { GLOSSARY } from './glossary'

/**
 * The NEARKITS fee is taken one of two ways: inside the swap by Rhea's aggregator (NEARKITS receives
 * 0.40%, Rhea keeps 0.10%), or, on a route straight to a DCL pool, as a separate transfer of the full
 * 0.50% to NEARKITS' fee account in the swap's own transaction. Copy that says it is always Rhea's, or
 * never a separate transfer, is wrong for DCL routes.
 */

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
/** The text between two markers of a source file. */
const between = (text: string, from: string, to: string) => {
  const start = text.indexOf(from)
  return start < 0 ? '' : text.slice(start, text.indexOf(to, start + from.length))
}
const ALWAYS_RHEA = /never (as )?a separate transfer|never as a transfer/i

describe('fee copy says how the fee is taken on each route', () => {
  it('the glossary: Rhea’s split inside its swap, the full fee as a transfer with a direct DCL swap', () => {
    const text = GLOSSARY.nearkitFee.text
    expect(text).toMatch(/Rhea’?'?s aggregator/)
    expect(text).toMatch(/DCL/)
    expect(text).toMatch(/transfer/)
    expect(text).not.toMatch(ALWAYS_RHEA)
  })

  it('the Docs page’s Fees section says both ways', () => {
    const fees = between(source('../pages/DocsPage.tsx'), '<Section id="fees"', '</Section>')
    expect(fees).not.toBe('')
    expect(fees).not.toMatch(ALWAYS_RHEA)
    expect(fees).toMatch(/DCL/)
    expect(fees).toMatch(/transfer/)
  })

  it('Settings’ Fees panel says both ways, Rhea’s split only for Rhea’s routes', () => {
    const panel = between(source('../pages/SettingsPage.tsx'), 'function FeesPanel', '\n}\n')
    expect(panel).not.toBe('')
    expect(panel).not.toMatch(ALWAYS_RHEA)
    expect(panel).toMatch(/DCL/)
  })

  it('DESIGN.md’s rule about the full 0.50% names the route it holds for', () => {
    const rule = source('../../DESIGN.md')
      .split('\n')
      .find((l) => /full 0\.50%/.test(l))
    expect(rule).toBeDefined()
    expect(rule).toMatch(/Rhea/)
    expect(rule).toMatch(/DCL/)
  })
})

describe('the bot’s commands, as documented', () => {
  it('/quote prices a buy first, and trades only once you confirm: it is the /buy flow, not quote-only', () => {
    const doc = commandDoc('quote').description
    expect(doc).not.toMatch(/without signing/)
    expect(doc).toMatch(/confirm/i)
    expect(doc).not.toMatch(/through Rhea/)
  })

  it('/balance shows the selected NEARKITS wallet, not a linked account', () => {
    expect(commandDoc('balance').description).not.toMatch(/linked account/)
    expect(commandDoc('balance').description).toMatch(/NEARKITS wallet/)
  })
})
