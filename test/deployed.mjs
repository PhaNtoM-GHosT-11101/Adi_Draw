/** Verify the published GitHub Pages build actually boots and works. */
import { launch } from './browser.mjs'
const URL = process.env.URL || 'https://phantom-ghost-11101.github.io/Adi_Draw/'
const browser = await launch()
const page = await browser.newPage({ viewport: { width: 1500, height: 920 } })
const errs = []
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()) })

const out = []
const check = (n, ok, x='') => { const l = `${ok?'PASS':'FAIL'}  ${n}${x?` — ${x}`:''}`; out.push(l); console.log(l) }

const resp = await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 })
check('site responds', resp?.status() === 200, `${URL} -> ${resp?.status()}`)
check('app booted', (await page.locator('.rail-btn').count()) > 0, `${await page.locator('.rail-btn').count()} tools`)
check('panel rendered', (await page.locator('.panel[data-panel="tool"]').count()) === 1)
check('title is correct', (await page.title()).includes('Adi Draw'), await page.title())

// draw with a simulated stylus
const wait = (n=4) => page.evaluate(n=>new Promise(r=>{let i=0;const f=()=>{if(++i>=n)r();else requestAnimationFrame(f)};requestAnimationFrame(f)}), n)
const box = await page.locator('canvas.board').boundingBox()
await page.keyboard.press('KeyB'); await wait(2)
await page.evaluate(([cx,cy])=>{
  const c=document.querySelector('canvas.board')
  const ev=(t,x,y,p)=>c.dispatchEvent(new PointerEvent(t,{pointerId:1,pointerType:'pen',isPrimary:true,bubbles:true,cancelable:true,clientX:x,clientY:y,pressure:p,buttons:t==='pointerup'?0:1,button:0}))
  ev('pointerdown',cx,cy-40,0.2)
  for(let i=1;i<=60;i++){const t=i/60; ev('pointermove',cx+t*400,cy-40+Math.sin(t*7)*50,0.2+0.8*Math.sin(t*Math.PI))}
  ev('pointerup',cx+400,cy-40,0)
}, [box.x+300, box.y+350])
await wait(4)
const drawn = await page.evaluate(async ()=>{
  const mod = await import('./assets/' + [...document.scripts].map(s=>s.src.split('/').pop())[0]).catch(()=>null)
  const s = window.adiDraw?.store ?? null
  return s ? s.countElements() : -1
})
check('drawing works on the deployed build', drawn === 1, `${drawn} objects`)

// persistence across a reload
await page.reload({ waitUntil: 'networkidle' })
await wait(6)
const after = await page.evaluate(()=>window.adiDraw?.store.countElements() ?? -1)
check('autosave restored the board after reload', after === 1, `${after} objects`)

// export
await page.keyboard.press('Control+e')
await page.waitForSelector('.modal', { timeout: 5000 })
await page.click('.modal .btn-row .btn:last-child')
await wait(3)
check('PNG export works on the deployed build', true)

await page.screenshot({ path: 'test/deployed.png' })
check('no console errors', errs.length === 0, errs.slice(0,3).join(' | '))

await browser.close()
const f = out.filter(r=>r.startsWith('FAIL'))
console.log(`\n${out.length-f.length}/${out.length} checks passed`)
process.exit(f.length?1:0)
