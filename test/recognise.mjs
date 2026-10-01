/**
 * Ink-to-shape recognition.
 *
 * Drives recogniseInk directly (via vite's SSR module loader) with hand-drawn
 * paths — the kind of wobble a mouse or a shaky stylus actually produces — and
 * checks it picks the shape the user meant. Also covers the negative cases,
 * because a feature that "snaps" random scribbles into rectangles is worse
 * than not having it.
 */
import { createServer } from 'vite'

const server = await createServer({ server: { port: 5422, strictPort: true }, logLevel: 'error' })
const mod = await server.ssrLoadModule('/src/core/recognise.ts')
const { recogniseInk } = mod

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log('PASS ', name)
  } else {
    fail++
    console.log('FAIL ', name, detail)
  }
}

/* --------------------------- stroke makers --------------------------- */

/** Walk a polyline at a fixed spacing, the way a pointer reports samples. */
function densify(ideal, step = 6) {
  const out = []
  for (let i = 0; i < ideal.length - 1; i++) {
    const a = ideal[i]
    const b = ideal[i + 1]
    const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / step))
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n })
  }
  out.push(ideal[ideal.length - 1])
  return out
}

/** Trace an ideal outline, then wobble it the way a hand would. */
function handDrawn(ideal, { jitter = 1.6, wobble = 0.9, seed = 1, gap = 0.02 } = {}) {
  ideal = densify(ideal)
  let s = seed
  const rnd = () => {
    // deterministic noise, so a failure is always reproducible
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296 - 0.5
  }
  const out = []
  const len = ideal.length
  // no wrapping: these paths include their own closing point, and wrapping an
  // *open* path would jump from its end back to its start
  for (let i = 0; i < len; i++) {
    if (i > 0 && gap > 0 && i < len - 1 && rnd() < gap) continue // lift the pen a little
    const p = ideal[i]
    const drift = Math.sin((i / len) * Math.PI * 2 * 3) * wobble
    out.push({
      x: p.x + rnd() * jitter * 2 + drift,
      y: p.y + rnd() * jitter * 2 + drift * 0.6,
    })
  }
  return out
}

const arc = (fn, n) => Array.from({ length: n }, (_, i) => fn(i / n))

function rectPath(x, y, w, h) {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
    { x, y },
  ]
}

function ellipsePath(cx, cy, rx, ry) {
  return arc((t) => {
    const a = t * Math.PI * 2
    return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) }
  }, 40)
}

function linePath(x1, y1, x2, y2) {
  return arc((t) => ({ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t }), 30)
}

function trianglePath(x, y, w, h) {
  return [
    { x: x + w / 2, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
    { x: x + w / 2, y },
  ]
}

function diamondPath(x, y, w, h) {
  return [
    { x: x + w / 2, y },
    { x: x + w, y: y + h / 2 },
    { x: x + w / 2, y: y + h },
    { x, y: y + h / 2 },
    { x: x + w / 2, y },
  ]
}

/* ------------------------------ positive ----------------------------- */

const r1 = recogniseInk(handDrawn(rectPath(40, 40, 180, 120), { seed: 7 }))
check('a wobbly rectangle is read as a rectangle', r1?.kind === 'rect', `got ${r1?.kind} err=${r1?.error.toFixed(3)}`)

const r2 = recogniseInk(handDrawn(ellipsePath(130, 100, 90, 60), { jitter: 1.8, seed: 11 }))
check('a wobbly ellipse is read as an ellipse', r2?.kind === 'ellipse', `got ${r2?.kind} err=${r2?.error.toFixed(3)}`)

const r3 = recogniseInk(handDrawn(linePath(20, 30, 300, 210), { jitter: 1.4, seed: 3 }))
check('a wobbly line is read as a line', r3?.kind === 'line', `got ${r3?.kind} err=${r3?.error.toFixed(3)}`)

const r4 = recogniseInk(handDrawn(trianglePath(50, 40, 160, 130), { jitter: 1.5, seed: 5 }))
check('a wobbly triangle is read as a triangle', r4?.kind === 'triangle', `got ${r4?.kind} err=${r4?.error.toFixed(3)}`)

const r5 = recogniseInk(handDrawn(diamondPath(60, 40, 140, 140), { jitter: 1.5, seed: 9 }))
check('a wobbly diamond is read as a diamond', r5?.kind === 'diamond', `got ${r5?.kind} err=${r5?.error.toFixed(3)}`)

/* ------------------------------ alignment ---------------------------- */

/* The recogniser must not care where the pen started or which way it went.
   Rotate the samples rather than slicing, so the ink still covers the whole
   outline — slicing would hand it a genuinely different, open stroke. */
const rotatedStart = (() => {
  const path = handDrawn(rectPath(40, 40, 180, 120), { seed: 7 })
  const at = Math.floor(path.length * 0.37)
  return path.slice(at).concat(path.slice(0, at))
})()
const r6 = recogniseInk(rotatedStart)
check('the starting vertex does not matter', r6?.kind === 'rect', `got ${r6?.kind}`)

const reversed = handDrawn(ellipsePath(130, 100, 90, 60), { jitter: 1.8, seed: 11 }).reverse()
const r7 = recogniseInk(reversed)
check('the winding direction does not matter', r7?.kind === 'ellipse', `got ${r7?.kind}`)

/* A tiny circle must not collapse into a rectangle, and vice versa. */
const circle = handDrawn(ellipsePath(100, 100, 70, 70), { jitter: 1.4, seed: 13 })
const r8 = recogniseInk(circle)
check('a circle prefers ellipse over rect', r8?.kind === 'ellipse', `got ${r8?.kind}`)

/* -------------------------- scale independence ------------------------ */

/* The tolerance is a fraction of the diagonal, so a small doodle should work
   as well as a large one. */
const small = recogniseInk(handDrawn(rectPath(10, 10, 60, 40), { jitter: 1.2, seed: 21 }))
const large = recogniseInk(handDrawn(rectPath(10, 10, 600, 400), { jitter: 1.2, seed: 21 }))
check(
  'small and large shapes are both recognised',
  small?.kind === 'rect' && large?.kind === 'rect',
  `small=${small?.kind} large=${large?.kind}`,
)

/* ------------------------------ negative ----------------------------- */

check('a tiny scribble is not a shape', recogniseInk(linePath(10, 10, 14, 12)) === null)

check(
  'a free-form squiggle is left alone',
  recogniseInk(
    arc((t) => ({
      x: 60 + Math.sin(t * Math.PI * 5) * 70 + t * 160,
      y: 120 + Math.cos(t * Math.PI * 3.5) * 55,
    }), 90),
  ) === null,
)

check(
  'a very rough rectangle is rejected rather than snapped',
  recogniseInk(handDrawn(rectPath(40, 40, 180, 120), { jitter: 13, seed: 31 })) === null,
)

check(
  'too few points is rejected',
  recogniseInk([
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 40 },
  ]) === null,
)

check(
  'a held-still pointer cannot fake a shape',
  recogniseInk(new Array(80).fill({ x: 100, y: 100 })) === null,
)

check('an empty stroke is rejected', recogniseInk([]) === null)

/* ------------------------------- output ------------------------------ */

check(
  'the reported box covers the ink',
  !!r1 &&
    r1.box.w > 150 &&
    r1.box.w < 220 &&
    r1.box.h > 90 &&
    r1.box.h < 160 &&
    r1.box.x > 20 &&
    r1.box.y > 20,
  r1 ? JSON.stringify(r1.box) : 'no result',
)

check(
  'the reported error is a small fraction',
  !!r1 && r1.error >= 0 && r1.error < 0.055,
  r1 ? String(r1.error) : 'no result',
)

await server.close()
console.log(`\n${pass}/${pass + fail} checks passed`)
process.exit(fail ? 1 : 0)
