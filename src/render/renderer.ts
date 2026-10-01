import type { AnyElement, DocumentState, NoteElement, StrokeElement, TextElement, ImageElement } from '../core/types'
import { elementBBox } from '../core/store'
import { outlinePath } from '../core/stroke'
import { shapeGeom, isLineShape, notePathData, noteFoldData } from '../core/shapes'
import { clamp, rectsIntersect, uid } from '../core/geometry'
import { TextureCache } from './textures'
import type { Rect, ViewState } from '../core/types'

interface CacheEntry {
  key: string
  path: Path2D | null
  fill: Path2D | null
  img?: HTMLImageElement
}

export interface RenderOptions {
  /** ids drawn with a selection overlay */
  selection: Set<string>
  /** live element being drawn this frame (already committed or in-progress) */
  hoverId?: string | null
  showSelectionUI: boolean
}

export type RenderQuality = 'performance' | 'balanced' | 'quality'

export class Renderer {
  readonly canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private cache = new Map<string, CacheEntry>()
  private textures: TextureCache
  private bboxCache = new Map<string, { key: string; box: Rect }>()
  private textCache = new Map<string, string[]>()
  private dpr = 1
  private cssW = 0
  private cssH = 0
  /**
   * The committed document lives on its own canvas. Frames composite it with
   * a single blit and only the cheap overlay (selection, laser) is redrawn,
   * and panning re-blits without re-painting any ink at all.
   */
  private scene: HTMLCanvasElement
  private sceneCtx: CanvasRenderingContext2D
  private sceneScale = 0
  private sceneView: ViewState = { x: 0, y: 0, scale: 1 }
  private scenePainted = false
  /** scratch used for the scrolling blit while panning */
  private shiftBuf: HTMLCanvasElement | null = null
  private shiftBufCtx: CanvasRenderingContext2D | null = null
  private quality: RenderQuality = 'balanced'
  /** opt-in phase timings, handy when a board feels slow */
  readonly profile = { total: 0, paint: 0, grid: 0, cull: 0, draw: 0, blit: 0, regions: 0, elements: 0 }
  /** transient laser-pointer trail: x, y, halfWidth, bornAt — colour is per-draw */
  private trail: number[] = []
  private trailColor = '#ef4444'
  private trailLife = 900
  private trailDirty = false

  constructor(canvas: HTMLCanvasElement, quality: RenderQuality = 'balanced') {
    this.canvas = canvas
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
    if (!ctx) throw new Error('2D canvas is not available in this browser.')
    this.ctx = ctx
    this.scene = document.createElement('canvas')
    const sctx = this.scene.getContext('2d', { alpha: false })
    if (!sctx) throw new Error('2D canvas is not available in this browser.')
    this.sceneCtx = sctx
    this.textures = new TextureCache(ctx)
    this.quality = quality
    this.resize()
  }

  setQuality(q: RenderQuality) {
    if (q === this.quality) return
    this.quality = q
    this.resize()
  }

  private dprBudget() {
    const raw = window.devicePixelRatio || 1
    if (this.quality === 'performance') return 1
    if (this.quality === 'balanced') return clamp(raw, 1, 2)
    return clamp(raw, 1, 3)
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect()
    const dpr = this.dprBudget()
    const w = Math.max(1, Math.round(rect.width))
    const h = Math.max(1, Math.round(rect.height))
    if (w === this.cssW && h === this.cssH && dpr === this.dpr) return
    this.cssW = w
    this.cssH = h
    this.dpr = dpr
    this.canvas.width = Math.round(w * dpr)
    this.canvas.height = Math.round(h * dpr)
    this.scene.width = this.canvas.width
    this.scene.height = this.canvas.height
    this.scenePainted = false
  }

  get width() {
    return this.cssW
  }
  get height() {
    return this.cssH
  }

  /** screen <-> world helpers */
  toWorld(sx: number, sy: number, v: ViewState) {
    return { x: (sx - v.x) / v.scale, y: (sy - v.y) / v.scale }
  }
  toScreen(wx: number, wy: number, v: ViewState) {
    return { x: wx * v.scale + v.x, y: wy * v.scale + v.y }
  }

  /* -------------------------- laser pointer ----------------------- */

  setLaser(color: string, life: number) {
    this.trailColor = color
    this.trailLife = Math.max(120, life)
  }
  clearTrail() {
    if (!this.trail.length) return
    this.trail.length = 0
    this.trailDirty = true
  }
  addTrailPoint(x: number, y: number, halfWidth: number, now = performance.now()) {
    this.trail.push(x, y, halfWidth, now)
    this.trailDirty = true
    if (this.trail.length > 4000) this.trail.splice(0, 1200)
  }
  private drawTrail(ctx: CanvasRenderingContext2D, now: number) {
    if (!this.trail.length) return
    const life = this.trailLife
    ctx.save()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = this.trailColor
    for (let i = 0; i + 7 < this.trail.length; i += 4) {
      const age = (now - this.trail[i + 3]) / life
      if (age >= 1) continue
      ctx.globalAlpha = Math.max(0, 1 - age) * 0.95
      ctx.lineWidth = this.trail[i + 2] * 2 * (1 - age * 0.35)
      ctx.beginPath()
      ctx.moveTo(this.trail[i], this.trail[i + 1])
      ctx.lineTo(this.trail[i + 4], this.trail[i + 5])
      ctx.stroke()
    }
    // the bright head
    const n = this.trail.length
    const headAge = (now - this.trail[n - 1]) / life
    if (headAge < 1) {
      ctx.globalAlpha = (1 - headAge) * 0.35
      ctx.beginPath()
      ctx.arc(this.trail[n - 4], this.trail[n - 3], this.trail[n - 2] * 2.4, 0, Math.PI * 2)
      ctx.fillStyle = this.trailColor
      ctx.fill()
    }
    ctx.restore()
  }

  visibleRect(v: ViewState) {
    return { x: -v.x / v.scale, y: -v.y / v.scale, w: this.cssW / v.scale, h: this.cssH / v.scale }
  }

  /* ------------------------- path caching ------------------------- */

  private key(el: AnyElement): string {
    switch (el.kind) {
      case 'stroke':
        return `${el.id}|${el.x},${el.y}|${el.pts.length}|${el.style.size}|${el.style.pressure}|${el.style.minWidth}|${el.style.taperIn}|${el.style.taperOut}|${el.style.velocity}|${el.style.blend}`
      case 'shape':
        return `${el.id}|${el.x},${el.y},${el.x2},${el.y2}|${JSON.stringify(el.style)}`
      case 'image':
        return `${el.id}|${el.w},${el.h}|${el.src.length}`
      default:
        return `${el.id}|t`
    }
  }

  /**
   * Cached bounding boxes. Recomputing these per frame is what actually costs
   * time on a big board — a stroke's box means walking every sampled point.
   */
  bboxFor(el: AnyElement): Rect {
    const key = this.bboxKey(el)
    const hit = this.bboxCache.get(el.id)
    if (hit && hit.key === key) return hit.box
    const box = elementBBox(el)
    if (this.bboxCache.size > 20000) this.bboxCache.clear()
    this.bboxCache.set(el.id, { key, box })
    return box
  }

  private bboxKey(el: AnyElement) {
    switch (el.kind) {
      case 'stroke':
        return `${el.x},${el.y},${el.pts.length},${el.style.size}`
      case 'shape':
        return `${el.x},${el.y},${el.x2},${el.y2},${el.style.stroke.size},${el.style.arrowHead},${el.style.shape}`
      case 'text':
        return `${el.x},${el.y},${el.width},${el.text.length},${el.style.fontSize}`
      case 'note':
        return `${el.x},${el.y},${el.w},${el.h},${el.text.length},${el.style.fontSize}`
      case 'image':
        return `${el.x},${el.y},${el.w},${el.h}`
    }
  }

  private pathFor(el: AnyElement): CacheEntry {
    const key = this.key(el)
    const hit = this.cache.get(el.id)
    if (hit && hit.key === key) return hit
    let entry: CacheEntry = { key, path: null, fill: null }
    if (el.kind === 'stroke') {
      entry.path =
        el.style.blend === 'destination-out' ? null : outlinePath(el.pts, el.style, el.x, el.y)
    } else if (el.kind === 'shape') {
      const isLine = isLineShape(el.style.shape)
      const g = shapeGeom(el.style.shape, el.x, el.y, el.x2, el.y2, el.style, isLine)
      entry.path = g.outline
      entry.fill = g.fillPath
    } else if (el.kind === 'image') {
      entry.img = getImage(el.src)
    }
    this.cache.set(el.id, entry)
    return entry
  }

  get needsFrame() {
    return this.trailDirty
  }
  clearTrailDirty() {
    this.trailDirty = false
  }

  invalidate(id: string) {
    this.cache.delete(id)
    this.bboxCache.delete(id)
  }
  clearCache() {
    this.cache.clear()
    this.bboxCache.clear()
    this.textCache.clear()
    this.textures.clear()
    this.scenePainted = false
  }

  /* ----------------------------- paint ---------------------------- */

  /**
   * @param dirty world-space rectangles that changed since the last frame,
   *   or `null` to repaint everything. Panning alone passes an empty array
   *   and costs a single blit.
   */
  render(doc: DocumentState, view: ViewState, opts: RenderOptions, dirty: Rect[] | null) {
    const t0 = performance.now()
    const p = this.profile
    p.total = 0
    p.paint = 0
    p.grid = 0
    p.cull = 0
    p.draw = 0
    p.blit = 0
    p.regions = 0
    p.elements = 0

    const vis = this.visibleRect(view)
    const scaleChanged = !this.scenePainted || Math.abs(view.scale - this.sceneScale) > 1e-9
    let regions: Rect[]

    if (dirty === null) {
      // caller asked for a complete repaint
      this.sceneScale = view.scale
      this.sceneView = { x: view.x, y: view.y, scale: view.scale }
      this.scenePainted = true
      regions = [vis]
    } else if (scaleChanged) {
      this.sceneScale = view.scale
      this.sceneView = { x: view.x, y: view.y, scale: view.scale }
      this.scenePainted = true
      regions = [vis]
    } else {
      // The scene is a rasterisation of one particular view. Panning is
      // therefore a scrolling blit: shift what we have, then repaint only the
      // strips that just became visible.
      const dx = view.x - this.sceneView.x
      const dy = view.y - this.sceneView.y
      const panned = dx || dy ? this.shiftScene(dx, dy, view) : []
      this.sceneView = { x: view.x, y: view.y, scale: view.scale }
      regions = panned
      if (dirty.length > 0) {
        if (panned.length + dirty.length > 12) regions = [vis]
        else regions = [...regions, ...this.clampRegions(dirty, vis, view)]
      }
    }

    p.regions = regions.length
    const tPaint = performance.now()
    for (const region of regions) this.paintSceneRegion(doc, view, region)
    p.paint = performance.now() - tPaint

    // composite
    const tBlit = performance.now()
    const ctx = this.ctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(this.scene, 0, 0)
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    p.blit = performance.now() - tBlit

    if (this.trail.length) {
      const now = performance.now()
      ctx.save()
      ctx.translate(view.x, view.y)
      ctx.scale(view.scale, view.scale)
      this.drawTrail(ctx, now)
      ctx.restore()
      let keep = 0
      while (keep + 3 < this.trail.length && now - this.trail[keep + 3] < this.trailLife) keep += 4
      if (keep > 0) this.trail.splice(0, keep)
      this.trailDirty = true
    }

    if (opts.showSelectionUI) this.drawSelectionUI(ctx, doc, view, opts)
    p.total = performance.now() - t0
  }

  /**
   * Shift the existing raster to follow a pan and report the strips that just
   * became visible. Works in device pixels so the retained ink stays pixel
   * exact; only the newly exposed edges are repainted.
   */
  private shiftScene(viewDx: number, viewDy: number, view: ViewState): Rect[] {
    const W = this.scene.width
    const H = this.scene.height
    if (W === 0 || H === 0) return []
    const dpr = this.dpr
    const ddx = Math.round(viewDx * dpr)
    const ddy = Math.round(viewDy * dpr)
    if (!ddx && !ddy) return []

    if (!this.shiftBuf) {
      this.shiftBuf = document.createElement('canvas')
      this.shiftBufCtx = this.shiftBuf.getContext('2d')
    }
    const bufCtx = this.shiftBufCtx
    if (this.shiftBuf.width !== W || this.shiftBuf.height !== H) {
      this.shiftBuf.width = W
      this.shiftBuf.height = H
    }
    if (!bufCtx) return []
    // the source must be snapshotted before the scene is cleared, so pan
    // through a scratch canvas rather than compositing onto itself
    bufCtx.setTransform(1, 0, 0, 1, 0, 0)
    bufCtx.clearRect(0, 0, W, H)
    bufCtx.drawImage(this.scene, 0, 0)
    const ctx = this.sceneCtx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, W, H)
    ctx.drawImage(this.shiftBuf, ddx, ddy)

    // device pixels -> world, through the new view
    const k = view.scale * dpr
    const toWorld = (dx: number, dy: number, dw: number, dh: number): Rect => ({
      x: (dx / dpr - view.x) / view.scale,
      y: (dy / dpr - view.y) / view.scale,
      w: dw / k,
      h: dh / k,
    })
    // the raster moved right by ddx, so the gap is on the left, and so on
    const out: Rect[] = []
    if (ddx > 0) out.push(toWorld(0, 0, ddx, H))
    else if (ddx < 0) out.push(toWorld(W + ddx, 0, -ddx, H))
    if (ddy > 0) out.push(toWorld(0, 0, W, ddy))
    else if (ddy < 0) out.push(toWorld(0, H + ddy, W, -ddy))
    // Widen the strips slightly: an element straddling the seam would
    // otherwise be clipped mid-shadow when the strip is repainted.
    const bleed = 24 / view.scale
    const vis = this.visibleRect(view)
    return out.map((r) => this.clampRegion({ x: r.x - bleed, y: r.y - bleed, w: r.w + bleed * 2, h: r.h + bleed * 2 }, vis))
  }

  private clampRegions(dirty: Rect[], vis: Rect, view: ViewState) {
    const pad = 2 / view.scale
    return dirty
      .map((r) => this.clampRegion({ x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 }, vis))
      .filter((r): r is Rect => r.w > 0 && r.h > 0)
  }

  private clampRegion(r: Rect, vis: Rect): Rect {
    const x = Math.max(r.x, vis.x)
    const y = Math.max(r.y, vis.y)
    const w = Math.min(r.x + r.w, vis.x + vis.w) - x
    const h = Math.min(r.y + r.h, vis.y + vis.h) - y
    return { x, y, w, h }
  }

  /** Repaint one world-space region of the scene canvas. */
  private paintSceneRegion(doc: DocumentState, view: ViewState, region: Rect) {
    const ctx = this.sceneCtx
    const { dpr } = this
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.save()
    ctx.translate(view.x, view.y)
    ctx.scale(view.scale, view.scale)
    // one world-space clip bounds everything below, so nothing has to be
    // sized to the viewport
    ctx.beginPath()
    ctx.rect(region.x, region.y, region.w, region.h)
    ctx.clip()
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'

    const tA = performance.now()
    ctx.fillStyle = doc.meta.background
    ctx.fillRect(region.x, region.y, region.w, region.h)
    const tB = performance.now()
    this.profile.grid += tB - tA
    this.drawGrid(ctx, doc, view, region)
    this.profile.grid += performance.now() - tB
    const tCull = performance.now()

    const overlay: { el: AnyElement; alpha: number }[] = []

    for (const layer of doc.layers) {
      if (!layer.visible || layer.opacity <= 0) continue
      const list = doc.elements[layer.id] ?? []
      if (needsLayerPass(list, layer.opacity)) {
        this.renderLayerToScratch(doc, layer.id, region)
        ctx.save()
        ctx.globalAlpha = layer.opacity
        ctx.drawImage(this.scratch!, view.x, view.y, this.cssW, this.cssH)
        ctx.restore()
      } else {
        let drawn = 0
        for (const el of list) {
          if (!rectsIntersect(this.bboxFor(el), region)) continue
          drawn++
          this.paintElement(ctx, el, { selection: new Set(), showSelectionUI: false })
          if (el.kind === 'stroke' && el.style.blend !== 'source-over' && el.style.blend !== 'destination-out')
            overlay.push({ el, alpha: layer.opacity })
        }
        this.profile.elements += drawn
      }
    }

    this.profile.cull += performance.now() - tCull
    const tDraw = performance.now()
    for (const { el, alpha } of overlay) {
      if (el.kind !== 'stroke') continue
      ctx.save()
      ctx.globalCompositeOperation = el.style.blend as GlobalCompositeOperation
      const e = this.pathFor(el)
      if (e.path) this.fillStroke(ctx, el, e.path, alpha * el.opacity)
      ctx.restore()
    }
    this.profile.draw += performance.now() - tDraw

    ctx.restore()
  }

  private scratch: HTMLCanvasElement | null = null

  private renderLayerToScratch(doc: DocumentState, layerId: string, region: Rect) {
    if (!this.scratch) this.scratch = document.createElement('canvas')
    const s = this.scratch
    const w = Math.round(this.cssW)
    const h = Math.round(this.cssH)
    if (s.width !== w || s.height !== h) {
      s.width = w
      s.height = h
    }
    const sctx = s.getContext('2d')!
    sctx.setTransform(1, 0, 0, 1, 0, 0)
    sctx.clearRect(0, 0, w, h)
    sctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    const list = doc.elements[layerId] ?? []
    for (const el of list) {
      if (!rectsIntersect(this.bboxFor(el), region)) continue
      this.paintElement(sctx, el, { selection: new Set(), showSelectionUI: false })
    }
  }

  private paintElement(ctx: CanvasRenderingContext2D, el: AnyElement, opts: RenderOptions) {
    ctx.save()
    ctx.globalAlpha = el.opacity
    const entry = this.pathFor(el)

    switch (el.kind) {
      case 'stroke': {
        const st = el.style
        if (st.blend === 'destination-out') {
          ctx.globalCompositeOperation = 'destination-out'
          const live = this.liveOutline(el)
          if (live) {
            ctx.fillStyle = '#000'
            ctx.fill(live)
          }
          break
        }
        if (st.blend !== 'source-over') {
          // handled in the overlay pass
          break
        }
        if (entry.path) this.fillStroke(ctx, el, entry.path, el.opacity)
        break
      }
      case 'shape': {
        const st = el.style
        if (st.fill && entry.fill) {
          ctx.globalAlpha = el.opacity * st.fillOpacity
          ctx.fillStyle = st.fill
          ctx.fill(entry.fill)
          ctx.globalAlpha = el.opacity
        }
        if (entry.path) {
          ctx.strokeStyle = st.stroke.color
          ctx.lineWidth = st.stroke.size
          if (st.dash) ctx.setLineDash(st.dash)
          ctx.stroke(entry.path)
          ctx.setLineDash([])
        }
        break
      }
      case 'text':
        this.paintText(ctx, el)
        break
      case 'note':
        this.paintNote(ctx, el)
        break
      case 'image': {
        const img = entry.img
        if (img && img.complete && img.naturalWidth) ctx.drawImage(img, el.x, el.y, el.w, el.h)
        else {
          ctx.fillStyle = 'rgba(120,130,150,0.15)'
          ctx.fillRect(el.x, el.y, el.w, el.h)
        }
        break
      }
    }

    if (opts.hoverId === el.id) {
      ctx.globalAlpha = 1
      ctx.strokeStyle = 'rgba(37,99,235,0.9)'
      ctx.lineWidth = 1.5 / (ctx.getTransform().a || 1)
      const b = elementBBox(el)
      ctx.strokeRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4)
    }
    ctx.restore()
  }

  /**
   * Fill a stroke. Textured tools get a flat underlay plus a pigment tile on
   * top, so the gaps read as bare surface instead of holes in whatever was
   * drawn earlier.
   */
  private fillStroke(ctx: CanvasRenderingContext2D, el: StrokeElement, path: Path2D, alpha: number) {
    const st = el.style
    if (st.texture === 'none') {
      ctx.fillStyle = st.color
      ctx.fill(path)
      return
    }
    const t = this.texturesFor(ctx).get(st.texture, st.textureScale, st.color)
    ctx.save()
    ctx.globalAlpha = alpha * (t ? st.textureBody : 1)
    ctx.fillStyle = st.color
    ctx.fill(path)
    if (t) {
      ctx.globalAlpha = alpha
      ctx.fillStyle = t.pattern
      ctx.fill(path)
    }
    ctx.restore()
  }

  /** Patterns belong to the context that made them, so keep one per target. */
  private extraTextures = new WeakMap<CanvasRenderingContext2D, TextureCache>()
  private texturesFor(ctx: CanvasRenderingContext2D): TextureCache {
    if (ctx === this.ctx) return this.textures
    let t = this.extraTextures.get(ctx)
    if (!t) {
      t = new TextureCache(ctx)
      this.extraTextures.set(ctx, t)
    }
    return t
  }

  /** Erasers are re-generated every frame because they read live opacity. */
  private liveOutline(el: StrokeElement): Path2D | null {
    return outlinePath(el.pts, el.style, el.x, el.y)
  }

  private font(style: { fontFamily: string; fontWeight: number; italic: boolean; fontSize: number }) {
    return `${style.italic ? 'italic ' : ''}${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`
  }

  /** Wrapping is the expensive part of text rendering, so memoise it. */
  private linesFor(ctx: CanvasRenderingContext2D, el: TextElement, width: number) {
    const key = `${el.text.length}:${el.text}\u0000${width}\u0000${el.style.fontSize}\u0000${el.style.fontFamily}\u0000${el.style.fontWeight}\u0000${el.style.italic ? 1 : 0}`
    const hit = this.textCache.get(key)
    if (hit) return hit
    ctx.save()
    ctx.font = this.font(el.style)
    const lines = wrapText(ctx, el.text, width)
    ctx.restore()
    if (this.textCache.size > 3000) this.textCache.clear()
    this.textCache.set(key, lines)
    return lines
  }

  paintText(ctx: CanvasRenderingContext2D, el: TextElement) {
    if (!el.text) return
    ctx.fillStyle = el.style.color
    ctx.font = this.font(el.style)
    ctx.textBaseline = 'top'
    ctx.textAlign = 'left'
    const lh = el.style.fontSize * el.style.lineHeight
    const lines = this.linesFor(ctx, el, el.width)
    const align = el.style.align
    for (let i = 0; i < lines.length; i++) {
      const y = el.y + i * lh
      const w = ctx.measureText(lines[i]).width
      const x = align === 'center' ? el.x + (el.width - w) / 2 : align === 'right' ? el.x + el.width - w : el.x
      if (el.style.underline) {
        const uy = y + el.style.fontSize * 1.05
        ctx.fillRect(x, uy, w, Math.max(1, el.style.fontSize / 16))
      }
      ctx.fillText(lines[i], x, y)
    }
  }

  private paintNote(ctx: CanvasRenderingContext2D, el: NoteElement) {
    const path = new Path2D(notePathData(el.x, el.y, el.w, el.h))
    ctx.fillStyle = el.color
    ctx.shadowColor = 'rgba(15,23,42,0.18)'
    ctx.shadowBlur = 10
    ctx.shadowOffsetY = 4
    ctx.fill(path)
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
    ctx.shadowOffsetY = 0

    const fold = new Path2D(noteFoldData(el.x, el.y, el.w, el.h))
    ctx.fillStyle = 'rgba(0,0,0,0.10)'
    ctx.fill(fold)

    if (el.text) {
      ctx.fillStyle = el.style.color
      ctx.font = this.font(el.style)
      ctx.textBaseline = 'top'
      const lines = this.linesFor(ctx, { ...el, width: el.w - 28 } as unknown as TextElement, el.w - 28)
      const lh = el.style.fontSize * el.style.lineHeight
      for (let i = 0; i < lines.length; i++) {
        const y = el.y + 14 + i * lh
        if (y + lh > el.y + el.h - 6) break
        ctx.fillText(lines[i], el.x + 14, y)
      }
    }
  }

  /* --------------------------- hit testing ------------------------ */

  private hitCtx: CanvasRenderingContext2D | null = null
  private get hit() {
    if (!this.hitCtx) {
      const c = document.createElement('canvas')
      c.width = c.height = 1
      this.hitCtx = c.getContext('2d')!
    }
    return this.hitCtx
  }

  /** Topmost element under a world-space point. */
  pick(doc: DocumentState, wx: number, wy: number, tol: number): AnyElement | null {
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const layer = doc.layers[i]
      if (!layer.visible || layer.locked) continue
      const list = doc.elements[layer.id] ?? []
      for (let j = list.length - 1; j >= 0; j--) {
        const el = list[j]
        if (!rectsIntersect(this.bboxFor(el), { x: wx - tol - 8, y: wy - tol - 8, w: (tol + 8) * 2, h: (tol + 8) * 2 }))
          continue
        if (this.hitTest(el, wx, wy, tol)) return el
      }
    }
    return null
  }

  hitTest(el: AnyElement, wx: number, wy: number, tol: number): boolean {
    const ctx = this.hit
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    switch (el.kind) {
      case 'stroke': {
        if (el.style.blend === 'destination-out') return false
        const n = el.pts.length / 3
        if (n === 0) return false
        const half = el.style.size / 2 + tol
        if (n === 1) {
          const dx = wx - (el.x + el.pts[0])
          const dy = wy - (el.y + el.pts[1])
          return dx * dx + dy * dy <= half * half
        }
        // use the generated outline so pressure/taper are respected
        const outline = outlinePath(el.pts, el.style, el.x, el.y)
        ctx.lineWidth = 1
        ctx.strokeStyle = '#000'
        if (ctx.isPointInPath(outline, wx, wy)) return true
        return ctx.isPointInStroke(outline, wx, wy)
      }
      case 'shape': {
        const e = this.pathFor(el)
        if (!e.path) return false
        if (e.fill && ctx.isPointInPath(e.fill, wx, wy)) return true
        ctx.lineWidth = el.style.stroke.size + tol * 2
        ctx.strokeStyle = '#000'
        return ctx.isPointInStroke(e.path, wx, wy)
      }
      case 'text': {
        const b = this.bboxFor(el)
        return (
          wx >= b.x - tol && wx <= b.x + b.w + tol && wy >= b.y - tol && wy <= b.y + b.h + tol
        )
      }
      case 'note':
      case 'image': {
        const b = this.bboxFor(el)
        return (
          wx >= b.x - tol && wx <= b.x + b.w + tol && wy >= b.y - tol && wy <= b.y + b.h + tol
        )
      }
    }
  }

  /** All visible elements whose bbox intersects the world rect. */
  pickRect(doc: DocumentState, box: Rect): AnyElement[] {
    const out: AnyElement[] = []
    for (const layer of doc.layers) {
      if (!layer.visible || layer.locked) continue
      for (const el of doc.elements[layer.id] ?? []) {
        if (rectsIntersect(this.bboxFor(el), box)) out.push(el)
      }
    }
    return out
  }

  /* ------------------------ selection chrome ---------------------- */

  private drawSelectionUI(
    ctx: CanvasRenderingContext2D,
    doc: DocumentState,
    view: ViewState,
    opts: RenderOptions,
  ) {
    if (!opts.selection.size) return
    // one bounding box around the whole selection, like every design tool
    let b: Rect | null = null
    for (const layer of doc.layers) {
      for (const el of doc.elements[layer.id] ?? []) {
        if (!opts.selection.has(el.id)) continue
        const r = this.bboxFor(el)
        if (!b) b = r
        else {
          const x = Math.min(b.x, r.x)
          const y = Math.min(b.y, r.y)
          b = { x, y, w: Math.max(b.x + b.w, r.x + r.w) - x, h: Math.max(b.y + b.h, r.y + r.h) - y }
        }
      }
    }
    if (!b) return

    ctx.save()
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    const p0 = this.toScreen(b.x, b.y, view)
    const p1 = this.toScreen(b.x + b.w, b.y + b.h, view)
    const x = Math.min(p0.x, p1.x)
    const y = Math.min(p0.y, p1.y)
    const w = Math.abs(p1.x - p0.x)
    const h = Math.abs(p1.y - p0.y)
    const midX = x + w / 2
    const midY = y + h / 2

    ctx.strokeStyle = '#2563eb'
    ctx.lineWidth = 1.25
    ctx.setLineDash([5, 4])
    ctx.strokeRect(x, y, w, h)

    // rotate handle above the top edge
    const rotY = y - 22
    ctx.beginPath()
    ctx.moveTo(midX, y)
    ctx.lineTo(midX, rotY + 4)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(midX, rotY, 4.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()

    // corner + edge handles
    const size = 7
    const pts: [number, number][] = [
      [x, y],
      [midX, y],
      [x + w, y],
      [x + w, midY],
      [x + w, y + h],
      [midX, y + h],
      [x, y + h],
      [x, midY],
    ]
    ctx.fillStyle = '#ffffff'
    for (const [hx, hy] of pts) {
      ctx.fillRect(hx - size / 2, hy - size / 2, size, size)
      ctx.strokeRect(hx - size / 2, hy - size / 2, size, size)
    }
    ctx.restore()
  }

  /**
   * The grid is drawn per *region*, not per viewport, and accumulated into a
   * single path — one fill instead of hundreds. This is what keeps an
   * incremental repaint of a small area cheap on a dense grid.
   */
  drawGrid(ctx: CanvasRenderingContext2D, doc: DocumentState, view: ViewState, region: Rect) {
    if (!doc.meta.showGrid) return
    const style = doc.meta.canvasStyle
    const step = doc.meta.gridSize
    if (step * view.scale < 5) return
    // thin the grid out on small cells so it never turns into noise
    const stride = Math.max(1, Math.round(5 / (step * view.scale))) * step
    const startX = Math.floor(region.x / stride) * stride
    const startY = Math.floor(region.y / stride) * stride
    const endX = region.x + region.w
    const endY = region.y + region.h

    ctx.save()
    ctx.fillStyle = doc.meta.gridColor
    ctx.strokeStyle = doc.meta.gridColor

    if (style === 'ruled') {
      // notebook paper: horizontal rules only
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let y = startY; y <= endY; y += stride) {
        const sy = Math.round(y * view.scale + view.y) + 0.5
        ctx.moveTo(region.x * view.scale + view.x, sy)
        ctx.lineTo(endX * view.scale + view.x, sy)
      }
      ctx.stroke()
    } else if (style === 'lines' || style === 'grid') {
      // cross-hatch / graph paper
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let x = startX; x <= endX; x += stride) {
        const sx = Math.round(x * view.scale + view.x) + 0.5
        ctx.moveTo(sx, region.y * view.scale + view.y)
        ctx.lineTo(sx, endY * view.scale + view.y)
      }
      for (let y = startY; y <= endY; y += stride) {
        const sy = Math.round(y * view.scale + view.y) + 0.5
        ctx.moveTo(region.x * view.scale + view.x, sy)
        ctx.lineTo(endX * view.scale + view.x, sy)
      }
      ctx.stroke()
    } else {
      const r = (style === 'dots' ? 1.15 : 0.95) / view.scale
      const path = new Path2D()
      for (let y = startY; y <= endY; y += stride) {
        for (let x = startX; x <= endX; x += stride) path.moveTo(x + r, y), path.arc(x, y, r, 0, Math.PI * 2)
      }
      ctx.fill(path)
    }
    ctx.restore()
  }
}

/* ----------------------------- helpers ----------------------------- */

/** A layer needs its own compositing pass if it fades or erases. */
function needsLayerPass(list: AnyElement[], opacity: number) {
  if (opacity < 1) return true
  for (const el of list) if (el.kind === 'stroke' && el.style.blend === 'destination-out') return true
  return false
}

const imageCache = new Map<string, HTMLImageElement>()

export function getImage(src: string): HTMLImageElement | undefined {
  const hit = imageCache.get(src)
  if (hit) return hit
  const img = new Image()
  img.src = src
  imageCache.set(src, img)
  return img
}

export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    if (!para) {
      out.push('')
      continue
    }
    const words = para.split(/(\s+)/)
    let line = ''
    for (const w of words) {
      const test = line + w
      if (ctx.measureText(test).width > maxWidth && line.trim()) {
        out.push(line.replace(/\s+$/, ''))
        line = w.replace(/^\s+/, '')
      } else {
        line = test
      }
    }
    if (line.trim() || !out.length) out.push(line)
  }
  return out
}

export function measureTextElement(
  ctx: CanvasRenderingContext2D,
  text: string,
  style: { fontFamily: string; fontWeight: number; italic: boolean; fontSize: number; lineHeight: number },
  width: number,
) {
  ctx.save()
  ctx.font = `${style.italic ? 'italic ' : ''}${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`
  const lines = wrapText(ctx, text, width)
  ctx.restore()
  return { lines, height: lines.length * style.fontSize * style.lineHeight }
}

export const newImageId = () => uid('img')
export type { ImageElement }
