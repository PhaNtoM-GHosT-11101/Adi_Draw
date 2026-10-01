import { el, clear, normaliseHex } from './dom'
import { hexToRgb, rgbToHex, withAlpha } from '../core/geometry'

export interface ColorPickerOptions {
  colors: string[]
  recents?: string[]
  onChange: (hex: string) => void
  onRecentsChange?: (recents: string[]) => void
  allowAlpha?: boolean
  onAlpha?: (a: number) => void
  alpha?: number
}

/**
 * Compact HSV picker: saturation/value square + hue strip + alpha strip.
 * No dependencies, keyboard accessible enough for everyday use.
 */
export class ColorPicker {
  readonly root: HTMLElement
  private sv: HTMLCanvasElement
  private svCtx: CanvasRenderingContext2D
  private hue: HTMLCanvasElement
  private hueCtx: CanvasRenderingContext2D
  private alphaCanvas: HTMLCanvasElement | null = null
  private hexInput: HTMLInputElement
  private swatch: HTMLDivElement
  private h = 0
  private s = 0
  private v = 0
  private a = 1
  private recents: string[]
  private recentsWrap!: HTMLElement
  private recentsLabel!: HTMLElement
  private dragging: 'sv' | 'hue' | 'alpha' | null = null

  constructor(private opts: ColorPickerOptions) {
    this.h = 210
    this.s = 0.7
    this.v = 0.9
    this.recents = opts.recents ?? []
    this.a = opts.alpha ?? 1

    this.sv = el('canvas', { class: 'sv', width: '220', height: '150' }) as HTMLCanvasElement
    this.svCtx = this.sv.getContext('2d')!
    this.hue = el('canvas', { class: 'hue', width: '220', height: '14' }) as HTMLCanvasElement
    this.hueCtx = this.hue.getContext('2d')!

    this.swatch = el('div', { class: 'cp-swatch' })
    this.hexInput = el('input', { type: 'text', class: 'hex wide', spellcheck: 'false' }) as HTMLInputElement
    this.hexInput.addEventListener('change', () => this.setFromHex(this.hexInput.value, true))

    const strip = el('div', { class: 'cp-strip' })
    if (opts.allowAlpha) {
      const alpha = el('canvas', { class: 'alpha', width: '220', height: '12' }) as HTMLCanvasElement
      this.alphaCanvas = alpha
      strip.append(alpha)
      alpha.addEventListener('pointerdown', (e) => this.startDrag(e, 'alpha', alpha))
    }
    strip.append(this.hue)
    this.hue.addEventListener('pointerdown', (e) => this.startDrag(e, 'hue', this.hue))

    const swatches = el('div', { class: 'cp-swatches' })
    for (const c of opts.colors) {
      const b = el('button', { class: 'cp-dot', type: 'button', title: c, style: `background:${c}` })
      b.addEventListener('click', () => this.setHex(c, true))
      swatches.append(b)
    }

    const recentWrap = el('div', { class: 'cp-recents' })
    this.recentsLabel = el('div', { class: 'cp-label', text: 'Recent' })
    this.recentsWrap = recentWrap
    this.renderRecents()

    this.root = el('div', { class: 'color-picker' }, [
      this.sv,
      strip,
      el('div', { class: 'cp-foot' }, [this.swatch, this.hexInput]),
      swatches,
      el('div', { class: 'cp-recents-block' }, [this.recentsLabel, recentWrap]),
    ])

    this.sv.addEventListener('pointerdown', (e) => this.startDrag(e, 'sv', this.sv))
    this.sv.addEventListener('pointermove', (e) => this.drag(e))
    this.sv.addEventListener('pointerup', () => (this.dragging = null))
    this.hue.addEventListener('pointermove', (e) => this.drag(e))
    this.hue.addEventListener('pointerup', () => (this.dragging = null))
    this.alphaCanvas?.addEventListener('pointermove', (e) => this.drag(e))
    this.alphaCanvas?.addEventListener('pointerup', () => (this.dragging = null))

    this.setHex(opts.colors[0] ?? '#3b82f6', false)
  }

  private startDrag(e: PointerEvent, kind: 'sv' | 'hue' | 'alpha', target: HTMLElement) {
    e.preventDefault()
    this.dragging = kind
    target.setPointerCapture(e.pointerId)
    this.drag(e)
  }

  private drag(e: PointerEvent) {
    if (!this.dragging) return
    const target = this.dragging === 'sv' ? this.sv : this.dragging === 'hue' ? this.hue : this.alphaCanvas
    if (!target) return
    const r = target.getBoundingClientRect()
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
    if (this.dragging === 'sv') {
      this.s = x
      this.v = 1 - y
    } else if (this.dragging === 'hue') {
      this.h = x
    } else {
      this.a = 1 - y
      this.opts.onAlpha?.(this.a)
    }
    this.emit()
  }

  private emit() {
    this.paint()
    this.rememberDebounced()
    const hex = this.currentHex()
    this.hexInput.value = hex
    this.swatch.style.background = this.a < 1 ? withAlpha(hex, this.a) : hex
    this.opts.onChange(hex)
  }

  private rememberTimer = 0
  private rememberDebounced() {
    window.clearTimeout(this.rememberTimer)
    this.rememberTimer = window.setTimeout(() => this.remember(this.currentHex()), 400)
  }

  private currentHex() {
    return hsvToHex(this.h, this.s, this.v)
  }

  setFromHex(value: string, notify: boolean) {
    const v = value.trim().replace(/^#/, '')
    if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(v)) return
    const full = v.length === 3 ? v.split('').map((c) => c + c).join('') : v
    const { h, s, v: vv } = rgbToHsv(parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16))
    this.h = h
    this.s = s
    this.v = vv
    if (notify) this.emit()
    else this.paint()
  }

  setHex(value: string, notify: boolean) {
    this.setFromHex(normaliseHex(value), notify)
    if (notify) this.remember(this.currentHex())
  }

  setAlpha(a: number) {
    this.a = a
    this.paint()
  }

  get value() {
    return this.currentHex()
  }
  get alphaValue() {
    return this.a
  }

  remember(hex: string) {
    const next = [hex, ...this.recents.filter((c) => c.toLowerCase() !== hex.toLowerCase())].slice(0, 10)
    this.recents = next
    this.opts.onRecentsChange?.(next)
    this.renderRecents()
  }

  private renderRecents() {
    if (!this.recentsWrap) return
    clear(this.recentsWrap)
    for (const c of this.recents) {
      const b = el('button', { class: 'cp-dot small', type: 'button', title: c, style: `background:${c}` })
      b.addEventListener('click', () => this.setHex(c, true))
      this.recentsWrap.append(b)
    }
    const empty = this.recents.length === 0
    this.recentsLabel.style.display = empty ? 'none' : ''
    this.recentsWrap.style.display = empty ? 'none' : ''
  }

  paint() {
    // saturation / value square
    const w = this.sv.width
    const h = this.sv.height
    const base = hsvToHex(this.h, 1, 1)
    const grad = this.svCtx.createLinearGradient(0, 0, w, 0)
    grad.addColorStop(0, '#ffffff')
    grad.addColorStop(1, base)
    this.svCtx.fillStyle = grad
    this.svCtx.fillRect(0, 0, w, h)
    const grad2 = this.svCtx.createLinearGradient(0, 0, 0, h)
    grad2.addColorStop(0, 'rgba(0,0,0,0)')
    grad2.addColorStop(1, 'rgba(0,0,0,1)')
    this.svCtx.fillStyle = grad2
    this.svCtx.fillRect(0, 0, w, h)

    const cx = this.s * w
    const cy = (1 - this.v) * h
    this.svCtx.beginPath()
    this.svCtx.arc(cx, cy, 6, 0, Math.PI * 2)
    this.svCtx.strokeStyle = this.v > 0.6 && this.s < 0.6 ? '#000' : '#fff'
    this.svCtx.lineWidth = 2
    this.svCtx.stroke()

    // hue strip
    const hw = this.hue.width
    const hh = this.hue.height
    const hg = this.hueCtx.createLinearGradient(0, 0, hw, 0)
    for (let i = 0; i <= 6; i++) hg.addColorStop(i / 6, hsvToHex((i / 6) * 360, 1, 1))
    this.hueCtx.fillStyle = hg
    this.hueCtx.fillRect(0, 0, hw, hh)
    this.marker(this.hueCtx, this.h * hw, hh / 2, 5, hh)

    if (this.alphaCanvas) {
      const aw = this.alphaCanvas.width
      const ah = this.alphaCanvas.height
      const ag = this.alphaCanvas.getContext('2d')!
      ag.clearRect(0, 0, aw, ah)
      const g1 = ag.createLinearGradient(0, 0, aw, 0)
      g1.addColorStop(0, withAlpha(hsvToHex(this.h, this.s, this.v), 0))
      g1.addColorStop(1, withAlpha(hsvToHex(this.h, this.s, this.v), 1))
      ag.fillStyle = g1
      ag.fillRect(0, 0, aw, ah)
      this.marker(ag, (1 - this.a) * aw, ah / 2, 5, ah)
    }

    this.swatch.style.background = this.a < 1 ? withAlpha(this.currentHex(), this.a) : this.currentHex()
    this.hexInput.value = this.currentHex()
  }

  private marker(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, h: number) {
    ctx.beginPath()
    ctx.moveTo(x - r, y - h / 2)
    ctx.lineTo(x + r, y - h / 2)
    ctx.lineTo(x, y + h / 2)
    ctx.closePath()
    ctx.fillStyle = '#fff'
    ctx.fill()
    ctx.strokeStyle = '#0f172a'
    ctx.lineWidth = 1
    ctx.stroke()
  }
}

export function hsvToHex(hDeg: number, s: number, v: number) {
  const c = v * s
  const hp = (((hDeg % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hp < 1) [r, g, b] = [c, x, 0]
  else if (hp < 2) [r, g, b] = [x, c, 0]
  else if (hp < 3) [r, g, b] = [0, c, x]
  else if (hp < 4) [r, g, b] = [0, x, c]
  else if (hp < 5) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const m = v - c
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255)
}

export function rgbToHsv(r: number, g: number, b: number) {
  const rr = r / 255
  const gg = g / 255
  const bb = b / 255
  const max = Math.max(rr, gg, bb)
  const min = Math.min(rr, gg, bb)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === rr) h = ((gg - bb) / d) % 6
    else if (max === gg) h = (bb - rr) / d + 2
    else h = (rr - gg) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : d / max, v: max }
}

export { hexToRgb }
