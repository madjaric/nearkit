import { createContext, useContext } from 'react'
import type { NearKitServices } from './types'

export const ServicesContext = createContext<NearKitServices | null>(null)

export function useServices(): NearKitServices {
  const services = useContext(ServicesContext)
  if (!services) throw new Error('useServices must be used inside <ServicesProvider>')
  return services
}
