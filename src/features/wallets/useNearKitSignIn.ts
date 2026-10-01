import { useEffect, useRef, useState } from 'react'
import { useToast } from '@/components/ui/toast-context'
import { describeError } from '@/services/errors'
import { readLoginCode } from '@/services/nearkitWeb'
import { useNearKitMutations } from '@/services/queries'

/** Reads the bot's `#login=` once: signs in, and takes the code out of the address bar at once. */
export function useNearKitSignIn() {
  const { login } = useNearKitMutations()
  const toast = useToast()
  const [code] = useState(() => (typeof window === 'undefined' ? null : readLoginCode(window.location.hash)))
  const used = useRef(false)
  useEffect(() => {
    if (!code || used.current) return
    used.current = true
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
    login.mutate(code, {
      onSuccess: (s) =>
        toast.push({
          tone: 'accent',
          title: `Signed in as ${s.userName}`,
          detail: 'Your NearKit wallets are listed here: buy, sell and send from them right on this page.',
        }),
      onError: (e) => toast.push({ tone: 'neg', title: 'Not signed in', detail: describeError(e).message }),
    })
  }, [code, login, toast])
  return { signingIn: login.isPending }
}
