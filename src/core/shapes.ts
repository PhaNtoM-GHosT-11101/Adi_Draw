import type { ShapeStyle } from './types'

export interface ShapeGeom {
  /** outline path in world coordinates */
  outline: Path2D
  /** filled path if a fill is configured, else null */
  fillPath: Path2D | null
}

const F = (v: number) => {
  const r = Number(v.toFixed(2))
  return Object.is(r, -0) ? 0 : r
}

type Cmd = [string, ...number[]]

function roundRectCmds(x: number, y: number, w: number, h: number, r: number): Cmd[] {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2))
  if (rr <= 0.01) {
    return [
      ['M', x, y],
      ['H', x + w],
      ['V', y + h],
      ['H', x],
      ['Z'],
    ]
  }
  return [
    ['M', x + rr, y],
    ['H', x + w - rr],
    ['A', rr, rr, 0, 0, 1, x + w, y + rr],
    ['V', y + h - rr],
    ['A', rr, rr, 0, 0, 1, x + w - rr, y + h],
    ['H', x + rr],
    ['A', rr, rr, 0, 0, 1, x, y + h - rr],
    ['V', y + rr],
    ['A', rr, rr, 0, 0, 1, x + rr, y],
    ['Z'],
  ]
}

function polyCmds(pts: number[], closed: boolean): Cmd[] {
  if (pts.length < 4) return []
  const out: Cmd[] = [['M', pts[0], pts[1]]]
  for (let i = 2; i < pts.length; i += 2) out.push(['L', pts[i], pts[i + 1]])
  if (closed) out.push(['Z'])
  return out
}

function starPoints(cx: number, cy: number, rx: number, ry: number, points: number): number[] {
  const out: number[] = []
  const n = Math.max(3, Math.round(points))
  for (let i = 0; i < n * 2; i++) {
    const a = (Math.PI * i) / n - Math.PI / 2
    const k = i % 2 === 0 ? 1 : 0.42
    out.push(cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k)
  }
  return out
}

function regularPolygonPoints(cx: number, cy: number, rx: number, ry: number, sides: number): number[] {
  const out: number[] = []
  const n = Math.max(3, Math.round(sides))
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n - Math.PI / 2
    out.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry)
  }
  return out
}

function arrowHeadCmds(
  tipX: number,
  tipY: number,
  fromX: number,
  fromY: number,
  size: number,
): Cmd[] {
  const dx = tipX - fromX
  const dy = tipY - fromY
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const px = -uy
  const py = ux
  const s = Math.max(6, size)
  return [
    ['M', tipX, tipY],
    ['L', tipX - ux * s + px * s * 0.42, tipY - uy * s + py * s * 0.42],
    ['M', tipX, tipY],
    ['L', tipX - ux * s - px * s * 0.42, tipY - uy * s - py * s * 0.42],
  ]
}

function toPathData(cmds: Cmd[]): string {
  const parts: string[] = []
  for (const c of cmds) {
    const op = c[0]
    const nums = (c.slice(1) as number[]).map((v) => F(v))
    parts.push(`${op}${nums.join(' ')}`)
  }
  return parts.join(' ')
}

/** Build the outline (and optional fill) commands for a shape. */
function shapeCmds(
  shape: ShapeStyle['shape'],
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  style: ShapeStyle,
  isLine: boolean,
): { outline: Cmd[]; fill: Cmd[] | null } {
  const arrowSize = style.stroke.size * 3.2

  if (isLine || shape === 'line' || shape === 'arrow') {
    const outline: Cmd[] = [
      ['M', x1, y1],
      ['L', x2, y2],
    ]
    if (style.arrowHead === 'end' || style.arrowHead === 'both')
      outline.push(...arrowHeadCmds(x2, y2, x1, y1, arrowSize))
    if (style.arrowHead === 'both') outline.push(...arrowHeadCmds(x1, y1, x2, y2, arrowSize))
    return { outline, fill: null }
  }

  const x = Math.min(x1, x2)
  const y = Math.min(y1, y2)
  const w = Math.abs(x2 - x1)
  const h = Math.abs(y2 - y1)
  const cx = x + w / 2
  const cy = y + h / 2
  const hasFill = !!style.fill

  let outline: Cmd[]
  switch (shape) {
    case 'rect':
      outline = roundRectCmds(x, y, w, h, style.corner)
      break
    case 'ellipse':
      outline = [
        ['M', cx - w / 2, cy],
        ['A', Math.max(w / 2, 0.01), Math.max(h / 2, 0.01), 0, 1, 0, cx + w / 2, cy],
        ['A', Math.max(w / 2, 0.01), Math.max(h / 2, 0.01), 0, 1, 0, cx - w / 2, cy],
        ['Z'],
      ]
      break
    case 'diamond':
      outline = polyCmds([cx, y, x + w, cy, cx, y + h, x, cy], true)
      break
    case 'triangle':
      outline = polyCmds([cx, y, x + w, y + h, x, y + h], true)
      break
    case 'star':
      outline = polyCmds(starPoints(cx, cy, w / 2, h / 2, style.sides), true)
      break
    case 'polygon':
      outline = polyCmds(regularPolygonPoints(cx, cy, w / 2, h / 2, style.sides), true)
      break
    default:
      outline = roundRectCmds(x, y, w, h, style.corner)
  }

  return { outline, fill: hasFill ? outline : null }
}

export function shapePathData(
  shape: ShapeStyle['shape'],
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  style: ShapeStyle,
  isLine: boolean,
  which: 'outline' | 'fill' = 'outline',
): string {
  const { outline, fill } = shapeCmds(shape, x1, y1, x2, y2, style, isLine)
  const cmds = which === 'outline' ? outline : (fill ?? [])
  return toPathData(cmds)
}

export function shapeGeom(
  shape: ShapeStyle['shape'],
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  style: ShapeStyle,
  isLine: boolean,
): ShapeGeom {
  const { outline, fill } = shapeCmds(shape, x1, y1, x2, y2, style, isLine)
  const outlinePath = new Path2D(toPathData(outline))
  const fillPath = fill ? new Path2D(toPathData(fill)) : null
  return { outline: outlinePath, fillPath }
}

export const isLineShape = (s: ShapeStyle['shape']) => s === 'line' || s === 'arrow'

/** Rounded sticky-note body with a folded bottom-left corner. */
export function notePathData(x: number, y: number, w: number, h: number, fold = 18) {
  const r = Math.max(2, Math.min(14, w / 3, h / 3))
  const f2 = Math.max(4, Math.min(fold, w / 2, h / 2))
  return (
    `M ${F(x + r)} ${F(y)} ` +
    `H ${F(x + w - r)} A ${r} ${r} 0 0 1 ${F(x + w)} ${F(y + r)} ` +
    `V ${F(y + h - r)} A ${r} ${r} 0 0 1 ${F(x + w - r)} ${F(y + h)} ` +
    `H ${F(x + f2)} L ${F(x)} ${F(y + h - f2)} ` +
    `V ${F(y + r)} A ${r} ${r} 0 0 1 ${F(x + r)} ${F(y)} Z`
  )
}

/** The small triangle that gives the note its folded-corner look. */
export function noteFoldData(x: number, y: number, w: number, h: number, fold = 18) {
  const f2 = Math.max(4, Math.min(fold, w / 2, h / 2))
  return `M ${F(x + f2)} ${F(y + h)} L ${F(x)} ${F(y + h - f2)} L ${F(x + f2)} ${F(y + h - f2)} Z`
}

/** Constrain a drag to a line/arrow from x1,y1 to the raw pointer. */
export function constrainLine(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  shift: boolean,
): [number, number] {
  if (!shift) return [x2, y2]
  const dx = x2 - x1
  const dy = y2 - y1
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
  const len = Math.hypot(dx, dy)
  return [x1 + Math.cos(ang) * len, y1 + Math.sin(ang) * len]
}

/** Keep a box aspect ratio (used for Shift-drag and corner scaling). */
export function constrainBox(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  shift: boolean,
): [number, number] {
  if (!shift) return [x2, y2]
  const w = x2 - x1
  const h = y2 - y1
  const s = Math.max(Math.abs(w), Math.abs(h))
  return [x1 + (Math.sign(w) || 1) * s, y1 + (Math.sign(h) || 1) * s]
}
