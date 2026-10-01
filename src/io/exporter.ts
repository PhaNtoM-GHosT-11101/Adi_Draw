import type {
  AnyElement,
  DocumentState,
  NoteElement,
  Rect,
  TextElement,
} from '../core/types'
import { elementBBox } from '../core/store'
import { outlinePathData } from '../core/stroke'
import { shapePathData, isLineShape, notePathData } from '../core/shapes'
import { downloadBlob, withAlpha } from '../core/geometry'
import { wrapText } from '../render/renderer'
import { TextureCache, svgTextureFilter } from '../render/textures'

export interface ExportOptions {
  /** draw the background grid into the exported image */
  grid: boolean
  /** expand the crop by this many world units */
  padding: number
  /** output resolution multiplier */
  scale: number
  background: string | 'transparent'
}

export const defaultExportOptions = (): ExportOptions => ({
  grid: true,
  padding: 32,
  scale: 2,
  background: '#ffffff',
})

/* ------------------------------- PNG ------------------------------ */

export async function exportPNG(doc: DocumentState, opts: Partial<ExportOptions> = {}) {
  const dataUrl = await toPngDataUrl(doc, opts)
  if (!dataUrl) throw new Error('PNG encoding failed')
  const res = await fetch(dataUrl)
  downloadBlob(await res.blob(), `${slug(doc.meta.title)}.png`)
}

/** Render the board to a PNG data URL (used by the Electron save dialog). */
export async function toPngDataUrl(doc: DocumentState, opts: Partial<ExportOptions> = {}) {
  const o = { ...defaultExportOptions(), ...opts }
  const bounds = contentBounds(doc)
  const pad = o.padding
  const worldW = bounds ? bounds.w + pad * 2 : 1200
  const worldH = bounds ? bounds.h + pad * 2 : 800
  const originX = bounds ? bounds.x - pad : 0
  const originY = bounds ? bounds.y - pad : 0
  const scale = o.scale

  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(worldW * scale))
  canvas.height = Math.max(1, Math.round(worldH * scale))
  const ctx = canvas.getContext('2d')!
  if (o.background !== 'transparent') {
    ctx.fillStyle = o.background
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  ctx.setTransform(scale, 0, 0, scale, -originX * scale, -originY * scale)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  if (o.grid) drawGrid(ctx, doc, { x: originX, y: originY, w: worldW, h: worldH }, scale)

  const textures = new TextureCache(ctx)
  const pending: Promise<void>[] = []
  for (const layer of doc.layers) {
    if (!layer.visible || layer.opacity <= 0) continue
    ctx.save()
    ctx.globalAlpha = layer.opacity
    for (const el of doc.elements[layer.id] ?? []) {
      const p = paint(ctx, el, textures)
      if (p) pending.push(p)
    }
    ctx.restore()
  }
  await Promise.all(pending)

  return canvas.toDataURL('image/png')
}

function paint(
  ctx: CanvasRenderingContext2D,
  el: AnyElement,
  textures: TextureCache,
): Promise<void> | null {
  ctx.save()
  ctx.globalAlpha = el.opacity
  switch (el.kind) {
    case 'section': {
      const h = Math.min(el.h, 34)
      ctx.fillStyle = 'rgba(255,255,255,0.72)'
      roundRect(ctx, el.x, el.y, el.w, el.h, 14)
      ctx.fill()
      ctx.fillStyle = el.accent
      ctx.fillRect(el.x, el.y, el.w, h)
      ctx.fillStyle = '#fff'
      ctx.font = '600 15px system-ui, sans-serif'
      ctx.textBaseline = 'middle'
      ctx.fillText(el.title, el.x + 14, el.y + h / 2, el.w - 28)
      break
    }
    case 'stroke': {
      const st = el.style
      ctx.globalCompositeOperation = st.blend as GlobalCompositeOperation
      const path = new Path2D(outlinePathData(el.pts, st, 2, el.x, el.y))
      if (st.texture === 'none') {
        ctx.fillStyle = st.color
        ctx.fill(path)
      } else {
        const t = textures.get(st.texture, st.textureScale, st.color)
        ctx.globalAlpha = el.opacity * (t ? st.textureBody : 1)
        ctx.fillStyle = st.color
        ctx.fill(path)
        if (t) {
          ctx.globalAlpha = el.opacity
          ctx.fillStyle = t.pattern
          ctx.fill(path)
        }
      }
      break
    }
    case 'shape': {
      const st = el.style
      const isLine = isLineShape(st.shape)
      if (st.fill) {
        ctx.globalAlpha = el.opacity * st.fillOpacity
        ctx.fillStyle = st.fill
        ctx.fill(new Path2D(shapePathData(st.shape, el.x, el.y, el.x2, el.y2, st, isLine, 'fill')))
        ctx.globalAlpha = el.opacity
      }
      ctx.strokeStyle = st.stroke.color
      ctx.lineWidth = st.stroke.size
      if (st.dash) ctx.setLineDash(st.dash)
      ctx.stroke(
        new Path2D(shapePathData(st.shape, el.x, el.y, el.x2, el.y2, st, isLine, 'outline')),
      )
      break
    }
    case 'text': {
      ctx.fillStyle = el.style.color
      ctx.font = fontOf(el.style)
      ctx.textBaseline = 'top'
      const lh = el.style.fontSize * el.style.lineHeight
      const lines = wrapText(ctx, el.text, el.width)
      lines.forEach((line, i) => {
        const w = ctx.measureText(line).width
        const x =
          el.style.align === 'center'
            ? el.x + (el.width - w) / 2
            : el.style.align === 'right'
              ? el.x + el.width - w
              : el.x
        const y = el.y + i * lh
        if (el.style.underline) ctx.fillRect(x, y + el.style.fontSize * 1.05, w, Math.max(1, el.style.fontSize / 16))
        ctx.fillText(line, x, y)
      })
      break
    }
    case 'note': {
      ctx.fillStyle = el.color
      ctx.shadowColor = 'rgba(15,23,42,0.2)'
      ctx.shadowBlur = 10
      ctx.shadowOffsetY = 4
      ctx.fill(new Path2D(notePathData(el.x, el.y, el.w, el.h)))
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur = 0
      ctx.shadowOffsetY = 0
      if (el.text) {
        ctx.fillStyle = el.style.color
        ctx.font = fontOf(el.style)
        ctx.textBaseline = 'top'
        const lines = wrapText(ctx, el.text, el.w - 28)
        const lh = el.style.fontSize * el.style.lineHeight
        lines.forEach((line, i) => {
          const y = el.y + 14 + i * lh
          if (y + lh > el.y + el.h - 6) return
          ctx.fillText(line, el.x + 14, y)
        })
      }
      break
    }
    case 'image': {
      const img = new Image()
      img.src = el.src
      return img
        .decode()
        .then(() => {
          ctx.drawImage(img, el.x, el.y, el.w, el.h)
          ctx.restore()
        })
        .catch(() => {
          ctx.restore()
        })
    }
  }
  ctx.restore()
  return null
}

function fontOf(s: { fontFamily: string; fontWeight: number; italic: boolean; fontSize: number }) {
  return `${s.italic ? 'italic ' : ''}${s.fontWeight} ${s.fontSize}px ${s.fontFamily}`
}

function drawGrid(ctx: CanvasRenderingContext2D, doc: DocumentState, view: Rect, scale: number) {
  const step = doc.meta.gridSize
  const target = 26 / scale
  const stride = Math.max(1, Math.round(target / step)) * step
  ctx.save()
  ctx.fillStyle = withAlpha(doc.meta.gridColor, 0.85)
  const startX = Math.floor(view.x / stride) * stride
  const startY = Math.floor(view.y / stride) * stride
  for (let x = startX; x < view.x + view.w; x += stride) {
    for (let y = startY; y < view.y + view.h; y += stride) {
      ctx.beginPath()
      ctx.arc(x, y, Math.max(0.5, 1.1 / scale), 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.restore()
}

function contentBounds(doc: DocumentState): Rect | null {
  let b: Rect | null = null
  for (const layer of doc.layers) {
    if (!layer.visible) continue
    for (const el of doc.elements[layer.id] ?? []) {
      const r = elementBBox(el)
      if (!b) b = r
      else {
        const x = Math.min(b.x, r.x)
        const y = Math.min(b.y, r.y)
        b = {
          x,
          y,
          w: Math.max(b.x + b.w, r.x + r.w) - x,
          h: Math.max(b.y + b.h, r.y + r.h) - y,
        }
      }
    }
  }
  return b
}

/* ------------------------------- SVG ------------------------------ */

export function exportSVG(doc: DocumentState, opts: Partial<ExportOptions> = {}) {
  const o = { ...defaultExportOptions(), ...opts }
  const bounds = contentBounds(doc)
  const pad = o.padding
  const vb = bounds
    ? { x: bounds.x - pad, y: bounds.y - pad, w: bounds.w + pad * 2, h: bounds.h + pad * 2 }
    : { x: 0, y: 0, w: 1200, h: 800 }

  const used = new Set<string>()
  for (const layer of doc.layers)
    for (const el of doc.elements[layer.id] ?? [])
      if (el.kind === 'stroke' && svgTextureFilter(el.style.texture, '')) used.add(el.style.texture)

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(vb.x)} ${f(vb.y)} ${f(vb.w)} ${f(vb.h)}" width="${Math.round(vb.w)}" height="${Math.round(vb.h)}">`,
  ]
  if (used.size) {
    parts.push('<defs>')
    for (const kind of used) {
      const def = svgTextureFilter(kind as never, `adi-grain-${kind}`)
      if (def) parts.push(def)
    }
    parts.push('</defs>')
  }
  if (o.background !== 'transparent')
    parts.push(
      `<rect x="${f(vb.x)}" y="${f(vb.y)}" width="${f(vb.w)}" height="${f(vb.h)}" fill="${o.background}"/>`,
    )
  if (o.grid) {
    const stride = Math.max(1, Math.round(26 / doc.meta.gridSize)) * doc.meta.gridSize
    const dots: string[] = []
    for (let x = Math.floor(vb.x / stride) * stride; x < vb.x + vb.w; x += stride)
      for (let y = Math.floor(vb.y / stride) * stride; y < vb.y + vb.h; y += stride)
        dots.push(`<circle cx="${f(x)}" cy="${f(y)}" r="1.1"/>`)
    parts.push(`<g fill="${doc.meta.gridColor}">${dots.join('')}</g>`)
  }

  for (const layer of doc.layers) {
    if (!layer.visible || layer.opacity <= 0) continue
    const list = doc.elements[layer.id] ?? []
    if (!list.length) continue
    parts.push(`<g data-layer="${escapeXml(layer.name)}" opacity="${f(layer.opacity)}">`)
    for (const el of list) parts.push(svgElement(el))
    parts.push('</g>')
  }
  parts.push('</svg>')
  downloadBlob(new Blob([parts.join('\n')], { type: 'image/svg+xml' }), `${slug(doc.meta.title)}.svg`)
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

function svgElement(el: AnyElement): string {
  const op = f(el.opacity)
  switch (el.kind) {
    case 'section': {
      const h = Math.min(el.h, 34)
      const body = `<rect x="${f(el.x)}" y="${f(el.y)}" width="${f(el.w)}" height="${f(el.h)}" rx="14" fill="rgba(255,255,255,0.72)"/>`
      const band = `<rect x="${f(el.x)}" y="${f(el.y)}" width="${f(el.w)}" height="${f(h)}" fill="${el.accent}"/>`
      const label = el.title
        ? `<text x="${f(el.x + 14)}" y="${f(el.y + h / 2 + 5)}" font-family="system-ui,sans-serif" font-size="15" font-weight="600" fill="#fff">${escapeXml(el.title)}</text>`
        : ''
      return `<g${op}>${body}${band}${label}</g>`
    }
    case 'stroke': {
      const s = el.style
      if (s.blend === 'destination-out') return ''
      const mix = s.blend !== 'source-over' ? ` style="mix-blend-mode:${s.blend}"` : ''
      const d = outlinePathData(el.pts, s, 2, el.x, el.y)
      // SVG has no cheap equivalent for a bristle pattern, so those export flat
      const filt = svgTextureFilter(s.texture, `adi-grain-${s.texture}`)
        ? ` filter="url(#adi-grain-${s.texture})"`
        : ''
      const data = s.texture === 'none' ? '' : ` data-texture="${s.texture}"`
      return `<path d="${d}" fill="${s.color}"${filt}${mix} opacity="${op}"${data} data-blend="${s.blend}"/>`
    }
    case 'shape': {
      const st = el.style
      const isLine = isLineShape(st.shape)
      const d = shapePathData(st.shape, el.x, el.y, el.x2, el.y2, st, isLine, 'outline')
      const fill = st.fill ? `${st.fill}" fill-opacity="${f(st.fillOpacity)}` : 'none'
      const dash = st.dash ? ` stroke-dasharray="${st.dash.join(' ')}"` : ''
      return `<path d="${d}" fill="${fill}" stroke="${st.stroke.color}" stroke-width="${f(st.stroke.size)}" stroke-linecap="round" stroke-linejoin="round"${dash} opacity="${op}"/>`
    }
    case 'text':
    case 'note': {
      const t = el as TextElement | NoteElement
      const isNote = el.kind === 'note'
      const lines = t.text.split('\n')
      const lh = t.style.fontSize * t.style.lineHeight
      const x = isNote ? el.x + 14 : el.x
      const top = isNote ? el.y + 14 : el.y
      const tspans = lines
        .map(
          (line, i) =>
            `<tspan x="${f(x)}" y="${f(top + i * lh + t.style.fontSize * 0.85)}">${escapeXml(line)}</tspan>`,
        )
        .join('')
      const style = `font-family:${t.style.fontFamily};font-size:${f(t.style.fontSize)}px;font-weight:${t.style.fontWeight};${t.style.italic ? 'font-style:italic;' : ''}${t.style.underline ? 'text-decoration:underline;' : ''}`
      if (isNote)
        return `<g opacity="${op}"><path d="${notePathData(el.x, el.y, el.w, el.h)}" fill="${el.color}"/><text style="${style}" fill="${t.style.color}">${tspans}</text></g>`
      const anchor = t.style.align === 'center' ? 'middle' : t.style.align === 'right' ? 'end' : 'start'
      const tx = t.style.align === 'center' ? el.x + el.width / 2 : t.style.align === 'right' ? el.x + el.width : el.x
      return `<text style="${style}" fill="${t.style.color}" opacity="${op}" text-anchor="${anchor}">${tspans.replace(/x="[^"]*"/g, `x="${f(tx)}"`)}</text>`
    }
    case 'image':
      return `<image href="${el.src}" x="${f(el.x)}" y="${f(el.y)}" width="${f(el.w)}" height="${f(el.h)}" opacity="${op}"/>`
  }
}

function f(v: number) {
  const r = Math.round(v * 100) / 100
  return Object.is(r, -0) ? 0 : r
}

function escapeXml(s: string) {
  return s.replace(
    /[<>&"']/g,
    (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === '"' ? '&quot;' : '&apos;'),
  )
}

function slug(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'board'
  )
}
