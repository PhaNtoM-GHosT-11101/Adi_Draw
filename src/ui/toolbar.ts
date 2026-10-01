import type { Tool } from '../core/types'
import type { ToolStore } from '../core/app'
import { el, clear, svgIcon } from './dom'
import { SHAPE_ICON } from '../core/tools'
import { luminance } from '../core/geometry'

const CATEGORY_ORDER: { key: string; label: string; hint: string }[] = [
  { key: 'select', label: 'Select', hint: 'Click or drag to select · Shift adds · drag handles to scale · top handle rotates' },
  { key: 'freehand', label: 'Draw', hint: 'Pressure-sensitive. The further you press, the thicker the line.' },
  { key: 'shape', label: 'Shapes', hint: 'Drag to draw · Shift constrains the angle or aspect' },
  { key: 'text', label: 'Text', hint: 'Click to place a text box' },
  { key: 'note', label: 'Notes', hint: 'Click for a square note, or drag for a custom size' },
  { key: 'image', label: 'Image', hint: 'Insert a picture from your computer, or paste from the clipboard' },
  { key: 'eraser', label: 'Eraser', hint: 'Ink eraser removes pixels · Whole-object eraser removes the entire stroke' },
  { key: 'laser', label: 'Laser', hint: 'A fading pointer dot — nothing is saved to the board' },
]

export class Toolbar {
  readonly root: HTMLElement
  private buttons = new Map<string, HTMLButtonElement>()

  constructor(
    private store: ToolStore,
    private onSelect: (id: string) => void,
    private onConfigure: () => void,
    private onAddTool: () => void,
  ) {
    this.root = el('nav', { class: 'rail', 'aria-label': 'Tools' })
    this.build()
    store.subscribe(() => this.sync())
  }

  private build() {
    clear(this.root)
    this.buttons.clear()
    const byCat = this.store.byCategory
    for (const { key, label, hint } of CATEGORY_ORDER) {
      const tools = byCat.get(key as Tool['category'])
      if (!tools?.length) continue
      if (key !== 'select') this.root.append(el('div', { class: 'rail-sep' }))
      for (const t of tools) this.root.append(this.buttonFor(t, label, hint))
    }
    this.root.append(
      el('div', { class: 'rail-sep' }),
      this.railButton('plus', 'New tool preset', () => this.onAddTool()),
    )
    this.sync()
  }

  private buttonFor(tool: Tool, groupLabel: string, hint: string) {
    const b = el('button', {
      class: 'rail-btn',
      type: 'button',
      'data-tool': tool.id,
      title: `${tool.name}${tool.shortcut ? `  (${tool.shortcut})` : ''}\n${groupLabel} — ${hint}`,
      'aria-label': tool.name,
    })
    const iconName = tool.category === 'shape' && tool.shape ? SHAPE_ICON[tool.shape] : tool.icon
    b.append(svgIcon(iconName, 21, 1.9))
    if (tool.category === 'freehand' || tool.category === 'shape') {
      const dot = el('span', { class: 'rail-dot' })
      b.append(dot)
    }
    if (tool.hidden) b.classList.add('muted')
    b.addEventListener('click', () => this.onSelect(tool.id))
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      this.onSelect(tool.id)
      this.onConfigure()
    })
    b.addEventListener('dblclick', () => {
      this.onSelect(tool.id)
      this.onConfigure()
    })
    this.buttons.set(tool.id, b)
    return b
  }

  private railButton(icon: string, title: string, onClick: () => void) {
    const b = el('button', { class: 'rail-btn', type: 'button', title, 'aria-label': title })
    b.append(svgIcon(icon, 20, 1.9))
    b.addEventListener('click', onClick)
    return b
  }

  private sync() {
    for (const [id, b] of this.buttons) {
      const tool = this.store.get(id)
      b.classList.toggle('active', id === this.store.activeId)
      const dot = b.querySelector<HTMLElement>('.rail-dot')
      if (dot && tool) {
        dot.style.background = tool.color
        dot.style.opacity = tool.category === 'freehand' ? String(0.25 + tool.opacity * 0.75) : '1'
        dot.style.boxShadow = `0 0 0 1px rgba(255,255,255,${luminance(tool.color) > 0.6 ? 0.9 : 0.25})`
      }
    }
  }
}
