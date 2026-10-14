import { isNavAction, type NavAction, type NavGroup, type NavItem } from './nav'

/**
 * The All Tools directory's reading of a search: a tool shows when every word typed is found in
 * its name, what it does, its keywords or its group's name ("automation" lists the whole group),
 * and, with a group picked, only in that group. Groups left empty are dropped; order never changes.
 */

export type DirectoryEntry = NavItem | NavAction

export interface DirectoryGroup {
  label: string
  /** The group's address in the directory (?group=…). */
  slug: string
  items: DirectoryEntry[]
}

export const groupSlug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-')

/** The directory's groups, from the sidebar's (the same names, the same order). */
export function directoryGroups(groups: readonly NavGroup[]): DirectoryGroup[] {
  return groups.map((g) => ({ label: g.label, slug: groupSlug(g.label), items: g.items }))
}

const words = (query: string) =>
  query
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^\/+/, ''))
    .filter(Boolean)

const haystack = (entry: DirectoryEntry, group: string) => [entry.label, entry.description, group, ...(entry.keywords ?? [])].join(' ').toLowerCase()

export function filterDirectory(groups: readonly DirectoryGroup[], query: string, group: string | null): DirectoryGroup[] {
  const terms = words(query)
  return groups
    .filter((g) => group === null || g.slug === group)
    .map((g) => ({ ...g, items: g.items.filter((entry) => terms.every((t) => haystack(entry, g.label).includes(t))) }))
    .filter((g) => g.items.length > 0)
}

/** A stable key for a directory entry (a page by its address, an in-place action by its name). */
export const entryKey = (entry: DirectoryEntry) => (isNavAction(entry) ? `action:${entry.action}` : entry.to)
