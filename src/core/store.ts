import { SECTION_HEADER } from './sections'
import type {
  AnyElement,
  DocumentState,
  HistoryEntry,
  Layer,
  Op,
  Rect,
  StrokeElement,
  ViewState,
} from './types'
import { uid } from './geometry'

export const DOC_VERSION = 1

export function emptyDoc(): DocumentState {
  const layer: Layer = {
    id: uid('l'),
    name: 'Layer 1',
    visible: true,
    locked: false,
    opacity: 1,
  }
  return {
    version: DOC_VERSION,
    meta: {
      title: 'Untitled board',
      background: '#ffffff',
      canvasStyle: 'infinite',
      gridSize: 24,
      gridColor: '#d7dbe3',
      showGrid: true,
      snapToGrid: false,
    },
    layers: [layer],
    elements: { [layer.id]: [] },
  }
}

const clone = <T,>(v: T): T => structuredClone(v)

/* ------------------------------------------------------------------ *
 *  Store: document + history + reactive change notification
 * ------------------------------------------------------------------ */

export type ChangeKind = 'doc' | 'history' | 'selection' | 'view' | 'tools'

type Listener = (kind: Set<ChangeKind>) => void

export class Store {
  doc: DocumentState = emptyDoc()
  view: ViewState = { x: 0, y: 0, scale: 1 }
  selection = new Set<string>()

  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  /**
   * World-space rectangles that changed since the renderer last painted.
   * The renderer repaints only these, so drawing or dragging one object on a
   * large board costs the same as on a small one.
   */
  dirtyRects: Rect[] = []
  /** cleared and set whenever a change cannot be localised */
  private fullDirty = true
  private listeners = new Set<Listener>()
  private batching = 0
  private pending = new Set<ChangeKind>()
  private frame = 0

  historyLimit = 500

  /* ------------------------ dirty tracking ----------------------- */

  /** @param rect world-space area that changed; omit for "everything" */
  markDirty(rect?: Rect) {
    if (!rect) {
      this.fullDirty = true
      this.dirtyRects.length = 0
      return
    }
    this.dirtyRects.push(rect)
    if (this.dirtyRects.length > 400) {
      this.dirtyRects.length = 0
      this.fullDirty = true
    }
  }

  /** Consume the pending damage list. `null` means "repaint everything". */
  takeDirty(): Rect[] | null {
    if (this.fullDirty) {
      this.fullDirty = false
      this.dirtyRects.length = 0
      return null
    }
    if (!this.dirtyRects.length) return []
    const out = this.dirtyRects.slice()
    this.dirtyRects.length = 0
    return out
  }

  /* ------------------------- subscription ------------------------- */

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  notify(...kinds: ChangeKind[]) {
    for (const k of kinds) this.pending.add(k)
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      const set = this.pending
      this.pending = new Set()
      this.listeners.forEach((fn) => fn(set))
    })
  }

  /* --------------------------- history ---------------------------- */

  private _tx: { label: string; ops: Op[] } | null = null

  begin(label: string) {
    this.batching++
    if (this.batching === 1) this._tx = { label, ops: [] }
  }

  commit() {
    if (this.batching === 0) return
    this.batching--
    if (this.batching > 0) return
    const tx = this._tx
    this._tx = null
    if (!tx?.ops.length) return
    this.undoStack.push({ label: tx.label, ops: tx.ops })
    if (this.undoStack.length > this.historyLimit) this.undoStack.shift()
    this.redoStack.length = 0
    this.notify('doc', 'history')
  }

  /** Wipe the undo/redo history (used when a different board is loaded). */
  resetHistory() {
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.selection.clear()
    this.notify('history', 'selection')
  }

  get canUndo() {
    return this.undoStack.length > 0
  }
  get canRedo() {
    return this.redoStack.length > 0
  }
  get undoLabel() {
    return this.undoStack.at(-1)?.label ?? ''
  }
  get redoLabel() {
    return this.redoStack.at(-1)?.label ?? ''
  }
  get historyDepth() {
    return this.undoStack.length
  }

  undo() {
    const entry = this.undoStack.pop()
    if (!entry) return
    this.applyOps(entry.ops, true)
    this.redoStack.push(entry)
    this.notify('doc', 'history', 'selection')
  }

  redo() {
    const entry = this.redoStack.pop()
    if (!entry) return
    this.applyOps(entry.ops, false)
    this.undoStack.push(entry)
    this.notify('doc', 'history', 'selection')
  }

  private applyOps(ops: Op[], reverse: boolean) {
    const list = reverse ? [...ops].reverse() : ops
    for (const op of list) {
      switch (op.t) {
        case 'add':
          if (reverse) this.removeElements(op.layerId, new Set(op.elems.map((e) => e.id)))
          else this.pushElements(op.layerId, op.elems)
          break
        case 'del':
          if (reverse) this.pushElements(op.layerId, op.elems)
          else this.removeElements(op.layerId, new Set(op.elems.map((e) => e.id)))
          break
        case 'mod':
          this.replaceElements(op.layerId, reverse ? op.before : op.after)
          break
        case 'layerAdd':
          if (reverse) this.removeLayerRaw(op.index, op.layer.id)
          else this.insertLayerRaw(op.index, op.layer)
          break
        case 'layerDel':
          if (reverse) this.insertLayerRaw(op.index, op.layer, op.elems)
          else this.removeLayerRaw(op.index, op.layer.id)
          break
        case 'layerMod':
          this.patchLayer(reverse ? op.before : op.after)
          break
      }
    }
    this.selection = new Set([...this.selection].filter((id) => this.getElement(id)))
  }

  /* -------------------------- element ops ------------------------- */

  private bucket(layerId: string): AnyElement[] {
    let b = this.doc.elements[layerId]
    if (!b) {
      b = []
      this.doc.elements[layerId] = b
    }
    return b
  }

  private record(op: Op) {
    if (this._tx) this._tx.ops.push(op)
    else {
      this.undoStack.push({ label: 'edit', ops: [op] })
      if (this.undoStack.length > this.historyLimit) this.undoStack.shift()
      this.redoStack.length = 0
      this.notify('doc', 'history')
    }
  }

  getElement(id: string): AnyElement | undefined {
    for (const list of Object.values(this.doc.elements))
      for (const el of list) if (el.id === id) return el
    return undefined
  }

  allElements(): AnyElement[] {
    const out: AnyElement[] = []
    for (const layer of this.doc.layers) out.push(...this.bucket(layer.id))
    return out
  }

  countElements(): number {
    let n = 0
    for (const list of Object.values(this.doc.elements)) n += list.length
    return n
  }

  addElement(layerId: string, el: AnyElement, record = true) {
    this.bucket(layerId).push(el)
    this.markDirty(elementPaintBBox(el))
    if (record) this.record({ t: 'add', layerId, elems: [el] })
    else this.notify('doc')
  }

  addElements(layerId: string, elems: AnyElement[], record = true) {
    if (!elems.length) return
    this.bucket(layerId).push(...elems)
    for (const el of elems) this.markDirty(elementPaintBBox(el))
    if (record) this.record({ t: 'add', layerId, elems })
    else this.notify('doc')
  }

  pushElements(layerId: string, elems: AnyElement[]) {
    this.bucket(layerId).push(...elems)
    for (const el of elems) this.markDirty(elementPaintBBox(el))
    this.notify('doc')
  }

  removeElements(layerId: string, ids: Set<string>, record = true) {
    const bucket = this.bucket(layerId)
    const removed = bucket.filter((e) => ids.has(e.id))
    if (!removed.length) return
    const kept = bucket.filter((e) => !ids.has(e.id))
    this.doc.elements[layerId] = kept
    for (const el of removed) this.markDirty(elementPaintBBox(el))
    if (record) this.record({ t: 'del', layerId, elems: clone(removed) })
    else this.notify('doc')
  }

  removeElementsAcross(ids: Set<string>, record = true) {
    const ops: Op[] = []
    for (const layer of this.doc.layers) {
      const bucket = this.bucket(layer.id)
      const removed = bucket.filter((e) => ids.has(e.id))
      if (!removed.length) continue
      this.doc.elements[layer.id] = bucket.filter((e) => !ids.has(e.id))
      for (const el of removed) this.markDirty(elementPaintBBox(el))
      ops.push({ t: 'del', layerId: layer.id, elems: clone(removed) })
    }
    if (!ops.length) return
    if (record) this.applyRecord(ops)
    else this.notify('doc')
  }

  private applyRecord(ops: Op[]) {
    if (this._tx) this._tx.ops.push(...ops)
    else {
      this.undoStack.push({ label: 'edit', ops })
      if (this.undoStack.length > this.historyLimit) this.undoStack.shift()
      this.redoStack.length = 0
      this.notify('doc', 'history')
    }
  }

  /** Record ops that were already applied to the document directly. */
  pushOp(...ops: Op[]) {
    this.applyRecord(ops.filter((o) => o.t !== 'add' || o.elems.length))
  }

  replaceElements(layerId: string, next: AnyElement[]) {
    const map = new Map(next.map((e) => [e.id, e]))
    const bucket = this.bucket(layerId)
    // the old footprint has to be repainted too, or moving something leaves
    // a ghost behind
    for (const el of next) {
      const old = bucket.find((e) => e.id === el.id)
      if (old) this.markDirty(elementPaintBBox(old))
    }
    this.doc.elements[layerId] = bucket.map((e) => map.get(e.id) ?? e)
    for (const el of next) this.markDirty(elementPaintBBox(el))
    this.notify('doc')
  }

  /** Record a modification of the given elements. */
  modify(layerId: string, before: AnyElement[], after: AnyElement[]) {
    this.replaceElements(layerId, after)
    this.record({ t: 'mod', layerId, before: clone(before), after: clone(after) })
  }

  /** Replace elements in place (used during live drag, not recorded). */
  patch(elems: AnyElement[]) {
    const byLayer = new Map<string, Map<string, AnyElement>>()
    for (const el of elems) {
      let m = byLayer.get(el.layerId)
      if (!m) byLayer.set(el.layerId, (m = new Map()))
      m.set(el.id, el)
    }
    for (const [layerId, m] of byLayer) {
      const bucket = this.bucket(layerId)
      this.doc.elements[layerId] = bucket.map((e) => m.get(e.id) ?? e)
      for (const el of m.values()) {
        this.markDirty(elementPaintBBox(el))
        const old = bucket.find((e) => e.id === el.id)
        if (old) this.markDirty(elementPaintBBox(old))
      }
    }
    this.notify('doc')
  }

  /* ---------------------------- layers ----------------------------- */

  insertLayerRaw(index: number, layer: Layer, elems: AnyElement[] = []) {
    this.fullDirty = true
    this.doc.layers.splice(index, 0, layer)
    this.doc.elements[layer.id] = elems
    this.notify('doc')
  }

  removeLayerRaw(index: number, layerId: string) {
    this.fullDirty = true
    this.doc.layers.splice(index, 1)
    delete this.doc.elements[layerId]
    this.notify('doc')
  }

  patchLayer(layer: Layer) {
    const i = this.doc.layers.findIndex((l) => l.id === layer.id)
    if (i < 0) return
    this.doc.layers[i] = { ...layer }
    this.fullDirty = true
    this.notify('doc')
  }

  addLayer(name?: string, atIndex?: number) {
    const base = 'Layer'
    let n = this.doc.layers.length + 1
    let name2 = name ?? `${base} ${n}`
    while (this.doc.layers.some((l) => l.name === name2)) name2 = `${base} ${++n}`
    const layer: Layer = { id: uid('l'), name: name2, visible: true, locked: false, opacity: 1 }
    const index = atIndex ?? this.doc.layers.length
    this.insertLayerRaw(index, layer)
    this.record({ t: 'layerAdd', index, layer })
    return layer
  }

  deleteLayer(layerId: string) {
    const index = this.doc.layers.findIndex((l) => l.id === layerId)
    if (index < 0 || this.doc.layers.length <= 1) return
    const layer = this.doc.layers[index]
    const elems = this.bucket(layerId)
    this.removeLayerRaw(index, layerId)
    this.record({ t: 'layerDel', index, layer: clone(layer), elems: clone(elems) })
    this.selection = new Set([...this.selection].filter((id) => this.getElement(id)))
  }

  updateLayer(layerId: string, patch: Partial<Layer>, record = true) {
    const cur = this.doc.layers.find((l) => l.id === layerId)
    if (!cur) return
    const next = { ...cur, ...patch }
    this.patchLayer(next)
    if (record) this.record({ t: 'layerMod', before: clone(cur), after: clone(next) })
  }

  moveLayer(layerId: string, delta: number) {
    const i = this.doc.layers.findIndex((l) => l.id === layerId)
    const j = i + delta
    if (i < 0 || j < 0 || j >= this.doc.layers.length) return
    const layers = this.doc.layers.slice()
    const [l] = layers.splice(i, 1)
    layers.splice(j, 0, l)
    this.doc.layers = layers
    this.notify('doc')
  }

  layerAt(id: string): Layer | undefined {
    return this.doc.layers.find((l) => l.id === id)
  }

  isLocked(layerId: string) {
    return this.doc.layers.find((l) => l.id === layerId)?.locked ?? false
  }

  /* ------------------------- z-ordering --------------------------- */

  bringForward(ids: Set<string>) {
    this.fullDirty = true
    const ops: Op[] = []
    for (const layer of this.doc.layers) {
      const bucket = this.bucket(layer.id)
      const moving = bucket.filter((e) => ids.has(e.id))
      if (!moving.length) continue
      const rest = bucket.filter((e) => !ids.has(e.id))
      this.doc.elements[layer.id] = [...rest, ...moving]
      ops.push({
        t: 'mod',
        layerId: layer.id,
        before: clone(bucket),
        after: clone(this.doc.elements[layer.id]),
      })
    }
    if (ops.length) this.applyRecord(ops)
  }

  sendBackward(ids: Set<string>) {
    this.fullDirty = true
    const ops: Op[] = []
    for (const layer of this.doc.layers) {
      const bucket = this.bucket(layer.id)
      const moving = bucket.filter((e) => ids.has(e.id))
      if (!moving.length) continue
      const rest = bucket.filter((e) => !ids.has(e.id))
      this.doc.elements[layer.id] = [...moving, ...rest]
      ops.push({
        t: 'mod',
        layerId: layer.id,
        before: clone(bucket),
        after: clone(this.doc.elements[layer.id]),
      })
    }
    if (ops.length) this.applyRecord(ops)
  }

  bringToFront(ids: Set<string>) {
    this.fullDirty = true
    const ops: Op[] = []
    for (const layer of this.doc.layers) {
      const bucket = this.bucket(layer.id)
      const moving = bucket.filter((e) => ids.has(e.id))
      if (!moving.length) continue
      const rest = bucket.filter((e) => !ids.has(e.id))
      this.doc.elements[layer.id] = [...rest, ...moving]
      ops.push({
        t: 'mod',
        layerId: layer.id,
        before: clone(bucket),
        after: clone(this.doc.elements[layer.id]),
      })
    }
    if (ops.length) this.applyRecord(ops)
  }

  sendToBack(ids: Set<string>) {
    this.fullDirty = true
    const ops: Op[] = []
    for (const layer of this.doc.layers) {
      const bucket = this.bucket(layer.id)
      const moving = bucket.filter((e) => ids.has(e.id))
      if (!moving.length) continue
      const rest = bucket.filter((e) => !ids.has(e.id))
      this.doc.elements[layer.id] = [...moving, ...rest]
      ops.push({
        t: 'mod',
        layerId: layer.id,
        before: clone(bucket),
        after: clone(this.doc.elements[layer.id]),
      })
    }
    if (ops.length) this.applyRecord(ops)
  }

  /* ------------------------- selection ---------------------------- */

  setSelection(ids: Iterable<string>) {
    this.selection = new Set(ids)
    this.notify('selection')
  }
  toggleSelection(id: string) {
    if (this.selection.has(id)) this.selection.delete(id)
    else this.selection.add(id)
    this.notify('selection')
  }
  clearSelection() {
    if (!this.selection.size) return
    this.selection = new Set()
    this.notify('selection')
  }
  get selectedElements(): AnyElement[] {
    return this.allElements().filter((e) => this.selection.has(e.id))
  }

  /* --------------------------- viewport --------------------------- */

  setView(v: Partial<ViewState>) {
    Object.assign(this.view, v)
    this.notify('view')
  }

  /** Call when board-level settings (background, grid) change. */
  markAllDirty() {
    this.markDirty()
  }
}

/* ------------------------------------------------------------------ *
 *  Element geometry helpers
 * ------------------------------------------------------------------ */

export function elementBBox(el: AnyElement): Rect {
  switch (el.kind) {
    case 'section': {
      // folded, a section *is* its title band, so the box has to say so or the
      // selection handles and hit test disagree with what is on screen
      const pad = 3
      const h = el.collapsed ? Math.min(el.h, SECTION_HEADER) : el.h
      return { x: el.x - pad, y: el.y - pad, w: el.w + pad * 2, h: h + pad * 2 }
    }
    case 'stroke': {
      const n = el.pts.length / 3
      if (!n) return { x: el.x, y: el.y, w: 0, h: 0 }
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (let i = 0; i < n; i++) {
        const x = el.pts[i * 3]
        const y = el.pts[i * 3 + 1]
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
      const pad = el.style.size / 2 + 1
      return { x: el.x + minX - pad, y: el.y + minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 }
    }
    case 'shape': {
      const pad = el.style.stroke.size / 2 + 2
      const x = Math.min(el.x, el.x2)
      const y = Math.min(el.y, el.y2)
      const w = Math.abs(el.x2 - el.x)
      const h = Math.abs(el.y2 - el.y)
      const isLine = el.style.shape === 'line' || el.style.shape === 'arrow'
      const arrow = isLine && el.style.arrowHead !== 'none' ? el.style.stroke.size * 3 : 0
      return {
        x: x - pad - arrow,
        y: y - pad - arrow,
        w: w + (pad + arrow) * 2,
        h: h + (pad + arrow) * 2,
      }
    }
    case 'text': {
      const lines = el.text.split('\n')
      const lh = el.style.fontSize * el.style.lineHeight
      return { x: el.x, y: el.y, w: el.width, h: lh * lines.length }
    }
    case 'note':
      return { x: el.x, y: el.y, w: el.w, h: el.h }
    case 'image':
      return { x: el.x, y: el.y, w: el.w, h: el.h }
  }
}

/**
 * How far a painted element extends past its bounding box. Sticky notes cast a
 * shadow, so a dirty rectangle that stops at the bbox would clip the shadow and
 * leave a visible seam when the region is repainted.
 */
export function paintBleed(el: AnyElement) {
  if (el.kind === 'note') return 18
  if (el.kind === 'shape' && el.style.arrowHead !== 'none') return el.style.stroke.size * 4
  return 0
}

/** Bounding box grown to cover everything the element actually paints. */
export function elementPaintBBox(el: AnyElement): Rect {
  const b = elementBBox(el)
  const pad = paintBleed(el)
  return pad ? { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 } : b
}

export function translateElement(el: AnyElement, dx: number, dy: number): AnyElement {
  const next = structuredClone(el)
  next.x += dx
  next.y += dy
  return next
}

export function isStrokeElement(el: AnyElement): el is StrokeElement {
  return el.kind === 'stroke'
}
