import { describe, expect, it } from 'vitest'
import { base58Encode } from '@/lib/encoding'
import { unsignedSolTransfer } from './solanaTx'

/**
 * Live, read only: Solana mainnet parses NEARKITS' SOL transfer. `simulateTransaction` with
 * signature checks off and the blockhash replaced runs it without sending anything; an unfunded
 * sender fails as AccountNotFound (the transaction parsed and ran), where bytes Solana can't read
 * fail before that as a JSON-RPC error.
 */

const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com'

describe('a SOL transfer on Solana mainnet (read only)', () => {
  it('parses and runs up to the missing balance of a random sender', async () => {
    const rnd = () => base58Encode(crypto.getRandomValues(new Uint8Array(32)))
    const tx = unsignedSolTransfer({ from: rnd(), to: rnd(), lamports: 1_000_000n, recentBlockhash: rnd() })
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'simulateTransaction',
        params: [Buffer.from(tx).toString('base64'), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true }],
      }),
    })
    const json = (await res.json()) as { error?: { message: string }; result?: { value: { err: unknown } } }
    expect(json.error).toBeUndefined()
    expect(json.result?.value.err).toBe('AccountNotFound')
  }, 30_000)
})
