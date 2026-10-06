import { base64Decode } from '@/lib/encoding'
import { useServices } from '@/services/context'
import { useCapabilities } from '@/services/queries'
import { challengeProblem, type OwnerChallenge } from '@/services/recovery'

/**
 * The owner wallet signs one of NearKit's signer-written requests: the message is checked against
 * what was asked before the wallet signs (challengeProblem), and the signature is kept only if its
 * key is a full-access key of the owner (walletService.signMessage). The signer decides.
 */
type Signed = { accountId: string; publicKey: string; signature: string }

export function useOwnerSign() {
  const services = useServices()
  const caps = useCapabilities()
  return async (c: OwnerChallenge, want: Omit<Parameters<typeof challengeProblem>[1], 'network' | 'recipient' | 'kind'>): Promise<Signed> => {
    if (!caps.network) throw new Error('This NEARKITS build is not on a NEAR network.')
    const problem = await challengeProblem(c, { ...want, kind: c.kind, network: caps.network, recipient: window.location.hostname })
    if (problem) throw new Error(problem)
    const nonce = base64Decode(c.nonce)
    if (!nonce || nonce.length !== 32) throw new Error('This request is malformed. Start again.')
    return services.wallets.signMessage({ message: c.message, recipient: c.recipient, nonce, accountId: c.ownerAccount })
  }
}
