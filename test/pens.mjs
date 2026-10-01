/**
 * Pen types and surface textures.
 *
 * Crayon, chalk and a loaded paint brush only look right if the pigment clumps
 * and the surface shows through — a flat fill reads as a marker. These checks
 * assert the pens exist and that a textured stroke really is uneven while a
 * smooth one is not.
 *
 * Measurement note: absolute darkness is useless here. A red crayon pixel
 * reads as "light" to any brightness threshold, and a dark crayon on a dark
 * board reads as solid either way. What separates a textured stroke from a
 * smooth one is the *variance* of ink density along it, so that is what gets
 * measured, against a background sample taken before the stroke is drawn.
 */
import { launch } from './browser.mjs'
import { createServer } from 'vite'
import { readFile } from 'node:fs/promises'

const server = await createServer({ server: { port: 5421, strictPort: true }, logLevel: 'error' })
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

const clearBoard = () =>
  page.evaluate(() => {
    const s = window.adiDraw.store
    s.setSelection([])
    s.doc.elements[s.doc.layers[0].id] = []
    s.markAllDirty()
    s.notify('doc')
  })

await page.goto('http://localhost:5421/', { waitUntil: 'networkidle' })
await page.waitForSelector('.rail-btn')

/* ------------------------- the pen line-up ------------------------- */

const WANTED = ['pencil', 'pen', 'fountain', 'highlighter', 'crayon', 'marker', 'brush']
const names = await page.evaluate(() =>
  Object.fromEntries(window.adiDraw.tools.all.map((t) => [t.id, t.name])),
)
for (const id of WANTED) check(`${id} exists`, !!names[id], names[id])
check('the brush is called Paint Brush', names.brush === 'Paint Brush', names.brush)
check(
  'the textured pens declare a surface',
  await page.evaluate(() =>
    ['crayon', 'chalk', 'brush', 'pencil'].every((id) => window.adiDraw.tools.get(id).texture !== 'none'),
  ),
)
check(
  'the smooth pens have no surface',
  await page.evaluate(() =>
    ['pen', 'fountain', 'marker', 'highlighter', 'ballpoint'].every(
      (id) => window.adiDraw.tools.get(id).texture === 'none',
    ),
  ),
)
check(
  'every pen has a shortcut',
  await page.evaluate(() =>
    ['pencil', 'pen', 'fountain', 'highlighter', 'crayon', 'marker', 'brush'].every(
      (id) => !!window.adiDraw.tools.get(id).shortcut,
    ),
  ),
)

/* ------------------------- texture measurement --------------------- */

/** Draw a horizontal stroke at `y` and report how uneven the pigment is. */
const strokeStats = (toolId, y) =>
  page.evaluate(
    async ([toolId, y]) => {
      const tools = window.adiDraw.tools
      tools.setActive(toolId)
      const c = document.querySelector('canvas.board')
      const b = c.getBoundingClientRect()
      const row = Math.round(y)
      const g = c.getContext('2d')

      // background reference, well clear of where the stroke will go
      const refRow = g.getImageData(12, row, 1, 1).data
      const ref = [refRow[0], refRow[1], refRow[2]]

      const ev = (t, x, p) =>
        c.dispatchEvent(
          new PointerEvent(t, {
            pointerId: 1, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
            clientX: b.left + x, clientY: b.top + y, pressure: p, tiltX: 20, tiltY: -8,
            buttons: t === 'pointerup' ? 0 : 1, button: 0,
          }),
        )
      const raf = () => new Promise((r) => requestAnimationFrame(r))
      ev('pointerdown', 140, 0.5)
      for (let i = 1; i <= 80; i++) {
        ev('pointermove', 140 + (i / 80) * 520, 0.5 + 0.4 * Math.sin((i / 80) * Math.PI))
        await raf()
      }
      ev('pointerup', 660, 0)
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

      const d = g.getImageData(0, row, c.width, 1).data
      const dist = (px) => {
        const k = px * 4
        return Math.abs(d[k] - ref[0]) + Math.abs(d[k + 1] - ref[1]) + Math.abs(d[k + 2] - ref[2])
      }
      const INK = 25
      let first = -1
      let last = -1
      for (let px = 0; px < c.width; px++)
        if (dist(px) > INK) {
          if (first < 0) first = px
          last = px
        }
      if (first < 0) return { empty: true, cv: 0, runs: 0, span: 0, mean: 0 }

      const vals = []
      for (let px = first; px <= last; px++) vals.push(dist(px))
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length
      const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length
      const cv = mean > 0 ? Math.sqrt(variance) / mean : 0
      let dips = 0
      let runs = 0
      let run = 0
      for (const v of vals) {
        if (v < mean * 0.35) {
          dips++
          run++
        } else if (run) {
          runs++
          run = 0
        }
      }
      if (run) runs++
      return { empty: false, cv, dips, runs, span: vals.length, mean: Math.round(mean) }
    },
    [toolId, y],
  )

await clearBoard()
await settle(3)

const crayon = await strokeStats('crayon', 200)
check('a crayon stroke is drawn at all', !crayon.empty, crayon.empty ? 'nothing on the row' : `${crayon.span} px`)
check(
  'a crayon stroke is clumpy rather than flat',
  crayon.cv > 0.2,
  `variation ${crayon.cv.toFixed(3)}, ${crayon.runs} bare patches of ${crayon.dips} px`,
)
check(
  'a crayon stroke still has plenty of pigment',
  crayon.mean > 100,
  `mean density ${crayon.mean}/765`,
)

const chalk = await strokeStats('chalk', 300)
check('chalk is drawn', !chalk.empty, chalk.empty ? 'nothing on the row' : `${chalk.span} px`)
check(
  'chalk lays down less pigment than crayon',
  !chalk.empty && chalk.mean < crayon.mean * 0.85,
  `mean density chalk ${chalk.mean} vs crayon ${crayon.mean} (of 765)`,
)
check(
  'and it is still uneven, not flat',
  chalk.cv > 0.08,
  `variation ${chalk.cv.toFixed(3)}`,
)

const brush = await strokeStats('brush', 400)
check('a paint brush is drawn', !brush.empty, brush.empty ? 'nothing on the row' : `${brush.span} px`)
check(
  'a paint brush shows its bristles',
  brush.cv > 0.1,
  `variation ${brush.cv.toFixed(3)}, ${brush.runs} bare patches`,
)

const pen = await strokeStats('pen', 500)
check('a pen is drawn', !pen.empty, pen.empty ? 'nothing on the row' : `${pen.span} px`)
check(
  'a smooth pen lays down flat ink',
  pen.cv < 0.1,
  `variation ${pen.cv.toFixed(3)}, ${pen.runs} bare patches`,
)

/* ---------------- texture is configurable on any tool --------------- */

// a thicker line, so the surface has room to read along a single row
await page.evaluate(() =>
  window.adiDraw.tools.update('pen', { texture: 'grain', textureScale: 1.4, size: 18 }),
)
await clearBoard()
await settle(3)
const texturedPen = await strokeStats('pen', 200)
check(
  'giving a smooth pen a surface changes how it draws',
  texturedPen.cv > pen.cv * 1.5,
  `variation ${pen.cv.toFixed(3)} -> ${texturedPen.cv.toFixed(3)}`,
)

await page.evaluate(() => window.adiDraw.tools.update('pen', { textureScale: 0.35 }))
await clearBoard()
await settle(3)
const fine = await strokeStats('pen', 200)
check(
  'grain size is honoured',
  fine.cv !== texturedPen.cv,
  `variation ${texturedPen.cv.toFixed(3)} -> ${fine.cv.toFixed(3)}`,
)

/* ------------------------ the inspector shows it -------------------- */

await page.keyboard.press('KeyV')
await settle(2)
await page.evaluate(() => window.adiDraw.tools.setActive('crayon'))
await page.click('.side-tab[data-tab="tool"]')
await settle(3)
check('the Surface section is in the tool panel', (await page.locator('.sect:has-text("Surface")').count()) === 1)
check(
  'it offers every texture',
  (await page.locator('.texture-chip').count()) === 5,
  `${await page.locator('.texture-chip').count()} options`,
)
await page.locator('.texture-chip').nth(4).click()
await settle(3)
check(
  'clicking an option applies it',
  (await page.evaluate(() => window.adiDraw.tools.get('crayon').texture)) === 'bristle',
)
check(
  'grain controls appear once a texture is on',
  (await page.locator('.ctl:has-text("Grain size")').count()) === 1,
)

/* ----------------------------- export ------------------------------ */

const svgPromise = page.waitForEvent('download')
await page.keyboard.press('Control+e')
await page.waitForSelector('.modal')
await page.click('.modal .btn-row .btn:nth-child(2)')
const svgFile = await svgPromise
const svg = await readFile(await svgFile.path(), 'utf8')
check('the SVG carries a texture filter', /feTurbulence/.test(svg), svg.match(/<filter[^>]*/)?.[0]?.slice(0, 60) ?? 'none')
check(
  'the texture is recorded on the path',
  /data-texture="(grain|bristle|chalk|graphite)"/.test(svg),
  svg.match(/data-texture="[a-z]+"/)?.[0] ?? 'none',
)
const parsed = await page.evaluate((t) => {
  const doc = new DOMParser().parseFromString(t, 'image/svg+xml')
  return { error: doc.querySelector('parsererror')?.textContent ?? null, paths: doc.querySelectorAll('path').length }
}, svg)
check('and it is still well-formed SVG', !parsed.error && parsed.paths > 0, JSON.stringify(parsed))

check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '))
await page.screenshot({ path: 'test/pens.png' })

await browser.close()
await server.close()
const failed = results.filter((r) => r.startsWith('FAIL'))
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
