import { useLocation } from 'react-router'
import { isComingSoon } from '@/config/release'
import { useCapabilities } from '@/services/queries'

/** The current page is COMING SOON in this build (the public testnet beta). */
export function useComingSoonPage(): boolean {
  return isComingSoon(useLocation().pathname)
}

/**
 * The network's name as the network chip and the sidebar status line print it.
 * Real services on testnet are the public testnet beta, and both say so.
 */
export function useNetworkWording() {
  const caps = useCapabilities()
  const beta = caps.mode === 'near' && caps.network === 'testnet'
  const tag = beta ? `${caps.networkLabel} beta` : caps.networkLabel
  return {
    beta,
    /** Network tag text, e.g. "Testnet beta" (set uppercase by the tag). */
    tag,
    /** The same in running text, e.g. "testnet beta". */
    name: tag.toLowerCase(),
  }
}

/**
 * Wording for automation rules and orders, which nothing executes yet: they are
 * "standby" in the demo and drafts saved in this browser in real mode.
 */
export function useRuleWording() {
  const { mode } = useCapabilities()
  const demo = mode === 'demo'
  return {
    demo,
    /** Toast detail after saving, e.g. "Saved as a draft in this browser." */
    saved: demo ? 'In standby.' : 'Saved as a draft in this browser.',
    /** Page status tag. */
    tag: demo ? 'Standby only' : 'Drafts only',
  }
}
