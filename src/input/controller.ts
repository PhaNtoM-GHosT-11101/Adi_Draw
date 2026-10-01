import type {
  AnyElement,
  ImageElement,
  NoteElement,
  Rect,
  ShapeElement,
  ShapeStyle,
  StrokeElement,
  StrokeStyle,
  TextElement,
  TextStyle,
  Tool,
} from '../core/types'
import { Store, elementBBox, elementPaintBBox } from '../core/store'
import { Renderer } from '../render/renderer'
import { clamp, dist, rectFrom, uid, roundTo, unionRects } from '../core/geometry'
import { StrokeBuilder } from '../core/stroke'
import { tiltAmount, twistAmount } from '../core/filters'
import { constrainBox, constrainLine, isLineShape } from '../core/shapes'
import { applyMatrix, boxToBox, rotateAbout, translate } from '../core/transform'
import { recogniseInk } from '../core/recognise'

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

type Mode =
  | 'idle'
  | 'draw'
  | 'shape'
  | 'note'
  | 'marquee'
  | 'move'
  | 'scale'
  | 'rotate'
  | 'pan'
  | 'erase'

export interface ControllerHooks {
  onRequestText: (payload: {
    x: number
    y: number
    width: number
    text: string
    style: TextStyle
    element?: TextElement
    note?: NoteElement
  }) => void
  onRequestImage: () => void
  onAfterStroke: (tool: Tool) => void
  onDirty: () => void
}

export interface ControllerOptions {
  palmRejection: boolean
}

/** Store absolute sampled points on a stroke, relative to its origin. */
function setStrokePoints(el: StrokeElement, abs: number[]): boolean {
  if (abs.length < 3) {
    el.pts = [0, 0, abs.length ? abs[2] : 0]
    el.x = abs[0] ?? 0
    el.y = abs[1] ?? 0
    return true
  }
  const ox = abs[0]
  const oy = abs[1]
  el.x = ox
  el.y = oy
  const rel = new Array<number>(abs.length - 3)
  for (let i = 3; i < abs.length; i += 3) {
    rel[i - 3] = abs[i] - ox
    rel[i - 2] = abs[i + 1] - oy
    rel[i - 1] = abs[i + 2]
  }
  el.pts = rel
  return true
}

export class Controller {
  private mode: Mode = 'idle'
  private startScreen = { x: 0, y: 0 }
  private startWorld = { x: 0, y: 0 }
  private liveEl: AnyElement | null = null
  private builder: StrokeBuilder | null = null
  private activePointer: number | null = null
  private spaceDown = false
  private shiftDown = false
  private altDown = false
  private sawPen = false
  private lastPenTime = 0
  private pinch: { d: number; cx: number; cy: number; scale: number } | null = null
  private pointers = new Map<number, { x: number; y: number }>()
  private pointerTypes = new Map<number, string>()

  private dragBox: Rect | null = null
  private selectionBox: Rect | null = null
  private selectionBefore: AnyElement[] = []
  private handle: Handle | null = null
  private rotateStart = 0
  private erased = new Map<string, AnyElement>()
  private noteStart: { x: number; y: number; sx: number; sy: number; moved: boolean } | null = null

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly store: Store,
    readonly renderer: Renderer,
    readonly getTool: () => Tool,
    readonly getLayer: () => string,
    readonly hooks: ControllerHooks,
    public options: ControllerOptions,
  ) {
    this.bind()
  }

  get isDrawing() {
    return this.mode === 'draw' || this.mode === 'shape' || this.mode === 'note'
  }
  get isPanning() {
    return this.mode === 'pan'
  }
  get isSpaceDown() {
    return this.spaceDown
  }
  get liveElement() {
    return this.liveEl
  }
  get marqueeBox() {
    return this.dragBox
  }

  /* ----------------------------- events --------------------------- */

  private bind() {
    const c = this.canvas
    c.addEventListener('pointerdown', this.onDown)
    c.addEventListener('pointermove', this.onMove)
    c.addEventListener('pointerup', this.onUp)
    c.addEventListener('pointercancel', this.onCancel)
    c.addEventListener('pointerleave', this.onLeave)
    c.addEventListener('wheel', this.onWheel, { passive: false })
    c.addEventListener('dblclick', this.onDblClick)
    c.addEventListener('contextmenu', (e) => e.preventDefault())

    this.onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') this.shiftDown = true
      if (e.key === 'Alt') this.altDown = true
      if (e.code === 'Space' && !isTextTarget(e.target)) {
        if (!this.spaceDown) c.classList.add('grabbing')
        this.spaceDown = true
        e.preventDefault()
      }
    }
    this.onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') this.shiftDown = false
      if (e.key === 'Alt') this.altDown = false
      if (e.code === 'Space') {
        this.spaceDown = false
        c.classList.remove('grabbing')
      }
    }
    this.onBlur = () => {
      this.shiftDown = false
      this.altDown = false
      this.spaceDown = false
      this.pointers.clear()
      this.pinch = null
      c.classList.remove('grabbing')
    }
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
  }

  private onKeyDown!: (e: KeyboardEvent) => void
  private onKeyUp!: (e: KeyboardEvent) => void
  private onBlur!: () => void

  destroy() {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
  }

  private local(e: { clientX: number; clientY: number }) {
    const r = this.canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  private shouldIgnore(e: PointerEvent) {
    if (e.pointerType === 'touch' && this.options.palmRejection && this.sawPen) {
      return performance.now() - this.lastPenTime < 1500
    }
    return false
  }

  /* ------------------------- preview damage ---------------------- */

  /**
   * The region painted on the previous frame of the gesture in progress.
   *
   * Every frame's damage rectangle must *contain* this one. Consecutive frames
   * are repainted independently, so if they only met edge to edge the strip
   * between them would keep the background and the stroke would appear
   * broken into segments with gaps.
   */
  private previewBox: Rect | null = null
  /** point index already handed to the renderer, for strokes that grow at one end */
  private markedFrom = 1

  /** Declare `box`, unioned with what this gesture painted last frame. */
  private claim(box: Rect, bleed: number) {
    const inflated = { x: box.x - bleed, y: box.y - bleed, w: box.w + bleed * 2, h: box.h + bleed * 2 }
    const region = this.previewBox ? unionRects(this.previewBox, inflated) : inflated
    this.store.markDirty(region)
    this.previewBox = region
  }

  /** Declare the whole area a live preview occupies (shapes, notes). */
  private markPreview(el: AnyElement) {
    this.claim(elementPaintBBox(el), 4)
  }

  /**
   * Declare only the newly grown tail of a stroke, plus the previous frame's
   * rectangle. Marking the full bbox every frame would make a long stroke's
   * repaint cost grow quadratically.
   */
  private markStrokeTail(el: StrokeElement, pointCount: number) {
    // `el.pts` holds one fewer point than the builder: its origin is el.x/el.y
    const count = Math.min(pointCount, el.pts.length / 3)
    const from = Math.max(0, Math.min(this.markedFrom - 1, count - 1))
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let i = from; i < count; i++) {
      const x = el.x + el.pts[i * 3]
      const y = el.y + el.pts[i * 3 + 1]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    this.markedFrom = Math.max(1, count)
    if (!Number.isFinite(minX) || !Number.isFinite(maxX) || minX > maxX) return
    // half the widest width, plus room for the soft edge of the fill
    this.claim({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }, el.style.size * 0.5 + 2.5)
  }

  /** One clean repaint of the finished stroke, so nothing is left at a seam. */
  private markStrokeSettled(el: AnyElement) {
    this.claim(elementPaintBBox(el), 4)
    this.previewBox = null
  }

  private resetPreviewDamage() {
    this.previewBox = null
    this.markedFrom = 1
  }

  /* ---------------------------- pointer down ---------------------- */

  private onDown = (e: PointerEvent) => {
    if (e.button === 2) return
    if (e.pointerType === 'pen') {
      this.sawPen = true
      this.lastPenTime = performance.now()
    }
    if (this.shouldIgnore(e)) return

    this.canvas.setPointerCapture(e.pointerId)
    const s = this.local(e)
    this.pointers.set(e.pointerId, s)
    this.pointerTypes.set(e.pointerId, e.pointerType)

    if (this.pointers.size === 2) {
      this.beginPinch()
      return
    }
    if (this.pointers.size > 2) return

    const w = this.renderer.toWorld(s.x, s.y, this.store.view)
    this.startScreen = s
    this.startWorld = w
    this.activePointer = e.pointerId

    // panning: middle button, space-drag, or alt-drag with any tool
    if (e.button === 1 || this.spaceDown || this.altDown) {
      this.mode = 'pan'
      this.canvas.classList.add('grabbing')
      return
    }

    const tool = this.getTool()
    switch (tool.category) {
      case 'select':
        this.beginSelect(s, w, e)
        break
      case 'laser':
        this.beginLaser(w, tool)
        break
      case 'freehand':
        this.beginDraw(w, e)
        break
      case 'eraser':
        this.beginErase(w, tool)
        break
      case 'shape':
        this.beginShape(w, tool)
        break
      case 'note':
        this.beginNote(s, w, tool)
        break
      case 'text': {
        this.mode = 'idle'
        this.activePointer = null
        this.store.clearSelection()
        const payload = { x: w.x, y: w.y, width: 340, text: '', style: textStyleOf(tool) }
        // defer so the browser's own mousedown focus change cannot steal focus
        // away from the editor we are about to open
        window.setTimeout(() => this.hooks.onRequestText(payload), 0)
        break
      }
      case 'image':
        this.mode = 'idle'
        this.activePointer = null
        this.hooks.onRequestImage()
        break
    }
  }

  private beginPinch() {
    const pts = [...this.pointers.values()]
    if (pts.length < 2) return
    const [a, b] = pts
    this.pinch = {
      d: Math.max(1, dist(a.x, a.y, b.x, b.y)),
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      scale: this.store.view.scale,
    }
    this.mode = 'pan'
    this.activePointer = null
  }

  /* ------------------------------ draw ---------------------------- */

  private beginDraw(w: { x: number; y: number }, e: PointerEvent) {
    const tool = this.getTool()
    this.mode = 'draw'
    const style = strokeStyleOf(tool)
    this.builder = new StrokeBuilder(style)
    this.builder.push(w.x, w.y, pressureOf(e), performance.now())
    const el: StrokeElement = {
      id: uid('s'),
      kind: 'stroke',
      layerId: this.getLayer(),
      opacity: tool.opacity,
      created: Date.now(),
      x: w.x,
      y: w.y,
      pts: [0, 0, pressureOf(e)],
      style,
    }
    this.liveEl = el
    this.store.addElement(el.layerId, el, false)
  }

  /* --------------------------- laser ------------------------------ */

  private laserActive = false

  private beginLaser(w: { x: number; y: number }, tool: Tool) {
    this.mode = 'draw'
    this.laserActive = true
    this.renderer.setLaser(tool.color, tool.laserTrail)
    this.renderer.addTrailPoint(w.x, w.y, Math.max(1.5, tool.size / 2))
    this.store.notify('view')
  }

  /* ----------------------------- eraser --------------------------- */

  private beginErase(w: { x: number; y: number }, tool: Tool) {
    if (tool.eraserMode === 'element') {
      this.mode = 'erase'
      this.erased = new Map()
      this.eraseAt(w.x, w.y, tool.size)
    } else {
      const style: StrokeStyle = {
        color: '#000000',
        size: tool.size,
        opacity: 1,
        blend: 'destination-out',
        pressure: 0,
        smoothing: 0.3,
        response: 0.4,
        pressureGamma: 1,
        tilt: 0,
        widthSmooth: 0,
        texture: 'none',
        textureScale: 1,
        textureBody: 0.3,
        velocity: 0,
        minWidth: 1,
        taperIn: 0,
        taperOut: 0,
      }
      this.builder = new StrokeBuilder(style)
      this.builder.push(w.x, w.y, 0.5, performance.now(), 0)
      const el: StrokeElement = {
        id: uid('e'),
        kind: 'stroke',
        layerId: this.getLayer(),
        opacity: 1,
        created: Date.now(),
        x: w.x,
        y: w.y,
        pts: [0, 0, 0.5],
        style,
      }
      this.liveEl = el
      this.mode = 'draw'
      this.store.addElement(el.layerId, el, false)
    }
  }

  private eraseAt(x: number, y: number, size: number) {
    const tol = size / 2
    const layers = this.store.doc.layers
    let changed = false
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i]
      if (!layer.visible || layer.locked) continue
      for (const el of this.store.doc.elements[layer.id] ?? []) {
        if (this.erased.has(el.id)) continue
        if (this.renderer.hitTest(el, x, y, tol)) {
          this.erased.set(el.id, structuredClone(el))
          changed = true
        }
      }
    }
    if (changed) {
      this.store.removeElementsAcross(new Set(this.erased.keys()), false)
      this.store.notify('doc')
    }
  }

  /* ------------------------------ shape --------------------------- */

  private beginShape(w: { x: number; y: number }, tool: Tool) {
    this.mode = 'shape'
    const el: ShapeElement = {
      id: uid('g'),
      kind: 'shape',
      layerId: this.getLayer(),
      opacity: tool.opacity,
      created: Date.now(),
      x: w.x,
      y: w.y,
      x2: w.x,
      y2: w.y,
      style: shapeStyleOf(tool),
    }
    this.liveEl = el
    this.store.addElement(el.layerId, el, false)
  }

  /* ------------------------------- note --------------------------- */

  private beginNote(s: { x: number; y: number }, w: { x: number; y: number }, tool: Tool) {
    this.mode = 'note'
    const el: NoteElement = {
      id: uid('n'),
      kind: 'note',
      layerId: this.getLayer(),
      opacity: 1,
      created: Date.now(),
      x: w.x,
      y: w.y,
      w: tool.size,
      h: tool.size,
      color: tool.noteColor,
      text: '',
      style: textStyleOf(tool),
    }
    this.liveEl = el
    this.store.addElement(el.layerId, el, false)
    this.noteStart = { x: w.x, y: w.y, sx: s.x, sy: s.y, moved: false }
  }

  /* ------------------------------ select -------------------------- */

  private beginSelect(s: { x: number; y: number }, w: { x: number; y: number }, e: PointerEvent) {
    if (this.store.selection.size) {
      if (this.rotatorAt(s.x, s.y)) {
        this.mode = 'rotate'
        this.selectionBox = this.selectionBounds()
        this.selectionBefore = this.store.selectedElements
        this.rotateStart = Math.atan2(
          w.y - (this.selectionBox.y + this.selectionBox.h / 2),
          w.x - (this.selectionBox.x + this.selectionBox.w / 2),
        )
        return
      }
      const h = this.handleAt(s.x, s.y)
      if (h) {
        this.mode = 'scale'
        this.handle = h
        this.selectionBox = this.selectionBounds()
        this.selectionBefore = this.store.selectedElements
        return
      }
    }

    const hit = this.renderer.pick(this.store.doc, w.x, w.y, 6 / this.store.view.scale)
    if (hit) {
      if (e.shiftKey) this.store.toggleSelection(hit.id)
      else if (!this.store.selection.has(hit.id)) this.store.setSelection([hit.id])
      this.mode = 'move'
      this.selectionBefore = this.store.selectedElements
    } else {
      this.store.clearSelection()
      this.mode = 'marquee'
      this.dragBox = { x: w.x, y: w.y, w: 0, h: 0 }
    }
  }

  selectionBounds(): Rect {
    const els = this.store.selectedElements
    if (!els.length) return { x: 0, y: 0, w: 0, h: 0 }
    let b = elementBBox(els[0])
    for (let i = 1; i < els.length; i++) {
      const r = elementBBox(els[i])
      const x = Math.min(b.x, r.x)
      const y = Math.min(b.y, r.y)
      b = {
        x,
        y,
        w: Math.max(b.x + b.w, r.x + r.w) - x,
        h: Math.max(b.y + b.h, r.y + r.h) - y,
      }
    }
    return b
  }

  handleAt(sx: number, sy: number): Handle | null {
    if (!this.store.selection.size) return null
    const b = this.selectionBounds()
    const v = this.store.view
    const p0 = this.renderer.toScreen(b.x, b.y, v)
    const p1 = this.renderer.toScreen(b.x + b.w, b.y + b.h, v)
    const r = 9
    const pts: [Handle, number, number][] = [
      ['nw', p0.x, p0.y],
      ['n', (p0.x + p1.x) / 2, p0.y],
      ['ne', p1.x, p0.y],
      ['e', p1.x, (p0.y + p1.y) / 2],
      ['se', p1.x, p1.y],
      ['s', (p0.x + p1.x) / 2, p1.y],
      ['sw', p0.x, p1.y],
      ['w', p0.x, (p0.y + p1.y) / 2],
    ]
    for (const [h, x, y] of pts) if (Math.abs(sx - x) <= r && Math.abs(sy - y) <= r) return h
    return null
  }

  rotatorAt(sx: number, sy: number) {
    if (!this.store.selection.size) return false
    const b = this.selectionBounds()
    const v = this.store.view
    const c = this.renderer.toScreen(b.x + b.w / 2, b.y, v)
    return dist(sx, sy, c.x, c.y) < 20
  }

  /* ------------------------------ move ---------------------------- */

  private onMove = (e: PointerEvent) => {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, this.local(e))

    if (this.pinch && this.pointers.size >= 2) {
      this.updatePinch()
      return
    }
    if (this.activePointer === null) {
      if (e.pointerType === 'mouse') this.updateHover(e)
      return
    }
    if (e.pointerId !== this.activePointer) return
    if (e.pointerType === 'pen') this.lastPenTime = performance.now()
    if (this.shouldIgnore(e)) return

    const s = this.local(e)
    const w = this.renderer.toWorld(s.x, s.y, this.store.view)

    switch (this.mode) {
      case 'pan':
        this.store.setView({
          x: this.store.view.x + (s.x - this.startScreen.x),
          y: this.store.view.y + (s.y - this.startScreen.y),
        })
        this.startScreen = s
        break
      case 'draw':
        if (this.laserActive) this.sampleLaser(e)
        else this.sampleDraw(e)
        break
      case 'shape':
        this.updateShape(w, e)
        break
      case 'note':
        this.updateNote(s, w)
        break
      case 'erase':
        this.eraseAt(w.x, w.y, this.getTool().size)
        break
      case 'marquee':
        this.dragBox = rectFrom(this.startWorld.x, this.startWorld.y, w.x, w.y)
        this.store.setSelection(this.renderer.pickRect(this.store.doc, this.dragBox).map((el) => el.id))
        break
      case 'move':
        this.updateMove(w, e)
        break
      case 'scale':
        this.updateScale(w, e)
        break
      case 'rotate':
        this.updateRotate(w, e)
        break
      case 'idle':
        break
    }
  }

  private updateHover(e: PointerEvent) {
    const tool = this.getTool()
    const s = this.local(e)
    if (tool.category !== 'select') {
      this.canvas.style.cursor = tool.category === 'text' ? 'text' : 'crosshair'
      return
    }
    let cursor = 'default'
    if (this.store.selection.size) {
      if (this.rotatorAt(s.x, s.y)) cursor = 'grab'
      else if (this.handleAt(s.x, s.y)) cursor = handleCursor(this.handle)
    }
    if (cursor === 'default') {
      const w = this.renderer.toWorld(s.x, s.y, this.store.view)
      const hit = this.renderer.pick(this.store.doc, w.x, w.y, 6 / this.store.view.scale)
      cursor = hit ? 'move' : 'default'
    }
    this.canvas.style.cursor = cursor
  }

  private sampleDraw(e: PointerEvent) {
    const el = this.liveEl
    const builder = this.builder
    if (!el || el.kind !== 'stroke' || !builder) return
    const tool = this.getTool()
    const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
    const batch = coalesced.length ? coalesced : [e]
    const fallback = performance.now()
    const v = this.store.view
    for (const ev of batch) {
      const s = this.local(ev)
      const p = this.renderer.toWorld(s.x, s.y, v)
      // each sample keeps its own timestamp so the filter sees a real dt
      const ts = ev.timeStamp > 0 && ev.timeStamp <= fallback + 1 ? ev.timeStamp : fallback
      builder.push(p.x, p.y, pressureOf(ev), ts, tiltOf(ev, tool.tilt))
    }
    if (builder.out.length >= 3) {
      setStrokePoints(el, builder.out)
      this.renderer.invalidate(el.id)
      this.markStrokeTail(el, builder.out.length / 3 - 1)
      this.store.notify('doc')
    }
  }

  private sampleLaser(e: PointerEvent) {
    const tool = this.getTool()
    const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
    const batch = coalesced.length ? coalesced : [e]
    const v = this.store.view
    for (const ev of batch) {
      const s = this.local(ev)
      const p = this.renderer.toWorld(s.x, s.y, v)
      const w = Math.max(1.5, (tool.size * (0.6 + 0.4 * pressureOf(ev))) / 2)
      this.renderer.addTrailPoint(p.x, p.y, w)
    }
    this.store.notify('view')
  }

  private updateShape(w: { x: number; y: number }, e: PointerEvent) {
    const el = this.liveEl
    if (!el || el.kind !== 'shape') return
    const shift = e.shiftKey || this.shiftDown
    if (isLineShape(el.style.shape)) {
      const [x2, y2] = constrainLine(el.x, el.y, w.x, w.y, shift)
      el.x2 = x2
      el.y2 = y2
    } else if (e.altKey) {
      el.x2 = el.x + (el.x - w.x)
      el.y2 = el.y + (el.y - w.y)
    } else {
      const [x2, y2] = constrainBox(el.x, el.y, w.x, w.y, shift)
      el.x2 = x2
      el.y2 = y2
    }
    if (this.store.doc.meta.snapToGrid) {
      const g = this.store.doc.meta.gridSize
      el.x = roundTo(el.x, g)
      el.y = roundTo(el.y, g)
      el.x2 = roundTo(el.x2, g)
      el.y2 = roundTo(el.y2, g)
    }
    this.renderer.invalidate(el.id)
    this.markPreview(el)
    this.store.notify('doc')
  }

  private updateNote(s: { x: number; y: number }, w: { x: number; y: number }) {
    const el = this.liveEl
    if (!el || el.kind !== 'note' || !this.noteStart) return
    if (!this.noteStart.moved && dist(s.x, s.y, this.noteStart.sx, this.noteStart.sy) <= 6) return
    this.noteStart.moved = true
    el.x = Math.min(this.noteStart.x, w.x)
    el.y = Math.min(this.noteStart.y, w.y)
    el.w = Math.max(20, Math.abs(w.x - this.noteStart.x))
    el.h = Math.max(20, Math.abs(w.y - this.noteStart.y))
    this.markPreview(el)
    this.store.notify('doc')
  }

  private updateMove(w: { x: number; y: number }, e: PointerEvent) {
    let dx = w.x - this.startWorld.x
    let dy = w.y - this.startWorld.y
    if (e.shiftKey) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0
      else dx = 0
    }
    if (dx === 0 && dy === 0) return
    this.store.patch(this.selectionBefore.map((el) => translate(el, dx, dy)))
  }

  private updateScale(w: { x: number; y: number }, e: PointerEvent) {
    if (!this.selectionBox || !this.handle) return
    const b = this.selectionBox
    const h = this.handle
    let x1 = b.x
    let y1 = b.y
    let x2 = b.x + b.w
    let y2 = b.y + b.h
    if (h.includes('e')) x2 = w.x
    if (h.includes('w')) x1 = w.x
    if (h.startsWith('n')) y1 = w.y
    if (h.startsWith('s')) y2 = w.y
    if (e.shiftKey) {
      const ar = b.w / (b.h || 1)
      const nw = Math.abs(x2 - x1)
      const nh = Math.abs(y2 - y1)
      if (nw / ar > nh) {
        if (h.startsWith('n')) y1 = y2 - nw / ar
        else y2 = y1 + nw / ar
      } else if (h.includes('w')) x1 = x2 - nh * ar
      else x2 = x1 + nh * ar
    }
    if (x2 - x1 < 1) x2 = x1 + 1
    if (y2 - y1 < 1) y2 = y1 + 1
    const m = boxToBox(b, rectFrom(x1, y1, x2, y2))
    this.store.patch(this.selectionBefore.map((el) => applyMatrix(el, m)))
  }

  private updateRotate(w: { x: number; y: number }, e: PointerEvent) {
    if (!this.selectionBox) return
    const b = this.selectionBox
    const cx = b.x + b.w / 2
    const cy = b.y + b.h / 2
    let delta = Math.atan2(w.y - cy, w.x - cx) - this.rotateStart
    if (e.shiftKey) delta = Math.round(delta / (Math.PI / 12)) * (Math.PI / 12)
    const m = rotateAbout(b, delta)
    this.store.patch(this.selectionBefore.map((el) => applyMatrix(el, m)))
  }

  /* ---------------------------- pointer up ------------------------ */

  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId)
    this.pointerTypes.delete(e.pointerId)
    if (this.pointers.size < 2) this.pinch = null
    if (e.pointerId !== this.activePointer) return
    this.finish()
    this.activePointer = null
  }

  private onCancel = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId)
    if (e.pointerId !== this.activePointer) return
    this.cancelLive()
    this.activePointer = null
  }

  private onLeave = (e: PointerEvent) => {
    if (this.activePointer === null) void e
  }

  private finish() {
    const tool = this.getTool()
    this.canvas.classList.remove('grabbing')
    if (this.laserActive) {
      this.laserActive = false
      this.mode = 'idle'
      this.store.notify('view')
      return
    }

    switch (this.mode) {
      case 'draw': {
        const el = this.liveEl
        const builder = this.builder
        if (el && el.kind === 'stroke' && builder) {
          builder.flush()
          const pts = builder.finish(0.3)
          if (pts.length === 0) {
            this.store.removeElements(el.layerId, new Set([el.id]), false)
          } else {
            setStrokePoints(el, pts)
            this.renderer.invalidate(el.id)
            this.markStrokeSettled(el)
            this.store.pushOp({ t: 'add', layerId: el.layerId, elems: [structuredClone(el)] })
            this.hooks.onAfterStroke(tool)
            this.hooks.onDirty()
          }
        }
        this.liveEl = null
        this.builder = null
        break
      }
      case 'shape': {
        const el = this.liveEl
        if (el && el.kind === 'shape') {
          const b = elementBBox(el)
          if (b.w > 1.5 && b.h > 1.5) {
            this.store.pushOp({ t: 'add', layerId: el.layerId, elems: [structuredClone(el)] })
            this.hooks.onAfterStroke(tool)
            this.hooks.onDirty()
          } else {
            this.store.removeElements(el.layerId, new Set([el.id]), false)
          }
        }
        this.liveEl = null
        break
      }
      case 'note': {
        const el = this.liveEl
        if (el && el.kind === 'note') {
          if (!this.noteStart?.moved) {
            el.w = tool.size
            el.h = tool.size
          }
          this.store.pushOp({ t: 'add', layerId: el.layerId, elems: [structuredClone(el)] })
          this.hooks.onRequestText({
            x: el.x,
            y: el.y,
            width: el.w - 28,
            text: '',
            style: el.style,
            note: structuredClone(el),
          })
          this.hooks.onDirty()
        }
        this.liveEl = null
        this.noteStart = null
        break
      }
      case 'erase': {
        if (this.erased.size) {
          const byLayer = new Map<string, AnyElement[]>()
          for (const el of this.erased.values()) {
            let arr = byLayer.get(el.layerId)
            if (!arr) byLayer.set(el.layerId, (arr = []))
            arr.push(el)
          }
          for (const [layerId, elems] of byLayer)
            this.store.pushOp({ t: 'del', layerId, elems })
          this.hooks.onDirty()
        }
        this.erased.clear()
        break
      }
      case 'move':
      case 'scale':
      case 'rotate': {
        const before = this.selectionBefore
        const after = this.store.selectedElements
        if (!sameElements(before, after)) {
          const byLayer = new Map<string, AnyElement[]>()
          for (const el of after) {
            let arr = byLayer.get(el.layerId)
            if (!arr) byLayer.set(el.layerId, (arr = []))
            arr.push(el)
          }
          for (const [layerId, next] of byLayer) {
            this.store.modify(layerId, before.filter((b) => b.layerId === layerId), next)
          }
        }
        this.selectionBefore = []
        this.handle = null
        this.selectionBox = null
        break
      }
      case 'marquee':
        this.dragBox = null
        break
    }
    this.mode = 'idle'
    this.resetPreviewDamage()
    this.store.notify('doc')
  }

  private cancelLive() {
    if (this.liveEl) {
      this.store.removeElements(this.liveEl.layerId, new Set([this.liveEl.id]), false)
      this.liveEl = null
    }
    this.builder = null
    this.mode = 'idle'
    this.noteStart = null
    this.resetPreviewDamage()
  }

  /** Escape / right-click cancellation while a gesture is in flight. */
  abort() {
    if (this.mode === 'move' || this.mode === 'scale' || this.mode === 'rotate') {
      this.store.patch(this.selectionBefore)
      this.mode = 'idle'
      this.selectionBefore = []
    } else if (this.mode === 'marquee') {
      this.store.clearSelection()
      this.dragBox = null
      this.mode = 'idle'
    } else {
      this.cancelLive()
    }
    this.activePointer = null
    this.store.notify('doc')
  }

  /* ------------------------------ wheel --------------------------- */

  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const s = this.local(e)
    if (e.ctrlKey || e.metaKey) this.zoomAt(s.x, s.y, Math.exp(-e.deltaY / 220))
    else if (e.shiftKey) this.store.setView({ x: this.store.view.x - e.deltaY, y: this.store.view.y })
    else this.store.setView({ x: this.store.view.x - e.deltaX, y: this.store.view.y - e.deltaY })
  }

  private updatePinch() {
    if (!this.pinch) return
    const pts = [...this.pointers.values()]
    if (pts.length < 2) return
    const [a, b] = pts
    const d = Math.max(1, dist(a.x, a.y, b.x, b.y))
    const cx = (a.x + b.x) / 2
    const cy = (a.y + b.y) / 2
    const scale = clamp((this.pinch.scale * d) / this.pinch.d, 0.05, 40)
    const w = this.renderer.toWorld(this.pinch.cx, this.pinch.cy, this.store.view)
    this.store.setView({ scale, x: cx - w.x * scale, y: cy - w.y * scale })
  }

  zoomAt(sx: number, sy: number, factor: number) {
    const v = this.store.view
    const scale = clamp(v.scale * factor, 0.05, 40)
    const w = this.renderer.toWorld(sx, sy, v)
    this.store.setView({ scale, x: sx - w.x * scale, y: sy - w.y * scale })
  }
  panBy(dx: number, dy: number) {
    this.store.setView({ x: this.store.view.x + dx, y: this.store.view.y + dy })
  }
  zoomBy(factor: number) {
    this.zoomAt(this.renderer.width / 2, this.renderer.height / 2, factor)
  }
  setZoom(scale: number) {
    this.zoomAt(this.renderer.width / 2, this.renderer.height / 2, scale / this.store.view.scale)
  }

  contentBounds(): Rect | null {
    const els = this.store.allElements()
    if (!els.length) return null
    let b = elementBBox(els[0])
    for (let i = 1; i < els.length; i++) {
      const r = elementBBox(els[i])
      const x = Math.min(b.x, r.x)
      const y = Math.min(b.y, r.y)
      b = { x, y, w: Math.max(b.x + b.w, r.x + r.w) - x, h: Math.max(b.y + b.h, r.y + r.h) - y }
    }
    return b
  }

  zoomToFit(rect?: Rect) {
    const r = rect ?? this.contentBounds()
    if (!r || r.w <= 0 || r.h <= 0) {
      this.store.setView({ x: 0, y: 0, scale: 1 })
      return
    }
    const pad = 64
    const scale = clamp(
      Math.min((this.renderer.width - pad * 2) / r.w, (this.renderer.height - pad * 2) / r.h),
      0.05,
      8,
    )
    this.store.setView({
      scale,
      x: this.renderer.width / 2 - (r.x + r.w / 2) * scale,
      y: this.renderer.height / 2 - (r.y + r.h / 2) * scale,
    })
  }

  /* ------------------------------ actions ------------------------- */

  insertImage(src: string, w: number, h: number) {
    const view = this.store.view
    const cx = (this.renderer.width / 2 - view.x) / view.scale
    const cy = (this.renderer.height / 2 - view.y) / view.scale
    const s = Math.min(1, 760 / Math.max(1, w))
    const el: ImageElement = {
      id: uid('img'),
      kind: 'image',
      layerId: this.getLayer(),
      opacity: 1,
      created: Date.now(),
      x: cx - (w * s) / 2,
      y: cy - (h * s) / 2,
      w: w * s,
      h: h * s,
      src,
    }
    this.store.addElement(el.layerId, el)
    this.store.setSelection([el.id])
    this.hooks.onDirty()
  }

  deleteSelection() {
    if (!this.store.selection.size) return
    this.store.begin('Delete')
    this.store.removeElementsAcross(this.store.selection)
    this.store.commit()
    this.store.clearSelection()
    this.hooks.onDirty()
  }

  duplicateSelection() {
    const sel = this.store.selectedElements
    if (!sel.length) return
    const copies = sel.map((el) => {
      const c = translate(el, 24, 24)
      c.id = uid('c')
      return c
    })
    this.store.begin('Duplicate')
    this.store.addElements(copies[0].layerId, copies)
    this.store.commit()
    this.store.setSelection(copies.map((c) => c.id))
    this.hooks.onDirty()
  }

  /**
   * Snap a drawn stroke to the shape it was aiming at.
   *
   * The stroke's own id, layer and style carry over, so the result stays
   * selected and one undo puts the ink back exactly as it was.
   */
  inkToShape(): boolean {
    const sel = this.store.selectedElements
    if (sel.length !== 1 || sel[0].kind !== 'stroke') return false
    const stroke = sel[0] as StrokeElement

    const ink = []
    for (let i = 0; i + 1 < stroke.pts.length; i += 3) {
      ink.push({ x: stroke.x + stroke.pts[i], y: stroke.y + stroke.pts[i + 1] })
    }
    const found = recogniseInk(ink)
    if (!found) return false

    const shape: ShapeElement = {
      id: stroke.id,
      kind: 'shape',
      layerId: stroke.layerId,
      opacity: stroke.opacity,
      created: stroke.created,
      x: found.box.x,
      y: found.box.y,
      x2: found.box.x + found.box.w,
      y2: found.box.y + found.box.h,
      style: {
        stroke: { ...stroke.style },
        fill: null,
        fillOpacity: 0,
        dash: null,
        corner: 0,
        sides: 0,
        arrowHead: 'none',
        shape: found.kind,
      },
    }

    this.store.begin('Ink to shape')
    this.store.modify(stroke.layerId, [stroke], [shape])
    this.store.commit()
    this.hooks.onDirty()
    return true
  }

  /** True when a single stroke is selected and is close enough to a shape. */
  canInkToShape(): boolean {
    const sel = this.store.selectedElements
    if (sel.length !== 1 || sel[0].kind !== 'stroke') return false
    const stroke = sel[0] as StrokeElement
    const ink = []
    for (let i = 0; i + 1 < stroke.pts.length; i += 3) {
      ink.push({ x: stroke.x + stroke.pts[i], y: stroke.y + stroke.pts[i + 1] })
    }
    return recogniseInk(ink) !== null
  }

  selectAll() {
    this.store.setSelection(
      this.store
        .allElements()
        .filter((el) => !this.store.isLocked(el.layerId))
        .map((el) => el.id),
    )
  }

  onDblClick = (e: MouseEvent) => {
    const s = this.local(e)
    const w = this.renderer.toWorld(s.x, s.y, this.store.view)
    const hit = this.renderer.pick(this.store.doc, w.x, w.y, 6 / this.store.view.scale)
    if (!hit) return
    if (hit.kind === 'note') {
      this.hooks.onRequestText({
        x: hit.x,
        y: hit.y,
        width: hit.w - 28,
        text: hit.text,
        style: hit.style,
        note: structuredClone(hit),
      })
    } else if (hit.kind === 'text') {
      this.hooks.onRequestText({
        x: hit.x,
        y: hit.y,
        width: hit.width,
        text: hit.text,
        style: hit.style,
        element: structuredClone(hit),
      })
    }
  }
}

/* ------------------------------ helpers ---------------------------- */

function isTextTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

/** Tilt scaled by the tool's tilt setting, 0..1. */
function tiltOf(e: PointerEvent, amount: number) {
  if (!amount) return 0
  const raw = tiltAmount(e.tiltX ?? 0, e.tiltY ?? 0)
  const twist = twistAmount(e.twist ?? 0)
  return clamp(Math.max(raw, twist * 0.8) * amount, 0, 1)
}

function pressureOf(e: PointerEvent) {
  if (e.pointerType === 'pen' && e.pressure > 0) return clamp(e.pressure, 0.02, 1)
  return 0.5
}

function handleCursor(h: Handle | null) {
  switch (h) {
    case 'nw':
    case 'se':
      return 'nwse-resize'
    case 'ne':
    case 'sw':
      return 'nesw-resize'
    case 'n':
    case 's':
      return 'ns-resize'
    case 'e':
    case 'w':
      return 'ew-resize'
    default:
      return 'default'
  }
}

function sameElements(a: AnyElement[], b: AnyElement[]) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false
    if (a[i].x !== b[i].x || a[i].y !== b[i].y) return false
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false
  }
  return true
}

export function strokeStyleOf(tool: Tool): StrokeStyle {
  return {
    color: tool.color,
    size: tool.size,
    opacity: 1,
    blend: tool.blend,
    pressure: tool.pressure,
    smoothing: tool.smoothing,
    response: tool.response,
    pressureGamma: tool.pressureGamma,
    tilt: tool.tilt,
    widthSmooth: tool.widthSmooth,
    texture: tool.texture,
    textureScale: tool.textureScale,
    textureBody: tool.textureBody,
    velocity: tool.velocity,
    minWidth: tool.minWidth,
    taperIn: tool.taperIn,
    taperOut: tool.taperOut,
  }
}

export function shapeStyleOf(tool: Tool): ShapeStyle {
  return {
    shape: tool.shape ?? 'rect',
    stroke: strokeStyleOf(tool),
    fill: tool.fill,
    fillOpacity: tool.fillOpacity,
    dash: tool.dash,
    corner: tool.corner,
    sides: tool.sides,
    arrowHead: tool.arrowHead,
  }
}

export function textStyleOf(tool: Tool): TextStyle {
  return {
    color: tool.color,
    fontSize: tool.fontSize,
    fontFamily: tool.fontFamily,
    fontWeight: tool.fontWeight,
    italic: tool.italic,
    underline: tool.underline,
    align: tool.align,
    lineHeight: tool.lineHeight,
  }
}
