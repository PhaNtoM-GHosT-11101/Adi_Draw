import { launch } from './browser.mjs'
import { createServer } from 'vite'
const server = await createServer({ server: { port: 5407, strictPort: true }, logLevel: 'error' })
await server.listen()
const browser = await launch()
const page = await browser.newPage({ viewport:{width:1600,height:950} })
page.on('pageerror', e=>console.log('ERR', e.message))
await page.goto('http://localhost:5407/', { waitUntil:'networkidle' })
await page.waitForSelector('.rail-btn')

// seed a heavy board directly through the model
const N = Number(process.env.N || 4000)
const seeded = await page.evaluate(async (N)=>{
  const { uid } = await import('/src/core/geometry.ts')
  const t = performance.now()
  const layer = window.adiDraw.store.doc.layers[0].id
  const elems = []
  for (let i=0;i<N;i++){
    const x = (i*97)%1800, y = (i*61)%1200
    const n = 12 + (i%18)
    const pts=[]; for(let k=0;k<n;k++){const a=k/n*Math.PI*2; pts.push(x+Math.cos(a)*(10+i%40), y+Math.sin(a)*(10+i%30), 0.4+0.6*Math.abs(Math.sin(a)))}
    elems.push({ id:uid('s'), kind:'stroke', layerId:layer, opacity:1, created:Date.now(), x:x-Math.max(10,i%40), y:y-Math.max(10,i%30), pts:pts.slice(3),
      style:{color:`hsl(${(i*7)%360} 70% ${30+(i%40)}%)`,size:1+(i%4),opacity:1,blend:'source-over',pressure:0.9,smoothing:0.3,response:0.5,pressureGamma:1,tilt:0,widthSmooth:0.3,velocity:0.1,minWidth:0.3,taperIn:0.1,taperOut:0.1}})
  }
  window.adiDraw.store.addElements(layer, elems, false)
  window.adiDraw.store.markAllDirty()
  return { ms: performance.now()-t, count: window.adiDraw.store.countElements() }
}, N)
console.log(`seeded ${seeded.count} strokes in ${seeded.ms.toFixed(0)}ms`)

await page.waitForTimeout(700)

// Wrap the renderer's render() so we time the real work, not the rAF wait.
await page.evaluate(()=>{
  const r = window.adiDraw.app.renderer
  const orig = r.render.bind(r)
  window.__perf = { total: 0, n: 0 }
  r.render = (...args) => {
    const a = performance.now()
    orig(...args)
    window.__perf.total += performance.now() - a
    window.__perf.n++
  }
})
const reset = () => page.evaluate(()=>{ window.__perf.total = 0; window.__perf.n = 0 })
const read = async () => {
  const avg = await page.evaluate(()=>window.__perf.n ? window.__perf.total/window.__perf.n : 0)
  const prof = await page.evaluate(()=>{
    const p = window.adiDraw.app.renderer.profile
    return Object.fromEntries(Object.entries(p).map(([k,v])=>[k, +(v/Math.max(1,window.__perf.n)).toFixed(3)]))
  })
  console.log('    phases:', JSON.stringify(prof))
  return avg
}

await reset()
await page.evaluate(async ()=>{ for(let i=0;i<10;i++){ window.adiDraw.store.markAllDirty(); window.adiDraw.store.notify('doc'); await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))) } })
console.log('full repaint        ', (await read()).toFixed(2)+'ms   (whole viewport)')

await reset()
await page.evaluate(async ()=>{ for(let i=0;i<30;i++){ window.adiDraw.store.setView({x:-i*7,y:-i*5}); window.adiDraw.store.notify('view'); await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))) } })
console.log('pan frame           ', (await read()).toFixed(2)+'ms   (blit + overlay only)')

await reset()
await page.evaluate(async ()=>{
  const s = window.adiDraw.store, layer = s.doc.layers[0].id
  for(let i=0;i<30;i++){
    const el={id:'probe'+i,kind:'shape',layerId:layer,opacity:1,created:Date.now(),x:400,y:400,x2:404,y2:404,
      style:{shape:'rect',stroke:{color:'#000',size:2,opacity:1,blend:'source-over',pressure:0,smoothing:0,response:0,pressureGamma:1,tilt:0,widthSmooth:0,velocity:0,minWidth:1,taperIn:0,taperOut:0},fill:null,fillOpacity:0.2,dash:null,corner:0,sides:4,arrowHead:'none'}}
    s.addElement(layer, el, false)
    s.notify('doc')
    await new Promise(r=>requestAnimationFrame(r))
  }
})
console.log('add 1 small object  ', (await read()).toFixed(2)+'ms   (on a '+seeded.count+'-object board)')

await reset()
const strokeMs = await page.evaluate(async ()=>{
  const s = window.adiDraw.store, layer = s.doc.elements[Object.keys(s.doc.elements)[0]] && Object.keys(s.doc.elements)[0]
  const mod = await import('/src/core/stroke.ts')
  const style = {color:'#111',size:4,opacity:1,blend:'source-over',pressure:0.9,smoothing:0.4,response:0.6,pressureGamma:1,tilt:0.3,widthSmooth:0.4,velocity:0.2,minWidth:0.3,taperIn:0.1,taperOut:0.1}
  for(let stroke=0; stroke<12; stroke++){
    const b = new mod.StrokeBuilder(style)
    const pts=[]
    for(let k=0;k<240;k++){
      const tt=k/239
      b.push(500+tt*400, 500+Math.sin(tt*8)*80, 0.2+0.8*Math.sin(tt*Math.PI), 1000+k*8, 0.2)
      pts.push(b.out[b.out.length-3], b.out[b.out.length-2], b.out[b.out.length-1])
    }
    const el={id:'stroke'+stroke,kind:'stroke',layerId:layer,opacity:1,created:Date.now(),x:pts[0],y:pts[1],pts:pts.slice(3),style}
    s.addElement(layer, el, false)
    s.notify('doc')
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))
  }
  return null
})
console.log('240-pt stroke frame ', (await read()).toFixed(2)+'ms   (repaint the stroke bbox only)  ', strokeMs ?? '')

// mem
const mem = await page.evaluate(()=>performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : null)
console.log('js heap      ', mem ? mem+'MB' : 'n/a')
await page.screenshot({ path:'test/perf.png' })
await browser.close(); await server.close()
