import { describe, expect, it } from 'vitest'
import { NETWORKS } from '@/config/networks'
import { dclPoolId } from '@/services/dcl/pools'
import { dclSwapMsg } from '@/services/dcl/swap'
import { classicSwapMsg, parseFindPath } from '@/services/rhea/classic'
import { buildSwapTransactions } from '@/services/rhea/swapTransactions'
import { checkPlan, PolicyViolation, type SwapRouteFacts, type WalletOperation, type WalletTxPlan } from './policy'

const net = NETWORKS.testnet
const WALLET = { accountId: 'a'.repeat(64), publicKey: 'ed25519:Anu7LYDfpLtkP7E16LT9imXF694BdQaa9ufVkQiwTQxC', network: 'testnet' }
const LINKED_KEY = 'ed25519:8hSHprDq2StXwMtNd43wDTXQYsjXcD4MJTXQYsjXcc5T'
const USDT = 'usdt.itachicara.testnet'
const EXCHANGE = net.rhea.classic.exchange
const REG = 1_250_000_000_000_000_000_000n
const ONE = 10n ** 24n

function route(tokenIn: string, tokenOut: string, amountIn: bigint, nativeOut: boolean): SwapRouteFacts {
  const r = parseFindPath(
    {
      result_code: 0,
      result_data: {
        amount_out: '1000000',
        routes: [{ amount_in: amountIn.toString(), pools: [{ pool_id: '17', token_in: tokenIn, token_out: tokenOut, min_amount_out: '990000' }] }],
      },
    },
    { tokenIn, tokenOut, amountIn, slippage: 0.01 },
  )
  return {
    router: 'classic',
    routeIn: tokenIn,
    routeOut: tokenOut,
    nativeIn: tokenIn === net.wrapContract,
    nativeOut,
    amountIn,
    receiver: EXCHANGE,
    msg: classicSwapMsg(r, { unwrapNear: nativeOut }),
    routeTokens: r.routeTokens,
    minOut: r.minAmountOut,
  }
}

function swapPlan(r: SwapRouteFacts, register = true): WalletTxPlan[] {
  return buildSwapTransactions({
    signerId: WALLET.accountId,
    wrap: r.nativeIn ? { contract: net.wrapContract, amount: r.amountIn, registerDeposit: register ? REG : null } : null,
    registrations: register && !r.nativeOut ? [{ contract: r.routeOut, accountId: WALLET.accountId, deposit: REG }] : [],
    aggregatorDeposits: null,
    swap: { tokenContract: r.routeIn, receiverId: r.receiver, amount: r.amountIn, msg: r.msg },
    label: 'swap',
  }).map((t) => ({ receiverId: t.receiverId, actions: t.actions, label: t.label }))
}

const BUY = route(net.wrapContract, USDT, ONE / 10n, false)
const SELL = route(USDT, net.wrapContract, 400_000n, true)
const buyOp: WalletOperation = { kind: 'swap', route: BUY, authorizedMinOut: BUY.minOut }
const sellOp: WalletOperation = { kind: 'swap', route: SELL, authorizedMinOut: SELL.minOut }

const refused = (op: WalletOperation, plan: WalletTxPlan[], wallet = WALLET, network = net) => {
  try {
    checkPlan(op, plan, wallet, network)
  } catch (e) {
    expect(e).toBeInstanceOf(PolicyViolation)
    return (e as Error).message
  }
  throw new Error('expected the policy to refuse')
}

/** A deep copy of a plan with one change applied. */
const tweak = (plan: WalletTxPlan[], change: (p: WalletTxPlan[]) => void) => {
  const copy = JSON.parse(JSON.stringify(plan)) as WalletTxPlan[]
  change(copy)
  return copy
}

describe('signer policy: swaps', () => {
  it('accepts exactly the planned buy (registrations, wrap, swap) and sell', () => {
    expect(() => checkPlan(buyOp, swapPlan(BUY), WALLET, net)).not.toThrow()
    expect(() => checkPlan(buyOp, swapPlan(BUY, false), WALLET, net)).not.toThrow()
    expect(() => checkPlan(sellOp, swapPlan(SELL), WALLET, net)).not.toThrow()
  })

  it('refuses an arbitrary receiver, method, deposit or extra action', () => {
    const plan = swapPlan(BUY)
    expect(
      refused(
        buyOp,
        tweak(plan, (p) => ((p[1] as WalletTxPlan).receiverId = 'evil.testnet')),
      ),
    ).toMatch(/different token contract/)
    expect(
      refused(
        buyOp,
        tweak(plan, (p) => (((p[1] as WalletTxPlan).actions.at(-1) as { method: string }).method = 'ft_transfer')),
      ),
    ).toMatch(/unexpected method/)
    expect(
      refused(
        buyOp,
        tweak(plan, (p) => (((p[1] as WalletTxPlan).actions.at(-2) as { deposit: string }).deposit = (ONE / 10n + 1n).toString())),
      ),
    ).toMatch(/unexpected deposit/)
    expect(
      refused(
        buyOp,
        tweak(plan, (p) => (p[1] as WalletTxPlan).actions.unshift({ kind: 'transfer', deposit: '1' })),
      ),
    ).toMatch(/unexpected actions|registration/)
    expect(refused(buyOp, [...plan, { receiverId: 'evil.testnet', actions: [{ kind: 'transfer', deposit: ONE.toString() }], label: 'x' }])).toMatch(/different token contract/)
    expect(
      refused(
        buyOp,
        tweak(plan, (p) => (((p[1] as WalletTxPlan).actions.at(-1) as { args: Record<string, unknown> }).args.receiver_id = 'evil.testnet')),
      ),
    ).toMatch(/different arguments/)
    // Selling more than confirmed: the token amount handed to the exchange is exact.
    expect(
      refused(
        sellOp,
        tweak(swapPlan(SELL), (p) => (((p.at(-1) as WalletTxPlan).actions.at(-1) as { args: Record<string, unknown> }).args.amount = '800000')),
      ),
    ).toMatch(/different arguments/)
  })

  it('refuses a route that changed after it was verified, or promises less than you confirmed', () => {
    const lowered = { ...BUY, msg: BUY.msg.replace('"990000"', '"1"') }
    expect(refused({ kind: 'swap', route: lowered, authorizedMinOut: BUY.minOut }, swapPlan(lowered))).toMatch(/minimum differs/)
    expect(refused({ kind: 'swap', route: BUY, authorizedMinOut: BUY.minOut + 1n }, swapPlan(BUY))).toMatch(/below the minimum you confirmed/)
    const extra = { ...BUY, msg: JSON.stringify({ ...JSON.parse(BUY.msg), referral_id: 'evil.testnet' }) }
    expect(refused({ kind: 'swap', route: extra, authorizedMinOut: BUY.minOut }, swapPlan(extra))).toMatch(/unexpected field referral_id/)
    const wnear = { ...SELL, msg: JSON.stringify({ actions: JSON.parse(SELL.msg).actions }) }
    expect(refused({ kind: 'swap', route: wnear, authorizedMinOut: SELL.minOut }, swapPlan(wnear))).toMatch(/wNEAR instead of NEAR/)
    const other = { ...BUY, receiver: 'evil.testnet' }
    expect(refused({ kind: 'swap', route: other, authorizedMinOut: BUY.minOut }, swapPlan(other))).toMatch(/not Rhea’s exchange/)
    expect(refused({ kind: 'swap', route: { ...BUY, router: 'aggregator' }, authorizedMinOut: BUY.minOut }, swapPlan(BUY))).toMatch(/classic router/)
  })

  it('registers only the wallet itself, on the route’s tokens, within the cap', () => {
    const plan = swapPlan(BUY)
    const reg = (p: WalletTxPlan[]) => (p[0] as WalletTxPlan).actions[0] as { args: Record<string, unknown>; deposit: string }
    expect(
      refused(
        buyOp,
        tweak(plan, (p) => (reg(p).args.account_id = 'evil.testnet')),
      ),
    ).toMatch(/unexpected account/)
    expect(
      refused(
        buyOp,
        tweak(plan, (p) => (reg(p).deposit = (2n * 10n ** 23n).toString())),
      ),
    ).toMatch(/outside NEARKITS’ limit/)
    expect(
      refused(
        buyOp,
        tweak(plan, (p) => ((p[0] as WalletTxPlan).receiverId = 'other-token.testnet')),
      ),
    ).toMatch(/outside the route/)
  })

  it('refuses the wrong network, and Rhea’s classic exchange on mainnet (swaps there carry NEARKITS’ fee through the aggregator)', () => {
    expect(refused(buyOp, swapPlan(BUY), { ...WALLET, network: 'mainnet' })).toMatch(/wallet is on mainnet/)
    expect(refused(buyOp, swapPlan(BUY), { ...WALLET, network: 'mainnet' }, NETWORKS.mainnet)).toMatch(/aggregator|fee account/)
  })
})

describe('signer policy: withdrawals, backup key, revoke', () => {
  const near = (to: string, amount = ONE): WalletTxPlan[] => [{ receiverId: to, actions: [{ kind: 'transfer', deposit: amount.toString() }], label: 'w' }]
  const token = (to: string, amount: bigint, registration: bigint | null): WalletTxPlan[] => [
    {
      receiverId: USDT,
      actions: [
        ...(registration !== null
          ? [{ kind: 'call' as const, method: 'storage_deposit', args: { account_id: to, registration_only: true }, gas: '10000000000000', deposit: registration.toString() }]
          : []),
        { kind: 'call' as const, method: 'ft_transfer', args: { receiver_id: to, amount: amount.toString() }, gas: '10000000000000', deposit: '1' },
      ],
      label: 'w',
    },
  ]

  it('withdraws NEAR to any valid address on this network, exactly as confirmed', () => {
    expect(() => checkPlan({ kind: 'withdraw-near', to: 'bob.testnet', amount: ONE }, near('bob.testnet'), WALLET, net)).not.toThrow()
    expect(() => checkPlan({ kind: 'withdraw-near', to: 'b'.repeat(64), amount: ONE }, near('b'.repeat(64)), WALLET, net)).not.toThrow()
    expect(refused({ kind: 'withdraw-near', to: 'bob.testnet', amount: ONE }, near('evil.testnet'))).toMatch(/one transfer to the destination/)
    expect(refused({ kind: 'withdraw-near', to: 'bob.testnet', amount: ONE }, near('bob.testnet', ONE + 1n))).toMatch(/confirmed amount/)
    expect(refused({ kind: 'withdraw-near', to: 'bob.near', amount: ONE }, near('bob.near'))).toMatch(/other network/)
    expect(refused({ kind: 'withdraw-near', to: WALLET.accountId, amount: ONE }, near(WALLET.accountId))).toMatch(/wallet itself/)
    expect(refused({ kind: 'withdraw-near', to: 'Bob!', amount: ONE }, near('bob.testnet'))).toMatch(/not a valid NEAR account/)
    expect(refused({ kind: 'withdraw-near', to: 'bob.testnet', amount: ONE }, [...near('bob.testnet'), ...near('bob.testnet')])).toMatch(/one transfer/)
  })

  it('withdraws tokens with or without registering the destination, and nothing more', () => {
    expect(() => checkPlan({ kind: 'withdraw-token', token: USDT, to: 'bob.testnet', amount: 5n, registration: null }, token('bob.testnet', 5n, null), WALLET, net)).not.toThrow()
    expect(() => checkPlan({ kind: 'withdraw-token', token: USDT, to: 'bob.testnet', amount: 5n, registration: REG }, token('bob.testnet', 5n, REG), WALLET, net)).not.toThrow()
    expect(refused({ kind: 'withdraw-token', token: USDT, to: USDT, amount: 5n, registration: null }, token(USDT, 5n, null))).toMatch(/own contract are lost/)
    expect(refused({ kind: 'withdraw-token', token: USDT, to: 'bob.testnet', amount: 5n, registration: null }, token('bob.testnet', 6n, null))).toMatch(/different arguments/)
    expect(refused({ kind: 'withdraw-token', token: USDT, to: 'bob.testnet', amount: 5n, registration: null }, token('bob.testnet', 5n, REG))).toMatch(/unexpected actions/)
    expect(refused({ kind: 'withdraw-token', token: USDT, to: 'bob.testnet', amount: 5n, registration: REG }, token('bob.testnet', 5n, REG + 1n))).toMatch(
      /differs from the one shown/,
    )
    const memo = tweak(token('bob.testnet', 5n, null), (p) => (((p[0] as WalletTxPlan).actions[0] as { args: Record<string, unknown> }).args.memo = 'x'))
    expect(refused({ kind: 'withdraw-token', token: USDT, to: 'bob.testnet', amount: 5n, registration: null }, memo)).toMatch(/different arguments/)
  })

  it('a token withdrawal can’t switch token, method or deposit, or carry a NEAR transfer along', () => {
    const op: WalletOperation = { kind: 'withdraw-token', token: USDT, to: 'bob.testnet', amount: 5n, registration: null }
    const plan = token('bob.testnet', 5n, null)
    const call = (p: WalletTxPlan[]) => (p[0] as WalletTxPlan).actions[0] as { method: string; deposit: string }
    expect(
      refused(
        op,
        tweak(plan, (p) => ((p[0] as WalletTxPlan).receiverId = net.wrapContract)),
      ),
    ).toMatch(/one transaction to the token contract/)
    expect(
      refused(
        op,
        tweak(plan, (p) => (call(p).method = 'ft_transfer_call')),
      ),
    ).toMatch(/unexpected method/)
    expect(
      refused(
        op,
        tweak(plan, (p) => (call(p).deposit = ONE.toString())),
      ),
    ).toMatch(/unexpected deposit/)
    expect(
      refused(
        op,
        tweak(plan, (p) => (p[0] as WalletTxPlan).actions.push({ kind: 'transfer', deposit: ONE.toString() })),
      ),
    ).toMatch(/expected a call to ft_transfer/)
    expect(refused(op, [...plan, ...near('evil.testnet')])).toMatch(/one transaction to the token contract/)
  })

  it('unwraps exactly the confirmed amount, as one call to the wrap contract', () => {
    const op: WalletOperation = { kind: 'unwrap', amount: ONE }
    const unwrap = (amount: bigint, receiver: string = net.wrapContract): WalletTxPlan[] => [
      { receiverId: receiver, actions: [{ kind: 'call', method: 'near_withdraw', args: { amount: amount.toString() }, gas: '30000000000000', deposit: '1' }], label: 'u' },
    ]
    const call = (p: WalletTxPlan[]) => (p[0] as WalletTxPlan).actions[0] as { method: string; deposit: string; gas: string }
    expect(() => checkPlan(op, unwrap(ONE), WALLET, net)).not.toThrow()
    expect(refused(op, unwrap(2n * ONE))).toMatch(/different arguments/)
    expect(refused(op, unwrap(ONE, USDT))).toMatch(/one call to the wrap contract/)
    expect(
      refused(
        op,
        tweak(unwrap(ONE), (p) => (call(p).method = 'ft_transfer')),
      ),
    ).toMatch(/unexpected method/)
    expect(
      refused(
        op,
        tweak(unwrap(ONE), (p) => (call(p).deposit = ONE.toString())),
      ),
    ).toMatch(/unexpected deposit/)
    expect(
      refused(
        op,
        tweak(unwrap(ONE), (p) => (call(p).gas = '300000000000000')),
      ),
    ).toMatch(/unexpected gas/)
    expect(
      refused(
        op,
        tweak(unwrap(ONE), (p) => (p[0] as WalletTxPlan).actions.push({ kind: 'transfer', deposit: '1' })),
      ),
    ).toMatch(/one call to the wrap contract/)
    expect(refused(op, [...unwrap(ONE), ...near('evil.testnet')])).toMatch(/one call to the wrap contract/)
  })

  it('adds only your linked wallet’s key as the backup key, and revokes only NEARKITS’ own key', () => {
    const add = (key: string, receiver = WALLET.accountId): WalletTxPlan[] => [{ receiverId: receiver, actions: [{ kind: 'add-key', publicKey: key }], label: 'b' }]
    expect(() => checkPlan({ kind: 'add-backup-key', publicKey: LINKED_KEY }, add(LINKED_KEY), WALLET, net)).not.toThrow()
    expect(refused({ kind: 'add-backup-key', publicKey: LINKED_KEY }, add(WALLET.publicKey))).toMatch(/differs from your linked wallet’s key/)
    expect(refused({ kind: 'add-backup-key', publicKey: WALLET.publicKey }, add(WALLET.publicKey))).toMatch(/NEARKITS’ own key/)
    expect(refused({ kind: 'add-backup-key', publicKey: LINKED_KEY }, add(LINKED_KEY, 'bob.testnet'))).toMatch(/to itself/)
    const del = (key: string): WalletTxPlan[] => [{ receiverId: WALLET.accountId, actions: [{ kind: 'delete-key', publicKey: key }], label: 'r' }]
    expect(() => checkPlan({ kind: 'revoke', publicKey: WALLET.publicKey }, del(WALLET.publicKey), WALLET, net)).not.toThrow()
    expect(refused({ kind: 'revoke', publicKey: LINKED_KEY }, del(LINKED_KEY))).toMatch(/only NEARKITS’ own key/)
    expect(refused({ kind: 'revoke', publicKey: WALLET.publicKey }, del(LINKED_KEY))).toMatch(/only NEARKITS’ own key/)
  })
})

describe('signer policy: direct DCL swaps', () => {
  const main = NETWORKS.mainnet
  const DCL = main.dex.dcl.contract
  const WRAP = main.wrapContract
  const SING = 'singularty.nearlytrade.near'
  const FEES = 'nearkitfee.near'
  const mainWallet = { ...WALLET, network: 'mainnet' }
  const pools = [dclPoolId(SING, WRAP, 10000)]

  /** A verified direct route: NEAR → SINGULARTY (buy) or SINGULARTY → NEAR (sell), fee off the input. */
  function direct(side: 'buy' | 'sell', amountIn: bigint, network = main, over: Partial<SwapRouteFacts> = {}): SwapRouteFacts {
    const fee = network.id === 'mainnet' ? (amountIn * 50n) / 10_000n : 0n
    const routeIn = side === 'buy' ? WRAP : SING
    const routeOut = side === 'buy' ? SING : WRAP
    const minOut = side === 'buy' ? 17_000n * ONE : (99n * ONE) / 200n
    return {
      router: 'dcl',
      routeIn,
      routeOut,
      nativeIn: side === 'buy',
      nativeOut: side === 'sell',
      amountIn,
      receiver: DCL,
      msg: dclSwapMsg({ pools, outputToken: routeOut, minOut, skipUnwrapNear: false }),
      routeTokens: [routeIn, routeOut],
      minOut,
      pools,
      direct: { swapAmount: amountIn - fee, fee, feeRecipient: network.id === 'mainnet' ? FEES : null },
      ...over,
    }
  }
  const plan = (r: SwapRouteFacts, registrations: { contract: string; accountId: string }[] = []): WalletTxPlan[] =>
    buildSwapTransactions({
      signerId: WALLET.accountId,
      wrap: r.nativeIn ? { contract: WRAP, amount: r.amountIn, registerDeposit: null } : null,
      registrations: registrations.map((x) => ({ ...x, deposit: REG })),
      aggregatorDeposits: null,
      swap: { tokenContract: r.routeIn, receiverId: r.receiver, amount: r.direct?.swapAmount ?? r.amountIn, msg: r.msg },
      feeTransfer: r.direct && r.direct.feeRecipient ? { recipient: r.direct.feeRecipient, amount: r.direct.fee } : null,
      label: 'swap',
    }).map((t) => ({ receiverId: t.receiverId, actions: t.actions, label: t.label }))
  const op = (r: SwapRouteFacts): WalletOperation => ({ kind: 'swap', route: r, authorizedMinOut: r.minOut })
  const refusedWith = (r: SwapRouteFacts, p: WalletTxPlan[], re: RegExp, network = main, fee: string | null = FEES) => {
    expect(() => checkPlan(op(r), p, { ...WALLET, network: network.id }, network, fee)).toThrow(re)
  }

  it('accepts exactly: the wrap, the fee transfer to NEARKITS’ account and the swap call with the rest, and registrations of the wallet or the fee account on route tokens', () => {
    const buy = direct('buy', ONE)
    expect(() => checkPlan(op(buy), plan(buy), mainWallet, main, FEES)).not.toThrow()
    expect(() => checkPlan(op(buy), plan(buy, [{ contract: SING, accountId: WALLET.accountId }]), mainWallet, main, FEES)).not.toThrow()
    const sell = direct('sell', 9000n * ONE)
    expect(() => checkPlan(op(sell), plan(sell, [{ contract: SING, accountId: FEES }]), mainWallet, main, FEES)).not.toThrow()
    expect(plan(sell, [{ contract: SING, accountId: FEES }])[0]?.actions.map((a) => (a.kind === 'call' ? a.method : a.kind))).toEqual([
      'storage_deposit',
      'ft_transfer',
      'ft_transfer_call',
    ])
  })

  it('refuses a fee to anyone else, a different fee, no fee, or an exchange amount that is not the rest', () => {
    const buy = direct('buy', ONE)
    const fee = buy.direct as NonNullable<SwapRouteFacts['direct']>
    const to = (over: Partial<NonNullable<SwapRouteFacts['direct']>>) => direct('buy', ONE, main, { direct: { ...fee, ...over } })
    // Route facts that disagree with NearKit's rate or account are refused whatever the plan says.
    refusedWith(to({ feeRecipient: 'mallory.near' }), plan(buy), /not NEARKITS’ fee account/)
    refusedWith(to({ fee: fee.fee - 1n, swapAmount: fee.swapAmount + 1n }), plan(buy), /fee rate/)
    refusedWith(to({ fee: 0n, feeRecipient: null, swapAmount: ONE }), plan(buy), /fee/)
    refusedWith(to({ swapAmount: fee.swapAmount + 1n }), plan(buy), /amount less the fee/)
    // A plan whose transfer goes elsewhere than the route says is refused too.
    const elsewhere = plan(to({ feeRecipient: 'mallory.near' }))
    refusedWith(buy, elsewhere, /different arguments/)
    // The plan's transfer must match the route's fee exactly.
    const p = plan(buy)
    const tx = p[0] as WalletTxPlan
    const a = tx.actions[1] as Extract<WalletTxPlan['actions'][number], { kind: 'call' }>
    refusedWith(
      buy,
      [
        {
          ...tx,
          actions: [tx.actions[0] as WalletTxPlan['actions'][number], { ...a, args: { ...a.args, receiver_id: 'mallory.near' } }, tx.actions[2] as WalletTxPlan['actions'][number]],
        },
      ],
      /different arguments/,
    )
    expect(() => checkPlan(op(buy), plan(buy), mainWallet, main, null)).toThrow(/no NEARKITS fee account/)
  })

  it('refuses pools that do not connect, another exchange, a message that is not the verified one, or a lower minimum than confirmed', () => {
    const buy = direct('buy', ONE)
    const badPools = direct('buy', ONE, main, { pools: [dclPoolId('usdt.tether-token.near', WRAP, 400)] })
    refusedWith(badPools, plan(badPools), /do not connect/)
    const elsewhere = direct('buy', ONE, main, { receiver: 'v2.ref-finance.near' })
    refusedWith(elsewhere, plan(elsewhere), /not the DCL exchange/)
    const altered = direct('buy', ONE, main, { msg: dclSwapMsg({ pools, outputToken: SING, minOut: 1n, skipUnwrapNear: false }) })
    refusedWith(altered, plan(altered), /differs from the verified route/)
    expect(() => checkPlan({ kind: 'swap', route: buy, authorizedMinOut: buy.minOut + 1n }, plan(buy), mainWallet, main, FEES)).toThrow(/below the minimum you confirmed/)
    const extra = plan(buy)
    ;(extra[0] as WalletTxPlan).actions.push({ kind: 'transfer', deposit: '1' })
    expect(() => checkPlan(op(buy), extra, mainWallet, main, FEES)).toThrow(PolicyViolation)
  })

  it('accepts a message minimum above the user’s minimum (the token’s own tax comes off after the pool pays), never below', () => {
    const buy = direct('buy', ONE)
    const poolMin = (buy.minOut * 100n) / 99n
    const taxed: SwapRouteFacts = { ...buy, signedMin: poolMin, msg: dclSwapMsg({ pools, outputToken: SING, minOut: poolMin, skipUnwrapNear: false }) }
    expect(() => checkPlan(op(taxed), plan(taxed), mainWallet, main, FEES)).not.toThrow()
    // The message must carry the message minimum, not the user's.
    refusedWith({ ...taxed, msg: buy.msg }, plan(buy), /differs from the verified route/)
    // A message minimum below the user's minimum would deliver less than confirmed.
    const below: SwapRouteFacts = { ...buy, signedMin: buy.minOut - 1n, msg: dclSwapMsg({ pools, outputToken: SING, minOut: buy.minOut - 1n, skipUnwrapNear: false }) }
    refusedWith(below, plan(below), /above what its message enforces/)
  })

  it('on testnet a direct route carries no fee, and a fee there is refused', () => {
    const net = NETWORKS.testnet
    const T = 'fresh.nearlytrade.testnet'
    const testPools = [dclPoolId(T, net.wrapContract, 10000)]
    const r: SwapRouteFacts = {
      router: 'dcl',
      routeIn: net.wrapContract,
      routeOut: T,
      nativeIn: true,
      nativeOut: false,
      amountIn: ONE,
      receiver: net.dex.dcl.contract,
      msg: dclSwapMsg({ pools: testPools, outputToken: T, minOut: 49n * ONE, skipUnwrapNear: false }),
      routeTokens: [net.wrapContract, T],
      minOut: 49n * ONE,
      pools: testPools,
      direct: { swapAmount: ONE, fee: 0n, feeRecipient: null },
    }
    const p = buildSwapTransactions({
      signerId: WALLET.accountId,
      wrap: { contract: net.wrapContract, amount: ONE, registerDeposit: null },
      registrations: [],
      aggregatorDeposits: null,
      swap: { tokenContract: net.wrapContract, receiverId: net.dex.dcl.contract, amount: ONE, msg: r.msg },
      label: 'swap',
    }).map((t) => ({ receiverId: t.receiverId, actions: t.actions, label: t.label }))
    expect(() => checkPlan(op(r), p, WALLET, net, null)).not.toThrow()
    const withFee = { ...r, direct: { swapAmount: ONE - 1n, fee: 1n, feeRecipient: 'x.testnet' } }
    expect(() => checkPlan(op(withFee), p, WALLET, net, null)).toThrow(/no fee is charged on this network/)
  })
})
