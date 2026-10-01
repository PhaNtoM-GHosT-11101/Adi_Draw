import type {
  AnyElement,
  ImageElement,
  NoteElement,
  Rect,
  ShapeElement,
  StrokeElement,
  TextElement,
} from './types'
import type { Mat } from './geometry'
import { matApply, matInvert } from './geometry'

/** Apply an affine matrix to an element, returning a transformed copy. */
export function applyMatrix(el: AnyElement, m: Mat): AnyElement {
  const next = structuredClone(el)
  const o = matApply(m, el.x, el.y)
  const det = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1
  const scaled = det < 0.999 || det > 1.001

  switch (el.kind) {
    case 'stroke': {
      const stroke = next as StrokeElement
      const n = stroke.pts.length / 3
      for (let i = 0; i < n; i++) {
        const p = matApply(m, el.x + el.pts[i * 3], el.y + el.pts[i * 3 + 1])
        stroke.pts[i * 3] = p.x - o.x
        stroke.pts[i * 3 + 1] = p.y - o.y
      }
      stroke.x = o.x
      stroke.y = o.y
      if (scaled) stroke.style = { ...stroke.style, size: Math.max(0.5, stroke.style.size * det) }
      return stroke
    }
    case 'shape': {
      const shape = next as ShapeElement
      const a = matApply(m, el.x, el.y)
      const b = matApply(m, el.x2, el.y2)
      shape.x = a.x
      shape.y = a.y
      shape.x2 = b.x
      shape.y2 = b.y
      if (scaled)
        shape.style = { ...shape.style, stroke: { ...shape.style.stroke, size: Math.max(0.5, shape.style.stroke.size * det) } }
      return shape
    }
    case 'text': {
      const t = next as TextElement
      t.x = o.x
      t.y = o.y
      t.width = Math.max(8, el.width * det)
      t.style = { ...t.style, fontSize: Math.max(2, t.style.fontSize * det) }
      return t
    }
    case 'note': {
      const nte = next as NoteElement
      nte.x = o.x
      nte.y = o.y
      nte.w = Math.max(4, el.w * det)
      nte.h = Math.max(4, el.h * det)
      nte.style = { ...nte.style, fontSize: Math.max(2, nte.style.fontSize * det) }
      return nte
    }
    case 'image': {
      const img = next as ImageElement
      img.x = o.x
      img.y = o.y
      img.w = Math.max(4, el.w * det)
      img.h = Math.max(4, el.h * det)
      return img
    }
  }
}

export function translate(el: AnyElement, dx: number, dy: number): AnyElement {
  const next = structuredClone(el)
  next.x += dx
  next.y += dy
  return next
}

/**
 * Matrix mapping the box `from` onto the box `to` (independent of rotation).
 * Both boxes are axis-aligned.
 */
export function boxToBox(from: Rect, to: Rect): Mat {
  const sx = from.w === 0 ? 1 : to.w / from.w
  const sy = from.h === 0 ? 1 : to.h / from.h
  return {
    a: sx,
    b: 0,
    c: 0,
    d: sy,
    e: to.x - from.x * sx,
    f: to.y - from.y * sy,
  }
}

/** Matrix that rotates `angleRad` about the centre of `box`. */
export function rotateAbout(box: Rect, angleRad: number): Mat {
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const cos = Math.cos(angleRad)
  const sin = Math.sin(angleRad)
  return {
    a: cos,
    b: sin,
    c: -sin,
    d: cos,
    e: cx - (cos * cx - sin * cy),
    f: cy - (sin * cx + cos * cy),
  }
}

export function scaleFromCentre(box: Rect, sx: number, sy: number): Mat {
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  return { a: sx, b: 0, c: 0, d: sy, e: cx - sx * cx, f: cy - sy * cy }
}

export function invert(m: Mat): Mat {
  return matInvert(m)
}
