/** Aria wiring for the panel that belongs to a <Tabs> strip. */
export function tabPanelProps(idBase: string, value: string) {
  return { id: `${idBase}-panel-${value}`, role: 'tabpanel' as const, 'aria-labelledby': `${idBase}-tab-${value}`, tabIndex: 0 }
}
