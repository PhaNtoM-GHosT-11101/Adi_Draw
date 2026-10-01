import type { StrokeStyle } from './types'
import { clamp, distToSegmentSq, simplify } from './geometry'
import { OneEuroFilter, euroParams } from './filters'
import type { Vec2 } from './geometry'

/* ------------------------------------------------------------------ *
 *  Stroke engine: sampled points -> variable-width outline path.
 *
 *  Points are stored flat as [x, y, pressure, x, y, pressure, ...]
 *  relative to the element origin.
 * ------------------------------------------------------------------ */

/** Exponential low-pass applied while the pen is down (low latency). */
export function smoothIncremental(prev: number, next: number, smoothing: number): number {
  const k = clamp(1 - smoothing * 0.92, 0.06, 1)
  return prev + (next - prev) * k
}

/** Windowed average applied when finalising a stroke (kills hand jitter). */
export function stabilize(pts: number[], strength: number): number[] {
  const n = pts.length / 3
  const win = Math.round(1 + clamp(strength, 0, 1) * 7)
  if (win < 2 || n < 3) return pts.slice()
  const out = new Array<number>(pts.length)
  const half = win >> 1
  for (let i = 0; i < n; i++) {
    let sx = 0
    let sy = 0
    let sw = 0
    for (let k = -half; k <= half; k++) {
      const j = clamp(i + k, 0, n - 1)
      sx += pts[j * 3]
      sy += pts[j * 3 + 1]
      sw++
    }
    out[i * 3] = sx / sw
    out[i * 3 + 1] = sy / sw
    out[i * 3 + 2] = pts[i * 3 + 2]
  }
  return out
}

/** Drop points that are visually identical, keeping the final one. */
export function dedupe(pts: number[], minDist: number): number[] {
  const n = pts.length / 3
  if (n < 2) return pts.slice()
  const md2 = minDist * minDist
  const out: number[] = [pts[0], pts[1], pts[2]]
  for (let i = 1; i < n; i++) {
    const lx = out[out.length - 3]
    const ly = out[out.length - 2]
    const dx = pts[i * 3] - lx
    const dy = pts[i * 3 + 1] - ly
    if (dx * dx + dy * dy >= md2) out.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2])
  }
  // always keep the true endpoint
  if (out.length < pts.length) {
    out[out.length - 3] = pts[pts.length - 3]
    out[out.length - 2] = pts[pts.length - 2]
  }
  return out
}

/** Final simplification pass to keep the document small. */
export function compress(pts: number[], tolerance: number): number[] {
  const n = pts.length / 3
  if (n < 4) return pts
  const vecs: Vec2[] = []
  for (let i = 0; i < n; i++) vecs.push({ x: pts[i * 3], y: pts[i * 3 + 1] })
  const keep = simplify(vecs, tolerance)
  if (keep.length < 2) return pts
  // Preserve the first & last and any exact keep hit
  const keptSet = new Set(keep.map((k) => `${k.x},${k.y}`))
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    if (keptSet.has(`${vecs[i].x},${vecs[i].y}`))
      out.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2])
  }
  if (out.length < 9) return pts
  out[out.length - 3] = pts[pts.length - 3]
  out[out.length - 2] = pts[pts.length - 2]
  return out
}

/* ------------------------------------------------------------------ *
 *  Streaming stroke builder.
 *
 *  Every incoming sample runs through a One Euro filter (adaptive, so it
 *  smooths hard when the pen is slow and barely at all when it is fast),
 *  then speed and tilt are folded into the pressure channel. The result is
 *  a clean, low-latency line without the rubber-band feel a fixed average
 *  buffer gives you.
 * ------------------------------------------------------------------ */

export class StrokeBuilder {
  /** emitted points, flat triples: x, y, effective-pressure */
  out: number[] = []
  /** timestamps parallel to `out` */
  times: number[] = []

  private fx: OneEuroFilter
  private fy: OneEuroFilter
  private fp: OneEuroFilter
  private prevT = 0
  private has = false
  private lastX = 0
  private lastY = 0
  /** EMA of the speed, in px/ms, used for the thinning curve */
  private speed = 0

  constructor(private style: StrokeStyle) {
    const p = euroParams(style.smoothing, style.response)
    this.fx = new OneEuroFilter(p.minCutoff, p.beta, p.dCutoff)
    this.fy = new OneEuroFilter(p.minCutoff, p.beta, p.dCutoff)
    // pressure is far noisier than position, so always filter it harder
    this.fp = new OneEuroFilter(
      Math.max(0.8, p.minCutoff * 0.35),
      Math.max(0.003, p.beta * 0.5),
      1,
    )
  }

  get length() {
    return this.out.length / 3
  }

  /** @param tilt 0..1 stylus tilt, already scaled by the tool's tilt setting */
  push(x: number, y: number, pressure: number, t: number, tilt = 0) {
    if (!this.has) {
      this.has = true
      this.prevT = t
      this.lastX = x
      this.lastY = y
      this.fx.reset()
      this.fy.reset()
      this.fp.reset()
      this.out.push(x, y, clamp(pressure + tilt * 0.45, 0, 1))
      this.times.push(t)
      return
    }

    // Every coalesced sample carries its own timeStamp. Using the frame time
    // instead would give them all the same dt, which starves the filter and
    // collapses the stroke to a dot at high sampling rates.
    const raw = (t - this.prevT) / 1000
    const dt = raw > 0.0005 ? Math.min(raw, 0.05) : 1 / 240
    this.prevT = t

    const sx = this.fx.filter(x, dt)
    const sy = this.fy.filter(y, dt)
    let p = this.fp.filter(clamp(pressure, 0, 1), dt)
    if (tilt > 0) p = clamp(p + tilt * 0.45, 0, 1)

    // Pen speed thins the line. The EMA keeps it steady instead of flickering.
    const v = Math.hypot(sx - this.lastX, sy - this.lastY) / (dt * 1000)
    this.speed += (v - this.speed) * 0.25
    if (this.style.velocity > 0.001) {
      p *= 1 - this.style.velocity * clamp(this.speed / 1.6, 0, 1)
    }

    this.lastX = sx
    this.lastY = sy
    this.out.push(sx, sy, clamp(p, 0, 1))
    this.times.push(t)
  }

  /** Nothing is buffered, but kept so callers can finish uniformly. */
  flush() {}

  /**
   * Finalise: dedupe then simplify. A stroke that covers real distance always
   * keeps at least two points — simplification must never turn a line into a
   * dot, which is exactly what a perfectly straight stroke would otherwise do.
   */
  finish(tolerance = 0.25): number[] {
    const raw = this.out
    if (raw.length < 6) return raw // a single tap
    const deduped = dedupe(raw, 0.35)
    if (deduped.length < 6) return raw
    const simplified = deduped.length >= 9 ? compress(deduped, tolerance) : deduped
    return simplified.length >= 6 ? simplified : deduped.length >= 6 ? deduped : raw
  }
}

export interface StrokeGeometry {
  xs: Float32Array
  ys: Float32Array
  ws: Float32Array
}

/**
 * Per-point width from the pressure curve and taper.
 * Pressure, speed and tilt are already folded into the single
 * `pts[i*3+2]` channel by `StrokeBuilder`, so this pass is pure arithmetic.
 */
export function geometry(pts: number[], style: StrokeStyle): StrokeGeometry {
  const n = Math.floor(pts.length / 3)
  const xs = new Float32Array(n)
  const ys = new Float32Array(n)
  const ws = new Float32Array(n)
  if (n === 0) return { xs, ys, ws }

  const size = style.size
  const minW = clamp(style.minWidth, 0, 1)
  const taperIn = clamp(style.taperIn, 0, 1)
  const taperOut = clamp(style.taperOut, 0, 1)
  const gamma = clamp(style.pressureGamma, 0.2, 4)
  const taperSpan = Math.max(2, Math.round(Math.min(n - 1, 14) * 0.5))

  for (let i = 0; i < n; i++) {
    const x = pts[i * 3]
    const y = pts[i * 3 + 1]
    const raw = clamp(pts[i * 3 + 2], 0, 1)
    xs[i] = x
    ys[i] = y

    // response curve: gamma < 1 gives a heavier, darker line
    const p = gamma === 1 ? raw : Math.pow(raw, gamma)
    const pf = 1 - style.pressure + style.pressure * p
    let w = size * (minW + (1 - minW) * pf)

    if (taperIn > 0.001) {
      const t = i / taperSpan
      if (t < 1) w *= 1 - taperIn * (1 - t * t * (3 - 2 * t))
    }
    if (taperOut > 0.001) {
      const t = (n - 1 - i) / taperSpan
      if (t < 1) w *= 1 - taperOut * (1 - t * t * (3 - 2 * t))
    }
    ws[i] = Math.max(0.35, w)
  }

  // Smooth the width profile so a jittery pressure signal can't make the
  // outline wobble. A short symmetric kernel keeps the stroke symmetric too.
  const k = Math.round(clamp(style.widthSmooth, 0, 1) * 5)
  if (k >= 1 && n > k * 2 + 1) {
    const src = Float32Array.from(ws)
    for (let i = k; i < n - k; i++) {
      let sum = 0
      for (let j = -k; j <= k; j++) sum += src[i + j]
      ws[i] = sum / (2 * k + 1)
    }
    // keep the very ends crisp so tapers still read
    for (let i = 0; i <= k && i < n; i++) ws[i] = src[i]
    for (let i = 0; i <= k && i < n; i++) ws[n - 1 - i] = src[n - 1 - i]
  }

  return { xs, ys, ws }
}

/**
 * SVG path data for the filled outline of a variable-width stroke.
 * `Path2D` can consume this string directly, so the canvas renderer and the
 * SVG exporter always agree on the exact same geometry.
 */
export function outlinePathData(
  pts: number[],
  style: StrokeStyle,
  precision = 2,
  ox = 0,
  oy = 0,
): string {
  const n = Math.floor(pts.length / 3)
  if (n === 0) return ''
  const k = 10 ** precision
  // Math.round avoids the string round-trip that Number(v.toFixed()) needs,
  // which matters: this runs for every frame of a live stroke.
  const F = (v: number) => Math.round(v * k) / k
  if (n === 1) {
    const r = Math.max(0.35, style.size / 2)
    const cx = pts[0] + ox
    const cy = pts[1] + oy
    return `M ${F(cx - r)} ${F(cy)} a ${F(r)} ${F(r)} 0 1 0 ${F(r * 2)} 0 a ${F(r)} ${F(r)} 0 1 0 ${F(-r * 2)} 0 Z`
  }

  const { xs, ys, ws } = geometry(pts, style)
  const count = xs.length
  for (let i = 0; i < count; i++) {
    xs[i] += ox
    ys[i] += oy
  }

  const nx = new Float32Array(count)
  const ny = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const i0 = Math.max(0, i - 1)
    const i1 = Math.min(count - 1, i + 1)
    let tx = xs[i1] - xs[i0]
    let ty = ys[i1] - ys[i0]
    const len = Math.hypot(tx, ty)
    if (len < 1e-6) {
      tx = 1
      ty = 0
    } else {
      tx /= len
      ty /= len
    }
    nx[i] = -ty
    ny[i] = tx
  }

  const lx = new Float32Array(count)
  const ly = new Float32Array(count)
  const rx = new Float32Array(count)
  const ry = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const h = ws[i] / 2
    lx[i] = xs[i] + nx[i] * h
    ly[i] = ys[i] + ny[i] * h
    rx[i] = xs[i] - nx[i] * h
    ry[i] = ys[i] - ny[i] * h
  }

  const last = count - 1
  let d = `M ${F(lx[0])} ${F(ly[0])}`
  for (let i = 1; i < count; i++) {
    const mx = (lx[i - 1] + lx[i]) * 0.5
    const my = (ly[i - 1] + ly[i]) * 0.5
    d += i === 1 ? `L ${F(lx[i])} ${F(ly[i])}` : `Q ${F(lx[i - 1])} ${F(ly[i - 1])} ${F(mx)} ${F(my)}`
  }
  d += `L ${F(lx[last])} ${F(ly[last])}`

  // Round caps bulge along the travel direction; sweep=0 with a marginally
  // larger radius keeps the semicircle unambiguous for every renderer.
  const rLast = ws[last] * 0.5 + 0.01
  d += `A ${F(rLast)} ${F(rLast)} 0 0 0 ${F(rx[last])} ${F(ry[last])}`

  for (let i = last - 1; i >= 0; i--) {
    const mx = (rx[i] + rx[i + 1]) * 0.5
    const my = (ry[i] + ry[i + 1]) * 0.5
    d += i === last - 1 ? `L ${F(rx[i])} ${F(ry[i])}` : `Q ${F(rx[i + 1])} ${F(ry[i + 1])} ${F(mx)} ${F(my)}`
  }
  d += `L ${F(rx[0])} ${F(ry[0])}`

  const rFirst = ws[0] * 0.5 + 0.01
  d += `A ${F(rFirst)} ${F(rFirst)} 0 0 0 ${F(lx[0])} ${F(ly[0])} Z`
  return d
}

/**
 * Path2D form of `outlinePathData`, in world coordinates.
 * Stroke points are stored relative to the element origin, so the origin
 * is baked in here rather than relying on a canvas transform.
 */
export function outlinePath(pts: number[], style: StrokeStyle, ox = 0, oy = 0): Path2D {
  return new Path2D(outlinePathData(pts, style, 2, ox, oy))
}

/** Simple constant-width polyline (laser, guides). */
/** Simple constant-width polyline (laser, guides). */
export function polylinePath(pts: number[], width: number): Path2D {
  const path = new Path2D()
  const n = Math.floor(pts.length / 3)
  if (n === 0) return path
  path.moveTo(pts[0], pts[1])
  if (n === 1) {
    path.lineTo(pts[0] + 0.01, pts[1])
  } else {
    for (let i = 1; i < n - 1; i++) {
      const mx = (pts[i * 3] + pts[(i + 1) * 3]) / 2
      const my = (pts[i * 3 + 1] + pts[(i + 1) * 3 + 1]) / 2
      path.quadraticCurveTo(pts[i * 3], pts[i * 3 + 1], mx, my)
    }
    path.lineTo(pts[(n - 1) * 3], pts[(n - 1) * 3 + 1])
  }
  void width
  return path
}

/** Hit test: distance from (x,y) to the stroke centre-line. */
export function hitStroke(
  pts: number[],
  style: StrokeStyle,
  x: number,
  y: number,
  tolerance: number,
): boolean {
  const n = Math.floor(pts.length / 3)
  if (n === 0) return false
  if (n === 1) {
    const r = style.size / 2 + tolerance
    return (x - pts[0]) ** 2 + (y - pts[1]) ** 2 <= r * r
  }
  const half = style.size / 2 + tolerance
  for (let i = 0; i < n - 1; i++) {
    if (distToSegmentSq(x, y, pts[i * 3], pts[i * 3 + 1], pts[(i + 1) * 3], pts[(i + 1) * 3 + 1]) <= half * half)
      return true
  }
  return false
}

/** Bounding box of the sampled points inflated by half the max width. */
export function strokeBBox(pts: number[], size: number): { x: number; y: number; w: number; h: number } {
  const n = Math.floor(pts.length / 3)
  if (n === 0) return { x: 0, y: 0, w: 0, h: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3]
    const y = pts[i * 3 + 1]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const pad = size / 2 + 1
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 }
}
