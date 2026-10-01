import './style.css'

import type { AnyElement, DocumentState, NoteElement, TextElement, Tool } from './core/types'
import { Store, emptyDoc } from './core/store'
import { ToolStore, writeJson } from './core/app'
import { Renderer } from './render/renderer'
import { Controller, textStyleOf } from './input/controller'
import { buildSectionTree, membersOf } from './core/sections'
import { toast } from './ui/toast'
import { installShortcuts, recordShortcut } from './input/shortcuts'
import { Toolbar } from './ui/toolbar'
import { Inspector, BoardPanel } from './ui/inspector'
import { LayersPanel } from './ui/layers'
import { TopBar, exportDialog } from './ui/topbar'
import { TextEditor } from './ui/texteditor'
import { helpOverlay } from './ui/help'
import { el } from './ui/dom'
import { slugify, uid } from './core/geometry'
import { translate } from './core/transform'
import {
  autosaveKey,
  loadBoard,
  openFromDisk,
  parseBoard,
  saveBoard,
  saveToDisk,
  scheduleAutosave,
  serialise,
} from './io/persist'
import { exportPNG, exportSVG, defaultExportOptions, toPngDataUrl } from './io/exporter'
import { desktop } from './io/desktop'

/* ------------------------------------------------------------------ *
 *  Application shell
 * ------------------------------------------------------------------ */

const RECENTS_KEY = 'adi-draw.recents'

class App {
  readonly store = new Store()
  readonly toolStore = new ToolStore()
  private renderer: Renderer
  controller!: Controller
  private activeLayerId: string
  private clipboard: AnyElement[] = []

  private stage!: HTMLElement
  private emptyHint!: HTMLElement
  private canvas!: HTMLCanvasElement
  private overlay!: HTMLElement
  private topBar!: TopBar
  private toolbar!: Toolbar
  private inspector!: Inspector
  private boardPanel!: BoardPanel
  private layers!: LayersPanel
  private textEditor = new TextEditor(document.body)
  private sidePanel!: HTMLElement
  private sideOpen = true
  private statusBar!: HTMLElement
  private statusInfo!: HTMLSpanElement
  private recordingCleanup: (() => void) | null = null
  private lastPointer = { x: 0, y: 0 }

  constructor() {
    const root = document.getElementById('app')!
    root.innerHTML = ''

    this.canvas = el('canvas', { class: 'board' }) as HTMLCanvasElement
    this.overlay = el('div', { class: 'overlay-layer' })
    this.emptyHint = el('div', { class: 'empty-hint' }, [
      el('h2', { text: 'Start drawing' }),
      el('p', {
        text: 'Pick a tool on the left and drag. A stylus works best — pressure, tilt and speed all shape the line. Press ? for the full shortcut list.',
      }),
      el('div', { class: 'keys' }, [
        el('kbd', { text: 'P' }),
        el('kbd', { text: 'B' }),
        el('kbd', { text: 'H' }),
        el('kbd', { text: 'R' }),
        el('kbd', { text: 'N' }),
        el('kbd', { text: 'Space + drag = pan' }),
      ]),
    ])
    this.stage = el('main', { class: 'stage' }, [this.canvas, this.overlay, this.emptyHint])

    this.activeLayerId = this.store.doc.layers[0].id

    this.topBar = new TopBar(this.store, {
      onUndo: () => this.undo(),
      onRedo: () => this.redo(),
      onSave: () => this.saveToDisk(),
      onOpen: () => void this.openFile(),
      onExport: () => this.openExportDialog(),
      onNew: () => this.newBoard(),
      onZoom: (d) => (d > 0 ? this.controller.zoomBy(1.2) : this.controller.zoomBy(1 / 1.2)),
      onFit: () => this.zoomFit(),
      onTogglePanel: () => this.togglePanel(),
      onHelp: () => this.toggleHelp(),
      onRename: (name) => {
        this.store.doc.meta.title = name
        this.store.notify('doc')
        this.markDirty()
      },
    })

    this.toolbar = new Toolbar(
      this.toolStore,
      (id) => this.selectTool(id),
      () => this.openPanel('tool'),
      () => this.newToolPreset(),
    )

    this.inspector = new Inspector(this.toolStore, {
      onChange: () => {
        this.requestFrame()
      },
      onPickShortcut: (tool) => this.recordShortcut(tool),
      onNewPreset: (tool) => this.newToolPreset(tool),
      onRecentsChange: (r) => writeJson(RECENTS_KEY, r),
      selectedSection: () => this.selectedSectionInfo(),
      onRenameSection: (id, title) => this.controller.setSectionTitle(id, title),
      onToggleSection: (id) => this.controller.toggleSectionCollapsed(id),
      canInkToShape: () => this.controller.canInkToShape(),
      inkToShape: () => this.applyInkToShape(),
    })

    this.boardPanel = new BoardPanel(
      () => this.store.doc.meta,
      (patch) => {
        Object.assign(this.store.doc.meta, patch)
        this.store.markAllDirty()
        this.store.notify('doc')
        this.markDirty()
      },
      this.toolStore,
      { onChange: () => this.requestFrame() },
    )

    this.layers = new LayersPanel(this.store, (id) => {
      this.activeLayerId = id
      this.requestFrame()
    })

    this.sidePanel = el('div', { class: 'side-panel' }, [
      el('div', { class: 'side-tabs' }, [
        this.tabButton('Tool', 'tool'),
        this.tabButton('Board', 'board'),
        this.tabButton('Layers', 'layers'),
      ]),
      this.inspector.root,
      this.boardPanel.root,
      this.layers.root,
    ])
    this.sidePanel.setAttribute('data-tab', 'tool')
    this.setTab('tool')

    this.statusInfo = el('span', { class: 'status-info' })
    this.statusBar = el('div', { class: 'statusbar' }, [this.statusInfo])

    root.append(this.topBar.root, this.toolbar.root, this.stage, this.sidePanel, this.statusBar)

    this.renderer = new Renderer(this.canvas, this.toolStore.settings.quality)
    this.controller = new Controller(
      this.canvas,
      this.store,
      this.renderer,
      () => this.toolStore.active,
      () => this.activeLayerId,
      {
        onRequestText: (p) => void this.beginText(p),
        onRequestImage: () => this.pickImage(),
        onAfterStroke: () => {
          this.dismissedHint = true
          this.requestFrame()
        },
        onDirty: () => this.markDirty(),
        onSectionFolded: (folded) => toast(folded ? 'Section folded' : 'Section unfolded'),
      },
      { palmRejection: this.toolStore.settings.palmRejection },
    )

    this.applyTheme()
    this.installEvents()
    this.installShortcuts()
    desktop?.onMenu((action) => this.onMenuAction(action))
    this.store.subscribe((kinds) => {
      if (kinds.has('doc') || kinds.has('view') || kinds.has('selection')) this.requestFrame()
      if (kinds.has('doc')) {
        this.layers.render()
        this.renderStatus()
      }
      // the tool panel offers "Ink to shape" based on what is selected, so it
      // has to follow selection changes as well as tool changes
      if (kinds.has('selection') || kinds.has('doc')) this.inspector.render()
      // every board control reads meta back out, so the panel must follow it
      if (kinds.has('doc')) this.boardPanel.render()
    })
    this.toolStore.subscribe(() => {
      this.applyTheme()
      this.renderer.setQuality(this.toolStore.settings.quality)
      this.store.markAllDirty()
      this.requestFrame()
    })
  }

  /**
   * The converted result is a shape, not ink, so the tool panel has to
   * re-read the selection or the button would linger after it is done.
   */
  /** Title and nesting of the selected section, for the tool panel. */
  private selectedSectionInfo() {
    const sel = this.store.selectedElements
    if (sel.length !== 1 || sel[0].kind !== 'section') return null
    const sec = sel[0]
    const sections = this.controller.allSections()
    const parent = buildSectionTree(sections).get(sec.id) ?? null
    const outer = parent ? sections.find((s) => s.id === parent) : null
    const members = membersOf(sec, this.store.allElements(), sections)
    return {
      id: sec.id,
      title: sec.title,
      collapsed: sec.collapsed,
      nestedIn: outer ? outer.title || 'Untitled section' : null,
      count: members.length,
    }
  }

  private applyInkToShape() {
    if (!this.controller.inkToShape()) {
      toast('That ink does not read as a shape', 'warn')
      return
    }
    this.requestFrame()
    this.inspector.render()
    toast('Snapped to a shape — Ctrl+Z to put the ink back', 'ok')
  }

  /* ----------------------------- layout --------------------------- */

  private tabButton(label: string, key: string) {
    const b = el('button', { class: 'side-tab', type: 'button', text: label, 'data-tab': key })
    b.addEventListener('click', () => this.setTab(key))
    return b
  }

  private setTab(key: string) {
    this.sidePanel.setAttribute('data-tab', key)
    for (const t of Array.from(this.sidePanel.querySelectorAll('.side-tab')))
      t.classList.toggle('active', (t as HTMLElement).dataset.tab === key)
    if (key === 'layers') this.layers.setActive(this.activeLayerId)
  }

  private openPanel(key: 'tool' | 'board' | 'layers') {
    if (!this.sideOpen) this.togglePanel()
    this.setTab(key)
  }

  private togglePanel() {
    this.sideOpen = !this.sideOpen
    this.store.historyLimit = this.toolStore.settings.history
    document.body.classList.toggle('panel-closed', !this.sideOpen)
    requestAnimationFrame(() => {
      this.renderer.resize()
      this.requestFrame()
    })
  }

  private toggleHelp() {
    const existing = document.querySelector('.modal-overlay.help')
    if (existing) {
      existing.remove()
      return
    }
    helpOverlay(document.body, this.toolStore, () => document.querySelector('.modal-overlay.help')?.remove())
  }

  /* ------------------------------ events -------------------------- */

  private installEvents() {
    window
      .matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', () => {
        if (this.toolStore.settings.theme === 'auto') {
          this.applyTheme()
          this.store.markAllDirty()
          this.requestFrame()
        }
      })

    const ro = new ResizeObserver(() => {
      this.renderer.resize()
      this.requestFrame()
    })
    ro.observe(this.stage)

    window.addEventListener('resize', () => {
      this.renderer.resize()
      this.requestFrame()
    })

    this.canvas.addEventListener('pointermove', (e) => {
      const r = this.canvas.getBoundingClientRect()
      this.lastPointer = { x: e.clientX - r.left, y: e.clientY - r.top }
      this.renderStatus()
    })
    this.canvas.addEventListener('pointerleave', () => this.renderStatus())

    window.addEventListener('paste', (e) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') return
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) {
            e.preventDefault()
            void readImage(file, (src, w, h) => this.controller.insertImage(src, w, h))
            return
          }
        }
      }
    })

    window.addEventListener('beforeunload', (e) => {
      if (this.dirty) {
        void saveBoard(autosaveKey, serialise(this.store.doc, this.store.view))
        e.preventDefault()
      }
    })
  }

  private dirty = false
  private markDirty() {
    this.dirty = true
    this.topBar.setSaved(this.toolStore.settings.autosave ? 'saving' : 'idle')
    if (this.toolStore.settings.autosave) {
      scheduleAutosave(() => serialise(this.store.doc, this.store.view))
      window.setTimeout(() => {
        this.dirty = false
        this.topBar.setSaved('saved')
      }, 600)
    }
  }

  /* ---------------------------- shortcuts ------------------------- */

  /** `auto` follows the OS, otherwise the explicit choice wins. */
  private applyTheme() {
    const choice = this.toolStore.settings.theme
    const dark =
      choice === 'dark' ||
      (choice === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.body.dataset.theme = dark ? 'dark' : 'light'
    this.renderer.setTheme(dark)
    this.store.markAllDirty()
    this.requestFrame()
  }

  private onMenuAction(action: string) {
    switch (action) {
      case 'new':
        this.newBoard()
        break
      case 'open':
        void this.openFile()
        break
      case 'save':
        void this.saveToDisk()
        break
      case 'save-as':
        void this.saveAs()
        break
      case 'export':
        this.openExportDialog()
        break
      case 'zoom-in':
        this.controller.zoomBy(1.2)
        break
      case 'zoom-out':
        this.controller.zoomBy(1 / 1.2)
        break
      case 'zoom-fit':
        this.zoomFit()
        break
      case 'zoom-reset':
        this.controller.setZoom(1)
        break
      case 'panel':
        this.togglePanel()
        break
      case 'help':
        this.toggleHelp()
        break
    }
  }

  private installShortcuts() {
    installShortcuts(
      this.toolStore,
      {
        undo: () => this.undo(),
        redo: () => this.redo(),
        deleteSelection: () => {
          const n = this.store.selection.size
          this.controller.deleteSelection()
          if (n) toast(`Deleted ${n} object${n === 1 ? '' : 's'}`)
        },
        selectAll: () => this.controller.selectAll(),
        duplicate: () => this.controller.duplicateSelection(),
        inkToShape: () => this.applyInkToShape(),
        copy: () => this.copySelection(),
        cut: () => {
          this.copySelection()
          this.controller.deleteSelection()
        },
        paste: () => this.pasteClipboard(),
        zoom: (d) => (d > 0 ? this.controller.zoomBy(1.2) : this.controller.zoomBy(1 / 1.2)),
        zoomFit: () => this.zoomFit(),
        zoomReset: () => this.controller.setZoom(1),
        save: () => this.saveToDisk(),
        open: () => void this.openFile(),
        exportImage: () => this.openExportDialog(),
        newBoard: () => this.newBoard(),
        help: () => this.toggleHelp(),
        togglePanel: () => this.togglePanel(),
        bringForward: () => this.reorder('forward'),
        sendBackward: () => this.reorder('backward'),
        bringToFront: () => this.reorder('front'),
        sendToBack: () => this.reorder('back'),
        escape: () => {
          if (this.textEditor.open) this.textEditor.close()
          this.store.clearSelection()
        },
        nudge: (dx, dy) => this.nudge(dx, dy),
        toggleGrid: () => {
          this.store.doc.meta.showGrid = !this.store.doc.meta.showGrid
          this.store.notify('doc')
          this.markDirty()
        },
        abortGesture: () => this.controller.abort(),
      },
      { onToolChange: () => this.requestFrame() },
    )
  }

  private recordShortcut(tool: Tool) {
    this.recordingCleanup?.()
    const input = this.inspector.root.querySelector<HTMLInputElement>('.key-input')
    if (input) input.value = 'press a key…'
    this.recordingCleanup = recordShortcut((combo) => {
      if (combo === null) {
        this.recordingCleanup = null
        this.inspector.render()
        return
      }
      if (combo) {
        const clash = this.toolStore.findByShortcut(combo)
        if (clash && clash.id !== tool.id) this.toolStore.update(clash.id, { shortcut: '' })
      }
      this.toolStore.update(tool.id, { shortcut: combo ?? '' })
      this.recordingCleanup = null
      this.requestFrame()
    })
  }

  /* ------------------------------ tools --------------------------- */

  private selectTool(id: string) {
    this.toolStore.setActive(id)
    this.setTab('tool')
    this.requestFrame()
  }

  private newToolPreset(from?: Tool) {
    const base = from ?? this.toolStore.active
    const copy = this.toolStore.create(base, {
      name: `${base.name} copy`,
      shortcut: '',
      hidden: false,
    })
    this.toolStore.setActive(copy.id)
    this.setTab('tool')
    this.openPanel('tool')
  }

  /* ------------------------------ text ---------------------------- */

  private async beginText(payload: {
    x: number
    y: number
    width: number
    text: string
    style: ReturnType<typeof textStyleOf>
    element?: TextElement
    note?: NoteElement
  }) {
    const res = await this.textEditor.start({
      x: payload.x,
      y: payload.y,
      width: payload.width,
      text: payload.text,
      style: payload.style,
      view: this.store.view,
      note: payload.note,
      element: payload.element,
    })
    this.requestFrame()
    if (!res) return

    if (res.element) {
      const before = structuredClone(res.element)
      const after = { ...structuredClone(res.element), text: res.text }
      this.store.begin('Edit text')
      this.store.modify(before.layerId, [before], [after])
      this.store.commit()
      this.markDirty()
      return
    }
    if (res.note) {
      const before = structuredClone(res.note)
      const after = { ...structuredClone(res.note), text: res.text }
      this.store.begin('Edit note')
      this.store.modify(before.layerId, [before], [after])
      this.store.commit()
      this.markDirty()
      return
    }
    const el2: TextElement = {
      id: uid('t'),
      kind: 'text',
      layerId: this.activeLayerId,
      opacity: 1,
      created: Date.now(),
      x: payload.x,
      y: payload.y,
      width: payload.width,
      text: res.text,
      style: payload.style,
    }
    this.store.addElement(el2.layerId, el2)
    this.markDirty()
  }

  /* ------------------------------ history ------------------------- */

  private undo() {
    this.store.undo()
    this.markDirty()
  }
  private redo() {
    this.store.redo()
    this.markDirty()
  }

  private reorder(kind: 'forward' | 'backward' | 'front' | 'back') {
    if (!this.store.selection.size) return
    this.store.begin('Reorder')
    if (kind === 'forward') this.store.bringForward(this.store.selection)
    else if (kind === 'backward') this.store.sendBackward(this.store.selection)
    else if (kind === 'front') this.store.bringToFront(this.store.selection)
    else this.store.sendToBack(this.store.selection)
    this.store.commit()
    this.markDirty()
  }

  private nudge(dx: number, dy: number) {
    const sel = this.store.selectedElements
    if (!sel.length) return
    this.store.begin('Move')
    const byLayer = new Map<string, AnyElement[]>()
    for (const e of sel) {
      const next = translate(e, dx, dy)
      let arr = byLayer.get(next.layerId)
      if (!arr) byLayer.set(next.layerId, (arr = []))
      arr.push(next)
    }
    for (const [layerId, next] of byLayer)
      this.store.modify(layerId, sel.filter((e) => e.layerId === layerId), next)
    this.store.commit()
    this.markDirty()
  }

  private copySelection() {
    const sel = this.store.selectedElements
    if (!sel.length) return
    this.clipboard = sel.map((e) => structuredClone(e))
    toast(`${sel.length} object${sel.length === 1 ? '' : 's'} copied`)
  }

  pasteClipboard() {
    if (!this.clipboard.length) return
    const copies = this.clipboard.map((e) => {
      const c = translate(e, 24, 24)
      c.id = uid('c')
      return c
    })
    this.store.begin('Paste')
    this.store.addElements(this.activeLayerId, copies)
    this.store.commit()
    this.store.setSelection(copies.map((c) => c.id))
    this.markDirty()
  }

  /* ------------------------------ files --------------------------- */

  private newBoard() {
    const doc = emptyDoc()
    this.loadDoc(doc)
    this.markDirty()
  }

  private async openFile() {
    if (desktop) {
      const res = await desktop.open()
      if (!res) return
      try {
        const { doc } = parseBoard(res.contents)
        this.loadDoc(doc)
        this.markDirty()
      } catch (err) {
        window.alert(`Could not open this file.\n\n${(err as Error).message}`)
      }
      return
    }
    const res = await openFromDisk()
    if (!res) return
    this.loadDoc(res.doc)
    this.markDirty()
  }

  private loadDoc(doc: DocumentState) {
    this.store.doc = doc
    this.store.resetHistory()
    this.dismissedHint = false
    this.renderer.clearCache()
    this.store.markAllDirty()
    this.activeLayerId = doc.layers.at(-1)?.id ?? doc.layers[0].id
    this.store.notify('doc', 'history', 'selection')
    this.layers.setActive(this.activeLayerId)
    this.zoomFit()
  }

  private async saveToDisk() {
    if (desktop) {
      const contents = JSON.stringify(serialise(this.store.doc, this.store.view), null, 2)
      const path = await desktop.save(contents, `${slugify(this.store.doc.meta.title)}.wbd`)
      if (path) {
        this.status(`Saved ${path}`)
        toast('Board saved', 'ok')
      }
      return
    }
    const name = saveToDisk(this.store.doc)
    this.status(`Saved ${name}`)
    toast('Board saved', 'ok')
  }

  private async saveAs() {
    if (!desktop) return this.saveToDisk()
    const contents = JSON.stringify(serialise(this.store.doc, this.store.view), null, 2)
    const path = await desktop.save(contents, `${slugify(this.store.doc.meta.title)}.wbd`)
    if (path) this.status(`Saved ${path}`)
  }

  private openExportDialog() {
    const base = defaultExportOptions()
    exportDialog(
      document.body,
      {
        grid: this.store.doc.meta.showGrid,
        scale: base.scale,
        transparent: false,
        padding: base.padding,
        background: this.store.doc.meta.background,
      },
      (opts, format) => {
        if (format === 'png') void this.exportPng(opts)
        else {
          exportSVG(this.store.doc, opts)
          toast('Exported as SVG', 'ok')
        }
      },
    )
  }

  private async exportPng(opts: { grid: boolean; scale: number; padding: number; background: string | 'transparent' }) {
    if (desktop) {
      const dataUrl = await toPngDataUrl(this.store.doc, opts)
      if (!dataUrl) return
      const path = await desktop.exportPng(`${slugify(this.store.doc.meta.title)}.png`, dataUrl)
      if (path) {
        this.status(`Exported ${path}`)
        toast('Exported as PNG', 'ok')
      }
      return
    }
    await exportPNG(this.store.doc, opts)
    toast('Exported as PNG', 'ok')
  }

  private zoomFit() {
    const sel = this.store.selection.size
      ? (() => {
          const b = this.controller.selectionBounds()
          return b.w > 0 ? b : undefined
        })()
      : undefined
    this.controller.zoomToFit(sel)
  }

  /* ----------------------------- images --------------------------- */

  private pickImage() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = () => {
      const file = input.files?.[0]
      if (file) void readImage(file, (src, w, h) => this.controller.insertImage(src, w, h))
    }
    input.click()
  }

  /* ------------------------------ loop ---------------------------- */

  private requestFrame() {
    if (this.frameQueued) return
    this.frameQueued = true
    requestAnimationFrame(() => {
      this.frameQueued = false
      this.draw()
      if (this.renderer.needsFrame) this.requestFrame()
    })
  }
  private frameQueued = false

  private draw() {
    this.updateEmptyHint()
    this.renderer.render(
      this.store.doc,
      this.store.view,
      {
        selection: this.store.selection,
        showSelectionUI: this.store.selection.size > 0,
      },
      this.store.takeDirty(),
    )
  }

  /* ----------------------------- status --------------------------- */

  private statusTimer = 0

  private status(msg: string) {
    this.statusInfo.dataset.msg = msg
    this.statusBar.classList.add('has-message')
    this.statusInfo.textContent = msg
    window.clearTimeout(this.statusTimer)
    this.statusTimer = window.setTimeout(() => {
      this.statusBar.classList.remove('has-message')
      delete this.statusInfo.dataset.msg
      this.renderStatus()
    }, 2800)
  }

  private updateEmptyHint() {
    const empty = this.store.countElements() === 0
    this.emptyHint.classList.toggle('hidden', !empty || this.dismissedHint)
  }
  private dismissedHint = false

  private renderStatus() {
    if (this.statusInfo.dataset.msg) return
    const w = this.renderer.toWorld(this.lastPointer.x, this.lastPointer.y, this.store.view)
    const layer = this.store.layerAt(this.activeLayerId)
    const n = this.store.countElements()
    const parts = [
      `x ${Math.round(w.x)}   y ${Math.round(w.y)}`,
      `${Math.round(this.store.view.scale * 100)}%`,
      layer ? `layer: ${layer.name}` : '',
      `${n} object${n === 1 ? '' : 's'}`,
      this.store.selection.size ? `${this.store.selection.size} selected` : '',
    ].filter(Boolean)
    this.statusInfo.textContent = parts.join('   ·   ')
  }

  async start() {
    const saved = await loadBoard(autosaveKey)
    if (saved?.doc) {
      this.loadDoc(saved.doc)
      if (saved.view) this.store.setView(saved.view)
      this.topBar.setSaved('saved')
    } else {
      this.controller.zoomToFit()
    }
    this.requestFrame()
    window.setInterval(() => this.renderStatus(), 500)
  }
}

function readImage(file: File, cb: (src: string, w: number, h: number) => void) {
  const reader = new FileReader()
  reader.onload = () => {
    const src = String(reader.result)
    const img = new Image()
    img.onload = () => cb(src, img.naturalWidth, img.naturalHeight)
    img.onerror = () => cb(src, 320, 240)
    img.src = src
  }
  reader.readAsDataURL(file)
}

const app = new App()
void app.start()

/* a small debug surface for the browser console */
declare global {
  interface Window {
    adiDraw: {
      app: App
      store: Store
      tools: ToolStore
    }
  }
}
window.adiDraw = { app, store: app.store, tools: app.toolStore }
