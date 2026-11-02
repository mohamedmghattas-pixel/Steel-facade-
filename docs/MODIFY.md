# Modify: join, split, extend, trim, break, stretch, rotate, mirror, offset and section operations

The member and profile modify toolkit changes existing members:
- the wire line: join, split, extend / trim, break, stretch, rotate, mirror, offset, reverse
- the section on it: rotate, flip, mirror, change profile, next / previous size, alignment, match properties.

Every operation is a pure function in `src/core/model/modify.ts` that edits a
project draft. The UI and the assistant run it through `store.apply`, so each
one is a single undo step. A refused operation throws a `ModifyError` with a
message for the user and leaves the model unchanged.

| Part | File |
| --- | --- |
| Operations (pure, tested) | `src/core/model/modify.ts` |
| Connections follow the operations (reconcile pass, summary) | `src/core/model/connectionFollow.ts` |
| Connection parameter transforms (mirror, reverse, rotate, flip side) | `src/core/connections/transform.ts`, `ParamSpec.flip` in the connection types |
| Mirrored sections in parts | `src/core/derive/model.ts` (`mirroredPartFrame`), `src/core/model/geometry.ts` (`sectionShift`), `src/core/geometry/endPrep.ts` (`fitPlane`) |
| Shared with the wireframe check | `memberPropsDiff` (`src/core/wireframe/analyze.ts`), `repointMemberRefs`, `pieceAt` (`src/core/wireframe/apply.ts`) |
| Interactive tools (state, preview, typed input) | `src/ui/modifyTools.ts` |
| Selection commands (menu, keys, properties) | `src/ui/modifyActions.ts` |
| Options bar, context menu, Operations section | `src/ui/ModifyPanels.tsx`, `src/ui/modify.css` |
| Viewer hooks (hover, press / drag, click, right-click, preview overlay) | `src/viewer/Viewer.ts` |
| Split at stock length, at transoms (pure, tested; §5a) | `src/core/model/stockSplit.ts`, `src/ui/stockSplitActions.ts`, `src/ui/dialogs/StockSplitDialog.tsx` |
| Assistant tools | `src/assistant/modules/modify.ts` |
| Tests | `tests/modify.test.ts`, `tests/connectionsFollow.test.ts` (connections, every type), `tests/stockSplit.test.ts` |

## 1. Using the tools

- **Tool rail → Modify:** Join, Split, Extend, Trim, Break, *Stock split* (§5a), Stretch, Rotate, Mirror, Offset, Reverse, Match, Section ⟳.
- **While a tool is active:**
  - The status bar prompts for the next step.
  - The options bar at the bottom of the 3D view shows the tool's settings.
  - Hovering shows a **preview** of what a click would do. The operation runs on a copy of the model and the changes are drawn on top: orange for new and moved lines and for the new section outline, grey for the old outline, red for removed pieces and split points, cyan for picked members and points.
  - **Typing** (a number, `=`, `@`, `/`, `<`, `>` or `-`) goes straight into the typed-input box. Enter applies it.
- **Enter** accepts the defaults, or applies the tool to the selection. **Esc** steps back. A second Esc leaves the tool.
- **Right-click a member:**
  - The member is selected if it was not already.
  - A menu lists the operations for the selection (one member, two members, or many), with their shortcuts.
  - "Here" items (*Split here*, *Break 30 mm gap here*, *Delete segment here*) use the clicked point on the member's axis.
- **Right-click a connection:** it is selected if it was not already; the menu has *Flip connection side* to the other face (local y) or the other depth side (local z) (§7a).
- **After an operation** the status toast says what happened to the connections (*Connections: 1 moved, 2 re-pointed, 1 removed (Splice plates).*).
- **Properties → Operations** (members selected):
  - length, angle to horizontal and to vertical; with two members, the angle between them
  - Split in N, at crossings
  - Extend ± a distance at the start, end or both ends
  - Rotate the section ±90°, flip 180°, mirror the section
  - Previous / next size (by mass, wall or outer size)
  - Reverse, Match from…, Join / Corner, Break…
  - A *Mirrored section* check box sits under the rotation.
- **Measure tool:**
  - Picking two points gives the distance, its components and the angle to horizontal.
  - Points on members add the member's length and angles, and the 3D angle between two members.
  - Activating Measure with members selected reports the same.

### Shortcuts

| Key | Action | Key | Action |
| --- | --- | --- | --- |
| J | Join | Shift+M | Mirror |
| K | Split | Shift+O | Offset |
| E | Extend / trim an end | V | Reverse |
| T | Trim | Shift+P | Match properties |
| B | Break (gap) | Shift+R | Section tool |
| G | Stretch (move an end) | ] / [ | Rotate the selected sections +90° / −90° |
| R | Rotate | Shift+F | Flip the selected sections 180° |
| + / − | Next / previous size of the selection (outside a modify tool) | Shift+X | Mirror the selected sections |

While a modify tool is active, digits, `-` and `=` go to the typed input (the view keys 1–4 apply again after Esc).

## 2. Join

**Collinear join** (`joinMembers`):
- **What it joins:**
  - two members, or a chain, on one line: direction within 1°, ends within 2 mm of the line
  - pieces that share a node, or are separated by a gap or overlap of up to *max gap* (default 100 mm; *Close gap* allows 1,000 mm).
- **Result:** one member.
  - The **longest piece** keeps its id and properties (with *keep first*, the first picked).
  - The outer ends keep their end preparations and extensions, re-expressed in the joined member's frame. A piece drawn the other way round is handled.
  - Connections, end-preparation targets (mitre / fit `to`) and welded plates of the absorbed pieces are re-pointed to the joined member. This uses the wireframe check's `repointMemberRefs`.
  - **Connections on a node between the pieces:** those whose supported member is one of the pieces (a splice, a stack-joint bracket, a cleat of a piece) are removed and reported — the member is continuous there. Joints of other members on that node (a transom's cleat on a stack node) are re-pointed to the joined member. With `jointConnections: 'refuse'` the join is refused instead (`code: 'joint'`, the connections in `detail`); the UI does that first and asks *Join and remove …?*.
  - End preparations at the joint are dropped (reported). Orphan nodes are removed. A node used by other members stays as a through-node.
- **Refused when:**
  - the pieces' properties differ (`code: 'conflict'`): profile, role, material, finish, phase / zone / batch, manual mark (the wireframe check's `memberPropsDiff`), or the **physical** section placement (orientation and position across the line, through the section's symmetry). Raw rotation values do not count, so pieces drawn in opposite directions join when their sections sit the same way.
  - The UI then asks *Keep first?* and retries with `keep: 'first'`.

**Corner join** (`cornerJoin`, two non-collinear members):
- Both members are extended or trimmed to the **closest approach** of their axes. This works in 3D: skew axes within the tolerance (default 50 mm) meet at the midpoint of the shortest connecting segment.
- The two ends are merged into one node.
- Inside a member, the shorter side is cut off (`keepA` / `keepB` choose the end to keep).
- Refused for parallel members, or axes further apart than the tolerance.

**Join to member (T)** (`joinToMember`):
- The end of A nearer to B is extended or trimmed onto B's axis, where A's axis passes closest to it (within the tolerance), and connected to a node on B.
- B stays continuous (the node is a through-node, see `membersAtNode`) unless *split B* is chosen; then B is cut there.

**Close gap** (`closeGap`) is a collinear join across the gap: the inverse of Break.

**Join tool:** pick the first member, then the second.
- Collinear: join. At an angle: corner. Shift+click (or mode *T* / *T + split*): join to member.
- Typed: a number sets the max gap; `t`, `s`, `c`, `a` set the mode.
- Enter joins the selected members (a collinear chain, or a corner of two).

## 3. Split

Splitting uses `splitMember`, so connections and mitres follow the piece at their node. Welded plates go to the piece they sit on. The first piece keeps the id.

| Function | Splits |
| --- | --- |
| `splitAtPoint` | at the axis point nearest to a picked point |
| `splitAtDistance` | at a distance from the start or end |
| `splitInto` | into N equal parts (2 … 1000) |
| `splitAtLengths` | into fixed lengths (e.g. stock 6,000) from one end; the remainder stays at the other end (14,000 → 6,000 + 6,000 + 2,000) |
| `splitAtPlane` | where a plane crosses the members: a level (horizontal at its z), a grid line (vertical), the work plane, three points, `x / y / z = value`, or point + normal (`resolvePlane`) |
| `splitAtCrossingMembers` | only these members, where other members cross them or end on them (within 1 mm); `mullionTransomOnly` uses the wireframe check's junction rule (`isMainRole` / `isSecondaryRole`); the other members stay continuous |

Pieces shorter than 1 mm are never made.

**Split tool:** click a member to split it with the current mode.

| Typed | Mode |
| --- | --- |
| `/3` or `n3` | N parts |
| `500` / `-500` | distance from the start / end |
| `L6000` | stock lengths |
| `p` | at the picked point |
| `z=3500`, `x=…`, `y=…`, `wp`, `level L01`, `grid B` | at a plane |
| `x` | all crossings |
| `mt` | mullion–transom crossings only |

- With a selection, typing applies the mode to the selection at once.
- Enter in *Crossings* mode with nothing selected splits every line at its crossings: the previous rail *Split* command, which now lives here.

## 4. Extend and trim

Moving an end uses `moveMemberEnd` (§6):
- *auto*: the node moves when nothing else uses it, else the end detaches
- *detach*
- *node*.

| Function | Does |
| --- | --- |
| `extendBy(d, start / end / both)` | extends (d > 0) or shortens (d < 0) along the member's own axis |
| `setLength(L, anchor)` | exact length, keeping the start, the end or the centre |
| `extendToMember(to: 'axis' / 'face', gap)` | extends or trims along the member's own axis to where it passes closest to the other member's axis, or to that member's **outer face** there, plus `gap` |
| `extendToPlane` | to a plane (the nearer end unless given) |
| `trimAtBoundary(keep)` | cuts the member where the boundary member crosses it (or its axis meets the boundary's span within 10 mm) and keeps the side `keep` (`start` / `end`, or a point on that side); the other piece is deleted with its connections and welded plates (reported) |
| `deleteSegment(pick)` | AutoCAD-style trim: deletes the piece between the crossings (members crossing it or ending on it) on either side of the pick; between an end and the first crossing, that end piece goes |

The face distance is the same function the connections use (`faceDistance`,
[CONNECTION_GEOMETRY.md §4.3](CONNECTION_GEOMETRY.md)): a transom at 30° in plan into an SHS 100 stops 50 / cos 30° = 57.74 mm from the axis.

**Extend to a face on a connected end.** An end that carries a joint (a connection with a main member) is never pulled off the joint:
- the wire end goes to the other member's **axis** (where a freshly applied connection has it), and the connection's trim cuts the member back to the face;
- a `gap` given (`g10` in the tool) sets the connection's clearance (`ConnectionDef.faceGap`: the `gap` of fin plates, cleats, double angles, seats, saddles, shear blocks and welded joints), so the parts are exactly those of a fresh connection with that gap (tested); without one the connection keeps its own;
- types whose cut-back is not face + gap (end plates, stubs, clamps, tee cleats …) keep their own cut-back (reported).

A free end goes to the face plus the gap, as before.

**Extend tool:**
- Click near the end to change.
- Then click a member (extend to its axis or face, as set in the options bar), click a point (the end goes to its projection on the axis), or type:
  - a distance (`200`, `-150`); Enter repeats the last distance (default 100 mm)
  - `=3000` for the length with the other end kept, `=3000c` with the centre kept
  - a plane token
  - `axis` / `face`, `g10` for the gap.

**Trim tool:**
- Pick the boundary, then click each member on the side to **keep**. The boundary stays picked for the next member.
- Enter or `seg` switches to *Delete segment*: click the piece between two crossings.

## 5. Break and close gap

`breakMember(at, gap = 30, side)` splits at a station or point and opens a gap of `gap` mm (a stack or movement joint):
- symmetric about the point (`both`), or towards the `start` / `end`
- **refused when a connection on the member sits inside the gap**
- other members whose ends fall inside the gap no longer touch the member (reported).

The two pieces copy the member. Close the gap with **Join** (collinear, max gap ≥ the gap) or *Close gap* in the context menu.

**Break tool:** click the member where the gap goes. Type the gap (`50`), or `<` / `>` / `=` for the side.

## 5a. Split at stock length, at transoms

A mullion longer than the stock bar of its profile is divided into pieces that
each fit a bar, at transoms, with a stack joint (`planStockSplit`,
`applyStockSplit` in `core/model/stockSplit.ts`).

- **Members:** the selection, or every mullion when nothing is selected. Only
  mullions and posts are divided (they are divided at transoms / rails);
  others are listed as not checked.
- **Stock length:** the longest bar for the member's profile and material —
  stock on hand with a quantity left (*Project settings → stock*), else the
  longest standard stock length — or a length given in the dialog. The longest
  piece is the bar less 2 × end trim and the kerf (the bar nesting's rule:
  12,000 − 2 × 10 − 3 = 11,977 mm by default). The member's length is its wire
  line plus its end extensions.
- **Where:** measured from the member's lower end, each cut goes at the
  transom junction (a node on the member's span where a transom / rail meets
  it) whose joint leaves the longest piece that still fits — the junction
  nearest below the limit — and so on up the member.
- **Joint position** at that transom:

  | Option | Piece below ends | Piece above starts | The transom |
  | --- | --- | --- | --- |
  | *Top* (`top`, default) | just above the transom's top face (and its joint parts) + clearance | one gap higher | stays on the piece below (a through-node) |
  | *Bottom* (`bottom`) | one gap lower | just below the transom's bottom face (and its joint parts) − clearance | stays on the piece above |
  | *Middle* (`centre`, on the transom's centre line) | gap / 2 below the transom axis | gap / 2 above it | its ends move gap / 2 down onto the top of the piece below, so it connects to the lower piece (the length the sleeve is fixed to); its transom joints there are removed for Auto-connect to place again on the lower piece |

  The transom's faces come from its profile: the section's extent along the
  member axis, with its rotation, surface normal and alignment (an RHS 100×50
  with its depth along the facade normal: ±25 mm). With the derived model
  (always in the dialog and the assistant) the joint also clears the parts of
  the connections at the junction (cleats, fin plates), so no joint hole ends
  up past a piece end.
- **Gap:** the project's stack-joint size (*Wireframe check → Rules → New
  joints*, default 30 mm), or the dialog's value. It must lie in the
  stack-joint range (10–60 mm) — the plan warns otherwise. **Clearance**
  (default 0) adds distance between the transom (or its joint parts) and the
  joint.
- **Not divided:** a member with no transom where a joint would leave a piece
  that fits, or whose candidate gaps would swallow another junction, its
  parts, a bracket or a connection node, is left as it is and listed with the
  reason.
- **Result:** the piece at the member's start keeps its id and start details,
  the last piece its end details; connections, end-preparation targets and
  welded plates go to the piece at their node; manual assemblies keep every
  piece; one undo step. The wireframe check lists each new joint as a kept
  stack joint and Auto-connect gives it a splice (sleeve on hollow sections),
  the lower piece as the main member.

**Dialog** (tool rail → Modify → *Stock split*, the Split tool's options bar
*At stock length (transoms)…*, right-click a member → *Split at stock length,
at transoms (stack joint)…*, Properties → Operations → *stock length…*):
members, stock length (by profile, with the bar, its source and the longest
piece, or a length), joint position, gap and clearance; the counts before
applying (members checked, longer than the stock, divided → pieces, left as
they are), warnings, the members to divide and the ones left, with zoom; the
planned joints in the 3D view (teal; members left as they are in red).

On the client facade (119 continuous mullions up to 12 m, profiles and
auto-connect first): a 12 m bar (11,977 mm pieces) divides 29 mullions into
58 pieces; 6 m bars divide 89 into 216 pieces. The check then lists 97 (or
195) stack joints and Auto-connect adds the 29 (or 127) sleeves, with no
other change. With *Top* or *Bottom* and no clearance, the default sleeve's
bolts (up to about 100 mm into each piece) come within 8–10 mm of the transom
cleat bolts in the same faces: the checks report the hole spacing. A clearance
of 100 mm (12 m bars) or 150 mm (6 m bars) clears them, so the dialog and the
assistant start at 150 mm (`STOCK_SPLIT_CLEARANCE`); the core function's own
default stays 0 ("just above / below the face").

## 6. Stretch (move an end)

`moveMemberEnd(id, end, to, mode)`:

| Mode | Moves |
| --- | --- |
| `node` | the node: every member and connection on it follows |
| `detach` | only this member's end: it gets its own node at `to` (an existing node there is reused); the connections of this end go with it (§10), those of other members stay |
| `auto` | `node` when no other member ends there and no connection of another member sits on it, else `detach` |

A node moved onto another node is merged into it.

**Stretch tool:**
- **Press on a member end and drag** (snapping as for drawing), or click the end and then pick or type the target: `x,y,z`, `@dx,dy,dz`, `u,v` on the work plane, or a single distance along the member.
- Options: *Move node* / *Detach end*. Shift+click uses the other one.

## 7. Rotate, mirror, offset

`transformMembers(ids, map, { copy })` applies a rigid map: `rotationMap`, `mirrorMap` or `translationMap`.

**Nodes:**
- The selected members move as a rigid group.
- A node also used by members outside the selection is left to them: the group gets its own node there.
- A connection moves with its supported member (§10); one whose members all moved moves entirely. A joint whose main member did not move keeps it if the moved end still meets it, takes a member the end now meets (a transom mirrored between two mullions: each cleat goes to the mullion its end lands on), else it is reported.
- Coincident nodes merge afterwards.

**Sections follow the map:**
- Each member is re-posed (`poseMember`): rotation, mirror flag, alignment and offsets are chosen so the section's world placement is the mapped one.
- Placements that are equivalent through the section's symmetry are preferred when they avoid the mirror flag or an alignment change.
- **A mirror mirrors the section, not only the line.** A reflection turns a right-handed member frame into a left-handed one, so an asymmetric section (channel, angle, Z, custom outline) gets `mirrorSection`. A symmetric one is placed through its symmetry instead (for example, an RHS on its +y face becomes an RHS on its −y face).

**Also mapped:**
- **End preparations:** saw angles are re-expressed in the new frame; copes swap top / bottom when local z flips.
- **Welded plates:** mirrored plates keep a right-handed frame, with the flat pattern, holes and bend lines mirrored.

**Connections:**
- Their parameters follow the map for every type (sides, fin sides, bolt head sides, survey offsets, lug sides, template flags — [CONNECTION_GEOMETRY.md §15](CONNECTION_GEOMETRY.md)): the parts are the rotated / mirrored image of the originals (tested for all 30 types and their variants).
- *Copy* also copies the welded plates, mitre partners within the set and the connections whose supported member is copied. Their main member is the copied main, else the original one where it still meets the copy (a transom copied up its mullions keeps them), else the member the copied end lands on; a joint with none is not copied (reported).

**Operations:**
- `rotateMembers(ids, point, dir, deg)`
- `mirrorMembers(ids, plane)`
- `offsetMembers(ids, distance, dir)`:
  - `dir`: each member's local `y` or `z`, its surface normal (falls back to local z until members carry one), or a world vector
  - copies by default
  - members moving by different vectors no longer share their nodes.

**Tools:**

| Tool | Steps | Options and typed input |
| --- | --- | --- |
| Rotate | pick the members (or start with a selection); then the axis: a centre point (axis = the work-plane normal), two points, or a member's axis | the angle (Enter: the option, default 90°); `c` toggles copy |
| Mirror | pick the members; then two points of a mirror line on the work plane (the plane contains the work-plane normal), three points, a member's axis, or Enter / `wp` for the work plane itself | copy is on by default |
| Offset | pick the members; click the side, or type the distance (a negative value is the other side) or `@dx,dy,dz` | `y` / `z` / `n` direction, `c` toggles copy |

## 7a. Flip connection side

`flipConnectionSide(connectionIds, axis)` mirrors connections to the other side of their supported member, the member unchanged:
- `y`: the other face across the member (through its local xz plane): fin plate / cleat side, bracket fin side, bolt head side …
- `z`: the other side in depth (through its local xy plane): the concrete side of a bracket …

The parameters are transformed by the same rules as a mirror, so the parts are the reflection of the old ones through that plane. Refused when nothing changes (the connection is symmetric about that plane).

**UI:** right-click a connection → *Flip connection side (other face, local y)* / *(other depth side, local z)*; connection properties → *Flip side ↔ (y)* / *Flip side ↕ (z)* (disabled when symmetric). **Assistant:** `connection_flip_side`.

## 8. Section operations ("over the profiles")

| Function | Does |
| --- | --- |
| `rotateSections(ids, deg)` | adds to the rotation (±90°, 180° flip) |
| `mirrorSections(ids, on?)` | toggles `Member.mirrorSection` (below) |
| `changeProfile(ids, name)` | swaps the profile, keeping the wire line's place on the section: the 3×3 grid is relative to the box; a member on an insertion point whose new profile has none moves to the nearest grid point (reported); the profile's material comes along |
| `profileSizeStep(name, ±1, mode)`, `stepProfiles` | next / previous size in the **same family, standard and section type, ordered by mass**: `mass` any size; `wall` the same outer size with the next wall (RHS 100x50x4 → 100x50x5); `size` the same wall with the next outer size (→ for example RHS 120x60x4) |
| `setAlignment(ids, { alignY, alignZ, mode })` | the 3×3 grid point or the profile's insertion point for a selection |
| `matchProperties(src, targets, fields)` | "format painter"; fields: profile, material, finish, rotation, alignment / insertion (with offsets), mirror, role, phase / zone / batch, end preparations (saw cuts, copes and extensions; mitres and fits belong to their partner and are skipped) |
| `reverseMembers(ids)` | swaps start and end; see below |

**Reverse:**
- The section stays where it is physically: rotation, mirror flag and alignment are re-posed.
- End preparations and extensions stay on their physical ends, with saw angles and cope sides re-expressed.
- Connection parameters are re-expressed in the new axes (sides, bolt sides; a lug side when the main member is reversed), so the parts stay where they are.
- Joints whose movement (slotted) end was automatic (the member's end node) get it set explicitly, so the slots stay where they were.
- RHS and other doubly symmetric sections never need the mirror flag. A channel reverses with z flipped. An angle needs the flag.

**Mirror section** (`Member.mirrorSection`):
- **What it does:** mirrors the outline about the member's local z axis through the wire line (local y → −y). The section shift mirrors with it, so the wire line stays at the same point of the section.
- **The part:** a mirrored channel is physically the same channel seen from the other end. `deriveModel` therefore gives the part the right-handed frame (−x, −y, z) with its origin at the far end, the **plain** outline, and its end cuts swapped (`mirroredPartFrame`).
- **Outputs:** every output reads parts, so the mirror reaches:
  - the 3D mesh and the instancing
  - IFC (the plain profile definition in the reversed placement, re-read with web-ifc in the tests)
  - DSTV (the start / end saw angles swap)
  - drawings
  - clash solids (the open side stays free)
  - BOM, nesting and numbering (a mirrored and a plain channel of the same cut are the same mark).
- **Connections and fits:** connection geometry uses the section box, which a mirror does not change. `fitPlane` swaps the channel's web faces. Stiffeners go on a mirrored channel's open (−y) side.

**Section tool:** click members to apply the action (rotate by the angle, flip, mirror, next / previous size). Type an angle, or `f`, `m`, `+`, `−`. Enter applies to the selection.

## 9. Assistant

| Tool | Does |
| --- | --- |
| `modify_join` | collinear / corner / tee join (`mode`, `keep`, `maxGap`, `tol`, `splitB`) |
| `modify_split` | point, distance (+ from), parts, length (stock), plane, crossings (+ mullionTransomOnly) |
| `modify_extend` | distance (+ end), length (+ anchor), toMember (+ to axis / face, gap), plane |
| `modify_trim` | at a boundary (+ keep), or delete the segment at a point |
| `modify_break` | distance or point, gap, side |
| `modify_move_end` | stretch to / by, mode |
| `modify_transform` | rotate (axis point + direction or member), mirror (plane), offset (distance, direction), copy |
| `modify_section` | rotate, flip, mirror, profile, step (next / previous, mode), alignment |
| `modify_match` | source, targets, fields |
| `modify_reverse` | — |
| `modify_measure` | length, angles, angle between two members |
| `modify_stock_split` | split at stock length at transoms (§5a): `filter` (default every mullion), `stockLength`, `at` (top / bottom / centre), `gap`, `clearance`, `dryRun`; returns the counts, the members divided (piece lengths, bar and its source), the ones left with the reason, and warnings |
| `connection_flip_side` | connections (ids, else the selected), axis `y` / `z` |

- Members are chosen by `filter`: `ids`, `selected` (the default), `all`, `role`, `profile` or `direction`, as in the core tools.
- Planes are `{ kind: level | grid | workPlane | x | y | z | points | plane, … }`.
- Replies carry the message, the resulting member ids (selected in the view), the warnings and `connections`: the summary line and the ids moved, re-pointed, mirrored / re-oriented, copied and removed. `edit_geometry` (move, copy, mirror) reports the same summary; its mirror now mirrors sections and connections too.

## 10. Rules for connections, end preparations and plates

Every operation takes a snapshot of the connections, runs, then reconciles them
(`followConnections`, `src/core/model/connectionFollow.ts`; also used by Move,
Copy and Array in `ops.ts`):

- **A connection belongs to the end of its supported member** (`secondary[0]`). When that end gets another node (extended, stretched with *detach*, moved with a group, corner / tee join, close gap), the connection moves to it. It is never left at the old node.
- **Main member:** kept while it still meets the node — the node is on its axis (1 mm) or inside its section box (an end extended into the main member keeps the joint: the parts are placed from the main face, so they do not move). After a split it is the piece that contains the node; at a cut between pieces the one continuing upwards (`pieceAt`, as Auto-connect picks it). When the end landed on another member (extend / join to member, corner join, a moved or copied group) that member becomes the main. Otherwise the connection stays on the member end and one warning names the joint.
- **Stack-joint members** (`secondary[1..]` of a slab bracket) that no longer end at the node are dropped from the connection (reported).
- **Parameters** follow rigid maps and reverses ([CONNECTION_GEOMETRY.md §15](CONNECTION_GEOMETRY.md)).
- **Summary:** `ModifyResult.connections` lists the connections moved, re-pointed, mirrored / re-oriented, copied and removed; the status toast shows it (*Connections: 2 moved, 1 re-pointed.*), the assistant replies carry it.

| Operation | Connections | End preparations | Welded plates |
| --- | --- | --- | --- |
| Join / close gap | of the joined pieces: re-pointed; on the joint, of the pieces: removed (reported; the UI asks first); joints of other members there: re-pointed to the joined member | outer ends kept (converted), inner ends dropped | re-pointed |
| Split / divide / stock lengths / at crossings | stay on the piece at their node; a split main is re-pointed to the piece that contains the node (the upper one at a cut) | kept at their ends; new cut ends square | to the piece they sit on |
| Break | as split; refused with a connection in the gap | as split | as split |
| Split at stock length | on the piece at their node (a transom's cleat on the piece it stays on); *centre*: the transom joints at the moved node are removed (reported) for Auto-connect | kept at the member's ends; new joint ends square | to the nearest piece |
| Extend / exact length / to a plane / stretch | move with the end; main kept while it meets the end, else reported | kept | — |
| Extend to member | move with the end; the member extended to becomes the main; *face* on a connected end keeps the wire on the axis and sets the joint gap (§4) | kept | — |
| Corner join / join to member | move with the end; the other member becomes the main where the old one no longer meets | kept | — |
| Stretch a shared node (*node*) | every member and connection on the node follows | kept | — |
| Trim / delete segment | of the removed piece: deleted (listed); a joint at the cut whose main was the removed piece: re-pointed to the kept piece | of the removed piece: gone | of the removed piece: deleted |
| Rotate / mirror / offset / move | move with their supported member, parameters mapped (image of the parts); copies copy them (main resolved as in §7) | converted to the new frame | mapped (mirrored plates stay right-handed) |
| Reverse | parameters re-expressed: physically unchanged; automatic movement ends pinned | swapped to the other field, angles converted | — |
| Flip connection side | parameters mirrored through the member's xz / xy plane; member unchanged | — | — |
| Section ops / match | unchanged (connections follow the box) | match copies saw cuts and copes | — |

After every operation the joints of the changed members are checked: a main
member that no longer meets its joint is reported once.

### 10a. Fit to, and ends that follow the face by themselves

*Fit to* (tool rail → Members, Properties → End preparation → *Fit to 2nd*,
assistant `fit_member_end`) cuts the first selected member's nearer end to the
facing side of the second, leaving the gap: in any direction — a transom to a
mullion, a mullion to a sill, head or beam — and on sloped, raking and folded
geometry, where the cut gets the saw angles of the face it meets (web, flange
or both). The face is the side whose normal is closest to the member's
direction; I and U members are cut to their web (with *cope* the flanges that
clash are coped). The status line reports the cut ("Fitted the end end
(flange 12.0°) with a 10 mm gap"), or why the end stayed square: the member
does not meet a side face (more than 78° off), or the cut would be steeper
than 85°; beyond 60° it adds the saw-range warning. A Fit replaces the
connection's cut-back and the auto-cut at that end.

Without a Fit, ends follow faces on their own: a connection's cut-back follows
the main member's face on a joint that is not square, and the project auto-cut
cuts ends that have no connection (Project → *End fitting*,
[CONNECTION_GEOMETRY.md §3.4a](CONNECTION_GEOMETRY.md)). Operations keep
neither in the model: they are derived from the joint, so they follow every
move, mirror, extend or split.

## 11. Member vectors

Operations that derive a member from another write it as `{ ...m, … }`, so new optional member fields carry over.

Two single helpers in `modify.ts` are the place for stored directions (a surface normal, for example):
- `transformMemberVectors(m, fn)`: called once per member by rotate, mirror and copies
- `memberAxes`: the section axes used by the re-posing.

## Limits

- **Axes and preview:** operations work on the wire line (straight members). The preview runs the operation on a copy of nodes, members, connections and plates on every hover; it is fast on facade-size models, and on very large models it can lag.
- **Connections without a main member that meets them:** a joint whose end was moved off its main member (extended past it, offset out of the facade plane) stays on the member end with its old main and one warning; re-apply or move it back. It is not re-placed on another member unless the operation put the end onto one (extend / join to member, corner join, moved or copied groups).
- **Gravity-referenced connections** (slab and facade brackets, seated angles, sleeve splices) keep their vertical rule: after a mirror about a horizontal plane or a rotation about a horizontal axis they are rebuilt with the seat under the member and the bracket's vertical up, not mirrored.
- **Cross-bracing centre plates** are centred on their node: extending a split brace off the crossing moves the plate with it.
- **Copies** of joints whose main member is neither copied nor met by the copied end are not made (reported).
- **Offset along the normal:** members without a surface normal fall back to local z (reported).
- **Mirror section:** members only. Connection profile parts (cleats, tees) have no mirror flag; they are placed through their own frames, so the angle of a mirrored joint is still the mirror image of the original one.
- **Measure:** angles are between axes (wire lines), not section faces.
- **Split at stock length:**
  - *Middle* joints move the transom ends half the gap off their drawn axis (reported), and the transom joint there sits at the end of the lower piece; use *Top* / *Bottom* to keep the transoms where they are drawn.
  - The joint clears the transom and the connection parts at that junction; the splice that Auto-connect adds afterwards is cleared by the clearance, 150 mm by default (0 mm puts the default sleeve's bolts 8–10 mm from the cleat bolts).
  - Run Auto-connect before the split so the joints also clear the cleats; without connections only the transom sections are cleared.
  - Lengths are measured on the wire line plus extensions, not the derived cut length (connection trims only shorten it).
  - Brackets that Auto-connect placed with an offset from a member end node (structure brackets, level brackets on the piece across a level) stay on the piece at that node; when the split puts the bracket's position on another piece, delete them and run Auto-connect again.
