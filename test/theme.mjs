import { launch } from './browser.mjs'
import { createServer } from 'vite'
const server = await createServer({ server: { port: 5412, strictPort: true }, logLevel: 'error' })
await server.listen()
const browser = await launch()
const out=[]
const check=(n,ok,x='')=>{const l=`${ok?'PASS':'FAIL'}  ${n}${x?` — ${x}`:''}`;out.push(l);console.log(l)}

// dark via OS preference
const page = await browser.newPage({ viewport:{width:1600,height:950}, colorScheme:'dark' })
page.on('pageerror', e=>console.log('ERR', e.message))
await page.goto('http://localhost:5412/', { waitUntil:'networkidle' })
await page.waitForSelector('.rail-btn')
check('auto theme follows the OS (dark)', (await page.evaluate(()=>document.body.dataset.theme))==='dark')
await page.screenshot({ path:'test/dark-empty.png' })

// draw a small board
const draw = async (pts) => page.evaluate((pts)=>{
  const c=document.querySelector('canvas.board')
  const ev=(t,x,y,p)=>c.dispatchEvent(new PointerEvent(t,{pointerId:1,pointerType:'pen',isPrimary:true,bubbles:true,cancelable:true,clientX:x,clientY:y,pressure:p,buttons:t==='pointerup'?0:1,button:0}))
  ev('pointerdown',...pts[0]); for(const p of pts.slice(1)) ev('pointermove',...p); ev('pointerup',pts.at(-1)[0],pts.at(-1)[1],0)
}, pts)
const wait = (n=4)=>page.evaluate(n=>new Promise(r=>{let i=0;const f=()=>{if(++i>=n)r();else requestAnimationFrame(f)};requestAnimationFrame(f)}), n)
for (const [key, y, size] of [['KeyB',260,4],['KeyA',400,26],['KeyM',540,12]]) {
  await page.keyboard.press(key); await wait(2)
  await draw(Array.from({length:70},(_,i)=>{const t=i/69; return [300+t*500, y+Math.sin(t*7)*40, 0.15+0.85*Math.sin(t*Math.PI)]}))
  await wait(2)
}
await page.keyboard.press('KeyH'); await wait(2)
await draw(Array.from({length:40},(_,i)=>{const t=i/39; return [300+t*500, 265, 0.5]}))
await wait(2)
check('empty hint disappears after drawing', await page.locator('.empty-hint.hidden').count() === 1)
await page.keyboard.press('KeyO'); await wait(2)
await page.evaluate(()=>window.adiDraw.tools.update('ellipse',{fill:'#5b8cff',fillOpacity:0.35,color:'#93c5fd',size:4}))
await page.evaluate(()=>{const c=document.querySelector('canvas.board');const ev=(t,x,y)=>c.dispatchEvent(new PointerEvent(t,{pointerId:1,pointerType:'mouse',isPrimary:true,bubbles:true,cancelable:true,clientX:x,clientY:y,pressure:.5,buttons:t==='pointerup'?0:1,button:0}));ev('pointerdown',850,300);ev('pointermove',1120,500);ev('pointerup',1120,500)})
await page.keyboard.press('KeyN'); await wait(2)
for (const [x,y,t] of [[330,640,'Check the\\nnumbers'],[530,660,'Ship it'],[720,680,'Ask design']]) {
  await page.mouse.click(x,y)
  await page.waitForSelector('textarea.text-editor')
  await page.keyboard.type(t)
  await page.keyboard.press('Control+Enter')
  await wait(3)
}
await page.keyboard.press('KeyT'); await wait(2)
await page.mouse.click(330,180); await page.waitForSelector('textarea.text-editor')
await page.keyboard.type('Writing, refined')
await page.keyboard.press('Control+Enter'); await wait(3)
await page.keyboard.press('KeyV'); await wait(2)
await page.evaluate(()=>{const c=document.querySelector('canvas.board');const ev=(t,x,y)=>c.dispatchEvent(new PointerEvent(t,{pointerId:1,pointerType:'mouse',isPrimary:true,bubbles:true,cancelable:true,clientX:x,clientY:y,pressure:.5,buttons:t==='pointerup'?0:1,button:0}));ev('pointerdown',260,120);ev('pointermove',860,820);ev('pointerup',860,820)})
await wait(4)
await page.screenshot({ path:'test/dark-board.png' })

// explicit light override
await page.click('.side-tab[data-tab="board"]'); await wait(2)
await page.selectOption('.panel[data-panel="board"] select:has(option[value="light"])', 'light'); await wait(3)
check('explicit light overrides the OS', (await page.evaluate(()=>document.body.dataset.theme))==='light')
await page.screenshot({ path:'test/light-board.png' })
await browser.close(); await server.close()
const f=out.filter(r=>r.startsWith('FAIL'))
console.log(`\n${out.length-f.length}/${out.length} checks passed`)
