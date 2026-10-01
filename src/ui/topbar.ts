import { el, button, svgIcon } from './dom'
import type { Store } from '../core/store'

export interface TopBarHooks {
  onUndo: () => void
  onRedo: () => void
  onSave: () => void
  onOpen: () => void
  onExport: () => void
  onNew: () => void
  onZoom: (v: number) => void
  onFit: () => void
  onTogglePanel: () => void
  onHelp: () => void
  onRename: (name: string) => void
}

export class TopBar {
  readonly root: HTMLElement
  private title: HTMLInputElement
  private undoBtn: HTMLButtonElement
  private redoBtn: HTMLButtonElement
  private zoomLabel: HTMLElement
  private saveDot: HTMLElement

  constructor(
    private store: Store,
    hooks: TopBarHooks,
  ) {
    this.title = el('input', {
      class: 'doc-title',
      value: store.doc.meta.title,
      spellcheck: 'false',
      title: 'Board name — used as the filename when you save',
    }) as HTMLInputElement
    this.title.addEventListener('change', () => hooks.onRename(this.title.value.trim() || 'Untitled board'))

    this.undoBtn = this.iconBtn('undo', 'Undo (Ctrl+Z)', () => hooks.onUndo()) as HTMLButtonElement
    this.redoBtn = this.iconBtn('redo', 'Redo (Ctrl+Shift+Z)', () => hooks.onRedo()) as HTMLButtonElement
    this.zoomLabel = el('span', { class: 'zoom-label', text: '100%' })
    this.saveDot = el('span', { class: 'save-dot', title: 'All changes saved' })

    this.root = el('header', { class: 'topbar' }, [
      el('div', { class: 'tb-left' }, [
        el('div', { class: 'brand' }, [
          // the same mark the app icon uses; relative so it resolves under a
          // GitHub Pages subpath and from file:// in the desktop build
          el('img', { class: 'brand-mark', src: './icons/icon-64.png', alt: '', width: 22, height: 22 }),
          el('span', { class: 'brand-name', text: 'Adi Draw' }),
        ]),
        el('div', { class: 'tb-sep' }),
        this.title,
        this.saveDot,
      ]),
      el('div', { class: 'tb-center' }, [
        el('div', { class: 'btn-group' }, [this.undoBtn, this.redoBtn]),
        el('div', { class: 'tb-sep' }),
        el('div', { class: 'btn-group zoom' }, [
          this.iconBtn('minus', 'Zoom out (Ctrl+-)', () => hooks.onZoom(-1)),
          this.zoomLabel,
          this.iconBtn('plus', 'Zoom in (Ctrl+=)', () => hooks.onZoom(1)),
          this.iconBtn('zoomfit', 'Zoom to fit (Shift+1)', () => hooks.onFit()),
        ]),
      ]),
      el('div', { class: 'tb-right' }, [
        button('New', () => hooks.onNew(), { icon: 'file', class: 'btn sm' }),
        button('Open', () => hooks.onOpen(), { icon: 'open', class: 'btn sm' }),
        button('Save', () => hooks.onSave(), { icon: 'save', class: 'btn sm' }),
        button('Export', () => hooks.onExport(), { icon: 'export', class: 'btn sm primary' }),
        el('div', { class: 'tb-sep' }),
        this.iconBtn('settings', 'Tool settings', () => hooks.onTogglePanel()),
        this.iconBtn('help', 'Keyboard shortcuts (?)', () => hooks.onHelp()),
      ]),
    ])

    store.subscribe((kinds) => {
      if (kinds.has('view')) this.syncZoom()
      if (kinds.has('history')) this.syncHistory()
      if (kinds.has('doc') && document.activeElement !== this.title)
        this.title.value = store.doc.meta.title
    })
    this.syncZoom()
    this.syncHistory()
  }

  private iconBtn(icon: string, title: string, onClick: () => void) {
    const b = el('button', { class: 'btn btn-icon', type: 'button', title, 'aria-label': title })
    b.append(svgIcon(icon, 17))
    b.addEventListener('click', onClick)
    return b
  }

  private syncZoom() {
    this.zoomLabel.textContent = `${Math.round(this.store.view.scale * 100)}%`
  }

  private syncHistory() {
    this.undoBtn.disabled = !this.store.canUndo
    this.redoBtn.disabled = !this.store.canRedo
    this.undoBtn.title = this.store.canUndo ? `Undo ${this.store.undoLabel} (Ctrl+Z)` : 'Nothing to undo'
    this.redoBtn.title = this.store.canRedo ? `Redo ${this.store.redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo'
  }

  setSaved(state: 'idle' | 'saving' | 'saved') {
    this.saveDot.className = `save-dot ${state}`
    this.saveDot.title =
      state === 'saving' ? 'Saving…' : state === 'saved' ? 'All changes saved' : 'Autosave is off'
  }
}

/* --------------------------- export dialog ------------------------ */

export function exportDialog(
  host: HTMLElement,
  opts: { grid: boolean; scale: number; transparent: boolean; padding: number; background: string },
  onExport: (o: { grid: boolean; scale: number; padding: number; background: string | 'transparent' }, format: 'png' | 'svg') => void,
) {
  const state = { ...opts }
  const grid = el('input', { type: 'checkbox' }) as HTMLInputElement
  grid.checked = state.grid
  grid.addEventListener('change', () => (state.grid = grid.checked))

  const transparent = el('input', { type: 'checkbox' }) as HTMLInputElement
  transparent.checked = state.transparent
  transparent.addEventListener('change', () => (state.transparent = transparent.checked))

  const scale = el('input', {
    type: 'range',
    min: '1',
    max: '4',
    step: '1',
    value: String(state.scale),
  }) as HTMLInputElement
  const scaleOut = el('span', { class: 'ctl-value', text: `${state.scale}×` })
  scale.addEventListener('input', () => (scaleOut.textContent = `${scale.value}×`))

  const result = () => ({
    grid: state.grid,
    scale: parseFloat(scale.value),
    padding: state.padding,
    background: (state.transparent ? 'transparent' : state.background) as string | 'transparent',
  })

  const overlay = el('div', { class: 'modal-overlay' })
  const close = () => overlay.remove()
  const card = el('div', { class: 'modal' }, [
    el('h3', { text: 'Export' }),
    el('div', { class: 'ctl ctl-inline' }, [
      el('label', { class: 'ctl-label', text: 'Include grid' }),
      grid,
    ]),
    el('div', { class: 'ctl ctl-inline' }, [
      el('label', { class: 'ctl-label', text: 'Transparent background' }),
      transparent,
    ]),
    el('div', { class: 'ctl' }, [
      el('div', { class: 'ctl-head' }, [el('label', { text: 'Resolution' }), scaleOut]),
      scale,
    ]),
    el('div', { class: 'btn-row end' }, [
      button('Cancel', close, { class: 'btn sm' }),
      button('Export SVG', () => {
        onExport(result(), 'svg')
        close()
      }, { class: 'btn sm' }),
      button('Export PNG', () => {
        onExport(result(), 'png')
        close()
      }, { icon: 'export', class: 'btn sm primary' }),
    ]),
  ])
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })
  overlay.append(card)
  host.append(overlay)
}
