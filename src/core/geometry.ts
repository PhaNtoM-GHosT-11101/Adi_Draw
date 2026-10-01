import type { Rect } from './types'

export const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export const dist = (ax: number, ay: number, bx: number, by: number) =>
  Math.hypot(bx - ax, by - ay)

export const uid = (() => {
  let n = 0
  return (prefix = 'e') => `${prefix}${(++n).toString(36)}${Date.now().toString(36)}`
})()

/* --------------------------- 2x3 matrices --------------------------- */

export interface Mat {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export const matIdentity = (): Mat => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })

export const matMul = (m: Mat, n: Mat): Mat => ({
  a: m.a * n.a + m.c * n.b,
  b: m.b * n.a + m.d * n.b,
  c: m.a * n.c + m.c * n.d,
  d: m.b * n.c + m.d * n.d,
  e: m.a * n.e + m.c * n.f + m.e,
  f: m.b * n.e + m.d * n.f + m.f,
})

export const matApply = (m: Mat, x: number, y: number) => ({
  x: m.a * x + m.c * y + m.e,
  y: m.b * x + m.d * y + m.f,
})

export const matInvert = (m: Mat): Mat => {
  const det = m.a * m.d - m.b * m.c
  if (Math.abs(det) < 1e-12) return matIdentity()
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  }
}

export function matCompose(
  tx: number,
  ty: number,
  rot: number,
  sx: number,
  sy: number,
  ox = 0,
  oy = 0,
): Mat {
  const cos = Math.cos(rot)
  const sin = Math.sin(rot)
  const a = cos * sx
  const b = sin * sx
  const c = -sin * sy
  const d = cos * sy
  // translate so that origin (ox,oy) maps through the linear part first
  return {
    a,
    b,
    c,
    d,
    e: tx - (a * ox + c * oy),
    f: ty - (b * ox + d * oy),
  }
}

/* ------------------------------ rects ------------------------------- */

export const rectFrom = (x1: number, y1: number, x2: number, y2: number): Rect => ({
  x: Math.min(x1, x2),
  y: Math.min(y1, y2),
  w: Math.abs(x2 - x1),
  h: Math.abs(y2 - y1),
})

export const rectsIntersect = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

export const rectContains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w &&
  inner.y + inner.h <= outer.y + outer.h

export const pointInRect = (x: number, y: number, r: Rect) =>
  x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h

export const inflate = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  w: r.w + by * 2,
  h: r.h + by * 2,
})

export const unionRects = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  }
}

export const emptyRect = (): Rect => ({ x: 0, y: 0, w: 0, h: 0 })

/* ------------------------------ points ------------------------------ */

export interface Vec2 {
  x: number
  y: number
}

/** Squared distance from point p to segment ab. */
export function distToSegmentSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-9) return (px - ax) ** 2 + (py - ay) ** 2
  let t = ((px - ax) * dx + (py - ay) * dy) / len2
  t = clamp(t, 0, 1)
  const cx = ax + t * dx
  const cy = ay + t * dy
  return (px - cx) ** 2 + (py - cy) ** 2
}

/** Ramer–Douglas–Peucker simplification. */
export function simplify(
  pts: Vec2[],
  tolerance: number,
): Vec2[] {
  if (pts.length < 3) return pts.slice()
  const keep = new Uint8Array(pts.length)
  keep[0] = 1
  keep[pts.length - 1] = 1
  const tol2 = tolerance * tolerance
  const stack: [number, number][] = [[0, pts.length - 1]]
  while (stack.length) {
    const [s, e] = stack.pop()!
    let maxD = -1
    let idx = -1
    const ax = pts[s].x
    const ay = pts[s].y
    const bx = pts[e].x
    const by = pts[e].y
    for (let i = s + 1; i < e; i++) {
      const d = distToSegmentSq(pts[i].x, pts[i].y, ax, ay, bx, by)
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (maxD > tol2 && idx > 0) {
      keep[idx] = 1
      stack.push([s, idx], [idx, e])
    }
  }
  const out: Vec2[] = []
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i])
  return out
}

/* ------------------------------ colour ------------------------------ */

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let h = hex.replace('#', '').trim()
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('')
  const n = parseInt(h || '000000', 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

export function rgbToHex(r: number, g: number, b: number): string {
  const f = (v: number) =>
    Math.round(clamp(v, 0, 255))
      .toString(16)
      .padStart(2, '0')
  return `#${f(r)}${f(g)}${f(b)}`
}

/** Perceptual-ish luminance used to pick readable label colours. */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}

export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex)
  return `rgba(${r},${g},${b},${clamp(alpha, 0, 1)})`
}

/* ---------------------------- misc helpers -------------------------- */

export const degToRad = (d: number) => (d * Math.PI) / 180

export function roundTo(v: number, step: number): number {
  return step <= 0 ? v : Math.round(v / step) * step
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'board'
  )
}
