import { launch } from './browser.mjs'
import { createServer } from 'vite'
const server = await createServer({ server: { port: 5405, strictPort: true }, logLevel: 'error' })
await server.listen()
const browser = await launch()
const page = await browser.newPage({ viewport:{width:1600,height:950} })
const errs=[]; page.on('pageerror', e=>errs.push(e.message))
page.on('console', m=>{ if(m.type()==='error') errs.push('console: '+m.text()) })
await page.goto('http://localhost:5405/', { waitUntil:'networkidle' })
await page.waitForSelector('.rail-btn')
const out=[]; const check=(n,ok,x='')=>{out.push(`${ok?'PASS':'FAIL'}  ${n}${x?` — ${x}`:''}`)}

// colour picker
await page.click('.tool-head .btn:has-text("Pick colour")')
await page.waitForTimeout(200)
check('colour picker opens', (await page.locator('.color-picker canvas.sv').count()) === 1)
await page.locator('.cp-dot').nth(4).click()
await page.waitForTimeout(200)
const afterSwatch = await page.evaluate(()=>window.adiDraw.tools.active.color)
check('picker swatch sets the colour', afterSwatch === '#ef4444', afterSwatch)
const box = await page.locator('canvas.sv').boundingBox()
await page.mouse.click(box.x + box.width*0.2, box.y + box.height*0.25)
await page.waitForTimeout(150)
const afterSv = await page.evaluate(()=>window.adiDraw.tools.active.color)
check('dragging in the picker changes the colour', afterSv !== '#ef4444', afterSv)
await page.screenshot({ path:'test/picker.png', clip:{x:1285,y:0,width:315,height:950} })

// shape section
await page.keyboard.press('KeyR'); await page.waitForTimeout(150)
check('shape kind chips render', (await page.locator('.shape-chip').count()) === 8)
await page.locator('.shape-chip').nth(4).click()  // diamond
await page.waitForTimeout(150)
check('shape kind changes', (await page.evaluate(()=>window.adiDraw.tools.active.shape))==='diamond')
await page.locator('.ctl:has-text("Pick a fill") .swatch').first().click()
await page.waitForTimeout(200)
check('a fill can be picked from the palette', !!(await page.evaluate(()=>window.adiDraw.tools.active.fill)))
check('fill opacity slider appears', (await page.locator('.ctl:has-text("Fill opacity")').count())===1)

// text section
await page.locator('.btn.none-chip').click()
await page.waitForTimeout(150)
check('fill can be removed again', (await page.evaluate(()=>window.adiDraw.tools.active.fill)) === null)
await page.keyboard.press('KeyT'); await page.waitForTimeout(150)
check('text controls render', (await page.locator('.sect:has-text("Text") select').count()) >= 2)

// board tab
await page.click('.side-tab[data-tab="board"]'); await page.waitForTimeout(150)
check('board panel visible', (await page.locator('.panel[data-panel="board"]:visible').count())===1)
await page.locator('.bg-chip').nth(3).click(); await page.waitForTimeout(150)
check('background preset applies', (await page.evaluate(()=>window.adiDraw.store.doc.meta.background))==='#1e293b')
await page.click('.side-tab[data-tab="tool"]'); await page.waitForTimeout(100)

// image paste
await page.keyboard.press('KeyI'); await page.waitForTimeout(50)
const before = await page.evaluate(()=>window.adiDraw.store.countElements())
// a 1x1 red png pasted via DataTransfer
await page.evaluate(()=>{
  const c=document.createElement('canvas'); c.width=c.height=40
  const x=c.getContext('2d'); x.fillStyle='#0f0'; x.fillRect(0,0,40,40)
  const dt=new DataTransfer(); dt.items.add(new File([c.toDataURL()],'a.png',{type:'image/png'}))
  window.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}))
})
await page.waitForTimeout(400)
const after = await page.evaluate(()=>({n:window.adiDraw.store.countElements(), img: window.adiDraw.store.allElements().filter(e=>e.kind==='image').length}))
check('pasting an image inserts it', after.img===1 && after.n===before+1, JSON.stringify(after))
await page.screenshot({ path:'test/paste.png' })

// new tool preset
await page.click('.tool-head .btn:has-text("New preset")')
await page.waitForTimeout(200)
const n1 = await page.evaluate(()=>window.adiDraw.tools.all.length)
await page.click('.tool-head .btn:has-text("New preset")')
await page.waitForTimeout(200)
const n2 = await page.evaluate(()=>window.adiDraw.tools.all.length)
check('new tool presets are created', n2===n1+1, `${n1} -> ${n2}`)
check('the new preset is active', (await page.evaluate(()=>window.adiDraw.tools.active.name)).includes('copy'))

// new board clears
await page.keyboard.press('Control+n'); await page.waitForTimeout(250)
check('new board clears the document', (await page.evaluate(()=>window.adiDraw.store.countElements()))===0)
check('new board resets the history', (await page.evaluate(()=>window.adiDraw.store.canUndo))===false)

await browser.close(); await server.close()
console.log(out.join('\n'))
const f = out.filter(r=>r.startsWith('FAIL'))
console.log(`\n${out.length-f.length}/${out.length} checks passed`)
if (errs.length) console.log('\nErrors:\n'+[...new Set(errs)].join('\n'))
process.exit(f.length||errs.length?1:0)
