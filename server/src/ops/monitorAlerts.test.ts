import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * How the host's watchdog (deploy/vps/monitor.sh) delivers its alerts, run as the VPS runs it, with a
 * stand-in for curl that answers as Telegram would. An alert Telegram doesn't take is asked once more,
 * then kept and sent, marked delayed, by the next run Telegram answers: an outage delays alerts, never
 * loses them. The bot token never appears in curl's arguments.
 */

const SCRIPT = fileURLToPath(new URL('../../../deploy/vps/monitor.sh', import.meta.url))
const TOKEN = '123456789:test-token-not-a-real-one-AAAAAAAAAAAAA'

// Plays Telegram: each call takes the next "<http code> <curl exit>" from plan (200 0 when it runs out),
// logs the message it was asked to send, and keeps the arguments it was given.
const FAKE_CURL = `#!/usr/bin/env bash
cat > /dev/null
printf '%s\\n' "$@" >> "$FAKE_CURL_DIR/args"
for a in "$@"; do case $a in text=*) printf '%s\\n<end>\\n' "\${a#text=}" >> "$FAKE_CURL_DIR/sent" ;; esac; done
line=$(head -n 1 "$FAKE_CURL_DIR/plan" 2> /dev/null)
[ -s "$FAKE_CURL_DIR/plan" ] && sed -i '1d' "$FAKE_CURL_DIR/plan"
read -r code rc <<< "\${line:-200 0}"
printf '%s' "$code"
exit "\${rc:-0}"
`

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nearkit-monitor-'))
  mkdirSync(join(root, 'secrets'))
  mkdirSync(join(root, 'fakebin'))
  writeFileSync(join(root, 'secrets', 'telegram_bot_token'), TOKEN)
  writeFileSync(join(root, 'monitor.env'), 'ALERT_TELEGRAM_CHAT_ID=4242\nMONITOR_RETRY_SECONDS=0\n')
  writeFileSync(join(root, 'fakebin', 'curl'), FAKE_CURL)
  chmodSync(join(root, 'fakebin', 'curl'), 0o755)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

/** Telegram's answers, in order, for the next run. */
const telegram = (...answers: string[]) => writeFileSync(join(root, 'plan'), answers.map((a) => `${a}\n`).join(''))

function monitor(mode = '--test') {
  const run = spawnSync('bash', [SCRIPT, mode], {
    encoding: 'utf8',
    env: { ...process.env, NEARKIT_MONITOR_ROOT: root, FAKE_CURL_DIR: root, PATH: `${join(root, 'fakebin')}${delimiter}${process.env.PATH ?? ''}` },
  })
  return { status: run.status, out: run.stdout, err: run.stderr }
}

const read = (name: string) => (existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8') : '')
/** The messages curl was asked to send, in order. */
const sent = () => read('sent').split('<end>\n').filter(Boolean)
const pending = () => read('monitor/pending')

// Each case starts bash a few times; a loaded CI runner gets room.
describe.skipIf(process.platform === 'win32')('the watchdog’s alert delivery', { timeout: 15_000 }, () => {
  it('sends the alert and notes it in the journal; the token goes to curl on stdin, never in its arguments', () => {
    telegram('200 0')
    const run = monitor()
    expect(run.status).toBe(0)
    expect(run.out).toContain('monitor: alert sent: 🧪 NEARKITS monitoring test')
    expect(sent()).toHaveLength(1)
    expect(pending()).toBe('')
    expect(read('args')).toContain('chat_id=4242')
    expect(read('args')).not.toContain(TOKEN)
    expect(run.out + run.err).not.toContain(TOKEN)
  })

  it('asks Telegram again when it refuses once (a 429), and sends', () => {
    telegram('429 0', '200 0')
    const run = monitor()
    expect(run.status).toBe(0)
    expect(sent()).toHaveLength(2)
    expect(pending()).toBe('')
  })

  it('keeps an alert Telegram didn’t take after two asks, says why in the journal, and exits non-zero', () => {
    telegram('000 28', '000 28')
    const run = monitor()
    expect(run.status).toBe(1)
    expect(sent()).toHaveLength(2)
    expect(run.err).toContain("Telegram didn't take the alert (HTTP 000, curl exit 28); kept to send again")
    expect(pending()).toContain('🧪 NEARKITS monitoring test')
  })

  it('sends kept alerts first, marked delayed, once Telegram answers again', () => {
    telegram('000 28', '000 28')
    monitor()
    telegram('200 0', '200 0')
    const run = monitor()
    expect(run.status).toBe(0)
    const [delayed, fresh] = sent().slice(2)
    expect(delayed).toMatch(/^📬 Delayed: NEARKITS alerts Telegram didn't take at the time\n🧪 NEARKITS monitoring test/)
    expect(fresh).toMatch(/^🧪 NEARKITS monitoring test/)
    expect(run.out).toContain('monitor: delayed alerts sent')
    expect(pending()).toBe('')
  })

  it('while Telegram still doesn’t answer, keeps everything and asks only once in the run', () => {
    telegram('000 28', '000 28')
    monitor()
    telegram('000 7', '000 7', '200 0')
    const run = monitor()
    expect(run.status).toBe(1)
    // The kept alert asked twice; the new one didn't wait on Telegram again.
    expect(sent()).toHaveLength(4)
    expect(run.err).toContain("Telegram still doesn't take alerts (HTTP 000, curl exit 7); delayed alerts kept")
    expect(pending().match(/🧪 NEARKITS monitoring test/g)).toHaveLength(2)
  })

  it('keeps at most the newest 3000 bytes, within one Telegram message', () => {
    mkdirSync(join(root, 'monitor'), { recursive: true })
    writeFileSync(join(root, 'monitor', 'pending'), `${'🔴 an older alert\n'.repeat(400)}`)
    telegram('000 28', '000 28')
    monitor()
    expect(Buffer.byteLength(pending())).toBeLessThanOrEqual(3000)
    // Cut at a line, never inside a character: Telegram refuses text that isn't valid UTF-8.
    expect(pending()).toMatch(/^🔴 an older alert\n/)
    expect(pending()).not.toContain('�')
    expect(pending().trimEnd().endsWith('Alerts reach this chat.')).toBe(true)
  })

  it('without a chat set, writes the alert to the journal and asks no one', () => {
    writeFileSync(join(root, 'monitor.env'), 'ALERT_TELEGRAM_CHAT_ID=\n')
    const run = monitor()
    expect(run.status).toBe(0)
    expect(run.out).toContain('ALERT (no Telegram chat configured): 🧪 NEARKITS monitoring test')
    expect(sent()).toHaveLength(0)
  })
})
