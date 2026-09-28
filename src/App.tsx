import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router'
import { ConfigError } from '@/components/page/ConfigError'
import { Toaster } from '@/components/ui/Toaster'
import { ENV_ISSUES } from '@/config/env'
import { router } from '@/router'
import { createServices } from '@/services'
import { ServicesProvider } from '@/services/ServicesProvider'
import { ConnectProvider } from '@/state/ConnectProvider'
import { SettingsProvider } from '@/state/SettingsProvider'
import { TradeDrawerProvider } from '@/state/TradeDrawerProvider'

// An invalid configuration stops here: no services, no network calls.
const services = ENV_ISSUES.length === 0 ? createServices() : null

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1 },
  },
})

export function App() {
  if (!services) return <ConfigError issues={ENV_ISSUES} />
  return (
    <ServicesProvider services={services}>
      <QueryClientProvider client={queryClient}>
        <SettingsProvider>
          <Toaster>
            <ConnectProvider>
              <TradeDrawerProvider>
                <RouterProvider router={router} />
              </TradeDrawerProvider>
            </ConnectProvider>
          </Toaster>
        </SettingsProvider>
      </QueryClientProvider>
    </ServicesProvider>
  )
}
