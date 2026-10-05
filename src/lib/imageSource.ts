/**
 * Image sources NearKit shows from data it doesn't control (a wallet's manifest icon, a token's
 * metadata icon): https and inline images only, and only ever in an <img> (an <img> never runs an
 * SVG's scripts), without a referrer.
 */
const IMAGE_SOURCE = /^(https:\/\/[^\s"'<>`]+|data:image\/(svg\+xml|png|jpeg|webp|gif)[;,])/i

export function isImageSource(src: string | null | undefined): src is string {
  return typeof src === 'string' && IMAGE_SOURCE.test(src)
}
