import { launch } from './browser.mjs'
import { createServer } from 'vite'
import { readFile } from 'node:fs/promises'
const server = await createServer({ server: { port: 5404, strictPort: true }, logLevel: 'error' })
await server.listen()
const browser = await launch()
const page = await browser.newPage({ viewport:{width:1400,height:900} })
page.on('pageerror', e=>console.log('ERR', e.message))
await page.goto('http://localhost:5404/', { waitUntil:'networkidle' })
await page.waitForSelector('.rail-btn')
const draw = async (pts) => page.evaluate((pts)=>{
  const c=document.querySelector('canvas.board')
  const ev=(t,x,y,p)=>c.dispatchEvent(new PointerEvent(t,{pointerId:1,pointerType:'pen',isPrimary:true,bubbles:true,cancelable:true,clientX:x,clientY:y,pressure:p,buttons:t==='pointerup'?0:1,button:0}))
  ev('pointerdown',...pts[0]); for(const p of pts.slice(1)) ev('pointermove',...p); ev('pointerup',pts.at(-1)[0],pts.at(-1)[1],0)
}, pts)
for (const [key, color] of [['KeyB','#111827'],['KeyA','#7c3aed'],['KeyM','#2563eb']]) {
  await page.evaluate((c)=>window.adiDraw.tools.update(window.adiDraw.tools.active.id,{color:c}), color)
  await page.keyboard.press(key); await page.waitForTimeout(60)
  const pts = Array.from({length:70},(_,i)=>{const t=i/69;return [260+t*700, 300+i*0+Math.sin(t*8)*70+ (key==='KeyA'?200:0), 0.15+0.85*Math.sin(t*Math.PI)]})
  await draw(pts); await page.waitForTimeout(80)
}
await page.keyboard.press('KeyO'); await page.waitForTimeout(50)
await page.evaluate(()=>{const c=document.querySelector('canvas.board');const ev=(t,x,y)=>c.dispatchEvent(new PointerEvent(t,{pointerId:1,pointerType:'mouse',isPrimary:true,bubbles:true,cancelable:true,clientX:x,clientY:y,pressure:.5,buttons:t==='pointerup'?0:1,button:0}));ev('pointerdown',300,600);ev('pointermove',520,760);ev('pointerup',520,760)})
await page.waitForTimeout(150)
const dl = page.waitForEvent('download')
await page.keyboard.press('Control+e')
await page.waitForSelector('.modal')
await page.click('.modal .btn-row .btn:nth-child(2)')
const file = await dl
const svg = await readFile(await file.path(), 'utf8')
const p2 = await browser.newPage({ viewport:{width:1000,height:700} })
await p2.setContent(`<body style="margin:0;background:#fff">${svg}</body>`)
await p2.waitForTimeout(300)
await p2.screenshot({ path: 'test/svg-render.png' })
console.log('svg bytes', svg.length, '| paths', (svg.match(/<path/g)||[]).length)
await browser.close(); await server.close()
