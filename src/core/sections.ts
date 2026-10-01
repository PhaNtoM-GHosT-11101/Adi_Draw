/**
 * Sections and sub-sections.
 *
 * A section is a titled region on the board that gathers whatever falls inside
 * it, the way a OneNote section gathers notes. Nothing has to be filed into one
 * explicitly: membership is decided by geometry, so dragging a sticky note
 * into a section files it, and dragging it back out unfiles it.
 *
 * Two rules keep that from being surprising:
 *
 *  - Membership uses the element's **centre**, not its edges. An object that
 *    merely overhangs a section has not joined it, which matches what the user
 *    sees when they drop something in.
 *
 *  - Sub-sections are sections *inside* sections. A section whose own centre
 *    lands inside another one becomes its child, and nesting follows the
 *    geometry, so there is no separate "make sub-section" mode to get wrong.
 *
 * Containment is derived on demand rather than stored, which means it can never
 * disagree with where things actually are.
 */

import type { AnyElement, SectionElement } from './types'
import { elementBBox } from './store'

/** Height of a section's title band, in world units at 100% zoom. */
export const SECTION_HEADER = 34
/** A section needs at least this much room to be worth having. */
export const SECTION_MIN = 96

export function isSection(el: AnyElement): el is SectionElement {
  return el.kind === 'section'
}

/** Centre of an element's box. */
function centre(el: AnyElement): { x: number; y: number } {
  const b = elementBBox(el)
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 }
}

/** True when `box` (a section's rect) contains the point. */
function contains(box: SectionElement, x: number, y: number): boolean {
  return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h
}

/** True when `child`'s body sits inside `parent`, ignoring the title band. */
export function sectionContains(parent: SectionElement, child: SectionElement): boolean {
  return contains(parent, centre(child).x, centre(child).y)
}

/**
 * Assign every section to the innermost section that contains it.
 *
 * Returns a map of section id to parent id (or null for a top-level section).
 * A section is never its own parent, and a cycle cannot form because a parent
 * must strictly contain its child.
 */
export function buildSectionTree(sections: SectionElement[]): Map<string, string | null> {
  const parent = new Map<string, string | null>()
  // Smallest first: the innermost container is the *first* match, not the
  // biggest one. Sorting the other way silently files every sub-section under
  // its outermost ancestor and flattens the whole tree.
  const sorted = [...sections].sort((a, b) => area(a) - area(b))
  for (const el of sections) parent.set(el.id, null)
  for (const child of sorted) {
    for (const candidate of sorted) {
      if (candidate.id === child.id) continue
      if (area(candidate) <= area(child)) continue
      if (!sectionContains(candidate, child)) continue
      parent.set(child.id, candidate.id)
      break
    }
  }
  return parent
}

function area(el: SectionElement): number {
  return Math.abs(el.w) * Math.abs(el.h)
}

/** Chain of ancestor ids for a section, outermost first. */
export function ancestorsOf(id: string, parent: Map<string, string | null>): string[] {
  const out: string[] = []
  const seen = new Set<string>([id])
  let at = parent.get(id) ?? null
  while (at && !seen.has(at)) {
    out.push(at)
    seen.add(at)
    at = parent.get(at) ?? null
  }
  return out.reverse()
}

/** Depth of a section, where a top-level section is 0. */
export function sectionDepth(id: string, parent: Map<string, string | null>): number {
  return ancestorsOf(id, parent).length
}

/**
 * True when a collapsed section hides this element — either because the element
 * sits inside it, or because it sits inside one of its descendants.
 *
 * Sections themselves are never hidden this way: a collapsed parent still shows
 * its own title band, with its children folded away.
 */
export function hiddenByCollapse(el: AnyElement, sections: SectionElement[]): boolean {
  if (isSection(el)) return false
  const parent = buildSectionTree(sections)
  const c = centre(el)
  for (const s of sections) {
    if (!s.collapsed) continue
    if (contains(s, c.x, c.y)) return true
    // anything inside one of its sub-sections is inside the parent too
    for (const childId of parent.keys()) {
      if (parent.get(childId) !== s.id) continue
      const child = sections.find((x) => x.id === childId)
      if (child && contains(child, c.x, c.y)) return true
    }
  }
  return false
}

/**
 * Everything a section owns: the plain elements sitting inside it, plus every
 * descendant section. Plain elements cannot nest, so one containment test
 * covers them all; sections need the parent chain walked because a sub-section
 * is inside its parent only in the sense that its parent contains it.
 */
export function membersOf(section: SectionElement, all: AnyElement[], sections: SectionElement[]): AnyElement[] {
  const parent = buildSectionTree(sections)

  const descendantSections = new Set<string>()
  for (const [child, up] of parent) {
    if (!up) continue
    if (up === section.id || ancestorsOf(child, parent).includes(section.id)) descendantSections.add(child)
  }

  const sc = centre(section)
  const out: AnyElement[] = []
  for (const el of all) {
    if (el.id === section.id) continue
    if (isSection(el)) {
      if (descendantSections.has(el.id)) out.push(el)
      continue
    }
    const c = centre(el)
    if (sc && c.x >= section.x && c.x <= section.x + section.w && c.y >= section.y && c.y <= section.y + section.h)
      out.push(el)
  }
  return out
}

/**
 * The section a newly created section should belong to: the smallest section
 * already on the board whose middle the new one lands in.
 */
export function parentForNewSection(created: SectionElement, sections: SectionElement[]): string | null {
  const c = centre(created)
  let best: SectionElement | null = null
  for (const s of sections) {
    // the section being created is already in the document while it is being
    // dragged, and it trivially contains its own centre
    if (s.id === created.id) continue
    if (!contains(s, c.x, c.y)) continue
    if (!best || area(s) < area(best)) best = s
  }
  return best ? best.id : null
}
