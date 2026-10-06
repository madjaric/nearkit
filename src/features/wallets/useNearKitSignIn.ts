import { useEffect, useRef, useState } from 'react'
import { useToast } from '@/components/ui/toast-context'
import { describeError } from '@/services/errors'
import { readLoginCode, type NearKitWebSession } from '@/services/nearkitWeb'
import { useNearKitMutations, useNearKitSession } from '@/services/queries'

/**
 * Reads the bot's `#login=` once and takes the code out of the address bar at once. The link may
 * not be the user's own (anyone can send one): it is redeemed without signing this browser in,
 * and the user confirms whose Telegram account it opens before it replaces anything.
 */
export function useNearKitSignIn() {
  const { redeem, adopt, discard } = useNearKitMutations()
  const current = useNearKitSession()
  const toast = useToast()
  const [code] = useState(() => (typeof window === 'undefined' ? null : readLoginCode(window.location.hash)))
  const [pending, setPending] = useState<NearKitWebSession | null>(null)
  const used = useRef(false)
  useEffect(() => {
    if (!code || used.current) return
    used.current = true
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
    redeem.mutate(code, {
      onSuccess: setPending,
      onError: (e) => toast.push({ tone: 'neg', title: 'Not signed in', detail: describeError(e).message }),
    })
  }, [code, redeem, toast])

  const confirm = () => {
    if (!pending) return
    const s = pending
    adopt.mutate(s, {
      onSuccess: () => {
        setPending(null)
        toast.push({ tone: 'accent', title: `Signed in as ${s.userName}`, detail: 'Your NEARKITS wallets are listed here: buy, sell and send from them right on this page.' })
      },
      onError: (e) => toast.push({ tone: 'neg', title: 'Not signed in', detail: describeError(e).message }),
    })
  }
  const cancel = () => {
    if (!pending) return
    discard.mutate(pending)
    setPending(null)
  }
  return { signingIn: redeem.isPending || adopt.isPending, pending, current, confirm, cancel }
}
