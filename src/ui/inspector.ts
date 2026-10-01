import type { DocMeta, ShapeKind, TextureKind, Tool, ToolCategory } from '../core/types'
import type { ToolStore } from '../core/app'
import { BLEND_MODES, FONT_FAMILIES, FONT_WEIGHTS, ICONS, NOTE_COLORS, PALETTE, makeTool } from '../core/tools'
import { el, clear, section, slider, toggle, select, colorRow, button, svgIcon, normaliseHex } from './dom'
import { ColorPicker } from './colorpicker'
import { clamp } from '../core/geometry'
import { loadJson } from '../core/app'

const CATEGORY_LABEL: Record<ToolCategory, string> = {
  select: 'Select',
  freehand: 'Freehand',
  eraser: 'Eraser',
  shape: 'Shape',
  text: 'Text',
  section: 'Section',
  note: 'Note',
  laser: 'Laser',
  image: 'Image',
}

const SHAPE_KINDS: { value: ShapeKind; label: string; icon: string }[] = [
  { value: 'rect', label: 'Rectangle', icon: ICONS.rect },
  { value: 'ellipse', label: 'Ellipse', icon: ICONS.ellipse },
  { value: 'line', label: 'Line', icon: ICONS.line },
  { value: 'arrow', label: 'Arrow', icon: ICONS.arrow },
  { value: 'diamond', label: 'Diamond', icon: ICONS.diamond },
  { value: 'triangle', label: 'Triangle', icon: ICONS.triangle },
  { value: 'star', label: 'Star', icon: ICONS.star },
  { value: 'polygon', label: 'Polygon', icon: ICONS.polygon },
]

export interface InspectorHooks {
  onChange: () => void
  /** offered only when a single stroke is selected and it reads as a shape */
  canInkToShape?: () => boolean
  /** the section the user currently has selected, if exactly one */
  selectedSection?: () => { id: string; title: string; collapsed: boolean; nestedIn: string | null; count: number } | null
  onRenameSection?: (id: string, title: string) => void
  onToggleSection?: (id: string) => void
  inkToShape?: () => void
  onPickShortcut: (tool: Tool) => void
  onNewPreset: (tool: Tool) => void
  onRecentsChange: (recents: string[]) => void
}

export class Inspector {
  readonly root: HTMLElement
  private body: HTMLElement
  private recents: string[]
  private pickerOpen = false
  private picker: ColorPicker | null = null
  private pickerTarget: 'stroke' | 'fill' | 'note' = 'stroke'

  constructor(
    private store: ToolStore,
    private hooks: InspectorHooks,
  ) {
    this.recents = loadJson<string[]>('adi-draw.recents') ?? []
    this.body = el('div', { class: 'panel-body' })
    this.root = el('aside', { class: 'panel', 'data-panel': 'tool' }, [
      el('div', { class: 'panel-head' }, [
        el('h2', { text: 'Tool setup' }),
        el('span', { class: 'panel-hint', text: 'right-click a tool for this' }),
      ]),
      this.body,
    ])
    this.render()
    store.subscribe(() => this.render())
  }

  private set(id: string, patch: Partial<Tool>) {
    this.store.update(id, patch, { save: false })
    this.hooks.onChange()
  }

  render() {
    const tool = this.store.active
    clear(this.body)
    if (!tool) return
    this.body.append(this.header(tool))
    const secPanel = this.selectedSectionSection()
    if (secPanel) this.body.append(secPanel)
    if (tool.category === 'select' && this.hooks.canInkToShape?.()) {
      const b = button('Ink to shape', () => this.hooks.inkToShape?.(), { icon: ICONS.inkToShape })
      this.body.append(section('Selection', [b, el('p', {
        class: 'hint',
        text: 'Snaps the selected stroke to the line, rectangle, ellipse, triangle or diamond it was aiming at.',
      })]))
    }
    this.body.append(this.colorSection(tool))
    if (tool.category !== 'select' && tool.category !== 'image')
      this.body.append(this.strokeSection(tool))
    if (tool.category === 'freehand' || tool.category === 'laser') {
      this.body.append(this.dynamicsSection(tool))
      this.body.append(this.surfaceSection(tool))
      this.body.append(this.filterSection(tool))
    }
    if (tool.category === 'shape') this.body.append(this.shapeSection(tool))
    if (tool.category === 'text' || tool.category === 'note') this.body.append(this.textSection(tool))
    if (tool.category === 'section') this.body.append(this.sectionSection(tool))
    if (tool.category === 'eraser') this.body.append(this.eraserSection(tool))
    this.body.append(this.shortcutSection(tool))
    this.body.append(this.presetSection(tool))
  }

  /* ------------------------------ header -------------------------- */

  private header(tool: Tool) {
    const name = el('input', { class: 'name-input', value: tool.name, spellcheck: 'false' }) as HTMLInputElement
    name.addEventListener('change', () => this.set(tool.id, { name: name.value.trim() || tool.name }))

    const badge = el('span', { class: 'badge', text: CATEGORY_LABEL[tool.category] })

    return el('div', { class: 'tool-head' }, [
      el('div', { class: 'tool-head-row' }, [
        el('span', { class: 'tool-icon' }, [svgIcon(tool.icon, 20)]),
        name,
        badge,
      ]),
      el('div', { class: 'quick-row' }, [
        button('Pick colour', () => this.openPicker('stroke'), { icon: 'settings', class: 'btn sm', title: 'Open the full colour picker' }),
        button('New preset', () => this.hooks.onNewPreset(tool), { icon: 'copy', class: 'btn sm', title: 'Duplicate this tool so you can tweak a copy' }),
        toggle('In toolbar', !tool.hidden, (v) => this.set(tool.id, { hidden: !v }), 'Show this tool in the left toolbar'),
      ]),
    ])
  }

  /* ------------------------------ colour -------------------------- */

  private colorSection(tool: Tool) {
    const colors = tool.category === 'note' ? NOTE_COLORS : PALETTE
    const swatches = el('div', { class: 'swatch-grid' })
    for (const c of colors) {
      const b = el('button', {
        class: `swatch${tool.color.toLowerCase() === c.toLowerCase() ? ' on' : ''}`,
        type: 'button',
        title: c,
        style: `background:${c}`,
      })
      b.addEventListener('click', () => this.set(tool.id, { color: c }))
      swatches.append(b)
    }

    const recentGrid =
      this.recents.length > 0
        ? el('div', { class: 'swatch-grid recent' }, this.recents.map((c) => {
            const b = el('button', { class: 'swatch', type: 'button', title: c, style: `background:${c}` })
            b.addEventListener('click', () => this.set(tool.id, { color: c }))
            return b
          }))
        : null

    const pickerSlot = el('div', { class: 'picker-slot' })
    const toggleBtn = button(
      this.pickerOpen ? 'Hide colour picker' : 'Custom colour…',
      () => {
        this.pickerOpen = !this.pickerOpen
        this.render()
      },
      { icon: 'settings', class: 'btn sm' },
    )
    queueMicrotask(() => {
      if (this.pickerOpen) this.mountPicker(pickerSlot, tool, this.pickerTarget)
    })

    return section('Colour', [
      el('div', { class: 'swatch-row' }, [swatches, recentGrid]),
      el('div', { class: 'btn-row' }, [toggleBtn]),
      colorRow('Hex', tool.color, (v) => this.set(tool.id, { color: normaliseHex(v ?? '#000000') })),
      pickerSlot,
    ])
  }

  openPicker(target: 'stroke' | 'fill' | 'note') {
    this.pickerTarget = target
    this.pickerOpen = true
    this.render()
    const slot = this.root.querySelector<HTMLElement>('.picker-slot')
    slot?.scrollIntoView({ block: 'nearest' })
  }

  private mountPicker(slot: HTMLElement, tool: Tool, target: 'stroke' | 'fill' | 'note') {
    if (!this.picker || this.pickerTarget !== target) {
      this.picker = new ColorPicker({
        colors: target === 'note' ? NOTE_COLORS : PALETTE,
        recents: this.recents,
        onChange: (hex) => {
          if (target === 'fill') this.set(tool.id, { fill: hex })
          else if (target === 'note') this.set(tool.id, { noteColor: hex })
          else this.set(tool.id, { color: hex })
        },
        onRecentsChange: (r) => {
          this.recents = r
          this.hooks.onRecentsChange(r)
        },
      })
    }
    this.picker.setHex(target === 'note' ? tool.noteColor : tool.color, false)
    slot.replaceChildren(this.picker.root)
  }

  /* ------------------------------ stroke -------------------------- */

  private strokeSection(tool: Tool) {
    const isEraser = tool.category === 'eraser'
    const maxSize = tool.category === 'shape' ? 60 : 120
    return section('Line', [
      slider(
        'Size',
        tool.size,
        0.25,
        maxSize,
        0.25,
        (v) => this.set(tool.id, { size: v }),
        { format: (v) => `${v.toFixed(2)} px` },
      ),
      slider(
        'Opacity',
        tool.opacity,
        0.05,
        1,
        0.01,
        (v) => this.set(tool.id, { opacity: v }),
        { format: (v) => `${Math.round(v * 100)}%` },
      ),
      select(
        'Blend',
        tool.blend,
        BLEND_MODES.map((b) => ({ label: b.label, value: b.value })),
        (v) => this.set(tool.id, { blend: v }),
      ),
      !isEraser && tool.category !== 'text'
        ? select(
            'Dash',
            tool.dash ? tool.dash.join(',') : 'solid',
            [
              { label: 'Solid', value: 'solid' },
              { label: 'Dotted', value: '1,6' },
              { label: 'Dashed', value: '10,7' },
              { label: 'Fine dash', value: '5,4' },
            ],
            (v) => this.set(tool.id, { dash: v === 'solid' ? null : v.split(',').map(Number) }),
          )
        : null,
    ])
  }

  /* ----------------------------- dynamics ------------------------- */

  private dynamicsSection(tool: Tool) {
    return section('Pressure & feel', [
      el('p', {
        class: 'hint',
        text: 'With a stylus these give real ink feel. The filter removes tremor when you write slowly and steps aside when you move fast, so smoothing never costs you control.',
      }),
      slider(
        'Pressure',
        tool.pressure,
        0,
        1,
        0.01,
        (v) => this.set(tool.id, { pressure: v }),
        { format: (v) => `${Math.round(v * 100)}%`, hint: 'How much stylus pressure controls the line width' },
      ),
      el('div', { class: 'ctl' }, [
        el('div', { class: 'ctl-head' }, [
          el('label', { text: 'Pressure curve' }),
          el('span', { class: 'ctl-value', text: curveLabel(tool.pressureGamma) }),
        ]),
        curvePad(tool, (v) => this.set(tool.id, { pressureGamma: v })),
        el('div', { class: 'curve-legend' }, [
          el('span', { text: 'light' }),
          el('span', { text: 'firm' }),
        ]),
      ]),
      slider(
        'Min width',
        tool.minWidth,
        0,
        1,
        0.01,
        (v) => this.set(tool.id, { minWidth: v }),
        { format: (v) => `${Math.round(v * 100)}% of size`, hint: 'Width at zero pressure' },
      ),
      slider(
        'Tilt',
        tool.tilt,
        0,
        1,
        0.01,
        (v) => this.set(tool.id, { tilt: v }),
        { format: (v) => (v < 0.005 ? 'off' : `${Math.round(v * 100)}%`), hint: 'How much stylus tilt thickens the line — great for shading' },
      ),
      tool.category === 'laser'
        ? slider('Glow time', tool.laserTrail, 200, 2500, 25, (v) => this.set(tool.id, { laserTrail: v }), {
            format: (v) => `${Math.round(v)} ms`,
            hint: 'How long the pointer trail takes to fade out',
          })
        : null,
    ].filter(Boolean) as Node[])
  }

  private surfaceSection(tool: Tool) {
    const chips = el('div', { class: 'texture-grid' })
    const OPTIONS: { value: TextureKind; label: string }[] = [
      { value: 'none', label: 'Smooth' },
      { value: 'grain', label: 'Wax' },
      { value: 'graphite', label: 'Graphite' },
      { value: 'chalk', label: 'Chalk' },
      { value: 'bristle', label: 'Bristle' },
    ]
    for (const o of OPTIONS) {
      const b = el('button', {
        class: `shape-chip texture-chip${tool.texture === o.value ? ' on' : ''}`,
        type: 'button',
        title: o.label,
      })
      b.append(swatchPreview(o.value, tool.color))
      b.append(el('span', { class: 'chip-label', text: o.label }))
      b.addEventListener('click', () => this.set(tool.id, { texture: o.value }))
      chips.append(b)
    }
    return section('Surface', [
      el('p', {
        class: 'hint',
        text: 'Texture clumps the pigment so the surface shows through, like real crayon or a loaded brush. Try it on any tool.',
      }),
      chips,
      tool.texture === 'none'
        ? el('p', { class: 'hint', text: 'Currently a flat, solid line.' })
        : el('div', {}, [
            slider('Grain size', tool.textureScale, 0.25, 4, 0.05, (v) => this.set(tool.id, { textureScale: v }), {
              format: (v) => `${v.toFixed(2)}×`,
              hint: 'Smaller is a finer, tighter texture',
            }),
            slider('Body opacity', tool.textureBody, 0.05, 1, 0.01, (v) => this.set(tool.id, { textureBody: v }), {
              format: (v) => `${Math.round(v * 100)}%`,
              hint: 'How much flat colour sits beneath the texture',
            }),
          ]),
    ])
  }

  private filterSection(tool: Tool) {
    return section('Smoothing', [
      el('p', {
        class: 'hint',
        text: 'Two dials: how much tremor to remove, and how quickly to get out of the way when the pen moves.',
      }),
      slider(
        'Steadiness',
        tool.smoothing,
        0,
        1,
        0.01,
        (v) => this.set(tool.id, { smoothing: v }),
        { format: (v) => `${Math.round(v * 100)}%`, hint: '0 = raw tablet input, 100 = very steady' },
      ),
      slider(
        'Response',
        tool.response,
        0,
        1,
        0.01,
        (v) => this.set(tool.id, { response: v }),
        { format: (v) => `${Math.round(v * 100)}%`, hint: 'High = follows fast strokes instantly' },
      ),
      slider(
        'Width smoothing',
        tool.widthSmooth,
        0,
        1,
        0.01,
        (v) => this.set(tool.id, { widthSmooth: v }),
        { format: (v) => (v < 0.005 ? 'off' : `${Math.round(v * 100)}%`), hint: 'Keeps the line from wobbling when pressure is noisy' },
      ),
      slider(
        'Speed thinning',
        tool.velocity,
        0,
        1,
        0.01,
        (v) => this.set(tool.id, { velocity: v }),
        { format: (v) => `${Math.round(v * 100)}%`, hint: 'Fast strokes get thinner' },
      ),
      el('div', { class: 'ctl' }, [
        el('div', { class: 'ctl-head' }, [
          el('label', { text: 'Taper' }),
          el('span', { class: 'ctl-value', text: `${Math.round(tool.taperIn * 100)}% / ${Math.round(tool.taperOut * 100)}%` }),
        ]),
        el('div', { class: 'dual-range' }, [
          slider('In', tool.taperIn, 0, 1, 0.01, (v) => this.set(tool.id, { taperIn: v }), {
            format: (v) => `${Math.round(v * 100)}%`,
          }),
          slider('Out', tool.taperOut, 0, 1, 0.01, (v) => this.set(tool.id, { taperOut: v }), {
            format: (v) => `${Math.round(v * 100)}%`,
          }),
        ]),
      ]),
    ])
  }

  /* ------------------------------ shape --------------------------- */

  private shapeSection(tool: Tool) {
    const kindWrap = el('div', { class: 'shape-grid' })
    for (const k of SHAPE_KINDS) {
      const b = el('button', {
        class: `shape-chip${tool.shape === k.value ? ' on' : ''}`,
        type: 'button',
        title: k.label,
      })
      b.append(svgIcon(k.icon, 18))
      b.addEventListener('click', () => this.set(tool.id, { shape: k.value }))
      kindWrap.append(b)
    }

    const children: (Node | null)[] = [
      el('div', { class: 'ctl-label', text: 'Kind' }),
      kindWrap,
    ]

    if (tool.shape === 'rect') {
      children.push(
        slider('Corner', tool.corner, 0, 80, 1, (v) => this.set(tool.id, { corner: v }), {
          format: (v) => `${Math.round(v)} px`,
        }),
      )
    }
    if (tool.shape === 'star' || tool.shape === 'polygon') {
      children.push(
        slider('Sides', tool.sides, 3, 16, 1, (v) => this.set(tool.id, { sides: v }), {
          format: (v) => `${Math.round(v)}`,
        }),
      )
    }
    if (tool.shape === 'line' || tool.shape === 'arrow') {
      children.push(
        select(
          'Arrowheads',
          tool.arrowHead,
          [
            { label: 'None', value: 'none' },
            { label: 'End', value: 'end' },
            { label: 'Both', value: 'both' },
          ],
          (v) => this.set(tool.id, { arrowHead: v }),
        ),
      )
    }
    const fillSlot = el('div', { class: 'picker-slot' })
    queueMicrotask(() => {
      if (this.pickerOpen && this.pickerTarget === 'fill') this.mountPicker(fillSlot, tool, 'fill')
    })
    children.push(
      el('div', { class: 'divider' }),
      colorRow(
        'Fill',
        tool.fill ?? '',
        (v) => this.set(tool.id, { fill: v }),
        { allowNone: true, noneLabel: 'No fill' },
      ),
      el('div', { class: 'btn-row' }, [
        button(
          this.pickerOpen && this.pickerTarget === 'fill' ? 'Hide fill picker' : 'Custom fill…',
          () => {
            this.pickerTarget = 'fill'
            this.pickerOpen = !(this.pickerOpen && this.pickerTarget === 'fill')
            this.render()
          },
          { icon: 'settings', class: 'btn sm' },
        ),
      ]),
      fillSlot,
      tool.fill
        ? slider('Fill opacity', tool.fillOpacity, 0.02, 1, 0.01, (v) => this.set(tool.id, { fillOpacity: v }), {
            format: (v) => `${Math.round(v * 100)}%`,
          })
        : null,
      !tool.fill
        ? el('div', { class: 'ctl' }, [
            el('label', { class: 'ctl-label', text: 'Pick a fill' }),
            el(
              'div',
              { class: 'swatch-grid' },
              PALETTE.slice(4, 22).map((c) => {
                const b = el('button', {
                  class: 'swatch',
                  type: 'button',
                  title: c,
                  style: `background:${c};opacity:${Math.max(0.12, tool.fillOpacity)}`,
                })
                b.addEventListener('click', () => this.set(tool.id, { fill: c }))
                return b
              }),
            ),
          ])
        : null,
    )
    return section('Shape', children.filter(Boolean) as Node[])
  }

  /* ------------------------------- text --------------------------- */

  private textSection(tool: Tool) {
    const isNote = tool.category === 'note'
    return section(isNote ? 'Note' : 'Text', [
      slider('Font size', tool.fontSize, 6, 160, 1, (v) => this.set(tool.id, { fontSize: v }), {
        format: (v) => `${Math.round(v)} pt`,
      }),
      select(
        'Typeface',
        tool.fontFamily,
        FONT_FAMILIES.map((f) => ({ label: f.label, value: f.value })),
        (v) => this.set(tool.id, { fontFamily: v }),
      ),
      select(
        'Weight',
        tool.fontWeight,
        FONT_WEIGHTS.map((f) => ({ label: f.label, value: f.value })),
        (v) => this.set(tool.id, { fontWeight: v }),
      ),
      slider('Line height', tool.lineHeight, 0.8, 2.4, 0.05, (v) => this.set(tool.id, { lineHeight: v }), {
        format: (v) => v.toFixed(2),
      }),
      el('div', { class: 'ctl ctl-inline' }, [
        el('label', { class: 'ctl-label', text: 'Style' }),
        el('div', { class: 'btn-group' }, [
          this.toggleChip('Italic', tool.italic, () => this.set(tool.id, { italic: !tool.italic })),
          this.toggleChip('Underline', tool.underline, () => this.set(tool.id, { underline: !tool.underline })),
        ]),
      ]),
      el('div', { class: 'ctl ctl-inline' }, [
        el('label', { class: 'ctl-label', text: 'Align' }),
        el('div', { class: 'btn-group' }, [
          this.toggleChip('Left', tool.align === 'left', () => this.set(tool.id, { align: 'left' })),
          this.toggleChip('Centre', tool.align === 'center', () => this.set(tool.id, { align: 'center' })),
          this.toggleChip('Right', tool.align === 'right', () => this.set(tool.id, { align: 'right' })),
        ]),
      ]),
      colorRow('Text colour', tool.color, (v) => this.set(tool.id, { color: normaliseHex(v ?? '#000000') })),
      isNote
        ? colorRow('Paper colour', tool.noteColor, (v) => this.set(tool.id, { noteColor: normaliseHex(v ?? '#ffd66b') }))
        : null,
      isNote
        ? slider('Default size', tool.size, 60, 480, 4, (v) => this.set(tool.id, { size: v }), {
            format: (v) => `${Math.round(v)} px`,
          })
        : null,
    ].filter(Boolean) as Node[])
  }

  private toggleChip(label: string, on: boolean, onClick: () => void) {
    const b = el('button', { class: `chip${on ? ' on' : ''}`, type: 'button', text: label })
    b.addEventListener('click', onClick)
    return b
  }

  /* ------------------------------ eraser -------------------------- */

  private sectionSection(tool: Tool) {
    const colors = NOTE_COLORS
    return section('Section', [
      el('p', {
        class: 'hint',
        text: 'Drag on the board to draw one. Anything you drop inside joins it, and drawing a section inside another makes a sub-section. Click a title band to fold it.',
      }),
      el('div', { class: 'bg-presets' },
        colors.map((c) => {
          const b = el('button', { class: 'bg-chip', type: 'button', title: c, style: `background:${c}` })
          b.addEventListener('click', () => this.set(tool.id, { noteColor: c }))
          return b
        }),
      ),
    ])
  }

  /** Shown once a section exists, so its title and nesting can be edited. */
  private selectedSectionSection() {
    const sel = this.hooks.selectedSection?.()
    if (!sel) return null
    const title = el('input', {
      class: 'name-input',
      value: sel.title,
      placeholder: 'Section title',
      spellcheck: 'false',
    }) as HTMLInputElement
    title.addEventListener('input', () => this.hooks.onRenameSection?.(sel.id, title.value))
    title.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') title.blur()
    })

    const fold = el(
      'button',
      { class: 'btn', type: 'button' },
      [
        svgIcon(ICONS['chevron'], 16),
        el('span', { text: sel.collapsed ? 'Unfold' : 'Fold' }),
      ],
    )
    fold.addEventListener('click', () => this.hooks.onToggleSection?.(sel.id))

    return section(sel.collapsed ? 'Section (folded)' : 'Section', [
      el('div', { class: 'field' }, [el('label', { class: 'field-label', text: 'Title' }), title]),
      sel.nestedIn
        ? el('p', { class: 'hint', text: `Sub-section of “${sel.nestedIn}”` })
        : el('p', { class: 'hint', text: 'Top-level section.' }),
      sel.count > 0
        ? el('p', { class: 'hint', text: `Holds ${sel.count} object${sel.count === 1 ? '' : 's'}.` })
        : el('p', { class: 'hint', text: 'Nothing inside yet — drop something in.' }),
      fold,
    ])
  }

  private eraserSection(tool: Tool) {
    return section('Eraser', [
      el('p', {
        class: 'hint',
        text: 'Ink eraser keeps your strokes but rubs out the ink, like a real eraser on paper. Whole-object eraser removes the entire stroke at once.',
      }),
      el('div', { class: 'radio-col' }, [
        this.radio('Ink (pixel eraser)', tool.eraserMode === 'stroke', () => this.set(tool.id, { eraserMode: 'stroke', blend: 'destination-out' })),
        this.radio('Whole object', tool.eraserMode === 'element', () => this.set(tool.id, { eraserMode: 'element', blend: 'source-over' })),
      ]),
      slider('Eraser size', tool.size, 2, 160, 1, (v) => this.set(tool.id, { size: v }), {
        format: (v) => `${Math.round(v)} px`,
      }),
    ])
  }

  private radio(label: string, checked: boolean, onChange: () => void) {
    const input = el('input', { type: 'radio', class: 'radio' }) as HTMLInputElement
    input.checked = checked
    input.addEventListener('change', onChange)
    return el('label', { class: 'radio-row' }, [input, el('span', { text: label })])
  }

  /* ---------------------------- shortcut -------------------------- */

  private shortcutSection(tool: Tool) {
    const input = el('input', {
      class: 'key-input',
      value: tool.shortcut || '',
      placeholder: 'press a key…',
      spellcheck: 'false',
      readonly: true,
    }) as HTMLInputElement
    input.addEventListener('click', () => this.hooks.onPickShortcut(tool))
    input.addEventListener('focus', () => this.hooks.onPickShortcut(tool))
    return section('Keyboard shortcut', [
      el('div', { class: 'ctl ctl-inline' }, [
        el('label', { class: 'ctl-label', text: 'Shortcut' }),
        input,
      ]),
      el('p', { class: 'hint', text: 'Click the box, then press the key combination you want. Press Backspace to clear it.' }),
    ])
  }

  /* ----------------------------- presets -------------------------- */

  private presetSection(tool: Tool) {
    const catTools = this.store.all.filter((t) => t.category === tool.category)
    const applyRow =
      catTools.length > 1
        ? el('div', { class: 'ctl ctl-inline' }, [
            el('label', { class: 'ctl-label', text: 'Apply to' }),
            el('div', { class: 'btn-group' }, [
              button('All', () => {
                this.store.updateCategoryStyle(tool.category, {
                  color: tool.color,
                  size: tool.size,
                  opacity: tool.opacity,
                  blend: tool.blend,
                  pressure: tool.pressure,
                  smoothing: tool.smoothing,
                  response: tool.response,
                  pressureGamma: tool.pressureGamma,
                  tilt: tool.tilt,
                  widthSmooth: tool.widthSmooth,
                  texture: tool.texture,
                  textureScale: tool.textureScale,
                  textureBody: tool.textureBody,
                  velocity: tool.velocity,
                  minWidth: tool.minWidth,
                  taperIn: tool.taperIn,
                  taperOut: tool.taperOut,
                })
              }, { class: 'btn sm', title: 'Copy these settings to every tool of this kind' }),
            ]),
          ])
        : null

    return section('Presets', [
      el('div', { class: 'btn-row' }, [
        button('Duplicate', () => this.hooks.onNewPreset(tool), { icon: 'copy', class: 'btn sm' }),
        button(
          'Reset tool',
          () => {
            const fresh = makeTool({ id: tool.id, name: tool.name, category: tool.category, icon: tool.icon })
            this.store.update(tool.id, { ...fresh, shortcut: tool.shortcut, hidden: tool.hidden })
          },
          { icon: 'undo', class: 'btn sm', title: 'Restore the default settings for this tool' },
        ),
        button('Reset all', () => this.store.reset(), { icon: 'trash', class: 'btn sm danger' }),
      ]),
      applyRow,
    ])
  }
}

/* ----------------------------- board panel ------------------------ */

/** Tiny canvas preview of each surface texture, in the tool's own colour. */
function swatchPreview(kind: TextureKind, colour: string) {
  const c = el('canvas', { class: 'tex-chip', width: '56', height: '20' }) as HTMLCanvasElement
  const g = c.getContext('2d')
  if (!g) return c
  if (kind === 'none') {
    g.fillStyle = colour
    g.fillRect(2, 8, 52, 4)
    return c
  }
  g.fillStyle = colour
  g.globalAlpha = 0.4
  g.fillRect(2, 8, 52, 4)
  g.globalAlpha = 1
  // reuse the same tile generators the renderer uses
  const url = textureTileDataUrl(kind, colour)
  if (url) {
    const img = new Image()
    img.onload = () => {
      const pat = g.createPattern(img, 'repeat')
      if (!pat) return
      pat.setTransform(new DOMMatrix([0.32, 0, 0, 0.32, 0, 0]))
      g.fillStyle = pat
      g.fillRect(2, 8, 52, 4)
    }
    img.src = url
  }
  return c
}

/** Build one texture tile and hand back a data URL, for the previews. */
function textureTileDataUrl(kind: TextureKind, colour: string): string | null {
  const c = document.createElement('canvas')
  const size = kind === 'bristle' ? 24 : 64
  c.width = c.height = size
  const g = c.getContext('2d')
  if (!g) return null
  g.fillStyle = colour
  if (kind === 'graphite') {
    for (let i = 0; i < size * size * 0.07; i++) {
      g.globalAlpha = 0.06 + Math.random() * 0.3
      g.beginPath()
      g.arc(Math.random() * size, Math.random() * size, 0.9 + Math.random(), 0, Math.PI * 2)
      g.fill()
    }
  } else if (kind === 'chalk') {
    for (let i = 0; i < size * size * 0.02; i++) {
      g.globalAlpha = 0.05 + Math.random() * 0.2
      g.beginPath()
      g.arc(Math.random() * size, Math.random() * size, 2 + Math.random() * 2, 0, Math.PI * 2)
      g.fill()
    }
  } else if (kind === 'bristle') {
    for (let x = 0; x < size; x++) {
      const a = Math.random()
      g.globalAlpha = a * 0.8
      for (let k = 0; k < 5; k++) g.fillRect(x, Math.random() * size, 1, size * (0.2 + Math.random() * 0.8))
    }
  } else {
    for (let i = 0; i < 90; i++) {
      const cx = Math.random() * size
      const cy = Math.random() * size
      g.globalAlpha = 0.35 + Math.random() * 0.5
      for (let k = 0; k < 6; k++) {
        g.beginPath()
        g.arc(cx + Math.cos(k) * 4, cy + Math.sin(k) * 4, 2 + Math.random() * 4, 0, Math.PI * 2)
        g.fill()
      }
    }
  }
  return c.toDataURL()
}

/** Draggable pressure-curve pad: horizontal = pressure, vertical = width. */
function curvePad(tool: Tool, onChange: (gamma: number) => void) {
  const canvas = el('canvas', { class: 'curve', width: '240', height: '120' }) as HTMLCanvasElement
  const ctx = canvas.getContext('2d')!
  const g = tool.pressureGamma
  let dragging = false

  const paint = () => {
    const w = canvas.width
    const h = canvas.height
    const cur = tool.pressureGamma
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#fafbfd'
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = '#e3e6ec'
    ctx.lineWidth = 1
    for (let i = 1; i < 4; i++) {
      ctx.beginPath()
      ctx.moveTo((i / 4) * w, 0)
      ctx.lineTo((i / 4) * w, h)
      ctx.moveTo(0, (i / 4) * h)
      ctx.lineTo(w, (i / 4) * h)
      ctx.stroke()
    }
    ctx.strokeStyle = '#c7dbff'
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(0, h)
    ctx.lineTo(w, 0)
    ctx.stroke()
    ctx.setLineDash([])

    // gamma < 1 bows the curve up (heavier), > 1 bows it down (lighter)
    const pts: [number, number][] = []
    for (let i = 0; i <= 24; i++) {
      const t = i / 24
      const v = Math.pow(t, cur)
      pts.push([t * w, h - v * h])
    }
    ctx.strokeStyle = '#2563eb'
    ctx.lineWidth = 2
    ctx.beginPath()
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
    ctx.stroke()

    const hx = pts[24][0]
    const hy = pts[24][1]
    ctx.beginPath()
    ctx.arc(hx, hy, 4, 0, Math.PI * 2)
    ctx.fillStyle = '#2563eb'
    ctx.fill()
    void g
    void dragging
  }

  const pick = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect()
    const w = canvas.width
    const h = canvas.height
    const x = Math.min(1, Math.max(0, ((e.clientX - r.left) / r.width) * w))
    const y = Math.min(1, Math.max(0, 1 - ((e.clientY - r.top) / r.height) * h))
    if (x < 0.02) return
    // invert y = x^gamma  ->  gamma = ln(y) / ln(x)
    const gamma = Math.log(Math.max(1e-4, y)) / Math.log(x)
    onChange(Math.min(3, Math.max(0.2, gamma)))
  }

  canvas.addEventListener('pointerdown', (e) => {
    dragging = true
    canvas.setPointerCapture(e.pointerId)
    pick(e)
  })
  canvas.addEventListener('pointermove', (e) => dragging && pick(e))
  canvas.addEventListener('pointerup', () => (dragging = false))
  requestAnimationFrame(paint)
  return canvas
}

function curveLabel(gamma: number) {
  if (gamma < 0.85) return 'heavy'
  if (gamma < 1.15) return 'linear'
  if (gamma < 1.8) return 'light'
  return 'very light'
}

/** Paper styles, each drawn as a real miniature of what it puts on the board. */
const PAPERS: { value: DocMeta['canvasStyle']; label: string }[] = [
  { value: 'infinite', label: 'Blank' },
  { value: 'lines', label: 'Grid' },
  { value: 'ruled', label: 'Ruled' },
  { value: 'dots', label: 'Dots' },
]

function paperPreview(value: DocMeta['canvasStyle'], ink: string): SVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 40 26')
  svg.setAttribute('class', 'paper-thumb')
  svg.setAttribute('aria-hidden', 'true')
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    const l = document.createElementNS(ns, 'line')
    l.setAttribute('x1', String(x1)); l.setAttribute('y1', String(y1))
    l.setAttribute('x2', String(x2)); l.setAttribute('y2', String(y2))
    l.setAttribute('stroke', ink); l.setAttribute('stroke-width', '1')
    svg.appendChild(l)
  }
  const dot = (x: number, y: number) => {
    const c = document.createElementNS(ns, 'circle')
    c.setAttribute('cx', String(x)); c.setAttribute('cy', String(y))
    c.setAttribute('r', '1'); c.setAttribute('fill', ink)
    svg.appendChild(c)
  }
  if (value === 'lines') {
    for (let x = 4; x <= 36; x += 8) line(x, 0, x, 26)
    for (let y = 4; y <= 22; y += 6) line(0, y, 40, y)
  } else if (value === 'ruled') {
    for (let y = 4; y <= 22; y += 6) line(0, y, 40, y)
  } else if (value === 'dots') {
    for (let y = 4; y <= 22; y += 6) for (let x = 4; x <= 36; x += 8) dot(x, y)
  }
  return svg
}

function paperRow(current: DocMeta['canvasStyle'], onPick: (v: DocMeta['canvasStyle']) => void) {
  const wrap = el('div', { class: 'paper-row' })
  for (const p of PAPERS) {
    const b = el(
      'button',
      { class: 'paper-chip' + (p.value === current ? ' is-active' : ''), type: 'button', title: p.label },
      [paperPreview(p.value, 'currentColor')],
    )
    b.appendChild(el('span', { text: p.label }))
    b.addEventListener('click', () => onPick(p.value))
    wrap.appendChild(b)
  }
  return wrap
}

export interface BoardHooks {
  onChange: () => void
}

export class BoardPanel {
  readonly root: HTMLElement
  private body: HTMLElement
  private lastSig = ''

  constructor(
    private getMeta: () => {
      title: string
      background: string
      canvasStyle: 'infinite' | 'grid' | 'dots' | 'lines' | 'ruled'
      gridSize: number
      gridColor: string
      showGrid: boolean
      snapToGrid: boolean
    },
    private patchMeta: (p: Record<string, unknown>) => void,
    private store: ToolStore,
    private hooks: BoardHooks,
  ) {
    this.body = el('div', { class: 'panel-body' })
    this.root = el('aside', { class: 'panel', 'data-panel': 'board' }, [
      el('div', { class: 'panel-head' }, [el('h2', { text: 'Board' })]),
      this.body,
    ])
    this.render()
  }

  /**
   * Rebuild the panel from the current meta.
   *
   * Without this every control here would be write-only: patching the paper or
   * the theme would change the board but leave the swatch showing the old
   * choice, because nothing re-read the values.
   */
  render() {
    const m = this.getMeta()
    // 'doc' fires on every stroke; rebuilding this panel each time would be
    // pure waste, so only redraw when a value the panel shows has moved
    const sig = JSON.stringify([m, this.store.settings])
    if (sig === this.lastSig) return
    this.lastSig = sig
    clear(this.body)
    this.body.append(
      section('Appearance', [
          colorRow('Background', m.background, (v) => this.patchMeta({ background: v })),
          el('div', { class: 'bg-presets' },
            ['#ffffff', '#fbfbfd', '#f4f6fb', '#1e293b', '#0f172a', '#fdf6e3'].map((c) => {
              const b = el('button', { class: 'bg-chip', type: 'button', title: c, style: `background:${c}` })
              b.addEventListener('click', () => {
                this.patchMeta({ background: c })
                this.hooks.onChange()
              })
              return b
            }),
          ),
        ]),
        section('Grid', [
          toggle('Show grid', m.showGrid, (v) => {
            this.patchMeta({ showGrid: v })
            this.hooks.onChange()
          }),
          paperRow(m.canvasStyle, (v) => {
            this.patchMeta({ canvasStyle: v })
            this.hooks.onChange()
          }),
          slider('Cell size', m.gridSize, 4, 200, 1, (v) => this.patchMeta({ gridSize: v }), {
            format: (v) => `${Math.round(v)} px`,
          }),
          colorRow('Grid colour', m.gridColor, (v) => {
            this.patchMeta({ gridColor: v })
            this.hooks.onChange()
          }),
          toggle('Snap to grid', m.snapToGrid, (v) => {
            this.patchMeta({ snapToGrid: v })
            this.hooks.onChange()
          }),
        ]),
        section('Appearance', [
          select(
            'Theme',
            this.store.settings.theme,
            [
              { label: 'Match system', value: 'auto' },
              { label: 'Light', value: 'light' },
              { label: 'Dark', value: 'dark' },
            ],
            (v) => {
              this.store.patchSettings({ theme: v })
              this.hooks.onChange()
            },
          ),
        ]),
        section('Performance', [
          select(
            'Render quality',
            this.store.settings.quality,
            [
              { label: 'Performance (1× pixels)', value: 'performance' },
              { label: 'Balanced (up to 2×)', value: 'balanced' },
              { label: 'Quality (up to 3×)', value: 'quality' },
            ],
            (v) => {
              this.store.patchSettings({ quality: v })
              this.hooks.onChange()
            },
          ),
          el('p', {
            class: 'hint',
            text: 'Ink is repainted only where it changed, so higher settings mainly cost on large strokes and text.',
          }),
        ]),
        section('Input', [
          toggle('Palm rejection', this.store.settings.palmRejection, (v) => {
            this.store.patchSettings({ palmRejection: v })
            this.hooks.onChange()
          }, 'Ignore finger touches while a stylus has been used recently'),
          toggle('Autosave', this.store.settings.autosave, (v) => this.store.patchSettings({ autosave: v })),
        ]),
    )
  }
}

export { clamp }
