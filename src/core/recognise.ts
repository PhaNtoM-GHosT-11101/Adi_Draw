/**
 * Ink-to-shape.
 *
 * People draw a rectangle with a wobbly hand and then mean a rectangle. This
 * scores the drawn ink against ideal candidates and reports the closest one,
 * so a rough shape can be snapped into a crisp element.
 *
 * Two decisions worth knowing:
 *
 *  - Shapes are compared in *arc-length* space, not by index. A hand-drawn
 *    triangle almost never starts at the same vertex a generated triangle
 *    does, so every candidate is tried at every start offset and in both
 *    directions, and the best alignment wins.
 *
 *  - The score is normalised by the shape's own diagonal, so the tolerance
 *    means the same thing for a 20px doodle and a 600px diagram.
 *
 * Simpler shapes win ties: a circle-ish scribble that fits both "rect" and
 * "ellipse" should not become a rectangle just because it came first.
 */

export type InkShapeKind = 'line' | 'rect' | 'ellipse' | 'triangle' | 'diamond'

export interface InkShape {
  kind: InkShapeKind
  /** the shape's extent, ready to become a ShapeElement */
  box: { x: number; y: number; w: number; h: number }
  /** 0..1, lower is a cleaner match */
  error: number
}

export interface Vec2 {
  x: number
  y: number
}

const SAMPLES = 48
/** how far the ink may sit from its best-fit shape, as a fraction of the diagonal */
const TOLERANCE = 0.055
/** two fits this close are considered a tie and the simpler shape wins */
const TIE = 0.12

/** Candidates in simplest-first order; ties resolve toward the front. */
const ORDER: InkShapeKind[] = ['line', 'rect', 'ellipse', 'triangle', 'diamond']

/* ----------------------------- geometry ----------------------------- */

function pathLength(pts: Vec2[]): number {
  let d = 0
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return d
}

/** Evenly spaced points along the path, by arc length. */
function resample(pts: Vec2[], n: number): Vec2[] {
  const total = pathLength(pts)
  if (total <= 0) return new Array(n).fill(pts[0] ?? { x: 0, y: 0 })
  const step = total / (n - 1)
  const out: Vec2[] = [{ x: pts[0].x, y: pts[0].y }]
  let seg = 1
  let acc = 0
  let prev = pts[0]
  while (out.length < n && seg < pts.length) {
    const cur = pts[seg]
    const segLen = Math.hypot(cur.x - prev.x, cur.y - prev.y)
    if (acc + segLen >= step) {
      const t = (step - acc) / segLen
      const p = { x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t }
      out.push(p)
      prev = p
      acc = 0
    } else {
      acc += segLen
      prev = cur
      seg++
    }
  }
  while (out.length < n) out.push({ x: pts[pts.length - 1].x, y: pts[pts.length - 1].y })
  return out
}

function boxOf(pts: Vec2[]) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** Root-mean-square gap between two equal-length point runs. */
function rms(a: Vec2[], b: Vec2[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    sum += (a[i].x - b[i].x) ** 2 + (a[i].y - b[i].y) ** 2
  }
  return Math.sqrt(sum / a.length)
}

/**
 * Best gap between `target` and `cand`, trying every start offset and both
 * travel directions so neither the starting point nor the winding matters.
 */
function bestAlignment(target: Vec2[], cand: Vec2[]): number {
  const n = cand.length
  let best = Infinity
  let bestShift = 0
  let bestFlip = false

  // coarse pass: eighths of the loop are plenty to bracket the right phase,
  // but on their own they can only land within stride/2 samples of it
  const coarse = Math.max(1, Math.round(n / 8))
  for (const flip of [false, true]) {
    const src = flip ? [...cand].reverse() : cand
    for (let shift = 0; shift < n; shift += coarse) {
      const rolled = src.slice(shift).concat(src.slice(0, shift))
      const e = rms(target, rolled)
      if (e < best) {
        best = e
        bestShift = shift
        bestFlip = flip
      }
    }
  }

  // fine pass around the winner, one sample at a time
  const src = bestFlip ? [...cand].reverse() : cand
  for (let shift = bestShift - coarse; shift <= bestShift + coarse; shift++) {
    const k = ((shift % n) + n) % n
    const rolled = src.slice(k).concat(src.slice(0, k))
    const e = rms(target, rolled)
    if (e < best) best = e
  }
  return best
}

/* ---------------------------- candidates ---------------------------- */

/** Dense outline for each candidate, drawn clockwise in the shape's own space. */
function outline(kind: InkShapeKind, box: { x: number; y: number; w: number; h: number }, ends: Vec2[]): Vec2[] {
  const { x, y, w, h } = box
  const pts: Vec2[] = []
  switch (kind) {
    case 'line':
      pts.push({ x: ends[0].x, y: ends[0].y }, { x: ends[ends.length - 1].x, y: ends[ends.length - 1].y })
      break
    case 'rect':
      pts.push({ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y })
      break
    case 'triangle':
      pts.push({ x: x + w / 2, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x: x + w / 2, y })
      break
    case 'diamond':
      pts.push(
        { x: x + w / 2, y },
        { x: x + w, y: y + h / 2 },
        { x: x + w / 2, y: y + h },
        { x, y: y + h / 2 },
        { x: x + w / 2, y },
      )
      break
    case 'ellipse': {
      const cx = x + w / 2
      const cy = y + h / 2
      for (let i = 0; i <= 120; i++) {
        const t = (i / 120) * Math.PI * 2
        pts.push({ x: cx + (w / 2) * Math.cos(t), y: cy + (h / 2) * Math.sin(t) })
      }
      break
    }
  }
  return pts
}

/* ------------------------------ public ------------------------------ */

export function recogniseInk(raw: Vec2[]): InkShape | null {
  // drop repeats so a held-still pointer cannot fake a shape out of nothing
  const pts: Vec2[] = []
  for (const p of raw) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    const prev = pts[pts.length - 1]
    if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) < 0.6) continue
    pts.push({ x: p.x, y: p.y })
  }
  // four corners is the least a rectangle can be, and a sparse pointer rate
  // legitimately delivers that few samples
  if (pts.length < 4) return null

  const box = boxOf(pts)
  const diagonal = Math.hypot(box.w, box.h)
  if (diagonal < 18) return null // a wiggle, not a shape

  const target = resample(pts, SAMPLES)

  let bestKind: InkShapeKind | null = null
  let bestError = Infinity
  for (const kind of ORDER) {
    // a "line" only makes sense when the ink really is elongated
    if (kind === 'line') {
      // a line is only plausible if the ink is clearly elongated; 0.75 still
      // admits a comfortable 40-degree diagonal but rejects flat rectangles,
      // whose two long sides are not collinear
      const smaller = Math.min(box.w, box.h) / Math.max(box.w, box.h, 0.001)
      if (smaller > 0.75) continue
    }
    const cand = resample(outline(kind, box, pts), SAMPLES)
    const error = bestAlignment(target, cand) / diagonal
    // simplest-first, so a strictly better score wins and a near-tie keeps the simpler shape
    if (error < bestError * (1 - TIE)) {
      bestError = error
      bestKind = kind
    }
  }

  if (!bestKind || bestError > TOLERANCE) return null
  return { kind: bestKind, box, error: bestError }
}
