# Wireframe check, clean-up and client confirmation

Imported wireframes rarely arrive as the clean line model detailing needs.
A 3D DXF typically has every member drawn as a polyline with extra vertices,
so it imports as many short pieces. Transoms stop a few millimetres short of
the mullion or sit slightly off its plane, and lines cross without a node.
The wireframe check turns that into **whole lines that are cut only where
mullions and transoms meet**. It sets the member roles, lists everything else
for review, and records the **client's confirmation** against a fingerprint of
the result.

| Part | File |
| --- | --- |
| Analysis (pure, no DOM) | `src/core/wireframe/analyze.ts` |
| Apply (inside `store.apply`, one undo step) | `src/core/wireframe/apply.ts` |
| Fingerprint, status, approvals | `src/core/wireframe/record.ts` |
| Actions (scope, apply, confirm) | `src/ui/wireframeActions.ts` |
| Dialog, status chip, 3D preview | `src/ui/dialogs/WireframeDialog.tsx`, `src/viewer/Viewer.ts` (`setWireOverlay`) |
| DXF import (whole lines, split mode) | `src/core/io/wireframeJoin.ts`, `src/core/io/dxfImport.ts` |
| Assistant tools | `src/assistant/modules/wireframe.ts` |
| Tests | `tests/wireframeCheck.test.ts` |

## 1. Where to find it

- **Manage → Wireframe check…** checks the whole model.
- **The status chip** next to the project name (*Wireframe not verified* /
  *✓ Wireframe verified* / *! Wireframe changed*) opens the check. It is hidden
  while the model is empty.
- **DXF import.** After a wireframe import the check opens by itself, scoped
  to the imported lines.
- **Issue drawings** shows a reminder with a link when the wireframe is not
  verified or has changed since it was confirmed.
- **Assistant:** `wireframe_check`, `wireframe_apply` and `wireframe_status` (§9).

## 2. Lines

A *line* is a chain of member pieces that continues straight through nodes.
Two pieces are paired at a node when they leave it in opposite directions
within 1°. Other members at the node do not matter, so a mullion keeps running
through a node where a transom ends. The chain must also stay within 1 mm of
its chord (Douglas–Peucker; a chain that bends more is cut where it bends most).
Members inside and outside the scope are never paired with each other.

Every analysis works on lines, so the result is the same whether the input
has one member per line, a piece between every vertex, or pieces split at
every node.

## 3. Junctions

A uniform grid (cell ≈ mean line length, never below 2 × near-miss) is the
broad phase for every pair test, so the cost stays close to linear.

**T-junctions.** A line end meets line *M* when one of these holds:
- the end lies within the **junction tolerance** (default 10 mm) of *M*'s span;
- the end's own axis, **extended or trimmed by up to 50 mm** (*Extend / trim ends
  up to*), meets *M*'s axis with a 3D gap of at most the junction tolerance.

The junction point *q* is where the axes meet, on *M*'s axis. If *M*'s own
ends are snapped elsewhere in the same check, *q* is taken on *M*'s moved
axis. A trim never passes the next node of the ending line. Collinear
continuations are not T-junctions.

Typical cases:
- Transoms that stop 15–25 mm short of a mullion axis, 0–10 mm off its plane:
  extended onto the axis.
- An end lying beside a mullion within 10 mm: snapped onto it.

**One node per junction.** The ends that meet *M* within the tolerance of each
other along *M* (left and right transoms at one mullion, for example) become
one node. The node is chosen in this order:
1. an existing node of *M* (preferring one with a connection);
2. an end node that carries a connection;
3. the end nearest to its junction point.

That node moves to *q*; the other ends merge into it. An end that carries its
own connection is never merged away; it is listed for review instead.

**Crossings.** Two spans that cross within the tolerance, both more than the
tolerance from their ends, form an X-junction. It gets a node: one already
there, a nearby junction node, or a new one. The new node goes on the line
that stays continuous, so it is a through-node there; when both lines are
cut it goes midway between the axes.

**End joins.** These become one node:
- two line ends within 1.5 × the tolerance of each other;
- two ends whose axes meet near both ends (a corner where both stop short).
  These are moved to where the axes meet.

**Collinear gaps.** A line end that faces the end of a collinear line beyond
the tolerance is a gap, for example a stack or movement joint between mullion
lengths. Gaps are listed once and never closed.

## 4. Roles (topology first)

1. **Isolated:** the line touches nothing at either end, nothing lands on it,
   nothing crosses it, there is no near-miss, and no connection uses it. It
   gets the role *other*.
2. **Families.** At a T-junction or a crossing the two lines belong to
   different families (mullions vs transoms). Junctions where the lines meet
   at more than 35° are weighted by sin(angle). The lines are 2-coloured along
   a **maximum spanning forest**, built with Kruskal's algorithm on a parity
   union-find, strongest junctions first. A few inconsistent junctions (a
   mullion meeting a mullion at a kink, a brace) therefore cannot flip a whole
   region. Shallow junctions (< 35°) do not vote.
3. **Which family is the mullions,** per connected group, in this order:
   1. roles already set in the group (mullion / post vs transom / rail);
   2. the family that **receives** the line ends (T-junction main), when it has
      at least 1.5 × the other family's count;
   3. otherwise the **steeper** family, when the mean angles from horizontal
      differ by 10° or more;
   4. otherwise more received ends;
   5. otherwise the longer lines.
4. **Per line:** the family role. Exceptions:
   - A line whose own junctions mostly disagree with its colour falls back to
     direction: ≥ 45° from horizontal = mullion.
   - A line that meets others only at its ends or at shallow angles also falls
     back to direction.
5. **Brackets:** a line of at most 600 mm (*Brackets up to*) with one end on a
   mullion and the other end free, which receives nothing and crosses nothing.
6. **Roles already set** (anything but *other*) are kept, unless *Re-assign
   roles already set* is ticked. Lines outside the scope keep their roles and
   seed the families.

Every line gets a reason, shown in the *Roles* list. For example: *"receives 8
line ends on its span; 61° from horizontal"*, or *"2 ends land on another line
(gap up to 3.5 mm); 10° from horizontal"*.

This is why a sloped or V-shaped facade, where no member is vertical, is
classified correctly. Direction alone ("vertical = mullion") would fail on it,
and the check never needs it when junctions exist.

## 5. Cuts and merges

| Junction | Main line (receives / continuous) | Other line |
| --- | --- | --- |
| Transom ends on a mullion | cut if *Cut mullions at transoms* (default); otherwise continuous, the transom end becomes a through-node | end snapped onto the mullion axis |
| Mullion ends on a transom (edge member) | transom cut | end snapped |
| Mullion × transom crossing mid-span | transom cut; mullion cut if the rule is on | — |
| Any other pair (transom on transom, bracket on mullion …) | not cut; the end is snapped (through-node) | — |
| Two lines of one family crossing | not cut; listed for review | — |

A cut is skipped and listed for review when it would leave a piece shorter
than the minimum length (default 20 mm) at the line end or next to the
previous cut.

**Unnecessary splits.** Every other node inside a line is merged away
(*Remove unnecessary splits*), except where:
- a **connection** sits on it;
- a junction above needs the cut;
- a member that is not explained by a junction ends there;
- the two pieces differ. Compared: profile, material, finish, rotation, position
  on the line, phase / zone / batch, manual mark, an end preparation or
  extension at the joint, and roles that are both set and different. These
  are listed as *property conflicts* and are not merged.

## 6. Issues for review

| Issue | Default | Action |
| --- | --- | --- |
| Isolated line | ticked when it has no profile | make a construction line (no profile) or delete (setting *Isolated lines*); already a construction line → listed only |
| Duplicate (lies on another collinear line) | ticked unless it carries a connection or has a different profile | delete the shorter |
| Very short line (< 20 mm) | not ticked | delete a stub with a free end; otherwise delete it and join its ends (not when both ends carry connections) |
| Near-miss (end 10–100 mm from a line, or its axis would need more than 50 mm of extension) | review only | — never auto-joined; raise the tolerance or extend the line |
| Dangling transom end (nothing within 100 mm) | review only | — free mullion ends are normal (they sit on the structure) |
| Partial collinear overlap | review only | — |
| Crossing without a junction | review only | — |
| Junction too close to an end or cut | review only | — |
| End shared with lines outside the scope / carrying its own connection | review only | — |
| Collinear gaps (stack joints) | review only | — |

## 7. Applying

`applyWireframePlan(project, plan, acceptedIds)` runs inside `store.apply`, so
the whole check is one undo step. It refuses a plan made for a different model
state (fingerprint mismatch). The steps:

1. Isolated, duplicate and short-line actions. Then node moves (snaps,
   corners) and node merges (junction clusters, joins, collapses) through a
   union-find. Connections follow their node.
2. Each line is rebuilt from its kept nodes and the new cut points.
   - In each final piece, the longest original piece keeps its id and all its
     properties (profile, role, phase, manual mark …).
   - A piece split in two copies the original's properties.
   - Extensions and end preparations stay at the ends where they were; new cut
     ends are square with no extension.
3. Roles of the accepted role items are set on every piece of the line.
4. **References are re-pointed** to the piece that now sits at their node:
   - connection `main` / `secondary`;
   - end-preparation `to`;
   - welded free plates.

   At a node where a piece was cut in two, the piece that continues upwards is
   chosen, as Auto-connect chooses a main member.
5. Absorbed pieces and orphan nodes are removed. **A node that carries a
   connection is never removed.**

A second check right after applying finds nothing left to change. The tests
assert this for the synthetic facade.

## 8. Client confirmation and the fingerprint

`Project.wireframe = { approvals, settings }`:
- `approvals[]` holds `{ date, by, note?, fingerprint, summary, changes }`;
- `settings` holds the rules above.

`migrateProject` fills both for older files.

**Fingerprint** (`wireframeFingerprint`): cyrb128 over
- every node position rounded to 0.1 mm;
- every member as its two rounded end points (sorted) plus role and profile.

Each list is sorted. It does not depend on ids or order, so undo, redo, save
and load give the same value.

**Status:**

| Status | Meaning |
| --- | --- |
| verified | the fingerprint equals the last approval's |
| changed since verification | any node moved more than about 0.05 mm, any line added, removed, split or merged, any role or profile changed since |
| not verified | no approval yet |

Changes to connections, materials, finishes, phases or drawings do not change
the status.

**Buttons:**
- **Apply and confirm** needs *Confirmed by* (the person or company that
  confirmed, for example the client's facade engineer) and takes an optional
  note (drawing revision, meeting, e-mail). It applies the ticked changes and
  records the approval of the result, in one undo step.
- **Apply without confirming** applies and leaves the status *not verified* /
  *changed*.
- **Confirm as is** records an approval of the current model with no changes.

The approval is a record in the project file with a typed name. It is not an
electronic signature.

## 9. Assistant

| Tool | What it does |
| --- | --- |
| `wireframe_check` | Analyse; returns counts before/after, groups, the first issues and changes (with item ids), settings and status. `open: true` opens the dialog. Changes nothing. |
| `wireframe_apply` | Apply the default-ticked items of `groups` (default all), plus `include` / minus `exclude` item ids. Records a confirmation **only** with `confirm: true` and `confirmedBy`; `groups: []` + confirm = confirm as is. |
| `wireframe_status` | Status, last confirmations, settings. |

All three accept the scope (`all`, `selection`, `last_import`, or member `ids`)
and the settings below.

## 10. Settings (stored with the project)

| Setting | Default | Meaning |
| --- | --- | --- |
| Junction tolerance | 10 mm | 3D gap between axes that still counts as meeting; also the cluster size of junction points along a line |
| Extend / trim ends up to | 50 mm | how far a line end may be extended or trimmed along its own axis to reach a junction |
| At mullion–transom junctions | Cut mullions at transoms | or *Keep mullions continuous* (transom ends become through-nodes) |
| Flag lines shorter than | 20 mm | very short lines; also the shortest piece a cut may leave |
| Near-miss up to | 100 mm | ends this close (beyond the tolerance) are flagged |
| Brackets up to | 600 mm | longest line classified as a bracket |
| Isolated lines | Make construction lines | or delete |
| Re-assign roles already set | off | roles other than *other* are kept |

**Scope:** whole model, the selection when the check opened, or the last
import. Lines outside the scope are context: junctions onto them are found and
their roles seed the families, but they are **never changed**. An imported
transom ending on an existing mullion is snapped, but the mullion is not cut.

## 11. DXF import

The import dialog now:
- merges collinear polyline pieces into whole lines (default on): a node where
  exactly two pieces of one layer continue straight is dropped, and model
  nodes never are;
- offers three split modes:
  - **Mullion–transom junctions only** (default): nothing is split on import,
    and the check opens next, scoped to the imported lines;
  - **Every crossing**: the previous behaviour;
  - **None**.

## 12. Performance

The analysis is close to linear (grid broad phase, union-find, no pairwise
loops over the model). Measured in the test suite (Node, one thread) on a
fragmented flat facade: 151 mullions drawn as 4 pieces each, 21,000 transoms
stopping 12 mm short. That is 21,604 members and 21,140 junction points.
- Analysis: about 1.7 s.
- Apply: about 0.7 s.

A 1,100-piece 3D facade checks in under 0.1 s in the browser.

## 13. Limits

- Lines are straight. Arcs imported as chords stay as chords. Each chord meets
  its neighbours at a small angle, so it is neither merged nor used for
  families.
- **Role classification needs junctions.** Lines that meet only at their ends
  or at shallow angles fall back to direction (45° from horizontal). Braces
  crossing a grid can end up in either family; set their role first (it is
  kept) or untick their role items.
- **Snapping moves the ending line's end node,** not the main line. A main line
  whose own end is snapped elsewhere is followed one level deep. Deeper chains
  can leave sub-millimetre offsets; they are below the 0.5 mm node tolerance
  and are not proposed again.
- **Partial overlaps, near-misses and crossings of one family are flagged,
  never fixed.** Collinear gaps (stack joints) are never closed.
- **With *Cut mullions at transoms*,** every transom node is a mullion end.
  Auto-connect treats ends of **vertical** mullions as stack joints and would
  place slab brackets there. On vertical facades, untick *Slab brackets* in
  Auto-connect, or use *Keep mullions continuous*. Sloped mullions are not
  vertical (more than 5.7° from plumb), so they get no automatic slab brackets.
- **The fingerprint does not cover connections, materials or finishes.** Moves
  below about 0.05 mm may not change it (0.1 mm rounding).
- **The analysis runs synchronously** when a rule changes: about 2 s on 20k
  lines.
