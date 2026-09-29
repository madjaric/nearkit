import { resolve } from 'node:path'
import { explorerTxUrl } from '@/services/near/explorer'
import { createRpcClient, RpcError, type RpcClient } from '@/services/near/rpc'
import { loadConfig } from '../config'
import { openDatabase } from '../db/open'
import { migrate } from '../db/schema'
import { loadEnvFile, loadSecretFiles } from '../env-file'
import { createTelegramApi } from '../telegram/api'
import { CustodyStore } from '../custody/store'
import { checkPayout } from './payout'
import { ReferralStore, type ClaimStatus } from './store'

/**
 * The owner's referral payouts, run with the app's configuration
 * (`npm run referrals -- <command>`). NearKit keeps no hot wallet: the owner pays each
 * claim from NearKit's own account (e.g. nearkitfee.near, after withdrawing fees from
 * Rhea's aggregator), then records the transaction here, which checks it on chain first.
 *
 *   summary                                  earned, paid, requested, available per token
 *   claims [requested|paid|rejected]         the claims (destination, amount, age)
 *   paid <claim> <tx hash> <payer account>   verify the payout on chain, mark it paid, tell the user
 *   reject <claim> <reason> [--forfeit]      refuse it: back to available, or forfeited (abuse)
 *
 * It prints amounts, accounts and hashes only; never a secret.
 */

export async function runReferralsAdmin(
  argv: string[],
  env: Record<string, string | undefined>,
  out: (line: string) => void,
  o: { fetch?: typeof fetch; rpc?: RpcClient; now?: () => number } = {},
): Promise<number> {
  const { config, issues } = loadConfig(env)
  if (issues.length) {
    for (const i of issues) out(`configuration problem: ${i.key}: ${i.message}`)
    return 2
  }
  const db = await openDatabase(config.database)
  try {
    await migrate(db)
    const rs = new ReferralStore(db, o.now)
    const network = config.network.id
    const rpc = o.rpc ?? createRpcClient({ urls: config.network.rpcUrls, fetch: o.fetch })
    const tell = async (userId: number, html: string) => {
      if (!config.telegramToken) return
      const tg = createTelegramApi({ token: config.telegramToken, fetch: o.fetch ?? globalThis.fetch.bind(globalThis), baseUrl: config.telegramApiUrl })
      await tg.sendMessage(userId, html).catch(() => out('(could not message the user in Telegram)'))
    }
    const [command, ...rest] = argv
    switch (command) {
      case 'summary': {
        const earnings = await rs.allEarnings(network)
        const claims = await rs.claims(network)
        const tokens = new Set([...earnings.map((e) => e.token), ...claims.map((c) => c.token)])
        for (const token of tokens) {
          const mine = earnings.filter((e) => e.token === token)
          const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n)
          const earned = sum(mine.filter((e) => e.forfeitedAt === null).map((e) => e.referral))
          const available = sum(mine.filter((e) => e.forfeitedAt === null && e.claimId === null).map((e) => e.referral))
          const paid = sum(claims.filter((c) => c.token === token && c.status === 'paid').map((c) => c.amount))
          const requested = sum(claims.filter((c) => c.token === token && c.status === 'requested').map((c) => c.amount))
          const net = sum(mine.map((e) => e.net))
          out(`${token}: earned ${earned} · paid ${paid} · requested ${requested} · available ${available} · NearKit net ${net} (raw units)`)
        }
        if (!tokens.size) out('no referral earnings yet')
        return 0
      }
      case 'claims': {
        const status = rest[0] as ClaimStatus | undefined
        if (status && !['requested', 'paid', 'rejected'].includes(status)) {
          out('usage: claims [requested|paid|rejected]')
          return 2
        }
        for (const c of await rs.claims(network, status))
          out(
            `${c.id} · ${c.status} · user ${c.referrerUserId} · ${c.amount} raw ${c.token} → ${c.destination} · ${new Date(c.requestedAt).toISOString()}${c.txHash ? ` · tx ${c.txHash}` : ''}`,
          )
        return 0
      }
      case 'paid': {
        const [id, hash, payer] = rest
        if (!id || !hash || !payer) {
          out('usage: paid <claim> <tx hash> <payer account>')
          return 2
        }
        const claim = await rs.claim(id)
        if (!claim || claim.network !== network) {
          out('no such claim on this network')
          return 1
        }
        if (claim.status !== 'requested') {
          out(`this claim is already ${claim.status}`)
          return 1
        }
        let result
        try {
          result = await rpc.txStatus(hash, payer, 'FINAL')
        } catch (e) {
          out(
            e instanceof RpcError && e.causeName === 'UNKNOWN_TRANSACTION'
              ? 'that transaction is not on chain (yet), or was not sent by that account'
              : 'could not ask NEAR; try again',
          )
          return 1
        }
        const check = checkPayout(result, claim, config.network.wrapContract)
        if (!check.ok) {
          out(`not marked paid: ${check.reason}`)
          return 1
        }
        if (!(await rs.markPaid(claim.id, hash))) {
          out('not marked paid: the claim changed meanwhile, or that transaction already paid another claim')
          return 1
        }
        out(`claim ${claim.id} marked paid`)
        await new CustodyStore(db).audit({ userId: claim.referrerUserId, action: 'referral-claim-paid', detail: { claim: claim.id, tx: hash, payer } })
        await tell(
          claim.referrerUserId,
          `💸 Your invite earnings were paid to <code>${claim.destination}</code>.\n<a href="${explorerTxUrl(config.network, hash)}">Transaction</a>`,
        )
        return 0
      }
      case 'reject': {
        const forfeit = rest.includes('--forfeit')
        const [id, ...words] = rest.filter((w) => w !== '--forfeit')
        const reason = words.join(' ').trim()
        if (!id || !reason) {
          out('usage: reject <claim> <reason> [--forfeit]')
          return 2
        }
        const claim = await rs.claim(id)
        if (!claim || !(await rs.reject(id, reason, forfeit))) {
          out('no open claim with that id')
          return 1
        }
        out(`claim ${id} rejected${forfeit ? '; its earnings are forfeited' : '; its earnings are available again'}`)
        await new CustodyStore(db).audit({ userId: claim.referrerUserId, action: 'referral-claim-rejected', detail: { claim: id, reason, forfeit } })
        await tell(
          claim.referrerUserId,
          forfeit
            ? '⚠️ A payout request of your invite earnings was refused.'
            : '⚠️ A payout request of your invite earnings was not paid; the earnings are available to claim again.',
        )
        return 0
      }
      default:
        out('usage: summary | claims [status] | paid <claim> <tx hash> <payer> | reject <claim> <reason> [--forfeit]')
        return 2
    }
  } finally {
    await db.close()
  }
}

// Run as a script (not when imported by tests).
if (process.argv[1] && /referrals-admin\.(js|ts)$/.test(process.argv[1])) {
  loadEnvFile(resolve(process.env.NEARKIT_ENV_FILE ?? 'server/.env.local'))
  loadSecretFiles()
  process.exitCode = await runReferralsAdmin(process.argv.slice(2), process.env, (line) => process.stdout.write(`${line}\n`))
}
