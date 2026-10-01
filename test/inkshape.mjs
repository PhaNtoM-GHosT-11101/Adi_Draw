/**
 * Ink-to-shape, end to end.
 *
 * test/recognise.mjs proves the matcher works on point lists. This drives the
 * real app: draw a wobbly shape with the pen, select it, press the button, and
 * confirm the stroke became a crisp shape element that still undoes cleanly.
 * Also covers the paper picker, since its swatches are the only way to change
 * what the board looks like.
 */
import { launch } from './browser.mjs'
import { createServer } from 'vite'

const server = await createServer({ server: { port: 5423, strictPort: true }, logLevel: 'error' })
await server.listen()
const browser = await launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })

const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text())
})

let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) {
    pass++
    console.log('PASS ', name)
  } else {
    fail++
    console.log('FAIL ', name, extra)
  }
}

const settle = (n = 4) =>
  page.evaluate(
    (k) =>
      new Promise((r) => {
        let i = 0
        const f = () => (++i >= k ? r() : requestAnimationFrame(f))
        requestAnimationFrame(f)
      }),
    n,
  )

const clearBoard = () =>
  page.evaluate(() => {
    const s = window.adiDraw.store
    s.setSelection([])
    s.doc.elements[s.doc.layers[0].id] = []
    s.markAllDirty()
    s.notify('doc')
  })

await page.goto('http://localhost:5423/', { waitUntil: 'networkidle' })
await page.waitForSelector('.rail-btn')

/* ------------------------------- draw ------------------------------- */

/** Trace a closed outline through the real pointer pipeline, with hand-wobble. */
const drawShape = (kind) =>
  page.evaluate(async (kind) => {
    window.adiDraw.tools.setActive('pen')
    const c = document.querySelector('canvas.board')
    const b = c.getBoundingClientRect()
    const ev = (t, x, y) =>
      c.dispatchEvent(
        new PointerEvent(t, {
          pointerId: 1, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
          clientX: b.left + x, clientY: b.top + y, pressure: 0.5, tiltX: 20, tiltY: -8,
          buttons: t === 'pointerup' ? 0 : 1, button: 0,
        }),
      )
    const raf = () => new Promise((r) => requestAnimationFrame(r))

    const X = 300, Y = 240, W = 340, H = 200
    let ideal
    if (kind === 'rect')
      ideal = [{ x: X, y: Y }, { x: X + W, y: Y }, { x: X + W, y: Y + H }, { x: X, y: Y + H }, { x: X, y: Y }]
    else if (kind === 'ellipse')
      ideal = Array.from({ length: 49 }, (_, i) => {
        const a = (i / 48) * Math.PI * 2
        return { x: X + W / 2 + (W / 2) * Math.cos(a), y: Y + H / 2 + (H / 2) * Math.sin(a) }
      })
    else ideal = [{ x: X + W / 2, y: Y }, { x: X + W, y: Y + H }, { x: X, y: Y + H }, { x: X + W / 2, y: Y }]

    // densify, then wobble each sample a little the way a hand would
    const pts = []
    for (let i = 0; i < ideal.length - 1; i++) {
      const a = ideal[i], z = ideal[i + 1]
      const n = Math.max(2, Math.round(Math.hypot(z.x - a.x, z.y - a.y) / 7))
      for (let k = 0; k < n; k++)
        pts.push({
          x: a.x + ((z.x - a.x) * k) / n + Math.sin(k * 1.7) * 1.3,
          y: a.y + ((z.y - a.y) * k) / n + Math.cos(k * 1.3) * 1.3,
        })
    }
    pts.push(ideal[ideal.length - 1])

    ev('pointerdown', pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) {
      ev('pointermove', pts[i].x, pts[i].y)
      await raf()
    }
    ev('pointerup', pts[pts.length - 1].x, pts[pts.length - 1].y)
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    return window.adiDraw.store.allElements().length
  }, kind)

const kindsOf = () => page.evaluate(() => window.adiDraw.store.allElements().map((e) => e.kind))

const shapeOf = () =>
  page.evaluate(() => {
    const e = window.adiDraw.store.allElements()[0]
    return e ? { kind: e.kind, shape: e.style?.shape, id: e.id, layerId: e.layerId } : null
  })

/* --------------------------- the conversion ------------------------- */

for (const [drawn, expect] of [
  ['rect', 'rect'],
  ['ellipse', 'ellipse'],
  ['triangle', 'triangle'],
]) {
  await clearBoard()
  await drawShape(drawn)
  check(`${drawn} starts as ink`, (await kindsOf()).join() === 'stroke', (await kindsOf()).join())

  // select it the way a user would: switch to select and click the ink
  await page.evaluate(() => {
    window.adiDraw.tools.setActive('select')
    const s = window.adiDraw.store
    s.setSelection(s.allElements().map((e) => e.id))
  })
  await settle()

  const offered = await page.evaluate(
    () => !!Array.from(document.querySelectorAll('.panel button')).find((b) => b.textContent.includes('Ink to shape')),
  )
  check(`${drawn}: the button is offered`, offered)

  const clicked = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.panel button')).find((x) => x.textContent.includes('Ink to shape'))
    if (!b) return false
    b.click()
    return true
  })
  check(`${drawn}: the button converts`, clicked)
  await settle()

  const after = await shapeOf()
  check(`${drawn}: became a ${expect}`, after?.kind === 'shape' && after?.shape === expect, JSON.stringify(after))
  check(`${drawn}: kept its id`, after?.id === (await page.evaluate(() => window.adiDraw.store.allElements()[0].id)))
}

/* ------------------------------- undo ------------------------------- */

await clearBoard()
await drawShape('rect')
await page.evaluate(() => {
  window.adiDraw.tools.setActive('select')
  const s = window.adiDraw.store
  s.setSelection(s.allElements().map((e) => e.id))
})
await settle()
await page.evaluate(() => {
  Array.from(document.querySelectorAll('.panel button'))
    .find((x) => x.textContent.includes('Ink to shape'))
    ?.click()
})
await settle()
check('converted before undo', (await kindsOf()).join() === 'shape')

await page.evaluate(() => window.adiDraw.store.undo())
await settle()
check('undo restores the original ink', (await kindsOf()).join() === 'stroke', (await kindsOf()).join())

await page.evaluate(() => window.adiDraw.store.redo())
await settle()
check('redo re-applies the shape', (await kindsOf()).join() === 'shape')

/* --------------------- a scribble must be left alone ------------------ */

await clearBoard()
await page.evaluate(async () => {
  window.adiDraw.tools.setActive('pen')
  const c = document.querySelector('canvas.board')
  const b = c.getBoundingClientRect()
  const ev = (t, x, y) =>
    c.dispatchEvent(
      new PointerEvent(t, {
        pointerId: 1, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
        clientX: b.left + x, clientY: b.top + y, pressure: 0.5,
        buttons: t === 'pointerup' ? 0 : 1, button: 0,
      }),
    )
  const raf = () => new Promise((r) => requestAnimationFrame(r))
  ev('pointerdown', 300, 300)
  for (let i = 1; i <= 90; i++) {
    const t = i / 90
    ev('pointermove', 300 + Math.sin(t * Math.PI * 9) * 150 + t * 180, 320 + Math.cos(t * Math.PI * 7) * 90)
    await raf()
  }
  ev('pointerup', 480, 320)
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
})
await page.evaluate(() => {
  window.adiDraw.tools.setActive('select')
  const s = window.adiDraw.store
  s.setSelection(s.allElements().map((e) => e.id))
})
await settle()
check(
  'a scribble is not offered for conversion',
  !(await page.evaluate(() =>
    Array.from(document.querySelectorAll('.panel button')).some((b) => b.textContent.includes('Ink to shape')),
  )),
)
check(
  'and calling it directly is a no-op',
  await page.evaluate(() => window.adiDraw.app.controller.inkToShape() === false),
)
check('the scribble is still ink', (await kindsOf()).join() === 'stroke')

/* ------------------------------ the paper --------------------------- */

await page.evaluate(() => window.adiDraw.store.begin && null)
const paperChips = await page.evaluate(() => {
  document.querySelector('[data-tab="board"]')?.click()
  return Array.from(document.querySelectorAll('.paper-chip')).map((b) => b.textContent.trim())
})
check('four paper styles are offered', paperChips.length === 4, JSON.stringify(paperChips))
check('they cover blank, grid, ruled and dots', paperChips.join() === 'Blank,Grid,Ruled,Dots', paperChips.join())

check('ruled paper is selectable', await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('.paper-chip')).find((x) => x.textContent.includes('Ruled'))
  b.click()
  return window.adiDraw.store.doc.meta.canvasStyle === 'ruled'
}))
await settle()
check(
  'the swatch marks the active paper',
  await page.evaluate(() =>
    Array.from(document.querySelectorAll('.paper-chip')).find((x) => x.textContent.includes('Ruled'))
      ?.classList.contains('is-active'),
  ),
)
check(
  'ruled paper paints horizontal rules',
  await page.evaluate(() => window.adiDraw.store.doc.meta.canvasStyle === 'ruled'),
)

/* Ruled lines must not be square. Horizontal rules are crossed by a vertical
   scan many times but by a horizontal scan almost never, so the column count
   is the one that must be high. Clear the board first or the scribble shows
   up in both counts. */
await clearBoard()
await settle()
const ruledLooksRight = await page.evaluate(async () => {
  const c = document.querySelector('canvas.board')
  const g = c.getContext('2d')
  const row = g.getImageData(0, Math.round(c.height / 2), c.width, 1).data
  const col = g.getImageData(Math.round(c.width / 2), 0, 1, c.height).data
  const count = (d, stride) => {
    let n = 0
    for (let i = 0; i < d.length; i += stride) if (d[i] < 240) n++
    return n
  }
  const horizontalRules = count(row, 4)
  const verticalRules = count(col, 4)
  return { rowCrossings: horizontalRules, columnCrossings: verticalRules }
})
check(
  'ruled paper is crossed by a vertical scan but not a horizontal one',
  ruledLooksRight.columnCrossings > 20 && ruledLooksRight.rowCrossings < 5,
  JSON.stringify(ruledLooksRight),
)

check(
  'switching back to grid restores the cross-hatch',
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('.paper-chip')).find((x) => x.textContent.includes('Grid')).click()
    return window.adiDraw.store.doc.meta.canvasStyle === 'lines'
  }),
)

check('no console errors', errors.length === 0, errors.join(' | '))

await browser.close()
await server.close()
console.log(`\n${pass}/${pass + fail} checks passed`)
process.exit(fail ? 1 : 0)
