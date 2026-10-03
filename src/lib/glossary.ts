import { GAS_RESERVE_NEAR, NEARKIT_FEE_LABEL, NEARKIT_FEE_RECEIVED_LABEL, RHEA_APP_FEE_SHARE_LABEL, STORAGE_DEPOSIT_NEAR } from './fees'
import { GAS_RESERVE_LABEL, GAS_RESERVE_TOOLTIP } from './gasReserve'

/**
 * One definition per term, shared by tooltips and the documentation page so the
 * app never explains the same idea two different ways.
 */
export const GLOSSARY = {
  slippage: {
    term: 'Slippage',
    text: 'The most the price may move against you between the quote and execution. If it moves further, the trade is cancelled instead of filled.',
  },
  priceImpact: {
    term: 'Price impact',
    text: 'How far your own order moves the pool price. Larger orders in thinner pools move it more.',
  },
  minReceived: {
    term: 'Minimum received',
    text: 'The least you receive after slippage. The trade reverts rather than return less.',
  },
  fdv: {
    term: 'FDV',
    text: 'Fully diluted value: the total supply read from the token’s contract, times its current price. Not a market cap: tokens not in circulation count too.',
  },
  nearkitFee: {
    term: 'NearKit fee',
    text: `NearKit's ${NEARKIT_FEE_LABEL} fee on each trade. On mainnet Rhea's aggregator collects it inside the swap: NearKit receives ${NEARKIT_FEE_RECEIVED_LABEL} and Rhea keeps ${RHEA_APP_FEE_SHARE_LABEL}. Testnet trades and the demo are not charged.`,
  },
  networkFee: {
    term: 'Network fee',
    text: 'The gas the NEAR network actually burns to process each transaction. Estimated here; the exact amount is known at execution. It is separate from the gas reserve, which is only held while the transaction runs and then refunded.',
  },
  gasReserveRefunded: {
    term: GAS_RESERVE_LABEL,
    text: GAS_RESERVE_TOOLTIP,
  },
  storageDeposit: {
    term: 'Storage deposit',
    text: `NEAR token contracts charge a one-time deposit (about ${STORAGE_DEPOSIT_NEAR} NEAR) the first time an account holds a token.`,
  },
  gasReserve: {
    term: 'Minimum wallet reserve',
    text: `The NEAR NearKit keeps available in each wallet: MAX leaves ${GAS_RESERVE_NEAR} NEAR so the wallet can still pay for gas and storage later. This is not the temporary gas reserve a transaction holds while it runs (“${GAS_RESERVE_LABEL}” on reviews).`,
  },
  quoteAge: {
    term: 'Quote age',
    text: 'Quotes refresh every 15 seconds. An expiring quote fades until the new one arrives.',
  },
  equalAllocation: {
    term: 'Equal allocation',
    text: 'The total is divided evenly across the selected wallets.',
  },
  customAllocation: {
    term: 'Custom allocation',
    text: "Set each wallet's amount yourself. The total is the sum of the rows.",
  },
  split: {
    term: 'Split',
    text: "Distribute one wallet's tokens across several wallets by equal shares or custom percentages.",
  },
  consolidate: {
    term: 'Consolidate',
    text: 'Gather a token from several wallets into one destination wallet.',
  },
  batchSend: {
    term: 'Batch send',
    text: 'Send one token to many recipients from a single list, reviewed line by line before sending.',
  },
  preset: {
    term: 'Wallet preset',
    text: 'A saved group of wallets you can apply to any multi-wallet tool.',
  },
  implicitAccount: {
    term: 'Implicit account',
    text: 'A 64-character hex NEAR account derived from a key pair. NearKit-managed wallets use these.',
  },
  top10: {
    term: 'Top 10 concentration',
    text: 'Share of total supply held by the ten largest holder accounts.',
  },
  creatorHoldings: {
    term: 'Creator holdings',
    text: 'Share of supply held by the account that deployed the token contract.',
  },
  contractVerified: {
    term: 'Contract verified',
    text: 'The deployed code matches published source code.',
  },
  mintCapability: {
    term: 'Mint capability',
    text: 'Whether an account can create new tokens after launch, diluting holders.',
  },
  transferRestrictions: {
    term: 'Transfer restrictions',
    text: 'Contract functions that can pause, block or allowlist transfers.',
  },
  liquidityStatus: {
    term: 'Liquidity status',
    text: "Whether the pool's liquidity is locked, withdrawable by its owner, or too thin to trade size.",
  },
  avgEntry: {
    term: 'Average entry',
    text: 'Average price paid per token for the balance you hold now.',
  },
  unrealizedPnl: {
    term: 'Unrealized PnL',
    text: 'Profit or loss on tokens you still hold, valued at the current price.',
  },
  realizedPnl: {
    term: 'Realized PnL',
    text: 'Profit or loss locked in by selling.',
  },
  winRate: {
    term: 'Win rate',
    text: 'Share of closed trades that ended in profit.',
  },
  limitOrder: {
    term: 'Limit order',
    text: 'Buy or sell only when the price reaches your trigger.',
  },
  takeProfit: {
    term: 'Take profit',
    text: 'Sell automatically when the price rises to your target.',
  },
  stopLoss: {
    term: 'Stop loss',
    text: 'Sell automatically when the price falls to your limit.',
  },
  dca: {
    term: 'DCA',
    text: 'Dollar-cost averaging: buy a fixed amount on a fixed schedule instead of all at once.',
  },
  copyTrade: {
    term: 'Copy trade',
    text: "Mirror another wallet's buys and sells with your own sizing and limits.",
  },
  sniper: {
    term: 'Sniper',
    text: 'Buy a token the moment a launch condition is met, across a wallet preset.',
  },
  priority: {
    term: 'Execution priority',
    text: 'How aggressively NearKit submits and retries a transaction. The exact routing, gas and retry mechanics are defined with execution in Phase 2.',
  },
} as const

export type GlossaryKey = keyof typeof GLOSSARY
