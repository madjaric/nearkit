import { useSyncExternalStore } from 'react'

/**
 * Tracks whether NEAR Connect is showing its own wallet popup.
 *
 * NEAR Connect runs sandboxed wallets in an iframe inside a popup it appends to
 * <body> (z-index 1e8), and some wallets need a click in it. NearKit's dialogs
 * are native modal <dialog>s in the top layer, which make everything outside them
 * inert, so while that popup is visible every NearKit dialog steps out of the top
 * layer (see Dialog.tsx). The popup is recognized by the `hot-connector-popup`
 * class of @hot-labs/near-connect 0.11.4 (pinned exactly in package.json).
 */

const POPUP_CLASS = 'hot-connector-popup'

const listeners = new Set<() => void>()
let visible = false
let started = false
const roots = new Set<HTMLElement>()

function compute(): boolean {
  for (const root of roots) {
    if (!root.isConnected) {
      roots.delete(root)
      continue
    }
    if (root.style.display !== 'none') return true
  }
  return false
}

function emit() {
  const next = compute()
  if (next === visible) return
  visible = next
  for (const l of listeners) l()
}

function track(node: Node) {
  if (!(node instanceof HTMLElement) || !node.classList.contains(POPUP_CLASS) || roots.has(node)) return
  roots.add(node)
  new MutationObserver(emit).observe(node, { attributes: true, attributeFilter: ['style'] })
}

function start() {
  if (started || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
  started = true
  for (const child of Array.from(document.body.children)) track(child)
  new MutationObserver((records) => {
    for (const r of records) r.addedNodes.forEach(track)
    emit()
  }).observe(document.body, { childList: true })
  emit()
}

function subscribe(listener: () => void) {
  start()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** True while a NEAR Connect wallet popup is on screen. */
export function useWalletOverlay(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => visible,
    () => false,
  )
}
