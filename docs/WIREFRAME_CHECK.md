# Wireframe check, clean-up and client confirmation

Imported wireframes rarely arrive as the clean line model detailing needs.
A 3D DXF typically has every member drawn as a polyline with extra vertices,
so it imports as many short pieces. Transoms stop a few millimetres short of
the mullion or sit slightly off its plane, and lines cross without a node.
The wireframe check turns that into **whole lines that are cut only where
mullions and transoms meet**. It sets the member roles, turns every profile
**perpendicular to the facade surface**, keeps the **stack joints**, lists
everything else for review, and records the **client's confirmation** against
a fingerprint of the result.

| Part | File |
| --- | --- |
| Analysis (pure, no DOM) | `src/core/wireframe/analyze.ts` |
| Apply (inside `store.apply`, one undo step) | `src/core/wireframe/apply.ts` |
| Fingerprint, status, approvals | `src/core/wireframe/record.ts` |
| Surfaces: patches, signs, exterior side, folds (pure) | `src/core/wireframe/surfaces.ts` |
| Orientation targets and items; standalone "Orient profiles to surface" | `src/core/wireframe/orient.ts`, `src/core/wireframe/orientModel.ts` |
| Member axes with a surface normal | `src/core/model/geometry.ts` (`axesFor`, `memberAxes`), [CONNECTION_GEOMETRY.md §3.1](CONNECTION_GEOMETRY.md) |
| Actions (scope, apply, confirm) | `src/ui/wireframeActions.ts`, `src/ui/surfaceActions.ts` |
| Dialog, status chip, 3D preview | `src/ui/dialogs/WireframeDialog.tsx`, `src/ui/dialogs/SurfacePanel.tsx`, `src/ui/dialogs/OrientDialog.tsx`, `src/viewer/Viewer.ts` (`setWireOverlay`) |
| DXF import (whole lines, split mode) | `src/core/io/wireframeJoin.ts`, `src/core/io/dxfImport.ts` |
| Assistant tools | `src/assistant/modules/wireframe.ts` |
| Tests | `tests/wireframeCheck.test.ts`, `tests/surfaceOrientation.test.ts` |

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
- **Orient profiles to surface** on its own (§5a): Manage menu, Members →
  *Orient* in the tool rail, *Section depth → Orient to surface…* in the member
  properties, or the assistant (`orient_to_surface`, `surface_info`). Whole
  model or the selection.

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
the tolerance (up to the near-miss distance) is a gap, for example a stack or
movement joint between mullion lengths. Gaps are never closed. A gap of the
**stack-joint size** (setting, default 10–60 mm) between two lines of one
family (mullion / post with mullion / post, transom / rail with transom / rail)
is a **stack joint**: it is listed once per pair in the informational group
*Stack joints (kept)*, with its size and zoom-to (the two facing pieces), and
marked teal in the 3D preview. Stack joints are not review issues; the
assistant reports them separately. Other gaps (another size, or between
different families) stay in *For review*. The two lengths of a stack joint
also tie the surfaces on both sides together (§5a).

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

## 5a. Orientation: profiles perpendicular to the surface

**Rule.** Profiles are always perpendicular to the facade surface: a member's
section depth (local z) is along the local surface normal and its width
(local y) lies in the surface, for mullions, transoms and every other member
in the surface. `Member.normal` stores the surface normal; local z is that
normal projected perpendicular to the member axis, and the member's rotation
applies on top ([CONNECTION_GEOMETRY.md §3.1](CONNECTION_GEOMETRY.md)). Without
a normal the old rule applies (section "up" = world Z, or +Y for vertical
members), which is right only for vertical facades: on a sloped, V-shaped or
curved facade it twists the transoms and some mullions against the surface.

**Surface detection** (`surfaces.ts`, on the check's lines and junctions):
1. **Junction normals.** Wherever two lines meet at 20°–160° (T-junctions,
   crossings, corners where both lines end, end joins), n = norm(d1 × d2).
   Pairs of one family (mullion with mullion, transom with transom) and
   brackets / outriggers do not define the surface there.
2. **Patches.** Along each line, junctions sorted by station whose normals are
   within 10° of each other are chained into one patch; patches spread through
   the lines they share (union-find). A smoothly curved facade stays one patch;
   a fold (the valley of a V, a building corner) separates two. The two
   lengths of a stack joint join their patches when their normals agree.
3. **Consistent sign.** Inside a patch a BFS flips each junction normal to agree
   with its neighbour. Between patches, at a line they share, each patch leaves
   the line on one side; an oriented surface crossing a fold has its two
   patches on opposite sides, which fixes their relative sign (else the sign
   of n_A·n_B). The relations are solved strongest first on a parity
   union-find, so one bad junction cannot flip a whole facade.
4. **Exterior side**, per connected facade, the first rule that decides:
   1. normals already set on its members (each patch keeps its side, so a
      flip is remembered);
   2. away from the centre of the loaded reference models (concrete, primary
      steel), when any are shown;
   3. away from the centre of all the facades, when they are curved, folded or
      wrap around it (a planar facade does not decide);
   4. upwards, when the facade is sloped;
   5. the side most section depths already point to (fewest changes);
   6. as found.

   The dialog says which rule decided. **Flip exterior side** reverses every
   member; each patch can be flipped on its own from the patch list.
5. **Normals per member.** A line in one patch takes the mean of its junction
   normals; each member piece the mean of the junctions on its span, so a
   warped surface is followed piece by piece. A **fold member** (in two
   patches) takes the **bisector** of the two patch normals, or follows patch
   A (the larger) or B — a setting, and per fold in the dialog.
6. **Brackets / outriggers** keep their axis; their depth runs along the line
   they are attached to (local z = the mullion axis projected perpendicular to
   the bracket), upwards.
7. **Members left as they are:** lines with no junction at 20°–160° (isolated
   lines, free stubs). The dialog lists them (*Show members left as is*).

**Proposals.** Group *Orientation (perpendicular to the surface)*: every line
in scope with a member whose current depth axis deviates from its target by
more than **2°**, with the largest deviation (a section facing the inside
shows as 180°). Accepted by default, except a line whose members only change
side (180°, the same solid for a symmetric section) and carry connections:
connection parameters such as *side* follow the local axes, so it is listed
unticked with a note. Applying sets `Member.normal` on every
final piece of the line (after merges and cuts) and resets the rotation to 0,
unless *Keep each member's rotation on top* is ticked. Role profiles given in
the same step do not bring their rotation back. Members within 2° are left
untouched.

**Dialog.** Above the group: the number of surface patches, fold members,
lines and members to turn and how far off they are, members left as is,
brackets, the exterior rule and *Flip exterior side*; the patch list (lines,
size, normal, curvature, flip, zoom) and the fold list (patches, angle,
bisector / follow A / follow B, zoom). The 3D preview draws the depth
direction as an arrow at member midpoints (every k-th member above 1,500),
in the patch colour (folds white, brackets orange); *Colour the preview by
surface patch* tints the lines (no surface: grey). Flips and fold choices
re-run only the orientation, not the analysis.

**Standalone.** *Orient profiles to surface* runs the same analysis on the
model as it is (nothing but the normals changes), shows the same panel and
preview, and applies the members to turn as one undo step. Scope: whole model
or the selection; the rest of the model still defines the surfaces.

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
| Collinear gaps outside the stack-joint range or between families | review only | — |
| Stack joints (10–60 mm, one family) | listed as kept (group *Stack joints*), not issues | — never closed |

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
   Accepted orientation items set the surface normal on every final piece of
   their line (per-piece normal from the junctions on its span).
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
- every member as its two rounded end points (sorted) plus role and profile;
- for a member with a surface normal, also the unit normal (rounded to 0.001)
  and its rotation. Members without a normal hash exactly as before, so
  confirmations recorded before orientation existed stay valid; orienting,
  flipping or rotating an oriented member counts as a change.

Each list is sorted. It does not depend on ids or order, so undo, redo, save
and load give the same value.

**Status:**

| Status | Meaning |
| --- | --- |
| verified | the fingerprint equals the last approval's |
| changed since verification | any node moved more than about 0.05 mm, any line added, removed, split or merged, any role or profile changed, any surface normal set or changed (or the rotation of an oriented member) since |
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
| `orient_to_surface` | Orient the profiles to the surface on the model as it is (scope `all` / `selection` / `ids`); `flip`, `flipPatches` (patch keys), `foldNormal`, `keepRotation`, `dryRun`. One undo step; returns the counts and the largest deviation left. |
| `surface_info` | Patches (key, normal, size, curvature), folds, exterior rule, lines / members off their normal and by how much, members left as is, brackets. Changes nothing. |

The first three accept the scope (`all`, `selection`, `last_import`, or member
`ids`) and the settings below; `wireframe_check` also returns `stackJoints`
(count, gap range) and `surfaces`.

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
| Stack joints from / to | 10 / 60 mm | collinear gaps of this size between lengths of one family are kept stack joints (§3) |
| Turn profiles perpendicular to the surface | on | the orientation group (§5a) |
| Fold members | Bisector | or follow the larger / smaller patch |
| Keep each member's rotation on top | off | off: oriented members get rotation 0 |

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

Orientation, on the same 21,151-member facade folded every ten bays (15
patches, 14 folds): analysis with surfaces 1.5 s, of which the surface
detection 0.2 s; setting the normals 0.1 s. The 459-line client facade (2
patches, 5 folds, 266 members turned): 0.1 s.

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
- **With *Cut mullions at transoms*,** every transom node is a mullion end,
  and a floor split with no transom is merged away. Auto-connect reads the
  result by role and topology ([CONNECTIONS.md "Auto-connect"](CONNECTIONS.md)):
  transom joints at every T-junction, splices at the kept stack joints, and
  mullion brackets at the reference structure or on bracket stubs. Its level
  brackets (vertical mullions only) go to chain ends and levels, never to a
  transom junction where a mullion was cut (earlier versions placed a slab
  bracket at every one of them). Sloped mullions get their brackets from the
  structure or from stubs.
- **The fingerprint does not cover connections, materials or finishes.** Moves
  below about 0.05 mm may not change it (0.1 mm rounding).
- **The analysis runs synchronously** when a rule changes: about 2 s on 20k
  lines.
- **Orientation needs junctions.** A member that meets nothing at 20°–160°
  keeps its orientation. A surface needs two families: a facade drawn with
  mullions only gets no normals.
- **The exterior side is a heuristic** (§5a); check it once in the preview and
  flip it if needed — the choice is then kept by the members' normals.
- **Patches are split at 10°.** A coarsely segmented arc with more than 10°
  between neighbouring facets becomes one patch per facet; the mullions
  between them are folds and get the bisector, which is the radial direction.
  End mullions of an open arc see one facet only and follow its normal.
- **Fold members with three or more patches** take the normalised sum of the
  patch normals; *follow A / B* picks the two largest.
- **Asymmetric sections** (channels, angles, custom outlines) keep the usual
  convention: local y is to the left of the drawing direction, so a member
  drawn the other way is mirrored across its depth.
