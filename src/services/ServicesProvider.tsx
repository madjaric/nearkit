import type { ReactNode } from 'react'
import { ServicesContext } from './context'
import type { NearKitServices } from './types'

export function ServicesProvider({ services, children }: { services: NearKitServices; children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>
}
