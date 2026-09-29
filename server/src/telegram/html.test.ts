import { describe, expect, it } from 'vitest'
import { bold, code, esc, link, plainText, shortAccount, truncate } from './html'

describe('Telegram HTML', () => {
  it('escapes markup characters and drops control characters from chain-supplied text', () => {
    expect(esc('<b>Fake</b> & "co"\u0000\u0007')).toBe('&lt;b&gt;Fake&lt;/b&gt; &amp; "co"')
  })

  it('keeps newlines and tabs', () => {
    expect(esc('a\nb\tc')).toBe('a\nb\tc')
  })

  it('wraps escaped text in tags', () => {
    expect(bold('<x>')).toBe('<b>&lt;x&gt;</b>')
    expect(code('a&b')).toBe('<code>a&amp;b</code>')
  })

  it('builds links only for http(s) URLs and escapes the href', () => {
    expect(link('https://nearblocks.io/txns/a"b', 'tx')).toBe('<a href="https://nearblocks.io/txns/a&quot;b">tx</a>')
    expect(link('javascript:alert(1)', 'x')).toBe('x')
  })

  it('shortens long accounts and texts', () => {
    expect(shortAccount('alice.near')).toBe('alice.near')
    expect(shortAccount('a'.repeat(64))).toBe('aaaaaa…aaaa')
    expect(truncate('abcdef', 4)).toBe('abc…')
  })

  it('reduces untrusted multi-line input to one plain line', () => {
    expect(plainText('  hello\n‮world  ', 20)).toBe('hello world')
  })
})
