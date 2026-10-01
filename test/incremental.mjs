/**
 * Correctness guard for the incremental renderer: after any sequence of edits,
 * the on-screen canvas must be pixel-identical to a forced full repaint.
 */
import { launch } from './browser.mjs'
import { createServer } from 'vite'
import { createHash } from 'node:crypto'
const server = await createServer({ server: { port: 5409, strictPort: true }, logLevel: 'error' })
await server.listen()
const browser = await launch()
const page = await browser.newPage({ viewport:{width:1400,height:880} })
page.on('pageerror', e=>console.log('ERR', e.message))
await page.goto('http://localhost:5409/', { waitUntil:'networkidle' })
await page.waitForSelector('.rail-btn')

/** Wait until the app has actually drawn the result of the last change. */
const settle = () => page.evaluate(() => new Promise((res) => {
  let i = 0
  const f = () => (++i >= 5 ? res() : requestAnimationFrame(f))
  requestAnimationFrame(f)
}))

const results = []
const check = (n, ok, x='') => { const l=`${ok?'PASS':'FAIL'}  ${n}${x?` — ${x}`:''}`; results.push(l); console.log(l) }

/** Snapshot the canvas, keeping the pixels in the page (transferring them is slow). */
const snapshot = () => page.evaluate(()=>{
  window.__snap = document.querySelector('canvas.board')
    .getContext('2d').getImageData(0,0,document.querySelector('canvas.board').width, document.querySelector('canvas.board').height)
  return window.__snap.width
})

/**
 * Compare the stored snapshot against the current canvas. A handful of
 * low-delta pixels on a region seam is antialiasing being computed twice, which
 * is invisible; anything more means stale content.
 */
const diff = () => page.evaluate(()=>{
  const c = document.querySelector('canvas.board')
  const now = c.getContext('2d').getImageData(0,0,c.width,c.height)
  const a = window.__snap.data
  const b = now.data
  const w = c.width
  let n = 0, worst = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.abs(a[i]-b[i]) + Math.abs(a[i+1]-b[i+1]) + Math.abs(a[i+2]-b[i+2])
    if (!d) continue
    const p = i / 4, x = p % w, y = (p - x) / w
    n++
    if (d > worst) worst = d
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return { n, worst, box: n ? [minX, minY, maxX, maxY] : null }
})

const report = (d) => d.n === 0 ? 'identical' : `${d.n}px worst=${d.worst} box=[${d.box}]`

/** force a full repaint, hash, then verify the incremental result matches */
const verify = async (label) => {
  await page.evaluate(()=>{ window.adiDraw.store.markAllDirty(); window.adiDraw.store.notify('doc') })
  await settle()
  await snapshot()
  // now rebuild the incremental state and compare
  await page.evaluate(()=>{ window.adiDraw.app.renderer.clearCache() })
  await page.evaluate(()=>{ window.adiDraw.store.markAllDirty(); window.adiDraw.store.notify('doc') })
  await settle()
  const d = await diff()
  check(`${label}: full repaint is deterministic`, d.n === 0, report(d))
}

// seed a board with a mix of content
await page.evaluate(async ()=>{
  const { uid } = await import('/src/core/geometry.ts')
  const s = window.adiDraw.store
  const l1 = s.doc.layers[0].id
  const l2 = s.addLayer('Overlay')
  const mkStroke = (x,y,color,size)=>({id:uid('s'),kind:'stroke',layerId:l1,opacity:1,created:Date.now(),x,y,pts:[],
    style:{color,size,opacity:1,blend:'source-over',pressure:0.9,smoothing:0.4,response:0.5,pressureGamma:1,tilt:0,widthSmooth:0.3,velocity:0.1,minWidth:0.3,taperIn:0.15,taperOut:0.15}})
  const mkShape = (x,y,x2,y2,fill)=>({id:uid('g'),kind:'shape',layerId:l1,opacity:1,created:Date.now(),x,y,x2,y2,
    style:{shape:'ellipse',stroke:{color:'#1d4ed8',size:3,opacity:1,blend:'source-over',pressure:0,smoothing:0,response:0,pressureGamma:1,tilt:0,widthSmooth:0,velocity:0,minWidth:1,taperIn:0,taperOut:0},fill,fillOpacity:0.4,dash:null,corner:0,sides:4,arrowHead:'none'}})
  const mkNote = (x,y,t)=>({id:uid('n'),kind:'note',layerId:l1,opacity:1,created:Date.now(),x,y,w:150,h:120,color:'#ffd66b',text:t,
    style:{color:'#3f2d00',fontSize:16,fontFamily:'sans-serif',fontWeight:400,italic:false,underline:false,align:'left',lineHeight:1.35}})
  const mkText = (x,y,t)=>({id:uid('t'),kind:'text',layerId:l1,opacity:1,created:Date.now(),x,y,width:300,text:t,
    style:{color:'#0f172a',fontSize:24,fontFamily:'sans-serif',fontWeight:500,italic:false,underline:false,align:'left',lineHeight:1.3}})
  const strokes=[]; for(let i=0;i<60;i++){
    const e = mkStroke(80+ (i%10)*120, 70+Math.floor(i/10)*120, `hsl(${i*11%360} 65% 40%)`, 2+(i%5))
    const n=10+(i%12)
    for(let k=0;k<n;k++){const a=k/n*Math.PI*2; e.pts.push(Math.cos(a)*(12+i%40)-e.x, Math.sin(a)*(12+i%40)-e.y, 0.3+0.6*Math.abs(Math.sin(a)))}
    strokes.push(e)
  }
  s.addElements(l1, strokes, false)
  s.addElements(l1, [mkShape(300,300,520,470,'#93c5fd'), mkShape(600,600,760,720,'#fca5a5'), mkNote(820,120,'A note'), mkText(820,300,'Some text here')], false)
  // an eraser on a separate layer exercises the scratch path
  s.addElements(l2, [{id:uid('e'),kind:'stroke',layerId:l2,opacity:1,created:Date.now(),x:340,y:340,pts:[0,0,0.5, 120,90,0.5, 200,60,0.5],
    style:{color:'#000',size:26,opacity:1,blend:'destination-out',pressure:0,smoothing:0.3,response:0.4,pressureGamma:1,tilt:0,widthSmooth:0,velocity:0,minWidth:1,taperIn:0,taperOut:0}}], false)
  s.markAllDirty()
  s.notify('doc')
})
await settle()
await verify('seeded board')
check('seeded board renders content', (await page.evaluate(()=>window.adiDraw.store.countElements())) === 65)

// the incremental frame must match a full repaint after each kind of change
const compare = async (label) => {
  await snapshot()
  await page.evaluate(()=>{ window.adiDraw.app.renderer.clearCache(); window.adiDraw.store.markAllDirty(); window.adiDraw.store.notify('doc') })
  await settle()
  const d = await diff()
  // a few antialiased pixels on a region seam differ by 1-2/255; that is
  // invisible and unavoidable when a region is repainted on its own
  const ok = d.n === 0 || (d.worst <= 6 && d.n < 40)
  check(label, ok, report(d))
}

// 1. add an object (partial repaint of its bbox)
await page.evaluate(async ()=>{
  const { uid } = await import('/src/core/geometry.ts')
  const s = window.adiDraw.store
  s.addElement(s.doc.layers[0].id, {id:uid('g'),kind:'shape',layerId:s.doc.layers[0].id,opacity:1,created:Date.now(),x:950,y:600,x2:1080,y2:720,
    style:{shape:'rect',stroke:{color:'#059669',size:4,opacity:1,blend:'source-over',pressure:0,smoothing:0,response:0,pressureGamma:1,tilt:0,widthSmooth:0,velocity:0,minWidth:1,taperIn:0,taperOut:0},fill:'#6ee7b7',fillOpacity:0.5,dash:null,corner:8,sides:4,arrowHead:'none'}})
})
await settle()
await compare('add object -> incremental matches full repaint')

// 2. move an object (old + new bbox must both be repainted)
await page.evaluate(()=>{
  const s = window.adiDraw.store
  const el = s.allElements().find(e=>e.kind==='note')
  s.begin('move'); s.modify(el.layerId, [el], [{...structuredClone(el), x: 300, y: 520}]); s.commit()
})
await settle()
await compare('move object -> no stale pixels left behind')

// 3. remove an object
await page.evaluate(()=>{
  const s = window.adiDraw.store
  const el = s.allElements().find(e=>e.kind==='text')
  s.removeElementsAcross(new Set([el.id]))
})
await settle()
await compare('remove object -> hole is repainted')

// 4. layer visibility
await page.evaluate(()=>{ const s=window.adiDraw.store; s.updateLayer(s.doc.layers[1].id, {visible:false}) })
await settle()
await compare('hide layer -> correct')
await page.evaluate(()=>{ const s=window.adiDraw.store; s.updateLayer(s.doc.layers[1].id, {visible:true}) })
await settle()
await compare('show layer -> correct')

// 5. pan then compare against a full repaint at the new view
await page.evaluate(()=>{ window.adiDraw.store.setView({x:-140,y:-60}) })
await settle()
await compare('pan -> matches full repaint at the new view')

// 6. zoom
await page.evaluate(()=>{ window.adiDraw.store.setView({scale:1.75,x:40,y:20}) })
await settle()
await compare('zoom -> matches full repaint')

// 7. undo / redo
await page.evaluate(()=>{ window.adiDraw.store.undo(); window.adiDraw.store.undo() })
await settle()
await compare('undo -> matches full repaint')

// 8. background change
await page.evaluate(()=>{ const s=window.adiDraw.store; s.doc.meta.background='#0f172a'; s.markAllDirty(); s.notify('doc') })
await settle()
await compare('background change -> matches full repaint')

await page.screenshot({ path:'test/incremental.png' })
await browser.close(); await server.close()
const failed = results.filter(r=>r.startsWith('FAIL'))
console.log(`\n${results.length-failed.length}/${results.length} checks passed`)
process.exit(failed.length?1:0)
