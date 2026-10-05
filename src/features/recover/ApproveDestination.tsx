import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Indicators'
import { ENV } from '@/config/env'
import { describeError } from '@/services/errors'
import { approveDestination, requestChallenge, type OwnerChallenge } from '@/services/recovery'
import { OwnerMessage, OwnerSignButton } from './ownerSign'
import { useOwnerSign } from './useOwnerSign'

/**
 * Approving a withdrawal destination from inside Send ("Approve & continue"): the request NearKit's
 * signer writes for Recover's approval, signed by the owner wallet under the same checks (the owner
 * account itself or a full-access key of it, the key that signed checked again; the signer decides),
 * then `onApproved`. Nothing is sent here: Send reviews the send again afterwards.
 */
export function ApproveDestinationStep({ wallet, destination, onApproved, onBack }: { wallet: string; destination: string; onApproved: () => void; onBack: () => void }) {
  const apiUrl = ENV.apiUrl
  const sign = useOwnerSign()
  const prepare = useMutation({ mutationFn: () => requestChallenge(apiUrl as string, { kind: 'approve-destination', accountId: wallet, destination }) })
  const approved = useMutation({
    mutationFn: async (c: OwnerChallenge) => {
      const signed = await sign(c, { wallet, destination })
      return approveDestination(apiUrl as string, { challengeId: c.id, publicKey: signed.publicKey, signature: signed.signature })
    },
    onSuccess: () => onApproved(),
  })
  // The request is written once, when this step opens (the user asked for it: "Approve & continue").
  const started = useRef(false)
  useEffect(() => {
    if (started.current || !apiUrl) return
    started.current = true
    prepare.mutate()
  }, [apiUrl, prepare])

  if (!apiUrl) return <p className="text-sm text-neg">This NearKit build has no NearKit server configured, so it can’t approve addresses.</p>
  const c = prepare.data
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-fg-2">{`Approve ${destination} for this NearKit wallet: its owner wallet signs the request below, once. Then NearKit reviews your send again.`}</p>
      {prepare.isError ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-neg">
            {describeError(prepare.error).message}
          </p>
          <Button variant="secondary" onClick={() => prepare.mutate()}>
            Try again
          </Button>
        </div>
      ) : c ? (
        <>
          <OwnerMessage text={c.message} />
          <OwnerSignButton owner={c.ownerAccount} wallet={wallet} label={`Sign to approve ${destination}`} pending={approved.isPending} onSign={() => approved.mutate(c)} />
        </>
      ) : (
        <Skeleton className="h-40 w-full" />
      )}
      {approved.isError && (
        <p role="alert" className="text-sm text-neg">
          {describeError(approved.error).message}
        </p>
      )}
      <div className="flex justify-end border-t border-line-soft pt-3">
        <Button variant="ghost" onClick={onBack} disabled={approved.isPending}>
          Back
        </Button>
      </div>
    </div>
  )
}
