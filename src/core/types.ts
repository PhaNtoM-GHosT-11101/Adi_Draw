/* ------------------------------------------------------------------ *
 *  Core data model for Adi Draw
 * ------------------------------------------------------------------ */

export type ShapeKind =
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'diamond'
  | 'triangle'
  | 'star'
  | 'polygon'

export type ToolCategory =
  | 'freehand'
  | 'eraser'
  | 'shape'
  | 'text'
  | 'note'
  | 'select'
  | 'laser'
  | 'image'

export type BlendMode =
  | 'source-over'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'destination-out'
  | 'source-atop'

export type TextAlign = 'left' | 'center' | 'right'

/** How a stroke's pigment sits on the surface. */
export type TextureKind = 'none' | 'grain' | 'graphite' | 'chalk' | 'bristle'

/** Fully user-configurable description of a drawing instrument. */
export interface Tool {
  id: string
  name: string
  category: ToolCategory
  icon: string
  /** Human key label, e.g. "B" or "Shift+B" */
  shortcut: string
  /** Hidden tools are removed from the rail but keep their settings. */
  hidden?: boolean

  /* ---- shared appearance ---- */
  color: string
  size: number
  opacity: number
  blend: BlendMode

  /* ---- stroke dynamics (freehand only) ---- */
  /** 0 = constant width, 1 = full stylus pressure */
  pressure: number
  /** jitter removal: 0 = raw input, 1 = very steady (0..1) */
  smoothing: number
  /** how fast the filter gets out of the way when the pen speeds up (0..1) */
  response: number
  /** pressure response curve: <1 heavier, >1 lighter (0.3 .. 3) */
  pressureGamma: number
  /** how much stylus tilt thickens the line (0..1) */
  tilt: number
  /** light smoothing of the width profile so the line never wobbles (0..1) */
  widthSmooth: number
  /** surface: none | grain (crayon/wax) | graphite | chalk | bristle */
  texture: TextureKind
  /** 1 = the raw tile size; smaller is finer grain */
  textureScale: number
  /** how solid the flat underlay is beneath the texture (0..1) */
  textureBody: number
  /** how much pen speed thins the line (0..1) */
  velocity: number
  /** width at zero pressure, as a fraction of `size` (0..1) */
  minWidth: number
  /** 0..1 taper amount at start / end of the stroke */
  taperIn: number
  taperOut: number

  /* ---- shape options ---- */
  shape?: ShapeKind
  fill: string | null
  fillOpacity: number
  dash: number[] | null
  corner: number
  sides: number
  arrowHead: 'none' | 'end' | 'both'

  /* ---- text / note options ---- */
  fontSize: number
  fontFamily: string
  fontWeight: number
  italic: boolean
  underline: boolean
  align: TextAlign
  lineHeight: number
  noteColor: string
  notePinned: boolean

  /* ---- eraser options ---- */
  eraserMode: 'stroke' | 'element'

  /* ---- laser ---- */
  laserTrail: number
}

export interface StrokeStyle {
  color: string
  size: number
  opacity: number
  blend: BlendMode
  pressure: number
  smoothing: number
  response: number
  pressureGamma: number
  tilt: number
  widthSmooth: number
  texture: TextureKind
  textureScale: number
  textureBody: number
  velocity: number
  minWidth: number
  taperIn: number
  taperOut: number
}

export interface ShapeStyle {
  stroke: StrokeStyle
  fill: string | null
  fillOpacity: number
  dash: number[] | null
  corner: number
  sides: number
  arrowHead: 'none' | 'end' | 'both'
  shape: ShapeKind
}

export interface TextStyle {
  color: string
  fontSize: number
  fontFamily: string
  fontWeight: number
  italic: boolean
  underline: boolean
  align: TextAlign
  lineHeight: number
}

export interface ElementBase {
  id: string
  layerId: string
  /** 0..1 */
  opacity: number
  /** iso date string */
  created: number
}

export interface StrokeElement extends ElementBase {
  kind: 'stroke'
  x: number
  y: number
  /** flat triples: x, y, pressure(0..1) — relative to x/y */
  pts: number[]
  style: StrokeStyle
}

export interface ShapeElement extends ElementBase {
  kind: 'shape'
  x: number
  y: number
  x2: number
  y2: number
  style: ShapeStyle
}

export interface TextElement extends ElementBase {
  kind: 'text'
  x: number
  y: number
  width: number
  text: string
  style: TextStyle
}

export interface NoteElement extends ElementBase {
  kind: 'note'
  x: number
  y: number
  w: number
  h: number
  color: string
  text: string
  style: TextStyle
}

export interface ImageElement extends ElementBase {
  kind: 'image'
  x: number
  y: number
  w: number
  h: number
  /** data URL */
  src: string
}

export type AnyElement =
  | StrokeElement
  | ShapeElement
  | TextElement
  | NoteElement
  | ImageElement

export interface Layer {
  id: string
  name: string
  visible: boolean
  locked: boolean
  opacity: number
}

export interface DocMeta {
  title: string
  background: string
  /** 'infinite' blank | 'grid' cross-hatch | 'lines' graph | 'ruled' notebook | 'dots' */
  canvasStyle: 'infinite' | 'grid' | 'dots' | 'lines' | 'ruled'
  gridSize: number
  gridColor: string
  showGrid: boolean
  snapToGrid: boolean
}

export interface DocumentState {
  version: number
  meta: DocMeta
  layers: Layer[]
  /** elements keyed by layer id, each in back-to-front order */
  elements: Record<string, AnyElement[]>
}

export interface ViewState {
  x: number
  y: number
  scale: number
}

/* ----------------------------- history ----------------------------- */

export type Op =
  | { t: 'add'; layerId: string; elems: AnyElement[] }
  | { t: 'del'; layerId: string; elems: AnyElement[] }
  | { t: 'mod'; layerId: string; before: AnyElement[]; after: AnyElement[] }
  | { t: 'layerAdd'; index: number; layer: Layer }
  | { t: 'layerDel'; index: number; layer: Layer; elems: AnyElement[] }
  | { t: 'layerMod'; before: Layer; after: Layer }

export interface HistoryEntry {
  label: string
  ops: Op[]
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Pt {
  x: number
  y: number
  p: number
}
