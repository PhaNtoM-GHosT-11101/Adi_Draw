import { ICONS } from '../core/tools'

type Attrs = Record<string, string | number | boolean | EventListener | undefined>

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string | null | undefined | false)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue
    if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener)
    } else if (k === 'class') {
      node.className = String(v)
    } else if (k === 'html') {
      node.innerHTML = String(v)
    } else if (k === 'text') {
      node.textContent = String(v)
    } else if (k === 'value' && node instanceof HTMLInputElement) {
      node.value = String(v)
    } else {
      node.setAttribute(k, v === true ? '' : String(v))
    }
  }
  for (const c of children) if (c) node.append(c)
  return node
}

const ICON_MAP = ICONS as Record<string, string>

/**
 * Callers hand over either an ICONS key ('help') or literal path data
 * ('M4 20l…'), because a Tool carries its icon as resolved path data while the
 * chrome uses keys. Resolving only keys made every tool icon fall back to the
 * pen, so the whole rail drew the same glyph.
 */
function resolveIcon(name: string): string {
  const hit = ICON_MAP[name]
  if (hit) return hit
  return /^[\sMmLlHhVvCcSsQqTtAaZz]/.test(name) ? name : ICON_MAP.pen
}

export function svgIcon(name: keyof typeof ICONS | string, size = 20, stroke = 1.7): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', String(stroke))
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.classList.add('icon')
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  p.setAttribute('d', resolveIcon(name))
  svg.append(p)
  return svg
}

export function clear(node: Element) {
  while (node.firstChild) node.removeChild(node.firstChild)
}

export function fmtPct(v: number) {
  return `${Math.round(v * 100)}%`
}

export function fmtNum(v: number) {
  return String(Math.round(v * 100) / 100)
}

/** Small labelled slider used all over the inspector. */
export function slider(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onInput: (v: number) => void,
  opts: { format?: (v: number) => string; hint?: string } = {},
): HTMLElement {
  const out = el('span', { class: 'ctl-value', text: opts.format ? opts.format(value) : fmtNum(value) })
  const input = el('input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
    class: 'range',
  }) as HTMLInputElement
  input.addEventListener('input', () => {
    const v = parseFloat(input.value)
    out.textContent = opts.format ? opts.format(v) : fmtNum(v)
    onInput(v)
  })
  return el('div', { class: 'ctl', title: opts.hint ?? '' }, [
    el('div', { class: 'ctl-head' }, [el('label', { text: label }), out]),
    input,
  ])
}

/** Toggle switch. */
export function toggle(
  label: string,
  value: boolean,
  onChange: (v: boolean) => void,
  hint?: string,
): HTMLElement {
  const knob = el('span', { class: 'switch-knob' })
  const sw = el('button', {
    class: `switch${value ? ' on' : ''}`,
    type: 'button',
    'aria-pressed': value ? 'true' : 'false',
    title: hint ?? '',
  }, [knob])
  sw.addEventListener('click', () => {
    const next = !sw.classList.contains('on')
    sw.classList.toggle('on', next)
    sw.setAttribute('aria-pressed', next ? 'true' : 'false')
    onChange(next)
  })
  return el('div', { class: 'ctl ctl-inline' }, [
    el('label', { text: label, class: 'ctl-label' }),
    sw,
  ])
}

export function select<T extends string | number>(
  label: string,
  value: T,
  options: { label: string; value: T }[],
  onChange: (v: T) => void,
): HTMLElement {
  const sel = el('select', { class: 'select' }) as HTMLSelectElement
  for (const o of options) {
    const opt = el('option', { value: String(o.value), text: o.label }) as HTMLOptionElement
    if (o.value === value) opt.selected = true
    sel.append(opt)
  }
  sel.addEventListener('change', () => {
    const raw = sel.value
    const found = options.find((o) => String(o.value) === raw)
    if (found) onChange(found.value)
  })
  return el('div', { class: 'ctl ctl-inline' }, [el('label', { text: label, class: 'ctl-label' }), sel])
}

export function colorRow(
  label: string,
  value: string,
  onChange: (v: string | null) => void,
  opts: { allowNone?: boolean; noneLabel?: string } = {},
): HTMLElement {
  const swatch = el('input', { type: 'color', class: 'color-input', value: normaliseHex(value) }) as HTMLInputElement
  swatch.addEventListener('input', () => onChange(swatch.value))
  const children: HTMLElement[] = []
  if (opts.allowNone) {
    const isNone = value === null || value === '' || value === 'transparent'
    const none = el('button', {
      class: `btn btn-sm none-chip${isNone ? ' active' : ''}`,
      type: 'button',
      title: opts.noneLabel ?? 'No fill',
      text: 'None',
    })
    none.addEventListener('click', () => onChange(null))
    children.push(none)
  }
  children.push(swatch)
  const hex = el('input', {
    type: 'text',
    class: 'hex',
    value: value === null ? 'none' : value,
    spellcheck: 'false',
  }) as HTMLInputElement
  hex.addEventListener('change', () => {
    const v = hex.value.trim()
    if (!v || v === 'none') return onChange(null)
    if (/^#?[0-9a-fA-F]{3}$|^#?[0-9a-fA-F]{6}$/.test(v)) onChange(v.startsWith('#') ? v : `#${v}`)
  })
  children.push(hex)
  return el('div', { class: 'ctl ctl-inline' }, [
    el('label', { text: label, class: 'ctl-label' }),
    el('div', { class: 'color-row' }, children),
  ])
}

export function normaliseHex(v: string) {
  if (!v) return '#000000'
  if (v.startsWith('#')) return v.length === 4 ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}` : v
  return '#000000'
}

export function section(title: string, children: (Node | string | null | false)[], collapsible = true) {
  const body = el('div', { class: 'sect-body' }, children)
  const chev = svgIcon('chevron', 14)
  const head = el('button', { class: 'sect-head', type: 'button' }, [
    el('span', { text: title }),
    collapsible ? chev : null as unknown as string,
  ])
  const sect = el('section', { class: 'sect' }, [head, body])
  if (collapsible) {
    head.addEventListener('click', () => {
      sect.classList.toggle('collapsed')
    })
  }
  return sect
}

export function fieldRow(children: (Node | string | null)[]) {
  return el('div', { class: 'field-row' }, children)
}

export function button(
  label: string,
  onClick: () => void,
  opts: { icon?: string; class?: string; title?: string; disabled?: boolean } = {},
) {
  const b = el('button', {
    class: `btn ${opts.class ?? ''}`,
    type: 'button',
    title: opts.title ?? label,
    disabled: opts.disabled,
  })
  if (opts.icon) b.append(svgIcon(opts.icon, 16))
  if (label) b.append(el('span', { text: label }))
  b.addEventListener('click', onClick)
  return b
}
