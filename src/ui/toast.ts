/**
 * Transient confirmations.
 *
 * Saving, exporting and converting all finish instantly and silently, which
 * leaves the user guessing whether the click registered. A short toast answers
 * that without stealing focus or interrupting anything.
 *
 * Toasts stack upward from the bottom-left, because the top-right corner is
 * where the panel and the cursor already compete for attention. Repeating the
 * same message re-uses the existing toast instead of stacking duplicates, so
 * holding a shortcut down does not build a wall.
 */

import { el } from './dom'

let host: HTMLElement | null = null

function ensureHost(): HTMLElement {
  if (host && host.isConnected) return host
  host = el('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' })
  document.body.appendChild(host)
  return host
}

const live = new Map<string, { node: HTMLElement; timer: number }>()

export type ToastKind = 'info' | 'ok' | 'warn'

export function toast(message: string, kind: ToastKind = 'info', ms = 2400) {
  if (!message) return
  const root = ensureHost()

  const existing = live.get(message)
  if (existing) {
    // bump the timer instead of adding a twin
    window.clearTimeout(existing.timer)
    existing.node.classList.remove('is-out')
    // force the animation to replay on a repeat
    existing.node.style.animation = 'none'
    void existing.node.offsetHeight
    existing.node.style.animation = ''
    existing.timer = window.setTimeout(() => dismiss(message), ms)
    return
  }

  const node = el('div', { class: `toast toast-${kind}` }, [
    el('span', { class: 'toast-dot' }),
    el('span', { text: message }),
  ])
  root.appendChild(node)
  live.set(message, { node, timer: window.setTimeout(() => dismiss(message), ms) })
}

function dismiss(message: string) {
  const hit = live.get(message)
  if (!hit) return
  live.delete(message)
  hit.node.classList.add('is-out')
  window.setTimeout(() => hit.node.remove(), 220)
}

/** Clear everything, e.g. when a board is replaced. */
export function clearToasts() {
  for (const [message] of live) {
    window.clearTimeout(live.get(message)!.timer)
    live.get(message)!.node.remove()
    live.delete(message)
  }
}
