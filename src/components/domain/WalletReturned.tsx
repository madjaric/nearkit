import type { WalletAccountDetail } from '@/types/domain'

/**
 * What the wallet returned for its accounts, as NearKit received it (src/lib/walletDetails.ts), for
 * when it isn't the account NearKit needs. Shown so the user can see it; never used to decide anything.
 */
export function WalletReturned({ details }: { details: readonly WalletAccountDetail[] | undefined }) {
  if (!details?.length) return null
  const text = details
    .map((d, i) => [`${details.length > 1 ? `${i + 1}. ` : ''}accountId: ${d.accountId ?? '(none)'}`, `publicKey: ${d.publicKey ?? '(none)'}`, ...d.extra].join('\n'))
    .join('\n\n')
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-[11px] text-fg-3 hover:text-fg-2">What your wallet returned</summary>
      <pre className="num mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-xs bg-well px-2 py-1.5 text-[11px] leading-4 text-fg-3">{text}</pre>
    </details>
  )
}
