import type { DocumentState, ViewState } from '../core/types'
import { DOC_VERSION } from '../core/store'
import { downloadBlob, slugify } from '../core/geometry'

const DB_NAME = 'adi-draw'
const DB_VERSION = 1
const STORE = 'boards'
const AUTOSAVE_KEY = '__autosave__'

let dbp: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbp) return dbp
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbp
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const req = fn(t.objectStore(STORE))
    req.onsuccess = () => resolve(req.result as T)
    req.onerror = () => reject(req.error)
  })
}

export interface BoardFile {
  app: 'adi-draw'
  version: number
  savedAt: string
  doc: DocumentState
  view?: ViewState
}

export function serialise(doc: DocumentState, view?: ViewState): BoardFile {
  return {
    app: 'adi-draw',
    version: DOC_VERSION,
    savedAt: new Date().toISOString(),
    doc,
    view,
  }
}

export function parseBoard(text: string): { doc: DocumentState; view?: ViewState } {
  const data = JSON.parse(text)
  if (!data || (data.app !== 'adi-draw' && data.app !== 'inkboard') || !data.doc)
    throw new Error('Not an Adi Draw file.')
  if (data.doc.version > DOC_VERSION) throw new Error('This file was made by a newer version of Adi Draw.')
  return { doc: data.doc as DocumentState, view: data.view as ViewState | undefined }
}

/* ------------------------------ autosave -------------------------- */

let timer = 0

export function scheduleAutosave(get: () => BoardFile, delay = 1200) {
  clearTimeout(timer)
  timer = window.setTimeout(() => {
    void saveBoard(AUTOSAVE_KEY, get()).catch(() => undefined)
  }, delay)
}

export const autosaveKey = AUTOSAVE_KEY

export async function saveBoard(key: string, value: BoardFile) {
  await tx('readwrite', (s) => s.put(value, key))
}

export async function loadBoard(key: string): Promise<BoardFile | null> {
  try {
    const v = await tx<BoardFile | undefined>('readonly', (s) => s.get(key))
    return v ?? null
  } catch {
    return null
  }
}

export async function listBoards(): Promise<{ key: string; title: string; savedAt: string; count: number }[]> {
  try {
    const keys = await tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys())
    const out: { key: string; title: string; savedAt: string; count: number }[] = []
    for (const k of keys) {
      const key = String(k)
      if (key === AUTOSAVE_KEY) continue
      const v = await loadBoard(key)
      if (!v) continue
      out.push({
        key,
        title: v.doc?.meta?.title ?? key,
        savedAt: v.savedAt,
        count: Object.values(v.doc?.elements ?? {}).reduce((n, a) => n + a.length, 0),
      })
    }
    return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  } catch {
    return []
  }
}

export async function deleteBoard(key: string) {
  await tx('readwrite', (s) => s.delete(key))
}

/* ------------------------------- files ---------------------------- */

export function saveToDisk(doc: DocumentState) {
  const name = `${slugify(doc.meta.title)}.wbd`
  const blob = new Blob([JSON.stringify(serialise(doc), null, 2)], { type: 'application/json' })
  downloadBlob(blob, name)
  return name
}

export function openFromDisk(): Promise<{ doc: DocumentState; name: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.wbd,application/json'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      const reader = new FileReader()
      reader.onload = () => {
        try {
          const { doc } = parseBoard(String(reader.result))
          doc.meta.title = doc.meta.title || file.name.replace(/\.wbd$/, '')
          resolve({ doc, name: file.name })
        } catch (err) {
          window.alert(`Could not open this file.\n\n${(err as Error).message}`)
          resolve(null)
        }
      }
      reader.readAsText(file)
    }
    input.click()
  })
}
