import type { NoteElement, TextElement, TextStyle } from '../core/types'
import type { ViewState } from '../core/types'
import { el } from './dom'

export interface EditorResult {
  text: string
  element?: TextElement
  note?: NoteElement
}

/**
 * A DOM textarea laid over the canvas so text editing feels native:
 * caret, selection, IME and spellcheck all come from the browser.
 */
export class TextEditor {
  private node: HTMLTextAreaElement | null = null
  private noteBox: HTMLDivElement | null = null

  constructor(private host: HTMLElement) {}

  get open() {
    return !!this.node
  }

  start(opts: {
    x: number
    y: number
    width: number
    text: string
    style: TextStyle
    view: ViewState
    note?: NoteElement
    element?: TextElement
  }): Promise<EditorResult | null> {
    this.close()
    const ta = el('textarea', {
      class: `text-editor${opts.note ? ' in-note' : ''}`,
      spellcheck: 'true',
    }) as HTMLTextAreaElement
    ta.value = opts.text
    const scale = opts.view.scale
    const fs = opts.style.fontSize * scale
    ta.style.font = `${opts.style.italic ? 'italic ' : ''}${opts.style.fontWeight} ${fs}px ${opts.style.fontFamily}`
    ta.style.lineHeight = String(opts.style.lineHeight)
    ta.style.color = opts.style.color
    ta.style.textAlign = opts.style.align
    ta.style.left = `${opts.x * scale + opts.view.x}px`
    ta.style.top = `${opts.y * scale + opts.view.y}px`
    ta.style.width = `${Math.max(80, opts.width * scale)}px`
    ta.style.transform = opts.note ? 'none' : 'none'
    if (opts.element) {
      ta.style.minHeight = `${opts.element.text.split('\n').length * fs * opts.style.lineHeight}px`
    }
    this.host.append(ta)
    this.node = ta

    if (opts.note) {
      const box = el('div', {
        class: 'note-edit-overlay',
        style: `left:${opts.note.x * scale + opts.view.x + 14 * scale}px;top:${opts.note.y * scale + opts.view.y + 14 * scale}px;width:${(opts.note.w - 28) * scale}px;height:${(opts.note.h - 20) * scale}px;`,
      })
      this.host.append(box)
      this.noteBox = box
    }

    ta.focus()
    ta.setSelectionRange(ta.value.length, ta.value.length)
    // keep the caret in view
    requestAnimationFrame(() => {
      ta.scrollTop = ta.scrollHeight
    })

    return new Promise((resolve) => {
      let settled = false
      const done = (commit: boolean) => {
        if (settled) return
        settled = true
        const text = ta.value
        this.close()
        if (!commit || (!text.trim() && opts.element && !opts.note)) {
          resolve(null)
          return
        }
        if (opts.element) resolve({ text, element: opts.element })
        else if (opts.note) resolve({ text, note: opts.note })
        else resolve({ text })
      }

      ta.addEventListener('keydown', (e) => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          done(false)
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          done(true)
        }
      })
      ta.addEventListener('blur', () => done(true))
    })
  }

  close() {
    // detach first: blur and Esc can both arrive, and removing an already
    // removed node throws
    const node = this.node
    const box = this.noteBox
    this.node = null
    this.noteBox = null
    node?.remove()
    box?.remove()
  }
}
