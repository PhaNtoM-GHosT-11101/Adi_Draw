import type { Tool } from '../core/types'
import type { ToolStore } from '../core/app'
import { normalizeShortcut } from '../core/app'

export interface ShortcutHandlers {
  undo: () => void
  redo: () => void
  deleteSelection: () => void
  selectAll: () => void
  duplicate: () => void
  copy: () => void
  cut: () => void
  paste: () => void
  zoom: (dir: number) => void
  zoomFit: () => void
  zoomReset: () => void
  save: () => void
  open: () => void
  exportImage: () => void
  newBoard: () => void
  help: () => void
  togglePanel: () => void
  bringForward: () => void
  sendBackward: () => void
  bringToFront: () => void
  sendToBack: () => void
  escape: () => void
  nudge: (dx: number, dy: number) => void
  toggleGrid: () => void
  abortGesture: () => void
}

function comboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  let key = e.key
  if (key === ' ') key = 'Space'
  if (key.length === 1) key = key.toUpperCase()
  if (!['Control', 'Meta', 'Alt', 'Shift'].includes(key)) parts.push(key)
  return parts.join('+')
}

function isTypingTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

export function installShortcuts(
  toolStore: ToolStore,
  h: ShortcutHandlers,
  opts: { onToolChange: () => void } = { onToolChange: () => undefined },
) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      h.abortGesture()
      h.escape()
      return
    }
    const typing = isTypingTarget(e.target)
    const combo = comboFromEvent(e)
    const ctrl = e.ctrlKey || e.metaKey

    if (ctrl) {
      switch (combo) {
        case 'Ctrl+Z':
          e.preventDefault()
          h.undo()
          return
        case 'Ctrl+Shift+Z':
          e.preventDefault()
          h.redo()
          return
        case 'Ctrl+Y':
          e.preventDefault()
          h.redo()
          return
        case 'Ctrl+S':
          e.preventDefault()
          h.save()
          return
        case 'Ctrl+O':
          e.preventDefault()
          h.open()
          return
        case 'Ctrl+E':
          e.preventDefault()
          h.exportImage()
          return
        case 'Ctrl+N':
          e.preventDefault()
          h.newBoard()
          return
        case 'Ctrl+A':
          if (typing) return
          e.preventDefault()
          h.selectAll()
          return
        case 'Ctrl+D':
          if (typing) return
          e.preventDefault()
          h.duplicate()
          return
        case 'Ctrl+C':
          if (typing) return
          e.preventDefault()
          h.copy()
          return
        case 'Ctrl+X':
          if (typing) return
          e.preventDefault()
          h.cut()
          return
        case 'Ctrl+V':
          return // let the paste event fire naturally
        case 'Ctrl+=':
        case 'Ctrl++':
          e.preventDefault()
          h.zoom(1)
          return
        case 'Ctrl+-':
          e.preventDefault()
          h.zoom(-1)
          return
        case 'Ctrl+0':
          e.preventDefault()
          h.zoomReset()
          return
        case 'Ctrl+1':
          e.preventDefault()
          h.zoomFit()
          return
        case 'Ctrl+Shift+]':
        case 'Ctrl+]':
          e.preventDefault()
          h.bringForward()
          return
        case 'Ctrl+Shift+[':
        case 'Ctrl+[':
          e.preventDefault()
          h.sendBackward()
          return
        case 'Ctrl+Shift+ArrowUp':
          e.preventDefault()
          h.bringToFront()
          return
        case 'Ctrl+Shift+ArrowDown':
          e.preventDefault()
          h.sendToBack()
          return
        case 'Ctrl+Shift+G':
          e.preventDefault()
          h.toggleGrid()
          return
        case 'Ctrl+Shift+U':
          e.preventDefault()
          h.togglePanel()
          return
      }
    }

    if (typing) return

    // tool shortcuts (any tool may claim any combination)
    if (!e.altKey && !['Control', 'Shift', 'Meta'].includes(e.key)) {
      const tool = toolStore.findByShortcut(combo)
      if (tool) {
        e.preventDefault()
        toolStore.setActive(tool.id)
        opts.onToolChange()
        return
      }
    } else if (e.shiftKey && e.key.length === 1) {
      const tool = toolStore.findByShortcut(`Shift+${e.key.toUpperCase()}`)
      if (tool) {
        e.preventDefault()
        toolStore.setActive(tool.id)
        opts.onToolChange()
        return
      }
    }

    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        e.preventDefault()
        h.deleteSelection()
        return
      case '?':
        e.preventDefault()
        h.help()
        return
      case 'F2':
        e.preventDefault()
        h.duplicate()
        return
    }

    // arrow-key nudging of the selection
    const step = e.shiftKey ? 10 : 1
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      h.nudge(-step, 0)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      h.nudge(step, 0)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      h.nudge(0, -step)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      h.nudge(0, step)
    }
  }

  window.addEventListener('keydown', onKeyDown)
  return () => window.removeEventListener('keydown', onKeyDown)
}

/* ------------------ one-shot shortcut recorder ---------------------- */

export function recordShortcut(
  onDone: (combo: string | null) => void,
): () => void {
  const handler = (e: KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      cleanup()
      onDone(null)
      return
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      cleanup()
      onDone('')
      return
    }
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return
    const combo = comboFromEvent(e)
    cleanup()
    onDone(combo)
  }
  const cleanup = () => {
    window.removeEventListener('keydown', handler, true)
    document.body.classList.remove('recording-key')
  }
  window.addEventListener('keydown', handler, true)
  document.body.classList.add('recording-key')
  return cleanup
}

export { normalizeShortcut, comboFromEvent }
export type { Tool }
