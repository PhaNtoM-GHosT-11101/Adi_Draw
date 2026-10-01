import type { Tool, ToolCategory } from './types'
import { defaultTools, makeTool, ICONS } from './tools'
import { uid } from './geometry'

const STORAGE_KEY = 'adi-draw.tools.v1'

export interface AppSettings {
  palmRejection: boolean
  autosave: boolean
  showStatus: boolean
  theme: 'light' | 'dark' | 'auto'
  snapToGrid: boolean
  /** device-pixel budget: 1 = fastest, 3 = sharpest */
  quality: 'performance' | 'balanced' | 'quality'
  /** show the floating quick-settings bubble next to the cursor */
  quickSettings: boolean
  /** length of the undo history */
  history: number
}

export const defaultSettings = (): AppSettings => ({
  palmRejection: true,
  autosave: true,
  showStatus: true,
  theme: 'auto',
  snapToGrid: false,
  quality: 'balanced',
  quickSettings: true,
  history: 500,
})

/**
 * Owns the tool collection (presets) plus app-level settings, and persists
 * both. Every tool is fully user-editable and new presets can be created.
 */
export class ToolStore {
  tools: Tool[]
  activeId = 'pencil'
  settings: AppSettings
  private listeners = new Set<() => void>()

  constructor() {
    const loaded = loadJson<{ tools: Tool[]; activeId: string; settings: AppSettings }>(STORAGE_KEY)
    if (loaded?.tools?.length) {
      this.tools = mergeWithDefaults(loaded.tools)
      this.activeId = loaded.activeId && this.tools.some((t) => t.id === loaded.activeId) ? loaded.activeId : this.tools[0].id
      this.settings = { ...defaultSettings(), ...(loaded.settings ?? {}) }
    } else {
      this.tools = defaultTools()
      this.activeId = 'pencil'
      this.settings = defaultSettings()
    }
    if (!this.tools.some((t) => t.id === this.activeId)) this.activeId = this.tools[0].id
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  private emit() {
    this.listeners.forEach((fn) => fn())
  }

  save() {
    writeJson(STORAGE_KEY, { tools: this.tools, activeId: this.activeId, settings: this.settings })
  }

  /* ------------------------------ tools --------------------------- */

  get all() {
    return this.tools
  }
  get visible() {
    return this.tools.filter((t) => !t.hidden)
  }
  get byCategory() {
    const map = new Map<ToolCategory, Tool[]>()
    for (const t of this.visible) {
      let arr = map.get(t.category)
      if (!arr) map.set(t.category, (arr = []))
      arr.push(t)
    }
    return map
  }
  get active(): Tool {
    return this.tools.find((t) => t.id === this.activeId) ?? this.tools[0]
  }
  get(id: string) {
    return this.tools.find((t) => t.id === id)
  }
  findByShortcut(key: string): Tool | undefined {
    return this.tools.find(
      (t) => !!t.shortcut && normalizeShortcut(t.shortcut) === normalizeShortcut(key),
    )
  }

  setActive(id: string) {
    if (!this.get(id)) return
    this.activeId = id
    this.save()
    this.emit()
  }

  update(id: string, patch: Partial<Tool>, opts: { save?: boolean } = {}) {
    const i = this.tools.findIndex((t) => t.id === id)
    if (i < 0) return
    this.tools[i] = { ...this.tools[i], ...patch }
    if (opts.save !== false) this.save()
    this.emit()
  }

  /** Push a style change onto every tool of the same category. */
  updateCategoryStyle(category: ToolCategory, patch: Partial<Tool>) {
    for (let i = 0; i < this.tools.length; i++) {
      if (this.tools[i].category === category) this.tools[i] = { ...this.tools[i], ...patch }
    }
    this.save()
    this.emit()
  }

  create(from?: Tool, overrides: Partial<Tool> = {}): Tool {
    const base = from ? structuredClone(from) : makeTool({ id: '', name: '', category: 'freehand', icon: ICONS.pencil })
    const tool: Tool = {
      ...base,
      ...overrides,
      id: uid('t'),
      name: overrides.name ?? uniqueName(`${base.name} copy`, this.tools),
      shortcut: overrides.shortcut ?? '',
    }
    this.tools.push(tool)
    this.save()
    this.emit()
    return tool
  }

  duplicate(id: string) {
    const src = this.get(id)
    if (!src) return
    const copy = this.create(src)
    this.setActive(copy.id)
    return copy
  }

  remove(id: string) {
    const i = this.tools.findIndex((t) => t.id === id)
    if (i < 0) return
    this.tools.splice(i, 1)
    if (this.activeId === id) this.activeId = this.tools[0]?.id ?? ''
    this.save()
    this.emit()
  }

  reset() {
    this.tools = defaultTools()
    this.activeId = 'pencil'
    this.save()
    this.emit()
  }

  reorder(ids: string[]) {
    const map = new Map(this.tools.map((t) => [t.id, t]))
    const next: Tool[] = []
    for (const id of ids) {
      const t = map.get(id)
      if (t) {
        next.push(t)
        map.delete(id)
      }
    }
    for (const t of this.tools) if (map.has(t.id)) next.push(t)
    this.tools = next
    this.save()
    this.emit()
  }

  /* ---------------------------- settings -------------------------- */

  patchSettings(patch: Partial<AppSettings>) {
    this.settings = { ...this.settings, ...patch }
    this.save()
    this.emit()
  }
}

export function normalizeShortcut(s: string) {
  return s
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join('+')
}

function uniqueName(base: string, tools: Tool[]) {
  let name = base
  let n = 2
  while (tools.some((t) => t.name === name)) name = `${base} ${n++}`
  return name
}

/** Keep user customisation but pick up new fields added in later versions. */
function mergeWithDefaults(saved: Tool[]): Tool[] {
  const base = defaultTools()
  const byId = new Map(saved.map((t) => [t.id, t]))
  const out: Tool[] = []
  for (const b of base) {
    const s = byId.get(b.id)
    if (s) out.push({ ...b, ...migrate(s), id: b.id, category: b.category })
  }
  for (const s of saved) if (!base.some((b) => b.id === s.id)) out.push({ ...makeTool(s), ...migrate(s) })
  return out
}

/** Older presets stored a single "stabilizer" value; split it sensibly. */
function migrate(t: Tool): Tool {
  const legacy = t as Tool & { stabilizer?: number }
  if (legacy.stabilizer === undefined) return t
  const { stabilizer, ...rest } = legacy
  return {
    ...rest,
    response: t.response ?? Math.min(1, stabilizer * 1.6),
    smoothing: t.smoothing ?? stabilizer,
  }
}

/* ----------------------------- storage ----------------------------- */

export function loadJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

export function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* quota exceeded — settings simply won't persist */
  }
}

export function removeKey(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}
