import type { Layer } from '../core/types'
import type { Store } from '../core/store'
import { el, clear, svgIcon } from './dom'

export class LayersPanel {
  readonly root: HTMLElement
  private list: HTMLElement
  private activeId: string | null = null

  constructor(
    private store: Store,
    private onSelectLayer: (id: string) => void,
  ) {
    this.list = el('div', { class: 'layer-list' })
    this.root = el('section', { class: 'panel', 'data-panel': 'layers' }, [
      el('div', { class: 'panel-head' }, [
        el('h2', { text: 'Layers' }),
        el('div', { class: 'btn-group' }, [
          this.miniBtn('plus', 'New layer above', () => this.addLayer()),
          this.miniBtn('up', 'Move layer up', () => this.moveLayer(1)),
          this.miniBtn('down', 'Move layer down', () => this.moveLayer(-1)),
          this.miniBtn('trash', 'Delete layer', () => this.deleteLayer()),
        ]),
      ]),
      this.list,
    ])
    this.render()
  }

  private miniBtn(icon: string, title: string, onClick: () => void) {
    const b = el('button', { class: 'btn btn-icon sm', type: 'button', title })
    b.append(svgIcon(icon, 15))
    b.addEventListener('click', onClick)
    return b
  }

  setActive(id: string | null) {
    if (this.activeId === id) return
    this.activeId = id
    this.render()
  }

  private addLayer() {
    const idx = this.store.doc.layers.findIndex((l) => l.id === this.activeId)
    const layer = this.store.addLayer(undefined, idx >= 0 ? idx + 1 : undefined)
    this.activeId = layer.id
    this.onSelectLayer(layer.id)
    this.render()
  }

  private moveLayer(delta: number) {
    if (!this.activeId) return
    this.store.moveLayer(this.activeId, delta)
    this.render()
  }

  private deleteLayer() {
    if (!this.activeId) return
    this.store.deleteLayer(this.activeId)
    this.activeId = this.store.doc.layers.at(-1)?.id ?? null
    if (this.activeId) this.onSelectLayer(this.activeId)
    this.render()
  }

  render() {
    clear(this.list)
    // topmost layer first, like every design tool
    for (const layer of [...this.store.doc.layers].reverse()) {
      this.list.append(this.row(layer))
    }
    const count = el('p', {
      class: 'hint',
      text: `${this.store.countElements()} object${this.store.countElements() === 1 ? '' : 's'} · ${this.store.historyDepth} undo step${this.store.historyDepth === 1 ? '' : 's'}`,
    })
    this.list.append(count)
  }

  private row(layer: Layer) {
    const count = (this.store.doc.elements[layer.id] ?? []).length
    const row = el('div', {
      class: `layer-row${layer.id === this.activeId ? ' active' : ''}${layer.visible ? '' : ' hidden-layer'}`,
    })
    row.append(
      this.miniBtn(layer.visible ? 'eye' : 'eye-off', layer.visible ? 'Hide layer' : 'Show layer', () => {
        this.store.updateLayer(layer.id, { visible: !layer.visible })
        this.render()
      }),
      this.miniBtn(layer.locked ? 'lock' : 'unlock', layer.locked ? 'Unlock layer' : 'Lock layer', () => {
        this.store.updateLayer(layer.id, { locked: !layer.locked })
        this.render()
      }),
    )

    const name = el('input', { class: 'layer-name', value: layer.name, spellcheck: 'false' }) as HTMLInputElement
    name.addEventListener('change', () => {
      this.store.updateLayer(layer.id, { name: name.value.trim() || layer.name })
      this.render()
    })
    name.addEventListener('click', (e) => e.stopPropagation())
    const opacity = el('input', {
      type: 'range',
      class: 'range layer-alpha',
      min: '0',
      max: '1',
      step: '0.01',
      value: String(layer.opacity),
      title: 'Layer opacity',
    }) as HTMLInputElement
    const opacityValue = el('span', { class: 'layer-alpha-value', text: `${Math.round(layer.opacity * 100)}%` })
    opacity.addEventListener('input', () => {
      opacityValue.textContent = `${Math.round(parseFloat(opacity.value) * 100)}%`
      this.store.updateLayer(layer.id, { opacity: parseFloat(opacity.value) }, false)
    })
    opacity.addEventListener('pointerdown', (e) => e.stopPropagation())
    opacity.addEventListener('click', (e) => e.stopPropagation())

    row.append(name, opacity, opacityValue, el('span', { class: 'layer-count', text: String(count) }))

    row.addEventListener('click', () => {
      this.activeId = layer.id
      this.onSelectLayer(layer.id)
      this.render()
    })

    return el('div', { class: 'layer-wrap' }, [row])
  }
}

