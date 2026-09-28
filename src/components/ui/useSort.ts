import { useMemo, useState } from 'react'

export type SortDir = 'asc' | 'desc'

export interface SortProps {
  active: boolean
  dir: SortDir
  onSort: () => void
}

type Getter<T> = (row: T) => number | string

/** Client-side sorting with header affordances. Numbers default to descending, text to ascending. */
export function useSort<T, K extends string>(rows: T[], getters: Record<K, Getter<T>>, initial: { key: NoInfer<K>; dir: SortDir }) {
  const [sort, setSort] = useState(initial)
  const sorted = useMemo(() => {
    const get = getters[sort.key]
    const factor = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const x = get(a)
      const y = get(b)
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * factor
      return String(x).localeCompare(String(y)) * factor
    })
  }, [rows, getters, sort])

  const thSort = (key: K): SortProps => ({
    active: sort.key === key,
    dir: sort.dir,
    onSort: () =>
      setSort((current) => {
        if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
        const sample = rows[0]
        const numeric = sample !== undefined && typeof getters[key](sample) === 'number'
        return { key, dir: numeric ? 'desc' : 'asc' }
      }),
  })

  return { sorted, sort, setSort, thSort }
}
