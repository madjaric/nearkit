import { useIsComingSoon } from '@/lib/modeCopy'
import type { NavItem } from './nav'

/**
 * Not live for this user: always-soon entries, and the ones the public beta holds back (an automation
 * NEARKITS switched on for a signed-in user is live: useIsComingSoon).
 */
export function useIsSoon(): (item: NavItem) => boolean {
  const comingSoon = useIsComingSoon()
  return (item: NavItem) => item.soon === true || comingSoon(item.to)
}
