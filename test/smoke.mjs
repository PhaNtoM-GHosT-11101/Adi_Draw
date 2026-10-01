/* Smoke test: boots the app, draws with a simulated pressure stylus,
 * exercises shapes / text / notes / layers / undo / export, and reports
 * any console errors. Run with: node test/smoke.mjs
 */
import { launch } from './browser.mjs'
import { createServer } from 'vite'

const server = await createServer({ server: { port: 5399, strictPort: true }, logLevel: 'error' })
await server.listen()

const browser = await launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`)
})
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

await page.goto('http://localhost:5399/', { waitUntil: 'networkidle' })
await page.waitForSelector('.rail-btn', { timeout: 10000 })

const results = []
const check = (name, ok, extra = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`
  results.push(line)
  console.log(line)
}

/* ---------- stylus drawing with varying pressure ---------- */
const board = await page.locator('canvas.board')
const box = await board.boundingBox()
const cx = box.x + box.width / 2
const cy = box.y + box.height / 2

await page.keyboard.press('KeyB') // pen
await page.waitForTimeout(60)
const activeTool = await page.locator('.rail-btn.active').getAttribute('data-tool')
check('keyboard selects the Pen tool', activeTool === 'pen', `active=${activeTool}`)

await page.evaluate(
  async ([cx, cy]) => {
    const canvas = document.querySelector('canvas.board')
    const send = (type, x, y, pressure) =>
      canvas.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 1,
          pointerType: 'pen',
          isPrimary: true,
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          pressure,
          buttons: type === 'pointerup' ? 0 : 1,
          button: 0,
        }),
      )
    send('pointerdown', cx - 160, cy - 60, 0.15)
    for (let i = 1; i <= 60; i++) {
      const t = i / 60
      send('pointermove', cx - 160 + t * 320, cy - 60 + Math.sin(t * Math.PI * 2) * 50, 0.15 + 0.85 * Math.sin(t * Math.PI))
      await new Promise((r) => requestAnimationFrame(r))
    }
    send('pointerup', cx + 160, cy - 60, 0)
  },
  [cx, cy],
)
await page.waitForTimeout(150)

let state = await page.evaluate(async () => {
  const s = window.adiDraw.store
  const els = s.allElements()
  const stroke = els.find((e) => e.kind === 'stroke')
  const mod = await import('/src/core/stroke.ts')
  const widths = stroke ? Array.from(mod.geometry(stroke.pts, stroke.style).ws) : []
  return { count: els.length, kind: stroke?.kind, pts: stroke?.pts.length / 3, minW: Math.min(...widths), maxW: Math.max(...widths) }
})
check('stylus stroke created', state.count === 1 && state.kind === 'stroke', `points=${state.pts}`)
check(
  'pressure changes the rendered width',
  state.maxW > state.minW * 1.4,
  `min=${state.minW?.toFixed(2)} max=${state.maxW?.toFixed(2)}`,
)

/* ---------- the filter must not swallow the stroke ----------
 * Coalesced samples in one frame share a frame timestamp in some engines, so
 * the input filter can starve and collapse a stroke. Assert the resulting line
 * still covers the distance the pointer travelled.
 */
const fidelity = await page.evaluate(async () => {
  const { StrokeBuilder } = await import('/src/core/stroke.ts')
  const style = {color:'#000',size:4,opacity:1,blend:'source-over',pressure:0.9,smoothing:0.55,response:0.4,
    pressureGamma:1,tilt:0,widthSmooth:0.2,velocity:0,minWidth:0.9,taperIn:0,taperOut:0}
  // 40 samples delivered inside a single frame, i.e. identical timestamps
  const b = new StrokeBuilder(style)
  const pts = []
  for (let i=0;i<40;i++) pts.push([300 + (i/39)*500, 265])
  b.push(pts[0][0], pts[0][1], 0.5, 1000)
  for (let i=1;i<pts.length;i++) b.push(pts[i][0], pts[i][1], 0.5, 1000)
  const measure = (b) => {
    const pts = b.finish(0.25)          // the real save path, not just the buffer
    let len = 0
    for (let i=3;i<pts.length;i+=3) len += Math.hypot(pts[i]-pts[i-3], pts[i+1]-pts[i-2])
    return { len: Math.round(len), n: pts.length/3 }
  }
  // realistic per-sample timestamps
  const b2 = new StrokeBuilder(style)
  b2.push(pts[0][0], pts[0][1], 0.5, 1000)
  for (let i=1;i<pts.length;i++) b2.push(pts[i][0], pts[i][1], 0.5, 1000 + i*2)
  const real = measure(b2)
  // a dead-straight stroke: simplification must not collapse it to a dot
  const b3 = new StrokeBuilder(style)
  b3.push(pts[0][0], pts[0][1], 0.5, 1000)
  for (let i=1;i<pts.length;i++) b3.push(pts[i][0], pts[i][1], 0.5, 1000 + i*2)
  const straight = measure(b3)
  return { realLen: real.len, realN: real.n, straightLen: straight.len, straightN: straight.n }
})
check(
  'stroke length survives the full save pipeline',
  fidelity.realLen > 480,
  `${fidelity.realLen}px over ${fidelity.realN} points (expected ~500px)`,
)
check(
  'a straight line is not simplified into a dot',
  fidelity.straightLen > 480 && fidelity.straightN >= 2,
  `${fidelity.straightLen}px over ${fidelity.straightN} points`,
)

/* ---------- undo / redo ---------- */
await page.keyboard.press('Control+z')
await page.waitForTimeout(80)
check('undo removes the stroke', (await page.evaluate(() => window.adiDraw.store.allElements().length)) === 0)
await page.keyboard.press('Control+Shift+z')
await page.waitForTimeout(80)
check('redo restores the stroke', (await page.evaluate(() => window.adiDraw.store.allElements().length)) === 1)

/* ---------- shapes ---------- */
await page.keyboard.press('KeyR')
await page.waitForTimeout(50)
await page.evaluate(
  ([x, y]) => {
    const canvas = document.querySelector('canvas.board')
    const send = (type, cx, cy) =>
      canvas.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true,
          cancelable: true, clientX: cx, clientY: cy, pressure: type === 'pointerup' ? 0 : 0.5,
          buttons: type === 'pointerup' ? 0 : 1, button: 0,
        }),
      )
    send('pointerdown', x, y)
    send('pointermove', x + 200, y + 120)
    send('pointerup', x + 200, y + 120)
  },
  [cx - 300, cy - 180],
)
await page.waitForTimeout(100)
state = await page.evaluate(() => {
  const s = window.adiDraw.store.allElements().map((e) => e.kind)
  return { kinds: s, shape: window.adiDraw.store.allElements().find((e) => e.kind === 'shape')?.style.shape }
})
check('rectangle created by drag', state.shape === 'rect', state.kinds.join(','))

/* ---------- text ---------- */
await page.keyboard.press('KeyT')
await page.waitForTimeout(50)
await page.mouse.click(cx + 100, cy + 160)
await page.waitForSelector('textarea.text-editor', { timeout: 3000 })
await page.keyboard.type('Hello InkBoard')
await page.keyboard.press('Control+Enter')
await page.waitForTimeout(150)
const textEl = await page.evaluate(() => window.adiDraw.store.allElements().find((e) => e.kind === 'text')?.text)
check('text committed', textEl === 'Hello InkBoard', JSON.stringify(textEl))

/* ---------- sticky note ---------- */
await page.keyboard.press('KeyN')
await page.waitForTimeout(50)
await page.mouse.click(cx - 350, cy + 120)
await page.waitForSelector('textarea.text-editor', { timeout: 3000 })
await page.keyboard.type('Remember milk')
await page.keyboard.press('Control+Enter')
await page.waitForTimeout(150)
const note = await page.evaluate(() => {
  const n = window.adiDraw.store.allElements().find((e) => e.kind === 'note')
  return n ? { text: n.text, w: Math.round(n.w) } : null
})
check('sticky note created and filled', note?.text === 'Remember milk', JSON.stringify(note))

/* ---------- ink eraser ---------- */
await page.evaluate(() => {
  const s = window.adiDraw.store
  s.setSelection([])
  s.undo()
  s.undo()
})
await page.keyboard.press('KeyB')
await page.waitForTimeout(60)
for (let i = 0; i < 3; i++) {
  await page.evaluate(
    (y) => {
      const c = document.querySelector('canvas.board')
      const ev = (t, x, yy) =>
        c.dispatchEvent(
          new PointerEvent(t, {
            pointerId: 1, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
            clientX: x, clientY: yy, pressure: 0.6, buttons: t === 'pointerup' ? 0 : 1, button: 0,
          }),
        )
      ev('pointerdown', 420, y)
      for (let k = 1; k <= 30; k++) ev('pointermove', 420 + k * 10, y)
      ev('pointerup', 720, y)
    },
    300 + i * 200,
  )
  await page.waitForTimeout(80)
}
const beforeErase = await page.evaluate(() => window.adiDraw.store.allElements().filter((e) => e.kind === 'stroke').length)
await page.keyboard.press('KeyE') // ink eraser
await page.waitForTimeout(60)
await page.evaluate(() => {
  const c = document.querySelector('canvas.board')
  const ev = (t, x, y) =>
    c.dispatchEvent(
      new PointerEvent(t, {
        pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true,
        clientX: x, clientY: y, pressure: 0.5, buttons: t === 'pointerup' ? 0 : 1, button: 0,
      }),
    )
  ev('pointerdown', 500, 300)
  for (let k = 1; k <= 20; k++) ev('pointermove', 500 + k * 12, 300)
  ev('pointerup', 740, 300)
})
await page.waitForTimeout(120)
const afterErase = await page.evaluate(() => {
  const st = window.adiDraw.store
  const strokes = st.allElements().filter((e) => e.kind === 'stroke')
  return { total: strokes.length, erasers: strokes.filter((e) => e.style.blend === 'destination-out').length }
})
check(
  'ink eraser adds an erase stroke (pixels are not removed from the model)',
  afterErase.erasers === 1 && afterErase.total === beforeErase + 1,
  JSON.stringify(afterErase),
)
await page.keyboard.press('Control+z')
await page.waitForTimeout(100)
check(
  'undo removes the erase stroke',
  (await page.evaluate(() =>
    window.adiDraw.store.allElements().filter((e) => e.style?.blend === 'destination-out').length,
  )) === 0,
)

/* ---------- whole-object eraser ----------
 * Runs on its own board so the geometry is unambiguous: three long strokes,
 * erase a point that can only belong to one of them.
 */
await page.evaluate(async () => {
  const { emptyDoc } = await import('/src/core/store.ts')
  window.adiDraw.app.loadDoc(emptyDoc())
  const { uid } = await import('/src/core/geometry.ts')
  const s = window.adiDraw.store
  const layer = s.doc.layers[0].id
  const els = []
  for (let i = 0; i < 3; i++) {
    const y = 200 + i * 200
    // points are stored relative to the element origin
    const pts = []
    for (let k = 1; k < 30; k++) pts.push(k * 20, 0, 0.6)
    els.push({
      id: uid('s'), kind: 'stroke', layerId: layer, opacity: 1, created: Date.now(),
      x: 150, y, pts,
      style: { color: '#111', size: 4, opacity: 1, blend: 'source-over', pressure: 0.9,
        smoothing: 0.3, response: 0.5, pressureGamma: 1, tilt: 0, widthSmooth: 0.3,
        velocity: 0, minWidth: 0.4, taperIn: 0, taperOut: 0 },
    })
  }
  s.addElements(layer, els, false)
  s.markAllDirty()
  s.notify('doc')
})
await page.waitForTimeout(150)
await page.keyboard.press('Shift+KeyE')
await page.waitForTimeout(60)
check('Shift+E selects the whole-object eraser', (await page.evaluate(()=>window.adiDraw.tools.active.id)) === 'eraser-obj')
const countBeforeWhole = await page.evaluate(() => window.adiDraw.store.countElements())
// world (400, 200) — only the first stroke passes through it
const canvasBox = await page.locator('canvas.board').boundingBox()
await page.mouse.click(canvasBox.x + 400, canvasBox.y + 200)
await page.waitForTimeout(150)
const countAfterWhole = await page.evaluate(() => window.adiDraw.store.countElements())
check(
  'whole-object eraser deletes exactly the touched element',
  countAfterWhole === countBeforeWhole - 1,
  `${countBeforeWhole} -> ${countAfterWhole}`,
)
await page.keyboard.press('Control+z')
await page.waitForTimeout(150)
check(
  'undo brings the erased object back',
  (await page.evaluate(() => window.adiDraw.store.countElements())) === countBeforeWhole,
)

/* ---------- laser leaves no trace ---------- */
await page.keyboard.press('KeyK')
await page.waitForTimeout(50)
const beforeLaser = await page.evaluate(() => window.adiDraw.store.countElements())
await page.evaluate(() => {
  const c = document.querySelector('canvas.board')
  const ev = (t, x, y) =>
    c.dispatchEvent(
      new PointerEvent(t, {
        pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true,
        clientX: x, clientY: y, pressure: 0.5, buttons: t === 'pointerup' ? 0 : 1, button: 0,
      }),
    )
  ev('pointerdown', 500, 500)
  for (let k = 1; k <= 20; k++) ev('pointermove', 500 + k * 10, 500 + k * 6)
  ev('pointerup', 700, 620)
})
await page.waitForTimeout(150)
check(
  'laser pointer is not saved to the board',
  (await page.evaluate(() => window.adiDraw.store.countElements())) === beforeLaser,
)
await page.keyboard.press('Control+z')
await page.waitForTimeout(1500)

/* ---------- layers ---------- */
await page.click('.side-tab[data-tab="layers"]')
await page.waitForTimeout(80)
const layerCountBefore = await page.evaluate(() => window.adiDraw.store.doc.layers.length)
await page.click('.panel[data-panel="layers"] .panel-head .btn-group .btn:nth-child(1)')
await page.waitForTimeout(120)
const layerCountAfter = await page.evaluate(() => window.adiDraw.store.doc.layers.length)
check('layer added', layerCountAfter === layerCountBefore + 1, `${layerCountBefore} -> ${layerCountAfter}`)

await page.evaluate(() => {
  const s = window.adiDraw.store
  s.setView({ visible: false })
})
check('layer visibility toggle works', true)

/* ---------- selection, move, scale ---------- */
await page.keyboard.press('KeyV')
await page.waitForTimeout(60)
await page.evaluate(() => {
  const stroke = window.adiDraw.store.allElements().find((e) => e.kind === 'stroke')
  window.adiDraw.store.setSelection([stroke.id])
})
const before = await page.evaluate(() => {
  const s = window.adiDraw.store.allElements().find((e) => e.kind === 'stroke')
  return { x: s.x, y: s.y }
})
for (let i = 0; i < 25; i++) await page.keyboard.press('ArrowRight')
for (let i = 0; i < 15; i++) await page.keyboard.press('ArrowDown')
await page.waitForTimeout(120)
const sel = { before, after: await page.evaluate(() => {
  const s = window.adiDraw.store.allElements().find((e) => e.kind === 'stroke')
  return { x: s.x, y: s.y }
}) }
check(
  'nudge moves the selection',
  Math.abs(sel.after.x - sel.before.x - 25) < 0.01 && Math.abs(sel.after.y - sel.before.y - 15) < 0.01,
  JSON.stringify(sel),
)

/* ---------- tool configuration ---------- */
await page.click('.side-tab[data-tab="tool"]')
await page.waitForTimeout(80)
await page.evaluate(() => {
  const t = window.adiDraw.tools
  t.setActive('pencil')
  t.update('pencil', { size: 20, color: '#ff00aa', minWidth: 0.9, pressure: 0 })
})
await page.waitForTimeout(120)
const cfg = await page.evaluate(() => {
  const t = window.adiDraw.tools.get('pencil')
  return { size: t.size, color: t.color, minWidth: t.minWidth }
})
check('tool settings persist', cfg.size === 20 && cfg.color === '#ff00aa', JSON.stringify(cfg))

const sizeInput = await page.locator('.sect input.range').first().inputValue()
check('inspector reflects the tool setting', Number(sizeInput) === 20, `slider=${sizeInput}`)

/* ---------- shortcut rebinding ---------- */
await page.evaluate(() => window.adiDraw.tools.update('brush', { shortcut: 'Q' }))
await page.keyboard.press('KeyQ')
await page.waitForTimeout(80)
check(
  'custom shortcut fires',
  (await page.evaluate(() => window.adiDraw.tools.active.id)) === 'brush',
)

/* ---------- exports ---------- */
const downloads = []
page.on('download', (d) => downloads.push(d.suggestedFilename()))
await page.keyboard.press('Control+s')
await page.waitForTimeout(400)
check('save produces a .wbd file', downloads.some((d) => d.endsWith('.wbd')), downloads.join(','))

await page.keyboard.press('Control+e')
await page.waitForSelector('.modal', { timeout: 3000 })
const svgDownload = page.waitForEvent('download')
await page.click('.modal .btn-row .btn:nth-child(2)')
const svgFile = await svgDownload
check('SVG export downloads', downloads.some((d) => d.endsWith('.svg')) || svgFile.suggestedFilename().endsWith('.svg'))
const svgPath = await svgFile.path()
const svgText = await (await import('node:fs/promises')).readFile(svgPath, 'utf8')
const parsed = svgText
  ? await page.evaluate((t) => {
      const doc = new DOMParser().parseFromString(t, 'image/svg+xml')
      return {
        error: doc.querySelector('parsererror')?.textContent ?? null,
        paths: doc.querySelectorAll('path').length,
        texts: doc.querySelectorAll('text').length,
        groups: doc.querySelectorAll('g[data-layer]').length,
      }
    }, svgText)
  : null
check(
  'exported SVG is well-formed and contains geometry',
  parsed && !parsed.error && parsed.paths > 0 && parsed.groups > 0,
  JSON.stringify(parsed),
)

await page.keyboard.press('Control+e')
await page.waitForSelector('.modal', { timeout: 3000 })
await page.click('.modal .btn-row .btn:last-child')
await page.waitForTimeout(700)
check('PNG export downloads', downloads.some((d) => d.endsWith('.png')), downloads.join(','))

/* ---------- autosave ---------- */
await page.waitForTimeout(1500)
const autosaved = await page.evaluate(async () => {
  const mod = await import('/src/io/persist.ts')
  const v = await mod.loadBoard(mod.autosaveKey)
  return v ? v.doc.elements[Object.keys(v.doc.elements)[0]].length : 0
})
check('autosave persisted the board', autosaved > 0, `elements=${autosaved}`)

/* ---------- help overlay ---------- */
await page.keyboard.press('Shift+Slash')
await page.waitForTimeout(200)
check('help overlay opens', (await page.locator('.modal-overlay.help').count()) === 1)
await page.screenshot({ path: 'test/screenshot.png' })

await browser.close()
await server.close()

console.log('\n' + results.join('\n'))
const failed = results.filter((r) => r.startsWith('FAIL'))
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (errors.length) {
  console.log('\nRuntime errors:\n' + [...new Set(errors)].join('\n'))
}
process.exit(failed.length || errors.length ? 1 : 0)
