import { describe, expect, it } from 'vitest'
import { sendButtonName } from './sendName'

/**
 * A Send button's accessible name: it contains the button's visible text (WCAG 2.5.3, label in name),
 * and it always names the token, so a list of Send buttons (Positions) reads apart.
 */
describe('a Send button’s accessible name', () => {
  it('a label that already names the token is the name itself: “Send $KITS” is read as written', () => {
    expect(sendButtonName('Send $KITS', 'KITS')).toBe('Send $KITS')
    expect(sendButtonName('Send BLACKDRAGON', 'BLACKDRAGON')).toBe('Send BLACKDRAGON')
  })

  it('a bare “Send” (a row in Positions) gets the token after it: the visible word first, then which token', () => {
    expect(sendButtonName('Send', 'BLACKDRAGON')).toBe('Send BLACKDRAGON')
    expect(sendButtonName('Send', 'NEAR')).toBe('Send NEAR')
  })

  it('the token is found whatever its case in the label, never twice', () => {
    expect(sendButtonName('Send kits', 'KITS')).toBe('Send kits')
  })
})
