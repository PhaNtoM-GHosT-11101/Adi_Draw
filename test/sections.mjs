/**
 * Sections and sub-sections.
 *
 * Membership is derived from geometry rather than stored, so these checks are
 * mostly about the two things that make that safe: nesting has to pick the
 * *innermost* container (not the first or the biggest), and folding a parent
 * has to hide what its sub-sections hold too, not just its own children.
 */
import { createServer } from 'vite'

const server = await createServer({ server: { port: 5424, strictPort: true }, logLevel: 'error' })
const { buildSectionTree, ancestorsOf, sectionDepth, membersOf, hiddenByCollapse, parentForNewSection, sectionContains, isSection } =
  await server.ssrLoadModule('/src/core/sections.ts')

let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) {
    pass++
    console.log('PASS ', name)
  } else {
    fail++
    console.log('FAIL ', name, extra)
  }
}

let n = 0
const section = (x, y, w, h, extra = {}) => ({
  id: `s${++n}`,
  kind: 'section',
  layerId: 'L1',
  opacity: 1,
  created: 0,
  x, y, w, h,
  title: '',
  accent: '#2563eb',
  collapsed: false,
  parentId: null,
  ...extra,
})
const note = (x, y, w = 100, h = 80) => ({
  id: `n${++n}`,
  kind: 'note',
  layerId: 'L1',
  opacity: 1,
  created: 0,
  x, y, w, h,
  color: '#fde68a',
  text: 'x',
  style: { fontSize: 14, color: '#111', fontFamily: 'Inter', fontWeight: 400, align: 'left', lineHeight: 1.3 },
})

/* ------------------------------ recognition ------------------------------ */

check('a section is recognised', isSection(section(0, 0, 10, 10)))
check('a note is not', !isSection(note(0, 0)))

/* -------------------------------- nesting -------------------------------- */

const outer = section(0, 0, 600, 400, { title: 'Outer' })
const middle = section(100, 100, 300, 200, { title: 'Middle' })
const inner = section(140, 140, 100, 60, { title: 'Inner' })

let tree = buildSectionTree([outer, middle, inner])
check('a section inside one section is its child', tree.get(middle.id) === outer.id)
check('a doubly nested section takes the innermost parent, not the outer one', tree.get(inner.id) === middle.id, `got ${tree.get(inner.id)}`)
check('a top-level section has no parent', tree.get(outer.id) === null)

check('ancestors read outermost first', ancestorsOf(inner.id, tree).join() === `${outer.id},${middle.id}`, ancestorsOf(inner.id, tree).join())
check('depth counts the chain', sectionDepth(inner.id, tree) === 2)
check('depth of a top-level section is zero', sectionDepth(outer.id, tree) === 0)

/* Disjoint sections must not become related. */
const far = section(900, 900, 200, 200)
tree = buildSectionTree([outer, far])
check('sections that do not overlap stay unrelated', tree.get(far.id) === null && tree.get(outer.id) === null)

/* Identical rectangles: containment must not let a section parent itself. */
const twin = section(0, 0, 100, 100)
const twinTree = buildSectionTree([twin, section(0, 0, 100, 100)])
check('no section is its own parent', [...twinTree.values()].filter((v) => v === twin.id).length === 0, JSON.stringify([...twinTree]))

/* ------------------------------- membership ------------------------------ */

const heldByOuter = note(500, 350, 40, 40) // centre (520,370): inside outer, outside middle
const heldByInner = note(160, 160, 40, 40)
const outside = note(1000, 1000, 40, 40)
const all = [outer, middle, inner, heldByOuter, heldByInner, outside]

const midIds = membersOf(middle, all, [outer, middle, inner]).map((e) => e.id)
check('a section collects the objects inside it', midIds.includes(heldByInner.id), midIds.join())
// heldByOuter sits inside outer but outside middle, so it must not be claimed
check('but not one that merely shares a parent', !midIds.includes(heldByOuter.id), midIds.join())
check('and leaves the ones outside alone', !midIds.includes(outside.id))
check('a sub-section counts as a member of its parent', midIds.includes(inner.id))
check('a section never counts itself', !midIds.includes(middle.id))

const outerIds = membersOf(outer, all, [outer, middle, inner]).map((e) => e.id)
check('a parent collects everything its sub-section holds', outerIds.includes(heldByInner.id), outerIds.join())
check('and the objects that are only its own', outerIds.includes(heldByOuter.id), outerIds.join())

/* Containment uses the centre, so a big object merely overhanging is not in. */
const overhanging = note(-140, 180, 300, 40) // centre x = 10, inside; but left edge is outside
const straddle = note(-500, 180, 200, 40) // centre x = -400, outside
check('an object that overhangs but centres inside counts as inside', membersOf(outer, [straddle, overhanging], [outer]).some((e) => e.id === overhanging.id))
check('an object centred outside is not in, even if it touches', !membersOf(outer, [straddle], [outer]).some((e) => e.id === straddle.id))

/* -------------------------------- folding -------------------------------- */

const secs = [outer, middle, inner]
check('nothing is hidden while everything is open', !hiddenByCollapse(heldByInner, secs))
check('folding a parent hides what its sub-section holds', hiddenByCollapse(heldByInner, [outer, middle, { ...inner }].map((s) => (s === outer ? { ...s, collapsed: true } : s))))
check('folding the middle hides the inner note', hiddenByCollapse(heldByInner, [outer, { ...middle, collapsed: true }, inner]))
check('folding a section never hides the section itself', !hiddenByCollapse({ ...outer, collapsed: true }, [{ ...outer, collapsed: true }]))
check('folding does not hide objects outside', !hiddenByCollapse(outside, [{ ...outer, collapsed: true }]))

/* ------------------------------ new sections ----------------------------- */

/* The element being created is already in the document while it is dragged,
   and it trivially contains its own centre — so it must not adopt itself. */
const fresh = section(0, 0, 100, 100)
check('a new section does not become its own parent', parentForNewSection(fresh, [fresh]) === null)
check('a new section drawn inside one is filed under it', parentForNewSection(section(120, 120, 50, 50), [outer]) === outer.id)
check('and under the innermost one', parentForNewSection(section(150, 150, 20, 20), [outer, middle]) === middle.id)
check('a new section drawn outside stays top-level', parentForNewSection(section(900, 900, 50, 50), [outer, middle]) === null)

/* -------------------------------- helpers -------------------------------- */

const child = section(150, 150, 20, 20)
check('sectionContains tests a child box', sectionContains(outer, child))
check('sectionContains rejects an outside box', !sectionContains(outer, section(900, 900, 20, 20)))

await server.close()
console.log(`\n${pass}/${pass + fail} checks passed`)
process.exit(fail ? 1 : 0)
