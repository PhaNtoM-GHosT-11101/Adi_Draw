#!/usr/bin/env node
/**
 * Generate every image asset for Adi Draw: the app icon at each size a
 * platform asks for, a bare mark, a social-preview card and a README banner.
 *
 * The mark is computed rather than drawn by hand, so the stroke really is the
 * same variable-width taper the app itself renders.
 *
 *   npm run icons
 */
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch } from '../test/browser.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ICONS = join(root, 'public', 'icons')
const DOCS = join(root, 'docs')
const BUILD = join(root, 'build')

for (const d of [ICONS, DOCS, BUILD]) mkdirSync(d, { recursive: true })

/* ------------------------------------------------------------------ *
 *  The mark
 * ------------------------------------------------------------------ */

const BRAND = { from: '#4f7cff', mid: '#7c3aed', to: '#c026d3', ink: '#ffffff' }

/** Sample a cubic Bézier. */
function bez(p0, p1, p2, p3, n) {
  const out = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ])
  }
  return out
}

/**
 * Outline of a stroke whose width follows `widthFn(t)`. This is the same idea
 * as the app's stroke engine, which is why the icon reads as a real ink mark
 * rather than a stroked path.
 */
function taperedStroke(p0, p1, p2, p3, widthFn, samples = 64) {
  const pts = bez(p0, p1, p2, p3, samples)
  const left = []
  const right = []
  for (let i = 0; i < pts.length; i++) {
    const t = i / (pts.length - 1)
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(pts.length - 1, i + 1)]
    let tx = b[0] - a[0]
    let ty = b[1] - a[1]
    const len = Math.hypot(tx, ty) || 1
    tx /= len
    ty /= len
    const h = widthFn(t) / 2
    left.push([pts[i][0] - ty * h, pts[i][1] + tx * h])
    right.push([pts[i][0] + ty * h, pts[i][1] - tx * h])
  }
  const n = (v) => Math.round(v * 100) / 100
  let d = `M ${n(left[0][0])} ${n(left[0][1])}`
  for (let i = 1; i < left.length; i++) {
    const mx = (left[i - 1][0] + left[i][0]) / 2
    const my = (left[i - 1][1] + left[i][1]) / 2
    d += ` Q ${n(left[i - 1][0])} ${n(left[i - 1][1])} ${n(mx)} ${n(my)}`
  }
  const last = left.length - 1
  d += ` L ${n(left[last][0])} ${n(left[last][1])}`
  const rEnd = widthFn(1) / 2
  if (rEnd > 0.4) d += ` A ${n(rEnd)} ${n(rEnd)} 0 0 1 ${n(right[last][0])} ${n(right[last][1])}`
  for (let i = last - 1; i >= 0; i--) {
    const mx = (right[i][0] + right[i + 1][0]) / 2
    const my = (right[i][1] + right[i + 1][1]) / 2
    d += ` Q ${n(right[i + 1][0])} ${n(right[i + 1][1])} ${n(mx)} ${n(my)}`
  }
  const rStart = widthFn(0) / 2
  if (rStart > 0.4) d += ` A ${n(rStart)} ${n(rStart)} 0 0 1 ${n(left[0][0])} ${n(left[0][1])}`
  return d + ' Z'
}

/** Width profile: light touch, full press, and a lifted, tapered finish. */
const inkWidth = (max) => (t) => {
  const body = Math.sin(Math.PI * Math.min(1, t * 1.06)) ** 0.75
  const entry = Math.min(1, t / 0.06)
  const lift = Math.min(1, (1 - t) / 0.22)
  return max * body * (0.35 + 0.65 * entry) * (0.28 + 0.72 * lift)
}

function markPath(size = 512) {
  const k = size / 512
  const s = (v) => Math.round(v * k * 100) / 100
  const d = taperedStroke(
    [150 * k, 356 * k],
    [214 * k, 236 * k],
    [300 * k, 300 * k],
    [364 * k, 162 * k],
    inkWidth(58 * k),
  )
  return d.replace(/-?\d+(\.\d+)?/g, (m) => s(Number(m)))
}

/**
 * The app tile.
 *
 * The mark is always authored in a 512-unit space and scaled as one group, so
 * a 16px icon is the same artwork as the 1024px one rather than a different
 * drawing that happens to fit.
 *
 * @param opts.size        square edge in px
 * @param opts.inset       shrink the mark — Android's maskable safe zone
 * @param opts.background  false for a bare mark on transparency
 * @param opts.filled      true for a full-bleed square (Android applies its
 *                         own mask, so the art must reach the edges)
 * @param opts.chunky      fatter stroke, no grid — for small sizes
 */
function tileSvg({ size = 512, inset = 0, background = true, filled = false, chunky = false, shadow = true } = {}) {
  const k = size / 512
  const radius = filled ? 0 : Math.round(size * 0.223) // ~22%, close to a squircle
  const showGrid = background && !chunky && size >= 128
  const strokeMax = chunky ? 96 : 70

  // scale the 512-space mark about the tile centre
  const s = (1 - inset * 2) * k
  const tx = f(size / 2 - 256 * s)
  const grid = showGrid
    ? (() => {
        const step = 50
        let d = ''
        for (let y = 1; y < 512 / step; y++)
          for (let x = 1; x < 512 / step; x++) d += `M ${x * step} ${y * step}h .1`
        return `<path d="${d}" stroke="#fff" stroke-opacity=".09" stroke-width="6" stroke-linecap="round" fill="none"/>`
      })()
    : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${BRAND.from}"/>
      <stop offset=".52" stop-color="${BRAND.mid}"/>
      <stop offset="1" stop-color="${BRAND.to}"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2=".35" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".30"/>
      <stop offset=".55" stop-color="#fff" stop-opacity=".05"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="ink" x1=".15" y1="1" x2=".85" y2="0">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".78"/>
      <stop offset=".45" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#f6ecff"/>
    </linearGradient>
    <filter id="lift" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="${f(14 * k)}" stdDeviation="${f(18 * k)}" flood-color="#200a40" flood-opacity=".5"/>
    </filter>
  </defs>
  ${
    background
      ? `<rect width="${size}" height="${size}" rx="${radius}" fill="url(#tile)"/>
  <rect width="${size}" height="${size}" rx="${radius}" fill="url(#sheen)"/>
  ${grid}`
      : ''
  }
  <g transform="translate(${tx} ${tx}) scale(${f(s)})"${shadow ? ' filter="url(#lift)"' : ''}>
    <path d="${taperedStroke([127, 378], [205, 232], [310, 310], [388, 141], inkWidth(strokeMax))}" fill="url(#ink)"/>
  </g>
</svg>`
}

function f(v) {
  return Math.round(v * 1000) / 1000
}

/* ------------------------------------------------------------------ *
 *  Wordmark + social card
 * ------------------------------------------------------------------ */

const FONT = `'Fira Sans','DejaVu Sans',system-ui,sans-serif`

/** Shared background: dark board, faint grid, a soft brand glow. */
function backdrop(w, h, id) {
  return `<defs>
    <linearGradient id="bg${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0a0f1d"/><stop offset=".55" stop-color="#120c22"/><stop offset="1" stop-color="#1a0b2e"/>
    </linearGradient>
    <radialGradient id="glow${id}" cx=".22" cy=".5" r=".7">
      <stop offset="0" stop-color="${BRAND.mid}" stop-opacity=".26"/>
      <stop offset="1" stop-color="${BRAND.mid}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="tile${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${BRAND.from}"/><stop offset=".52" stop-color="${BRAND.mid}"/><stop offset="1" stop-color="${BRAND.to}"/>
    </linearGradient>
    <linearGradient id="sheen${id}" x1="0" y1="0" x2=".35" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="ink${id}" x1=".15" y1="1" x2=".85" y2="0">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".78"/><stop offset=".5" stop-color="#ffffff"/><stop offset="1" stop-color="#f6ecff"/>
    </linearGradient>
    <filter id="lift${id}" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#12042a" flood-opacity=".55"/>
    </filter>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg${id})"/>
  <rect width="${w}" height="${h}" fill="url(#glow${id})"/>
  <g stroke="#fff" stroke-opacity=".05" stroke-width="1">
    ${Array.from({ length: Math.ceil(h / 48) }, (_, i) => `<line x1="0" y1="${i * 48}" x2="${w}" y2="${i * 48}"/>`).join('')}
    ${Array.from({ length: Math.ceil(w / 48) }, (_, i) => `<line x1="${i * 48}" y1="0" x2="${i * 48}" y2="${h}"/>`).join('')}
  </g>`
}

/** The tile, drawn at `size`, with the mark scaled to fill it. */
function tile(x, y, size, id) {
  return `<g transform="translate(${x} ${y})">
    <rect width="${size}" height="${size}" rx="${Math.round(size * 0.223)}" fill="url(#tile${id})"/>
    <rect width="${size}" height="${size}" rx="${Math.round(size * 0.223)}" fill="url(#sheen${id})"/>
    <g stroke="#fff" stroke-opacity=".09" stroke-width="${f(size / 85)}" stroke-linecap="round" fill="none">
      <path d="${(() => {
        const step = 50
        let d = ''
        for (let y = 1; y < 512 / step; y++)
          for (let x = 1; x < 512 / step; x++) d += `M ${x * step} ${y * step}h .1`
        return d
      })()}"/>
    </g>
    <g transform="scale(${f(size / 512)})" filter="url(#lift${id})"><path d="${taperedStroke([127, 378], [205, 232], [310, 310], [388, 141], inkWidth(70))}" fill="url(#ink${id})"/></g>
  </g>`
}

function ogSvg(w = 1200, h = 630) {
  const id = 'g'
  const tx = 84
  const size = 316
  const ty = (h - size) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
  ${backdrop(w, h, id)}
  ${tile(tx, ty, size, id)}
  <g transform="translate(${tx + size + 62} 0)">
    <text x="0" y="${ty + 128}" font-family="${FONT}" font-size="116" font-weight="700" fill="#fff" letter-spacing="-4">Adi Draw</text>
    <rect x="4" y="${ty + 158}" width="74" height="5" rx="2.5" fill="url(#tile${id})"/>
    <text x="4" y="${ty + 214}" font-family="${FONT}" font-size="30" font-weight="500" fill="#aeb9cd">a whiteboard where every pen, colour</text>
    <text x="4" y="${ty + 254}" font-family="${FONT}" font-size="30" font-weight="500" fill="#aeb9cd">and shortcut is yours to configure</text>
    <text x="4" y="${ty + 316}" font-family="${FONT}" font-size="23" fill="#8494ad">Pressure-sensitive ink · shapes &amp; text · layers · offline</text>
    <text x="4" y="${ty + 372}" font-family="ui-monospace,'DejaVu Sans Mono',monospace" font-size="22" fill="#63718c">github.com/PhaNtoM-GHosT-11101/Adi_Draw</text>
  </g>
</svg>`
}

function bannerSvg(w = 1600, h = 520) {
  const id = 'b'
  const tx = 96
  const size = 328
  const ty = (h - size) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
  ${backdrop(w, h, id)}
  ${tile(tx, ty, size, id)}
  <g transform="translate(${tx + size + 72} 0)">
    <text x="0" y="${ty + 128}" font-family="${FONT}" font-size="112" font-weight="700" fill="#fff" letter-spacing="-4">Adi Draw</text>
    <rect x="4" y="${ty + 158}" width="72" height="5" rx="2.5" fill="url(#tile${id})"/>
    <text x="4" y="${ty + 216}" font-family="${FONT}" font-size="30" font-weight="500" fill="#aeb9cd">a whiteboard where every pen, colour and shortcut</text>
    <text x="4" y="${ty + 256}" font-family="${FONT}" font-size="30" font-weight="500" fill="#aeb9cd">is yours to configure</text>
    <text x="4" y="${ty + 320}" font-family="ui-monospace,'DejaVu Sans Mono',monospace" font-size="23" fill="#63718c">phantom-ghost-11101.github.io/Adi_Draw</text>
  </g>
</svg>`
}

/* ------------------------------------------------------------------ *
 *  Render
 * ------------------------------------------------------------------ */

const browser = await launch()

async function shot(svg, w, h, file, transparent = false) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })
  await page.setContent(
    `<!doctype html><html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${
      transparent ? 'transparent' : '#ffffff'
    }">${svg}</body></html>`,
    { waitUntil: 'load' },
  )
  await page.waitForTimeout(40)
  await page.screenshot({ path: file, omitBackground: transparent })
  await page.close()
  console.log('  ' + file.replace(root + '/', ''))
}

console.log('\nGenerating Adi Draw artwork\n')

// master vector
const logo = tileSvg({ size: 512 })
writeFileSync(join(ICONS, 'logo.svg'), logo)
writeFileSync(join(DOCS, 'logo.svg'), logo)
console.log('  public/icons/logo.svg')
console.log('  docs/logo.svg')

// favicon: same mark, no grid, fatter so it reads at 16px
const favicon = tileSvg({ size: 32, chunky: true, shadow: false })
writeFileSync(join(ICONS, 'favicon.svg'), favicon.replace('width="32" height="32"', 'width="32" height="32"'))
console.log('  public/icons/favicon.svg')

// raster sizes — the tile's rounded corners are transparent so the icon sits
// correctly on light *and* dark browser/desktop chrome
for (const size of [16, 32, 48, 64, 96, 128, 180, 192, 256, 512, 1024]) {
  const chunky = size <= 64
  const svg = tileSvg({ size, chunky, shadow: size >= 96 })
  const name = size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`
  await shot(svg, size, size, join(ICONS, name), true)
}

// Android applies its own mask, so the art must reach the edges and the mark
// has to stay inside the 80% safe zone
await shot(tileSvg({ size: 512, inset: 0.12, shadow: false, filled: true }), 512, 512, join(ICONS, 'icon-maskable-512.png'), true)

// a bare mark for placing on any background
await shot(tileSvg({ size: 512, background: false, shadow: false }), 512, 512, join(ICONS, 'mark-512.png'), true)

// docs — and the social card is also served so link previews can point at it
await shot(ogSvg(), 1200, 630, join(DOCS, 'og-image.png'))
await shot(bannerSvg(), 1600, 520, join(DOCS, 'banner.png'))
await shot(ogSvg(), 1200, 630, join(ICONS, 'og-image.png'))
copyFileSync(join(DOCS, 'og-image.png'), join(root, 'public', 'og-image.png'))
copyFileSync(join(DOCS, 'banner.png'), join(root, 'public', 'banner.png'))

// desktop packaging icon
await shot(tileSvg({ size: 512, shadow: false }), 512, 512, join(BUILD, 'icon.png'))
copyFileSync(join(BUILD, 'icon.png'), join(BUILD, 'icon.ico'))
copyFileSync(join(BUILD, 'icon.png'), join(BUILD, 'icon.icns'))

// web app manifest
writeFileSync(
  join(ICONS, 'manifest.webmanifest'),
  JSON.stringify(
    {
      name: 'Adi Draw',
      short_name: 'Adi Draw',
      description:
        'A whiteboard where every pen, colour and shortcut is yours to configure.',
      start_url: '../',
      scope: '../',
      display: 'standalone',
      background_color: '#0b1020',
      theme_color: '#7c3aed',
      icons: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icon-256.png', sizes: '256x256', type: 'image/png' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    null,
    2,
  ),
)
console.log('  public/icons/manifest.webmanifest')

await browser.close()
console.log('\nDone.\n')