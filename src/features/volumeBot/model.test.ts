import { describe, expect, it } from 'vitest'
import type { BotMetricPoint } from '@/lib/volumeBot/api'
import { controlsFor, issuesByField, runPoints, statusLamp } from './model'

describe('the controls a bot offers', () => {
  it('follow its status: only what the server would accept', () => {
    expect(controlsFor('draft')).toEqual(['start', 'edit', 'delete'])
    expect(controlsFor('running')).toEqual(['pause', 'stop', 'emergency'])
    expect(controlsFor('paused')).toEqual(['resume', 'stop', 'emergency'])
    // Settling a stop: nothing to press until it has ended.
    expect(controlsFor('stopping')).toEqual([])
    expect(controlsFor('stopped')).toEqual(['start', 'edit', 'delete'])
    expect(controlsFor('completed')).toEqual(['start', 'edit', 'delete'])
  })
})

describe('the status lamp', () => {
  it('lights only a running bot; a guardian pause is a caution with its reason, an owner pause is idle', () => {
    expect(statusLamp({ status: 'running', pauseCode: null })).toEqual({ tone: 'on', label: 'Running' })
    expect(statusLamp({ status: 'paused', pauseCode: 'abnormal-price' })).toEqual({ tone: 'warn', label: 'Paused by the guardian' })
    expect(statusLamp({ status: 'paused', pauseCode: 'operator' })).toEqual({ tone: 'warn', label: 'Paused by NEARKITS' })
    expect(statusLamp({ status: 'paused', pauseCode: 'owner' })).toEqual({ tone: 'idle', label: 'Paused' })
    expect(statusLamp({ status: 'draft', pauseCode: null })).toEqual({ tone: 'off', label: 'Not started' })
    expect(statusLamp({ status: 'stopping', pauseCode: null })).toEqual({ tone: 'idle', label: 'Stopping' })
  })
})

describe('the run’s chart points', () => {
  const p = (at: number): BotMetricPoint => ({ at, priceNear: 1, equityNear: 1, pnlNear: 0, tokenPct: 50, volumeNear: 0, trades: 0 })
  it('are the current run’s only: an earlier run’s figures never join its line', () => {
    expect(runPoints([p(1), p(5), p(9)], 5).map((x) => x.at)).toEqual([5, 9])
    expect(runPoints([p(1), p(5)], null)).toEqual([])
  })
})

describe('configuration issues', () => {
  it('map to their fields, the first message per field', () => {
    expect(
      issuesByField([
        { field: 'risk.maxTradeNear', message: 'Enter an amount above zero' },
        { field: 'risk.maxTradeNear', message: 'second' },
        { field: 'walletIds', message: 'Choose at least one NEARKITS wallet' },
      ]),
    ).toEqual({ 'risk.maxTradeNear': 'Enter an amount above zero', walletIds: 'Choose at least one NEARKITS wallet' })
  })
})
