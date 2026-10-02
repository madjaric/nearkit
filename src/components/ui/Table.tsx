import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'
import type { SortProps } from './useSort'

/**
 * Scrolls horizontally inside its panel instead of pushing the page wider.
 * Body rows are 36px. A table whose cells carry a second line (symbol over
 * name, amount over wallet) sets `rows="double"` for 44px rows, so the two
 * lines keep their breathing room and single-line tables stay dense.
 */
export function Table({
  children,
  label,
  className,
  minWidth,
  rows = 'single',
}: {
  children: ReactNode
  label: string
  className?: string
  minWidth?: number
  rows?: 'single' | 'double'
}) {
  return (
    <div className={cn('relative overflow-x-auto', className)}>
      <table aria-label={label} data-rows={rows} className="group/table w-full border-collapse text-sm" style={minWidth ? { minWidth } : undefined}>
        {children}
      </table>
    </div>
  )
}

interface ThProps extends ThHTMLAttributes<HTMLTableCellElement> {
  align?: 'left' | 'right' | 'center'
  sort?: SortProps
}

export function Th({ align = 'left', sort, className, children, ...rest }: ThProps) {
  const alignClass = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'
  return (
    <th
      scope="col"
      aria-sort={sort ? (sort.active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}
      className={cn('h-10 whitespace-nowrap border-b border-line px-3 font-normal first:pl-4 last:pr-4', alignClass, className)}
      {...rest}
    >
      {sort ? (
        <button
          type="button"
          onClick={sort.onSort}
          className={cn(
            'legend -mx-1 inline-flex items-center gap-1 rounded-xs px-1 py-0.5 transition-colors hover:text-fg-2',
            sort.active && 'text-fg-2',
            align === 'right' && 'flex-row-reverse',
          )}
        >
          {children}
          {sort.active ? (
            sort.dir === 'asc' ? (
              <ArrowUp size={11} aria-hidden="true" />
            ) : (
              <ArrowDown size={11} aria-hidden="true" />
            )
          ) : (
            <ArrowUpDown size={11} aria-hidden="true" className="text-fg-4" />
          )}
        </button>
      ) : (
        <span className="legend">{children}</span>
      )}
    </th>
  )
}

export function Tr({ className, children, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={cn('border-b border-line-soft transition-colors duration-100 last:border-b-0 hover:bg-raised/50', className)} {...rest}>
      {children}
    </tr>
  )
}

interface TdProps extends TdHTMLAttributes<HTMLTableCellElement> {
  align?: 'left' | 'right' | 'center'
  mono?: boolean
}

export function Td({ align = 'left', mono = false, className, children, ...rest }: TdProps) {
  return (
    <td
      className={cn(
        'h-11 whitespace-nowrap px-3 first:pl-4 last:pr-4 group-data-[rows=double]/table:h-14',
        align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left',
        mono && 'num',
        className,
      )}
      {...rest}
    >
      {children}
    </td>
  )
}
