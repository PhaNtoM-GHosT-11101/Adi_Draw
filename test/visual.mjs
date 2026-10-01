/**
 * Draws a sample board so there is something to look at.
 * Writes test/board.png, test/dark-board.png and test/light-board.png.
 */
import { launch } from './browser.mjs'
import { createServer } from 'vite'

const server = await createServer({ server: { port: 5400, strictPort: true }, logLevel: 'error' })
await server.listen()
const browser = await launch()

const settle = (page, n = 4) =>
  page.evaluate(
    (k) =>
      new Promise((r) => {
        let i = 0
        const f = () => (++i >= k ? r() : requestAnimationFrame(f))
        requestAnimationFrame(f)
      }),
    n,
  )

/** Smooth stylus stroke: many samples per frame. */
const smoothStroke = (page, key, x0, y0, dx, dy, colour, wave = 0) =>
  page.evaluate(
    async ([key, x0, y0, dx, dy, colour, wave]) => {
      const s = window.adiDraw.tools
      const id = s.findByShortcut(key)?.id
      if (id) s.setActive(id)
      if (colour) s.update(id, { color: colour })
      const c = document.querySelector('canvas.board')
      const b = c.getBoundingClientRect()
      const ev = (t, x, y, p) =>
        c.dispatchEvent(
          new PointerEvent(t, {
            pointerId: 1, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
            clientX: b.left + x, clientY: b.top + y, pressure: p,
            buttons: t === 'pointerup' ? 0 : 1, button: 0,
          }),
        )
      const raf = () => new Promise((r) => requestAnimationFrame(r))
      ev('pointerdown', x0, y0, 0.15)
      for (let i = 1; i <= 70; i++) {
        const t = i / 70
        ev(
          'pointermove',
          x0 + dx * t,
          y0 + dy * t + Math.sin(t * 7) * wave,
          0.15 + 0.8 * Math.sin(t * Math.PI),
        )
        await raf()
      }
      ev('pointerup', x0 + dx, y0 + dy, 0)
    },
    [key, x0, y0, dx, dy, colour, wave],
  )

/** Fast stroke: one sample per frame — the case that used to break into gaps. */
const fastStroke = (page, key, x0, y0, steps = 34, step = 26, wave = 26) =>
  page.evaluate(
    async ([key, x0, y0, steps, step, wave]) => {
      const s = window.adiDraw.tools
      const id = s.findByShortcut(key)?.id
      if (id) s.setActive(id)
      const c = document.querySelector('canvas.board')
      const b = c.getBoundingClientRect()
      const ev = (t, x, y, p) =>
        c.dispatchEvent(
          new PointerEvent(t, {
            pointerId: 1, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
            clientX: b.left + x, clientY: b.top + y, pressure: p,
            buttons: t === 'pointerup' ? 0 : 1, button: 0,
          }),
        )
      const raf = () => new Promise((r) => requestAnimationFrame(r))
      ev('pointerdown', x0, y0, 0.15)
      let x = x0
      for (let i = 0; i < steps; i++) {
        x += step
        ev('pointermove', x, y0 + Math.sin(i / 3) * wave, 0.15 + 0.8 * Math.sin((i / steps) * Math.PI))
        await raf()
      }
      ev('pointerup', x, y0, 0)
    },
    [key, x0, y0, steps, step, wave],
  )

const shape = (page, key, x1, y1, x2, y2) =>
  page.evaluate(
    async ([key, x1, y1, x2, y2]) => {
      const s = window.adiDraw.tools
      const id = s.findByShortcut(key)?.id
      if (id) s.setActive(id)
      const c = document.querySelector('canvas.board')
      const b = c.getBoundingClientRect()
      const ev = (t, x, y) =>
        c.dispatchEvent(
          new PointerEvent(t, {
            pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true,
            clientX: b.left + x, clientY: b.top + y, pressure: 0.5,
            buttons: t === 'pointerup' ? 0 : 1, button: 0,
          }),
        )
      ev('pointerdown', x1, y1)
      for (let i = 1; i <= 12; i++)
        ev('pointermove', x1 + ((x2 - x1) * i) / 12, y1 + ((y2 - y1) * i) / 12)
      ev('pointerup', x2, y2)
    },
    [key, x1, y1, x2, y2],
  )

const note = async (page, x, y, text) => {
  await page.keyboard.press('N')
  await settle(page, 2)
  await page.mouse.click(box0.x + x, box0.y + y)
  await page.waitForSelector('textarea.text-editor')
  await page.keyboard.type(text)
  await page.keyboard.press('Control+Enter')
  await settle(page, 3)
}

const text = async (page, x, y, body) => {
  await page.keyboard.press('T')
  await settle(page, 2)
  await page.mouse.click(box0.x + x, box0.y + y)
  await page.waitForSelector('textarea.text-editor')
  await page.keyboard.type(body)
  await page.keyboard.press('Control+Enter')
  await settle(page, 3)
}

const scheme = process.argv[2] || 'dark'
const errs = []
const page = await browser.newPage({ viewport: { width: 1600, height: 950 }, colorScheme: scheme })
page.on('pageerror', (e) => console.log('ERR', e.message))
await page.goto('http://localhost:5400/', { waitUntil: 'networkidle' })
await page.waitForSelector('.rail-btn')
const box0 = await page.locator('canvas.board').boundingBox()

await smoothStroke(page, 'B', 300, 230, 470, 90, '#111827', 46)
await settle(page, 2)
await smoothStroke(page, 'A', 300, 400, 470, 60, '#7c3aed', 46)
await settle(page, 2)
await smoothStroke(page, 'M', 860, 230, 320, 90, '#2563eb', 40)
await settle(page, 2)
await smoothStroke(page, 'H', 300, 245, 470, 100, '#fde047', 46)
await settle(page, 2)

// fast strokes — one sample per frame
await fastStroke(page, 'P', 300, 520)
await settle(page, 2)
await fastStroke(page, 'M', 300, 590)
await settle(page, 2)
await fastStroke(page, 'F', 300, 655, 34, 26, 22)
await settle(page, 2)

await shape(page, 'R', 880, 420, 1140, 620)
await settle(page, 2)
await shape(page, 'O', 1170, 420, 1420, 620)
await settle(page, 2)
await shape(page, 'L', 300, 730, 620, 730)
await settle(page, 2)

await text(page, 300, 300, 'Writing, refined')
await note(page, 700, 640, 'Check the numbers')
await note(page, 890, 660, 'Ship it')
await note(page, 1060, 680, 'Ask design')

// selection chrome
await page.keyboard.press('V')
await settle(page, 2)
await page.evaluate(
  ([bx, by]) => {
    const c = document.querySelector('canvas.board')
    const ev = (t, x, y) =>
      c.dispatchEvent(
        new PointerEvent(t, {
          pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true,
          clientX: bx + x, clientY: by + y, pressure: 0.5,
          buttons: t === 'pointerup' ? 0 : 1, button: 0,
        }),
      )
    ev('pointerdown', 260, 170)
    ev('pointermove', 700, 800)
    ev('pointerup', 700, 800)
  },
  [box0.x, box0.y],
)
await settle(page, 4)

await page.screenshot({ path: `test/${scheme === 'dark' ? 'dark' : 'light'}-board.png` })
console.log(
  `${scheme}: ${await page.evaluate(() => window.adiDraw.store.countElements())} objects`,
  errs.length ? `ERRORS: ${errs.join(' | ')}` : 'no errors',
)

await browser.close()
await server.close()
