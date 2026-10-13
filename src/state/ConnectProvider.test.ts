import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WalletCustodyNote } from './ConnectProvider'

/**
 * The line under the wallet list in "Connect a wallet": who holds what. A wallet the user
 * connects signs itself, and NEARKITS never holds it. NEARKITS wallets are custodial: NEARKITS'
 * signer holds their keys (DocsPage, llms.txt), and their owner can recover them. No blanket
 * "never holds your funds".
 */

const text = renderToStaticMarkup(createElement(WalletCustodyNote))
  .replace(/<[^>]+>/g, ' ')
  .replace(/&#x27;|&#39;/g, '’')
  .replace(/\s+/g, ' ')
  .trim()

describe('the connect window’s custody line', () => {
  it('a connected wallet: signed in that wallet, no seed phrase asked, its keys and funds never held by NEARKITS', () => {
    expect(text).toMatch(/A wallet you connect signs every transaction itself: NEARKITS never asks for a seed phrase, never sees its keys and never holds its funds\./)
  })

  it('NEARKITS wallets: custodial, their keys held by NEARKITS’ signer, recoverable by their owner', () => {
    expect(text).toMatch(/NEARKITS wallets are custodial: NEARKITS’ signer holds their keys, and their owner can recover them\./)
  })

  it('makes no blanket claim that NEARKITS never holds funds, and stays short', () => {
    expect(text).not.toMatch(/never holds your funds/)
    expect(text.split(/\.\s/).length).toBeLessThanOrEqual(3)
  })
})
