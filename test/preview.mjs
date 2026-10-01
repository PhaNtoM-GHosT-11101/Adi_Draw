/**
 * Live-preview regression tests.
 *
 * The scene is repainted region by region, so every gesture that grows
 * something under the cursor has to declare the area it claimed — and each
 * frame's damage rectangle has to *contain* the previous frame's, or the strip
 * between them is never repainted and the stroke appears broken into pieces.
 *
 * Both failure modes are covered here:
 *   - ink missing entirely while drawing (it only turned up after an unrelated
 *     full repaint)
 *   - gaps between the per-frame repaints of a fast stroke
 */
import { launch } from './browser.mjs'
import { createServer } from 'vite'

const server = await createServer({ server: { port: 5415, strictPort: true }, logLevel: 'error' })
await server.listen()
const browser = await launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text())
})

const results = []
const check = (name, ok, extra = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`
  results.push(line)
  console.log(line)
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

const top = () => page.evaluate(() => document.querySelector('canvas.board').getBoundingClientRect().top)
const left = () => page.evaluate(() => document.querySelector('canvas.board').getBoundingClientRect().left)

/** Count ink in the canvas row that `clientY` falls on. */
const inkInRow = (clientY) =>
  page.evaluate((y) => {
    const c = document.querySelector('canvas.board')
    const row = Math.round(y - c.getBoundingClientRect().top)
    const d = c.getContext('2d').getImageData(0, row, c.width, 1).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] < 220 || d[i + 1] < 220 || d[i + 2] < 220) n++
    return n
  }, clientY)

/** Count ink in a rectangle given in client coordinates. */
const inkInBox = (x, y, w, h) =>
  page.evaluate(
    ([x, y, w, h]) => {
      const c = document.querySelector('canvas.board')
      const b = c.getBoundingClientRect()
      const d = c
        .getContext('2d')
        .getImageData(Math.round(x - b.left), Math.round(y - b.top), Math.round(w), Math.round(h)).data
      let n = 0
      for (let i = 0; i < d.length; i += 4) if (d[i] < 220 || d[i + 1] < 220 || d[i + 2] < 220) n++
      return n
    },
    [x, y, w, h],
  )

const pen = (x, y, pressure) =>
  page.evaluate(
    ([x, y, pressure]) => {
      const c = document.querySelector('canvas.board')
      c.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerId: 1, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
          clientX: x, clientY: y, pressure, buttons: 1, button: 0,
        }),
      )
    },
    [x, y, pressure],
  )

await page.goto('http://localhost:5415/', { waitUntil: 'networkidle' })
await page.waitForSelector('.rail-btn')

const L = await left()
const T = await top()

/* ---------------------------- freehand ---------------------------- */

await page.keyboard.press('KeyB')
await settle(2)
const Y1 = T + 400
await page.evaluate(
  ([L, Y]) => {
    const c = document.querySelector('canvas.board')
    const ev = (t, x, y) =>
      c.dispatchEvent(
        new PointerEvent(t, {
          pointerId: 1, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
          clientX: x, clientY: y, pressure: 0.8, buttons: t === 'pointerup' ? 0 : 1, button: 0,
        }),
      )
    window.__ev = ev
    ev('pointerdown', L + 200, Y)
    for (let i = 1; i <= 30; i++) ev('pointermove', L + 200 + i * 20, Y)
    window.__lift = () => ev('pointerup', L + 800, Y)
  },
  [L, Y1],
)
await settle(5)
const penDown = await inkInRow(Y1)
const penProfile = await page.evaluate(() => ({ ...window.adiDraw.app.renderer.profile }))
check('freehand ink appears while the pointer is still down', penDown > 100, `${penDown} px`)
check(
  'only a few regions are repainted, not the whole board',
  penProfile.regions >= 1 && penProfile.regions <= 4,
  `${penProfile.regions} region(s), ${penProfile.paint.toFixed(2)}ms paint`,
)
await page.evaluate(() => window.__lift())
await settle(4)
check('the stroke survives pointerup unchanged', (await inkInRow(Y1)) === penDown, `${await inkInRow(Y1)} px`)

/* a second stroke elsewhere must not disturb the first */
await page.keyboard.press('KeyM')
await settle(2)
const Y2 = T + 600
await page.evaluate(
  ([L, Y]) => {
    const ev = (t, x) => window.__ev(t, x, Y)
    ev('pointerdown', L + 200)
    for (let i = 1; i <= 20; i++) ev('pointermove', L + 200 + i * 20)
    window.__lift2 = () => ev('pointerup', L + 600)
  },
  [L, Y2],
)
await settle(5)
check('a second stroke draws while the first stays put', (await inkInRow(Y2)) > 100)
await page.evaluate(() => window.__lift2())
await settle(3)
check('the first stroke is untouched', (await inkInRow(Y1)) === penDown)

/* --------------------------- gap check --------------------------- */

/**
 * One sample per animation frame, 26px apart — far more than the pen is wide.
 * Consecutive damage rectangles only stay invisible if each one contains the
 * previous one; otherwise the background strip between them shows through.
 */
await page.keyboard.press('KeyB')
await settle(2)
const Y3 = T + 200
const gap = await page.evaluate(
  async ([L, Y]) => {
    const c = document.querySelector('canvas.board')
    const ev = (t, x, pressure) =>
      c.dispatchEvent(
        new PointerEvent(t, {
          pointerId: 1, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
          clientX: x, clientY: Y, pressure, buttons: t === 'pointerup' ? 0 : 1, button: 0,
        }),
      )
    const raf = () => new Promise((r) => requestAnimationFrame(r))
    ev('pointerdown', L + 120, 0.4)
    let x = 120
    const worstDuring = { runs: [], seen: 0 }
    for (let i = 0; i < 24; i++) {
      x += 26
      ev('pointermove', L + x, 0.95)
      await raf()
      const d = c.getContext('2d').getImageData(0, Math.round(Y - c.getBoundingClientRect().top), c.width, 1).data
      const ink = []
      for (let px = 0; px < c.width; px++) {
        const k = px * 4
        ink.push(d[k] < 220 || d[k + 1] < 220 || d[k + 2] < 220)
      }
      const first = ink.indexOf(true)
      let last = -1
      for (let px = 0; px < ink.length; px++) if (ink[px]) last = px
      const runs = []
      let run = 0
      for (let px = Math.max(0, first); px <= last; px++) {
        if (!ink[px]) run++
        else if (run) {
          runs.push(run)
          run = 0
        }
      }
      if (run) runs.push(run)
      worstDuring.seen++
      worstDuring.runs.push(...runs)
    }
    ev('pointerup', L + x, 0)
    return { runs: worstDuring.runs, frames: worstDuring.seen }
  },
  [L, Y3],
)
check(
  'a fast stroke is continuous — no gaps between frames',
  gap.runs.filter((r) => r > 0).length === 0,
  gap.runs.length
    ? `${gap.runs.length} gap px over ${gap.frames} frames (${gap.runs.join('/')})`
    : `solid across ${gap.frames} frames`,
)
await settle(3)
const gapAfterUp = await page.evaluate(
  ([L, Y]) => {
    const c = document.querySelector('canvas.board')
    const d = c.getContext('2d').getImageData(0, Math.round(Y - c.getBoundingClientRect().top), c.width, 1).data
    const ink = []
    for (let px = 0; px < c.width; px++) {
      const k = px * 4
      ink.push(d[k] < 220 || d[k + 1] < 220 || d[k + 2] < 220)
    }
    const first = ink.indexOf(true)
    let last = -1
    for (let px = 0; px < ink.length; px++) if (ink[px]) last = px
    let runs = 0
    let run = 0
    for (let px = first; px <= last; px++) {
      if (!ink[px]) run++
      else if (run) {
        runs++
        run = 0
      }
    }
    return runs + run
  },
  [L, Y3],
)
check('and stays solid after the stroke is committed', gapAfterUp === 0, `${gapAfterUp} gap px`)

/* ----------------------------- shape ----------------------------- */

await page.keyboard.press('KeyR')
await settle(2)
await page.evaluate(
  ([L, T]) => {
    const ev = (t, x, y) => window.__ev(t, x, y)
    ev('pointerdown', L + 850, T + 200)
    for (let i = 1; i <= 10; i++) ev('pointermove', L + 850 + i * 20, T + 200 + i * 18)
    window.__liftShape = () => ev('pointerup', L + 1050, T + 380)
  },
  [L, T],
)
await settle(5)
check('shape outline appears while dragging', (await inkInBox(L + 900, T + 260, 120, 90)) > 40)
await page.evaluate(() => window.__liftShape())
await settle(3)

/* ------------------------------ note ----------------------------- */

await page.keyboard.press('KeyN')
await settle(2)
await page.evaluate(
  ([L, T]) => {
    const ev = (t, x, y) => window.__ev(t, x, y)
    ev('pointerdown', L + 120, T + 180)
    for (let i = 1; i <= 20; i++) ev('pointermove', L + 120 + i * 8, T + 180 + i * 5)
    window.__liftNote = () => ev('pointerup', L + 280, T + 280)
  },
  [L, T],
)
await settle(5)
check('note body appears while resizing', (await inkInBox(L + 150, T + 200, 100, 60)) > 500)
await page.evaluate(() => window.__liftNote())
await settle(3)
// dropping a note opens its text editor, which would swallow the next keystroke
await page.waitForSelector('textarea.text-editor', { timeout: 3000 })
await page.keyboard.press('Escape')
await settle(3)

/* ------------------------ selection drag ------------------------- */

await page.keyboard.press('KeyV')
await settle(2)
const grabbed = await page.evaluate(
  ([L, T]) => {
    const s = window.adiDraw.store
    // element y is world space, and the marker stroke was drawn at client
    // y = T + 600, so its world y is 600
    const stroke = s.allElements().find((e) => e.kind === 'stroke' && Math.abs(e.y - 600) < 8)
    if (!stroke) return null
    s.setSelection([stroke.id])
    const midX = stroke.x + 300
    const ev = (t, x, y) =>
      c2(t, x, y)
    const c2 = (t, x, y) =>
      document.querySelector('canvas.board').dispatchEvent(
        new PointerEvent(t, {
          pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true,
          clientX: x, clientY: y, pressure: 0.5, buttons: t === 'pointerup' ? 0 : 1, button: 0,
        }),
      )
    void ev
    ev('pointerdown', L + midX, T + stroke.y)
    for (let i = 1; i <= 20; i++) ev('pointermove', L + midX, T + stroke.y - i * 6)
    window.__liftSel = () => ev('pointerup', L + midX, T + stroke.y - 120)
    return { worldY: stroke.y, clientY: T + stroke.y }
  },
  [L, T],
)
check('a stroke can be grabbed', !!grabbed, grabbed ? `at client y=${Math.round(grabbed.clientY)}` : 'not found')

if (grabbed) {
  await settle(5)
  const movedInk = await inkInRow(grabbed.clientY - 120)
  const vacated = await inkInRow(grabbed.clientY)
  check('the dragged selection is visible mid-drag', movedInk > 60, `${movedInk} px at the new position`)
  check('the vacated area is repainted, not left behind', vacated < 60, `${vacated} px left behind`)
  await page.evaluate(() => window.__liftSel())
  await settle(4)
  check('it stays put after release', (await inkInRow(grabbed.clientY - 120)) === movedInk)
}

/* ------------------- never a viewport-wide repaint ------------------ */

const regionsSeen = await page.evaluate(() => window.adiDraw.app.renderer.profile.regions)
check('no gesture triggered a viewport-wide repaint', regionsSeen <= 4, `${regionsSeen} regions on the last frame`)

check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '))
await page.screenshot({ path: 'test/preview.png' })

await browser.close()
await server.close()
const failed = results.filter((r) => r.startsWith('FAIL'))
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
