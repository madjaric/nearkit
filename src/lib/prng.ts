/** Small deterministic PRNG so demo data is identical on every load. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hashString(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 64-char hex string derived from a seed — used for demo implicit accounts. */
export function hexFromSeed(seed: string): string {
  const rand = mulberry32(hashString(seed))
  let out = ''
  for (let i = 0; i < 64; i++) out += Math.floor(rand() * 16).toString(16)
  return out
}
