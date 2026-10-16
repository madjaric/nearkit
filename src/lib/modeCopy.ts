import { useLocation } from 'react-router'
import { discoverySoon, isComingSoonFor } from '@/config/release'
import { useAutomationEnabled, useCapabilities, useDiscoveryOn } from '@/services/queries'

/** The current page is COMING SOON in this build (the public beta), unless NEARKITS switched its automation on for this user. */
export function useComingSoonPage(): boolean {
  return useIsComingSoon()(useLocation().pathname)
}

/**
 * `isComingSoon` for this user: an automation route the server switched on is live; Launch Radar and
 * Top Wallets are live where NEARKITS' server runs them.
 */
export function useIsComingSoon(): (path: string) => boolean {
  const enabled = useAutomationEnabled()
  const discovery = useDiscoveryOn()
  return (path: string) => isComingSoonFor(path, enabled) || discoverySoon(path, discovery)
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
