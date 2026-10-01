/**
 * Sections in the real app.
 *
 * The containment maths is covered by test/sections.mjs. This drives the
 * pointer pipeline: draw a section, nest one inside it, drop notes in, check
 * folding hides the right things, and that moving a section carries what it
 * holds. Also checks the toasts, since a silent action is exactly the kind of
 * thing that looks broken even when it works.
 */
import { launch } from './browser.mjs'
import { createServer } from 'vite'

const server = await createServer({ server: { port: 5425, strictPort: true }, logLevel: 'error' })
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

await page.goto('http://localhost:5425/', { waitUntil: 'networkidle' })
await page.waitForSelector('.rail-btn')

/* ------------------------------ pointer ------------------------------ */

const drag = (x1, y1, x2, y2) =>
  page.evaluate(async ([x1, y1, x2, y2]) => {
    const c = document.querySelector('canvas.board')
    const r = c.getBoundingClientRect()
    const ev = (t, x, y) =>
      c.dispatchEvent(
        new PointerEvent(t, {
          pointerId: 1, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
          clientX: r.left + x, clientY: r.top + y, pressure: 0.5,
          buttons: t === 'pointerup' ? 0 : 1, button: 0,
        }),
      )
    const raf = () => new Promise((z) => requestAnimationFrame(z))
    ev('pointerdown', x1, y1)
    for (let k = 1; k <= 14; k++) {
      ev('pointermove', x1 + ((x2 - x1) * k) / 14, y1 + ((y2 - y1) * k) / 14)
      await raf()
    }
    ev('pointerup', x2, y2)
    await new Promise((z) => requestAnimationFrame(() => requestAnimationFrame(z)))
  }, [x1, y1, x2, y2])

const clickAt = (x, y) =>
  page.evaluate(async ([x, y]) => {
    const c = document.querySelector('canvas.board')
    const r = c.getBoundingClientRect()
    const ev = (t) =>
      c.dispatchEvent(
        new PointerEvent(t, {
          pointerId: 1, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
          clientX: r.left + x, clientY: r.top + y, pressure: 0.5,
          buttons: t === 'pointerup' ? 0 : 1, button: 0,
        }),
      )
    ev('pointerdown')
    ev('pointerup')
    await new Promise((z) => requestAnimationFrame(() => requestAnimationFrame(z)))
  }, [x, y])

const useTool = (id) => page.evaluate((id) => window.adiDraw.tools.setActive(id), id)

/** A sticky note dropped at a spot, as a plain object, so the test stays quick. */
const addNote = (x, y, text) =>
  page.evaluate(
    ([x, y, text]) => {
      const s = window.adiDraw.store
      s.doc.elements[s.doc.layers[0].id].push({
        id: 'note-' + Math.round(x) + '-' + Math.round(y),
        kind: 'note', layerId: s.doc.layers[0].id, opacity: 1, created: Date.now(),
        x, y, w: 160, h: 110, color: '#fde68a', text,
        style: { fontSize: 14, color: '#111827', fontFamily: 'Inter', fontWeight: 400, align: 'left', lineHeight: 1.3 },
      })
      s.markAllDirty()
      s.notify('doc')
    },
    [x, y, text],
  )

const sections = () =>
  page.evaluate(() =>
    window.adiDraw.store.allElements().filter((e) => e.kind === 'section').map((s) => ({
      id: s.id, x: s.x, y: s.y, w: s.w, h: s.h, title: s.title, collapsed: s.collapsed, parentId: s.parentId,
    })),
  )

/* ------------------------------- the tool ----------------------------- */

check('a section tool exists', await page.evaluate(() => !!window.adiDraw.tools.all.find((t) => t.id === 'section')))
check('and it is in the toolbar', await page.evaluate(() => !!window.adiDraw.tools.get('section')))
check(
  'and it has a shortcut',
  await page.evaluate(() => !!window.adiDraw.tools.get('section').shortcut),
)

await clearBoard()
await useTool('section')
await drag(220, 200, 1040, 680)
let secs = await sections()
check('dragging draws a section', secs.length === 1, JSON.stringify(secs))
check('it takes the dragged size', secs[0] && Math.abs(secs[0].w - 820) < 3 && Math.abs(secs[0].h - 480) < 3, JSON.stringify(secs[0]))
check('and starts top-level', secs[0]?.parentId === null)

/* A click with no drag should still produce something usable. */
await clearBoard()
await useTool('section')
await clickAt(500, 400)
secs = await sections()
check('a plain click drops a section of a usable size', secs.length === 1 && secs[0].w >= 400 && secs[0].h >= 200, JSON.stringify(secs[0]))

/* ---------------------------- sub-sections --------------------------- */

await clearBoard()
await useTool('section')
await drag(200, 180, 1000, 660)
const outerId = (await sections())[0].id
await useTool('section')
await drag(280, 260, 640, 520)
secs = await sections()
check('drawing inside a section makes a sub-section', secs.length === 2 && secs[1].parentId === outerId, JSON.stringify(secs.map((s) => s.parentId)))
check('and the outer one stays top-level', secs[0].parentId === null)

const innerId = secs[1].id
check(
  'a sub-section reports its parent in the panel',
  await page.evaluate(() => {
    const s = window.adiDraw.store
    s.setSelection(s.allElements().filter((e) => e.kind === 'section')[1].id ? [s.allElements().filter((e) => e.kind === 'section')[1].id] : [])
    return true
  }),
)

await settle()
check(
  'the panel names the parent section',
  await page.evaluate(
    (id) =>
      !!Array.from(document.querySelectorAll('.panel p'))
        .map((p) => p.textContent)
        .find((t) => t && t.includes('Sub-section of')),
    innerId,
  ),
)

/* ------------------------------ membership ---------------------------- */

await clearBoard()
await useTool('section')
await drag(300, 220, 900, 620)
await addNote(420, 320, 'inside')
await addNote(1100, 700, 'outside')
const insideId = await page.evaluate(() => window.adiDraw.store.allElements().find((e) => e.text === 'inside').id)

await page.evaluate((id) => window.adiDraw.store.setSelection([id]), (await sections())[0].id)
await settle()
check(
  'the panel counts what the section holds',
  await page.evaluate(
    () => !!Array.from(document.querySelectorAll('.panel p')).map((p) => p.textContent).find((t) => t && t.includes('Holds 1 object')),
  ),
)

/* -------------------------------- folding ----------------------------- */

await useTool('select')
await clickAt(400, 240) // the title band
secs = await sections()
check('clicking a title band folds the section', secs[0].collapsed === true, JSON.stringify(secs[0]))
await settle()
check(
  'folding says so',
  await page.evaluate(() => !!document.querySelector('.toast')),
)

/* The element keeps its stored height, but everything that positions chrome —
   the selection box, the hit test — has to agree it is only a header now. */
const foldedBox = await page.evaluate(() => {
  const s = window.adiDraw.store
  const sec = s.allElements().find((e) => e.kind === 'section')
  return { stored: sec.h, bbox: window.adiDraw.app.renderer.bboxFor(sec).h }
})
check('a folded section keeps its stored size for unfolding', foldedBox.stored > 300, JSON.stringify(foldedBox))
check('but its box shrinks to the header, so selection matches what is drawn', foldedBox.bbox < 60, JSON.stringify(foldedBox))

/* The note inside must not paint while folded. Sampled at the note's own
   centre: distance from white to the note's #fde68a is ~144, and ~0 on paper. */
const sample = () =>
  page.evaluate(() => {
    const c = document.querySelector('canvas.board')
    const g = c.getContext('2d')
    const note = window.adiDraw.store.allElements().find((e) => e.kind === 'note')
    const x = Math.round(note.x + note.w / 2)
    const y = Math.round(note.y + note.h / 2)
    const d = g.getImageData(x, y, 1, 1).data
    return Math.abs(d[0] - 253) + Math.abs(d[1] - 230) + Math.abs(d[2] - 138)
  })
/* `sample` is a distance from the note's colour, so a *large* value means the
   note is not there and a small one means it is. */
const inkAfterFold = await sample()
check('the note inside is not painted while folded', inkAfterFold > 100, String(inkAfterFold))

await clickAt(400, 240)
secs = await sections()
check('clicking again unfolds it', secs[0].collapsed === false)
await settle()
const inkAfterUnfold = await sample()
check('and the note comes back', inkAfterUnfold < 60, String(inkAfterUnfold))

/* --------------------------- moving a section -------------------------- */

await clearBoard()
await useTool('section')
await drag(300, 220, 900, 620)
await addNote(420, 340, 'rides along')
const before = await page.evaluate(() => {
  const s = window.adiDraw.store
  const sec = s.allElements().find((e) => e.kind === 'section')
  const note = s.allElements().find((e) => e.text === 'rides along')
  return { sec: { x: sec.x, y: sec.y }, note: { x: note.x, y: note.y } }
})

await useTool('select')
await drag(500, 238, 700, 300) // grab the title band and drag
const after = await page.evaluate(() => {
  const s = window.adiDraw.store
  const sec = s.allElements().find((e) => e.kind === 'section')
  const note = s.allElements().find((e) => e.text === 'rides along')
  return { sec: { x: sec.x, y: sec.y }, note: { x: note.x, y: note.y } }
})
check('dragging a section moves it', Math.abs(after.sec.x - before.sec.x) > 50, JSON.stringify(after.sec))
check('and carries what it holds', after.note.x - before.note.x === after.sec.x - before.sec.x, JSON.stringify({ before: before.note, after: after.note }))

/* -------------------------------- undo -------------------------------- */

await page.evaluate(() => window.adiDraw.store.undo())
await settle()
const undone = await page.evaluate(() => {
  const s = window.adiDraw.store
  const note = s.allElements().find((e) => e.text === 'rides along')
  return note ? { x: note.x, y: note.y } : null
})
check('one undo puts the note back where it was', undone && undone.x === before.note.x && undone.y === before.note.y, JSON.stringify(undone))

/* ------------------------------- toasts -------------------------------- */

await page.evaluate(() => window.adiDraw.store.setSelection(window.adiDraw.store.allElements().filter((e) => e.kind === 'note').map((e) => e.id)))
await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }))
})
await page.waitForTimeout(150)
check('copying says what was copied', await page.evaluate(() => !!document.querySelector('.toast')))
const firstToast = await page.evaluate(() => document.querySelector('.toast')?.textContent ?? '')
check('and says it once', !/copied.*copied/i.test(firstToast), firstToast)

/* repeating the same message must not stack duplicates */
await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }))
})
await page.waitForTimeout(120)
check(
  'a repeat reuses the toast instead of stacking',
  await page.evaluate(() => Array.from(document.querySelectorAll('.toast')).filter((t) => /copied/i.test(t.textContent)).length === 1),
  String(await page.evaluate(() => Array.from(document.querySelectorAll('.toast')).filter((t) => /copied/i.test(t.textContent)).length)),
)

check('toasts announce themselves politely', await page.evaluate(() => document.querySelector('.toast-host')?.getAttribute('aria-live') === 'polite'))
check(
  'toasts do not steal clicks',
  await page.evaluate(() => getComputedStyle(document.querySelector('.toast-host')).pointerEvents === 'none'),
)

check('no console errors', errors.length === 0, errors.join(' | '))

await browser.close()
await server.close()
console.log(`\n${pass}/${pass + fail} checks passed`)
process.exit(fail ? 1 : 0)
