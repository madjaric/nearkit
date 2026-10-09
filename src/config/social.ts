/**
 * NEARKITS' official community accounts: one list for the web app (the navigation, the $KITS page,
 * the site's structured data) and the Telegram bot (its Community screen). Only these two exist; no
 * other account speaks for NEARKITS.
 */

export interface SocialAccount {
  /** Where it is. */
  url: string
  /** What a link to it says, e.g. on a button. */
  label: string
  /** Its handle as people write it. */
  handle: string
}

export const SOCIAL = Object.freeze({
  /** NEARKITS on X (formerly Twitter). */
  x: Object.freeze({ url: 'https://x.com/Near_Kits', label: 'NEARKITS on X', handle: '@Near_Kits' } satisfies SocialAccount),
  /** The NEARKITS Community chat on Telegram (the bot is @NearKitBot; this is where people talk). */
  telegram: Object.freeze({ url: 'https://t.me/NearKitsCommunity', label: 'NEARKITS Community on Telegram', handle: '@NearKitsCommunity' } satisfies SocialAccount),
})

/** Both accounts, in the order every surface lists them: the community chat first, then X. */
export const SOCIAL_ACCOUNTS: readonly SocialAccount[] = Object.freeze([SOCIAL.telegram, SOCIAL.x])
