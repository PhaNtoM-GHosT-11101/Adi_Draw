import { el, button, svgIcon } from './dom'
import type { ToolStore } from '../core/app'

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'General',
    rows: [
      ['Draw', 'Press and drag on the board'],
      ['Pan', 'Space + drag · middle mouse · two fingers'],
      ['Zoom', 'Ctrl/⌘ + scroll · pinch · Ctrl + / -'],
      ['Zoom to fit', 'Ctrl + 1'],
      ['Reset zoom', 'Ctrl + 0'],
      ['Cancel a gesture', 'Esc'],
      ['Toggle the settings panel', 'Ctrl + Shift + U'],
    ],
  },
  {
    title: 'Selection',
    rows: [
      ['Select everything', 'Ctrl + A'],
      ['Add to selection', 'Shift + click'],
      ['Move', 'Drag'],
      ['Constrain movement', 'Shift + drag'],
      ['Scale', 'Drag a corner handle (Shift = keep aspect)'],
      ['Rotate', 'Drag the handle above the box (Shift = 15° steps)'],
      ['Nudge', 'Arrow keys (Shift = 10 px)'],
      ['Duplicate', 'Ctrl + D or F2'],
      ['Delete', 'Delete / Backspace'],
    ],
  },
  {
    title: 'Stacking',
    rows: [
      ['Bring forward', 'Ctrl + ]'],
      ['Send backward', 'Ctrl + ['],
      ['Bring to front', 'Ctrl + Shift + ↑'],
      ['Send to back', 'Ctrl + Shift + ↓'],
    ],
  },
  {
    title: 'Files',
    rows: [
      ['Save board (.wbd)', 'Ctrl + S'],
      ['Open a board', 'Ctrl + O'],
      ['Export PNG / SVG', 'Ctrl + E'],
      ['New board', 'Ctrl + N'],
      ['Paste an image', 'Ctrl + V'],
    ],
  },
]

export function helpOverlay(host: HTMLElement, toolStore: ToolStore, onClose: () => void) {
  const overlay = el('div', { class: 'modal-overlay help' })
  const toolRows: [string, string][] = toolStore.all
    .filter((t) => !t.hidden)
    .map((t) => [t.name, t.shortcut || '—'])

  const card = el('div', { class: 'modal help-card' }, [
    el('div', { class: 'help-head' }, [
      el('h3', { text: 'Keyboard' }),
      button('', onClose, { icon: 'close', class: 'btn btn-icon sm', title: 'Close' }),
    ]),
    el('div', { class: 'help-grid' }, [
      ...GROUPS.map((g) =>
        el('div', { class: 'help-col' }, [
          el('h4', { text: g.title }),
          el(
            'table',
            { class: 'help-table' },
            g.rows.map(([a, b]) =>
              el('tr', {}, [el('td', { text: a }), el('td', { class: 'keys', text: b })]),
            ),
          ),
        ]),
      ),
      el('div', { class: 'help-col' }, [
        el('h4', { text: 'Tools' }),
        el('p', { class: 'hint', text: 'Every shortcut is rebindable in the Tool setup panel.' }),
        el(
          'table',
          { class: 'help-table' },
          toolRows.map(([a, b]) => el('tr', {}, [el('td', { text: a }), el('td', { class: 'keys', text: b })])),
        ),
      ]),
    ]),
    el('div', { class: 'help-foot' }, [
      svgIcon('help', 16),
      el('span', {
        text: 'Tip: with a stylus, every freehand tool responds to pressure. Set it per tool in Tool setup → Stroke dynamics.',
      }),
    ]),
  ])
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) onClose()
  })
  overlay.append(card)
  host.append(overlay)
}
