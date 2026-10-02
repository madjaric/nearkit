/// <reference types="vite/client" />

/** Every build-time variable NearKit reads. `src/config/env.ts` is the only reader. */
interface ImportMetaEnv {
  readonly VITE_NEARKIT_SERVICES?: string
  readonly VITE_NEAR_NETWORK?: string
  readonly VITE_NEAR_RPC_URL?: string
  readonly VITE_ENABLE_MAINNET_EXECUTION?: string
  readonly VITE_NEARKIT_FEE_RECIPIENT?: string
  readonly VITE_KIT_TOKEN_CONTRACT?: string
  readonly VITE_NEARKIT_API_URL?: string
  readonly VITE_TELEGRAM_BOT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/**
 * True only in a `vite --mode e2e` build, where a scripted test wallet replaces
 * NEAR Connect. It is a compile-time constant, so normal builds drop the test
 * wallet entirely (asserted by scripts/e2e-real.mjs).
 */
declare const __NEARKIT_E2E__: boolean
/** The app's version from package.json, set by the Vite config. */
declare const __NEARKIT_VERSION__: string
