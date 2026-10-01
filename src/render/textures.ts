import type { TextureKind } from '../core/types'

/**
 * Stroke surface textures.
 *
 * Crayon, chalk and a loaded paint brush do not lay down flat colour: pigment
 * sits in clumps and skips across the tooth of the surface. Faking that with a
 * solid fill is what makes most whiteboard "crayons" look like markers.
 *
 * Each texture is a seamless tile of periodic value noise, filled *over* a thin
 * solid body — so the gaps read as bare paper rather than as holes punched in
 * whatever was drawn underneath. Tiles are painted in world space, so the grain
 * belongs to the page and stays put while you pan and zoom, like real pigment.
 */

interface Tile {
  canvas: HTMLCanvasElement
  /** fraction of the tile the pigment actually covers */
  coverage: number
}

/**
 * Periodic value noise: a small random lattice, bilinearly interpolated with
 * smoothstep. Because the lattice wraps, the resulting tile is seamless.
 */
function periodicNoise(size: number, cells: number, seed?: Float32Array): Float32Array {
  const g = seed ?? new Float32Array(cells * cells)
  if (!seed) for (let i = 0; i < g.length; i++) g[i] = Math.random()
  const out = new Float32Array(size * size)
  const smooth = (t: number) => t * t * (3 - 2 * t)
  for (let y = 0; y < size; y++) {
    const fy = (y / size) * cells
    const iy = Math.floor(fy)
    const y0 = ((iy % cells) + cells) % cells
    const y1 = (y0 + 1) % cells
    const ty = smooth(fy - iy)
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells
      const ix = Math.floor(fx)
      const x0 = ((ix % cells) + cells) % cells
      const x1 = (x0 + 1) % cells
      const tx = smooth(fx - ix)
      const a = g[y0 * cells + x0]
      const b = g[y0 * cells + x1]
      const c = g[y1 * cells + x0]
      const d = g[y1 * cells + x1]
      out[y * size + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty
    }
  }
  return out
}

function fbm(size: number, cells: number, octaves: number): Float32Array {
  const out = new Float32Array(size * size)
  let amp = 1
  let total = 0
  let c = cells
  for (let o = 0; o < octaves; o++) {
    const n = periodicNoise(size, c)
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp
    total += amp
    amp *= 0.5
    c *= 2
  }
  for (let i = 0; i < out.length; i++) out[i] /= total
  return out
}

const smoothstep = (edge0: number, edge1: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function rgbOf(colour: string): [number, number, number] {
  const h = colour.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * Paint a tile from a noise field.
 * @param alphaFor maps noise (0..1) to alpha (0..1)
 */
function fromNoise(
  size: number,
  noise: Float32Array,
  colour: string,
  alphaFor: (n: number, x: number, y: number) => number,
  width = size,
  height = size,
): Tile {
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  const g = c.getContext('2d')!
  const img = g.createImageData(width, height)
  const [r, gg, b] = rgbOf(colour)
  let covered = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const n = noise[(y % size) * size + (x % size)]
      const a = alphaFor(n, x, y)
      const i = (y * width + x) * 4
      img.data[i] = r
      img.data[i + 1] = gg
      img.data[i + 2] = b
      img.data[i + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255)
      if (a > 0.08) covered++
    }
  }
  g.putImageData(img, 0, 0)
  return { canvas: c, coverage: covered / (width * height) }
}

/* ------------------------------ recipes ---------------------------- */

function waxTile(size: number, colour: string): Tile {
  // waxy: chunky clumps with hard-ish edges, ~30% covered
  const n = fbm(size, 4, 3)
  return fromNoise(size, n, colour, (v) => smoothstep(0.46, 0.6, v) * (0.65 + v * 0.35))
}

function graphiteTile(size: number, colour: string): Tile {
  // graphite: mostly covered but finely speckled, low per-pixel alpha
  const coarse = fbm(size, 8, 2)
  const fine = periodicNoise(size, 32)
  return fromNoise(size, coarse, colour, (v, x, y) => {
    const spec = fine[y * size + x]
    return smoothstep(0.3, 0.68, v) * (0.24 + spec * 0.6)
  })
}

function chalkTile(size: number, colour: string): Tile {
  // chalk: dusty, low coverage, very soft edges
  const n = fbm(size, 3, 2)
  return fromNoise(size, n, colour, (v) => smoothstep(0.5, 0.88, v) * (0.1 + v * 0.42))
}

function bristleTile(colour: string): Tile {
  // bristles: streaks running along the stroke, unevenly loaded.
  // Kept deliberately few and wide — a bristle under ~1.5px averages away
  // under antialiasing and the texture reads as flat colour.
  const w = 15
  const h = 96
  const along = fbm(h, 5, 2)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')!
  const img = g.createImageData(w, h)
  const [r, gg, b] = rgbOf(colour)
  let covered = 0
  for (let x = 0; x < w; x++) {
    // each column is one bristle; most carry pigment, some barely do
    const load = Math.pow(Math.random(), 0.6)
    for (let y = 0; y < h; y++) {
      const a = load * (0.2 + along[y * h % (h * 5)] * 0.8)
      const i = (y * w + x) * 4
      img.data[i] = r
      img.data[i + 1] = gg
      img.data[i + 2] = b
      img.data[i + 3] = Math.round(Math.min(1, a) * 255)
      if (a > 0.08) covered++
    }
  }
  g.putImageData(img, 0, 0)
  return { canvas: c, coverage: covered / (w * h) }
}

function buildTile(kind: Exclude<TextureKind, 'none'>, colour: string): Tile {
  switch (kind) {
    case 'graphite':
      return graphiteTile(64, colour)
    case 'chalk':
      return chalkTile(64, colour)
    case 'bristle':
      return bristleTile(colour)
    case 'grain':
    default:
      return waxTile(64, colour)
  }
}

/**
 * Patterns belong to a context and bake in the colour, so the renderer owns a
 * cache keyed by texture, scale and colour.
 */
export class TextureCache {
  private patterns = new Map<string, CanvasPattern | undefined>()
  private coverages = new Map<string, number>()

  constructor(private ctx: CanvasRenderingContext2D) {}

  get(
    kind: TextureKind,
    scale: number,
    colour: string,
  ): { pattern: CanvasPattern; coverage: number } | null {
    if (kind === 'none') return null
    const s = Math.max(0.15, Math.min(6, scale))
    const key = `${kind}:${s.toFixed(2)}:${colour}`
    let pattern = this.patterns.get(key)
    if (pattern === undefined) {
      const tile = buildTile(kind, colour)
      pattern = this.ctx.createPattern(tile.canvas, 'repeat') ?? undefined
      // 1.0 means the raw tile size; the pattern lives in world space so the
      // grain is anchored to the paper
      if (pattern) pattern.setTransform(new DOMMatrix([1 / s, 0, 0, 1 / s, 0, 0]))
      this.patterns.set(key, pattern)
      this.coverages.set(key, tile.coverage)
    }
    if (!pattern) return null
    return { pattern, coverage: this.coverages.get(key) ?? 0.4 }
  }

  clear() {
    this.patterns.clear()
    this.coverages.clear()
  }
}

/** SVG equivalent, for the vector export. */
export function svgTextureFilter(kind: TextureKind, id: string): string | null {
  if (kind === 'none' || kind === 'bristle') return null
  const cfg =
    kind === 'graphite'
      ? { baseFrequency: 0.85, octaves: 3, keep: 0.5 }
      : kind === 'chalk'
        ? { baseFrequency: 0.32, octaves: 4, keep: 0.72 }
        : { baseFrequency: 0.16, octaves: 2, keep: 0.6 }
  return `<filter id="${id}" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency="${cfg.baseFrequency}" numOctaves="${cfg.octaves}" seed="11" result="n"/>
    <feColorMatrix in="n" type="matrix" result="m" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1.2 0.4 0 0 ${cfg.keep}"/>
    <feComposite in="SourceGraphic" in2="m" operator="out"/>
  </filter>`
}
