# Connection library

FacadeSteel ships 30 parametric connection types (29 library types + custom
templates) for facade secondary steel. Every type is a `ConnectionDef` in
`src/core/connections/` that turns a joint (node + supported member + optional
main member) and its parameters into plates, profile parts (angles, tees,
stubs, sleeves), bolts / anchors, holes and slots in members, member cut-backs
and shop welds. Everything downstream — 3D, IFC, BOM, drawings, NC, nesting,
code checks — reads the derived model, so a new type needs no special cases
elsewhere.

**Detailing only — capacity by the engineer of record.** The library places
holes, slots, edge distances, spacings, plate sizes and weld references that
satisfy the detailing rules of EN 1993-1-8 / EN 1090-2 and AISC 360 (see
`docs/CODE_RULES.md`). It does not check bolt, weld, plate, anchor or member
resistance. Anchor and cast-in channel data are typical values: design with
the product ETA (EAD 330232 / 330499 / 330008) or ICC-ES ESR.

## Where things live

| File | Content |
| --- | --- |
| `src/core/connections/concreteBrackets.ts` | Steel to concrete: helping hand, cast-in channel, embed plate, soffit hanger, wall angle, 3-way bracket, stiffened base, anchor plate |
| `src/core/connections/steelJoints.ts` | Steel to steel: flange clamp, double angle, tee cleat, seated angle, stub bracket, U-saddle, shear block, end cap |
| `src/core/connections/spliceJoints.ts` | End-plate splice, sleeve (spigot) splice |
| `src/core/connections/bracing.ts` | Gusset plate (flat / angle / tube braces), cross-bracing centre plate |
| `src/core/connections/hangers.ts` | Hanger rod end, tie-back strut end (shared lug joint) |
| `src/core/connections/kit.ts` | Shared helpers: code-compliant edge / pitch / slot defaults, plates and holes from world points, angle and tee placement, joint frames |
| `src/core/connections/catalog.ts` | Library metadata: category, use, members, standards notes, key parameters, preview joint, expected warnings |
| `src/core/connections/preview.ts` | Pure preview builder: representative joints, the user's real joint, concrete context, weld lines, hole runs, findings |
| `src/core/connections/registry.ts` | `CONNECTIONS`, placement rules (`applyConnection`, `APPLY_END`, `COLLINEAR_TYPES`, `ONE_PER_NODE`) |
| `src/core/connections/autoConnect.ts` | Auto-connect by roles and topology: `planAutoConnect` (what each rule places, without changing the model), `applyAutoPlan`, `autoConnect` |
| `src/ui/dialogs/AutoConnectDialog.tsx`, `src/ui/autoConnectActions.ts` | Auto-connect dialog (rules, types, counts, 3D markers) and the reference structure it reads |
| `src/viewer/ConnectionPreview.ts` | Three.js live preview and the shared offscreen thumbnail renderer |
| `src/ui/ConnectionLibrary.tsx` | Library browser, `ConnectionPreviewView`, `ParamEditor`, `TypeSelect` |
| `src/assistant/modules/connections.ts` | Assistant tools `connection_library` and `preview_connection` |

## Live preview

`ConnectionPreviewView` builds a mini project (`preview.ts`) and runs the real
`deriveModel`, so the preview is exactly what the model will get. It is shown in

- the **connection library** (Joints → Library, Joints → Add → Browse, or Apply
  dialog → Browse library…), with thumbnails rendered by one shared offscreen
  renderer and cached;
- the **Apply connection** dialog — on the first joint Apply would create on the
  selected members (or a typical joint);
- the **custom template editor** — the unsaved draft template, on the selection
  or a typical joint;
- **connection properties** in the side panel — the selected connection, live
  as parameters are edited ("Open in library…" edits it with the full library).

What it shows: members translucent (role colours), plates with cut-through
holes and slots, cleats / stubs / sleeves, bolts with washers and nuts, anchors
(brass) and headed studs, holes through member and profile walls as dark
cylinders (slots as dark bars), shop welds as orange beads, concrete as a
translucent block behind the anchors (slab edge, slab top, wall, floor or
soffit, inferred from the anchor direction) and cast-in channels. "Labels"
shows plate sizes, sections and bolt groups. The camera stays put while
parameters change (100 ms debounce); it refits when the joint changes. Below
the view: part / hole / bolt counts, mass, and the detailing-check errors and
warnings (`runCodeChecks` with the project's design code) for that joint.

Preview sources (`PreviewSpec.on`): `typical` (representative joint per
catalogue entry — `previewJoint`), `members` (`previewFromMembers` runs
`applyConnection` on a copy of the project and previews the first joint it
creates), `connection` (`previewFromConnection`: the real node, the members
meeting there clipped to ±900 mm, the connection with the edited parameters).

## Catalogue

Key parameters are listed with their defaults or options. "Standards" are the
notes beyond the hole / edge / spacing rules that every type follows
(EN 1090-2 Table 11 and EN 1993-1-8 Table 3.3; AISC 360 Tables J3.3–J3.5 —
all checked by the code-check module).

### Steel to concrete

| Type | Name | Use | Members | Key parameters | Standards notes |
| --- | --- | --- | --- | --- | --- |
| `slabBracket` | Slab bracket | Curtain-wall mullions to slab edge / top at stack joints | Mullion(s); slab | mount edge / top, standoff 150, fin side ±1, base plate set-back 20 (top mount), fin / back plate 10, M12 bolts and anchors, fin slot 17 | Long fin slots ≤ 2.5 d |
| `baseplate` | Base plate | Posts on slabs / plinths | Post; floor | t 15, width / length auto, edge 35, M16 anchors | Oversize anchor holes |
| `helpingHand` | Helping-hand bracket | Rainscreen subframes on walls: fixed point + sliding points | Mullion / vertical rail; wall or slab edge | variant fixed / sliding point; angle L 100x100x10 … L 200x100x12 (default L 150x100x10); standoff 120; M12; slot 17; anchor type | Sliding points: long slots, snug-tight bolts with sliding washers; thermal isolator pad (typical practice) |
| `castInChannel` | Cast-in channel bracket | Brackets on cast-in anchor channels; 3-way adjustment | Mullion; slab edge or slab top with channel | mount; channel 28/15 … 72/48 (40/22); T-bolt M12; plate slot across channel 17; fin slot 17 | T-bolt sizes per channel (typical); channel design by the supplier (EN 1992-4 / EAD 330008, ICC-ES AC232) |
| `embedPlate` | Embed plate + fin | Cast-in plate with headed studs, fin welded after alignment | Mullion; slab edge or top (embed flush) | mount; fin weld site / shop; embed 12 thick; studs Ø16 × 100; fin 10; fin slot 0 | Studs to EN ISO 13918 / AWS D1.1 Type B; site welds per EN 1090-2 / AWS D1.1 |
| `soffitHanger` | Soffit hanger / head restraint | Head restraints under slabs with vertical freedom | Mullion / post top; slab soffit | twin / single fin; deflection gap 20; plate 12; fin 10; M16; vertical slot 22 | Gap ≥ slab deflection + tolerance (project movement settings) |
| `wallAngle` | Wall angle bracket | Rails / transoms ending at walls or columns | Rail end; wall / column face | angle L 60x60x6 … L 120x80x10 (L 80x80x8); M12; angle slot 17; member thermal slot 0 | — |
| `adjustableBracket` | 3-way adjustable bracket | Large tolerances in all three directions | Mullion; slab edge / wall | wall angle L 100x100x10 …; standoff 150; slots vertical 17, in/out 17, along facade 20; serrated plates on | Serrated plates lock slotted joints (typical practice) |
| `stiffenedBase` | Stiffened base plate | Cantilever / canopy posts with base moment | Post; floor | t 20; gussets 4 / 2 (t 10, h 150); anchors 4 / 6 M16; anchor type; h_ef | Gusset snipes clear the post weld (typical practice) |
| `anchorPlate` | Anchor plate (post-installed) | Member ends fixed with post-installed anchors | Rail / strut / post end; concrete face | fixing end plate / plate + fin; pattern 4 / 2 / 6; anchor type chemical / expansion / undercut / screw; h_ef; t 15 | Fixture holes per EN 1992-4 Table 6.1; anchor length from typical h_ef; spacing vs typical family minimum warned |

### Steel to steel

| Type | Name | Use | Members | Key parameters | Standards notes |
| --- | --- | --- | --- | --- | --- |
| `finPlate` | Fin plate | Transoms to mullions; knife in slotted members | Main + secondary | t 10, length 100, side / knife, M12 × 2, slot | — |
| `angleCleat` | Angle cleat | Default transom joint | Main + secondary | L 60x60x6, M12, bolts, gauge | — |
| `endPlate` | End plate | Transoms / beams to posts | Main + secondary | t 10, M12, rows, edge | — |
| `welded` | Welded | Shop-assembled frames | Main + secondary | gap | Fillet size vs part thickness checked |
| `flangeClamp` | Flange clamp | Brackets / posts on primary steel beams, no drilling | I / channel main (on its flange) + post | clamps fabricated / proprietary; top plate 15; M16 × 2 per side; clamp plate 12 | Proprietary clamps: manufacturer data (e.g. Lindapter); fabricated clamp plates with packer = flange thickness (typical practice) |
| `doubleAngle` | Double angle cleat | Heavier transoms / outriggers | Main + secondary | L 50x50x5 … L 100x100x10 (L 60x60x6); M12; slot in main legs | — |
| `teeCleat` | Tee cleat | Transoms with the stem hidden inside the hollow transom | Main + secondary | T 80 … T 140 (T 120x120x13); knife / side; M12 | Flange bolts clear the secondary and the stem root |
| `seatedAngle` | Seated angle | Bearing seat under a horizontal secondary | Main + horizontal secondary | L 80x80x8 … L 150x90x10 (L 100x100x10); M12; seat slot; top cleat | Lateral slot in the seat for tolerance |
| `stubBracket` | Stub / outrigger bracket | Stand-off brackets and outriggers | Main + outrigger | stub same as secondary / SHS / RHS; length 150; end plates 12; M12 | — |
| `saddleBracket` | U-saddle bracket | Transoms on mullions without drilling them | Main + secondary | side / back plates 10; M12; optional bolt through main | Packs where the fork is wider than the secondary |
| `shearBlock` | Shear block / spigot | Hidden (stick-system look) transom joints | Mullion + hollow transom | solid block / twin plates; insert 80; clearance 2; M12; thermal slot | Clearance allows for galvanizing (typical practice ≥ 2 mm a side) |
| `endCap` | End cap plate | Free ends of hollow members | Hollow member, free end | t 6; overhang 0; match section / square; vent Ø | Galvanized closed sections need vent holes |

### Splices & movement joints

| Type | Name | Use | Members | Key parameters | Standards notes |
| --- | --- | --- | --- | --- | --- |
| `splicePlates` | Splice plates | Mullion stack joints, long rails | Two collinear members | t 10, length 300, M12 × 2 per member, slot, gap 10 | — |
| `endPlateSplice` | End-plate splice | Rigid shop splices | Two collinear members | t 15; two sides / four corners; M16; shim pack | — |
| `sleeveSplice` | Sleeve (spigot) splice | Stack joints with thermal / deflection movement | Two collinear hollow members (sharing a node, or drawn with their gap) | sliding / fixed; sleeve auto-fit (largest same-shape section ≥ 1.5 mm inside); length 400; gap 20; M12; slot = long slot; sliding member (auto = upper / supported / main) | Lower member fixed, upper member slides on long slots in the sleeve |

### Bracing & gussets

| Type | Name | Use | Members | Key parameters | Standards notes |
| --- | --- | --- | --- | --- | --- |
| `gussetPlate` | Gusset plate | Wind bracing of facade frames | Column / beam / mullion + brace (FL, L, CHS, RHS) | t 10; M12 × 2; slotted gusset holes along the brace; knife 10 and insert (tubes) | Gusset outline = convex hull of the weld base and the bolt group with its edge distances; tube end slot = knife t + 2 × insert + 5 |
| `crossBrace` | Cross-bracing centre plate | X-bracing of flats / angles | Two crossing braces | t 10; M12 × 2 per brace; end clearance 20 | One plate per crossing |

### Hangers & ties

| Type | Name | Use | Members | Key parameters | Standards notes |
| --- | --- | --- | --- | --- | --- |
| `hangerRod` | Hanger rod end | Hung facades and canopies | Supporting beam + rod (RD) / tube | fork + lug (pinned) / tab + lug (bolted); pin M20; lug 12; lug slot | Pin holes sized as bolt holes; proprietary tension-rod systems by their supplier |
| `tieBack` | Tie-back strut end | Struts tying facade frames back | Mullion / column / beam + strut | tongue (single shear) / fork on end cap (double shear); M16; lug slot 22 | Strut end slot = tongue t + 2 × insert + 5 |

### Custom templates & presets

`custom` connections are built from formula templates in the project library
(Joints → Custom). Plates are positioned in the joint frame u (into the
secondary), w (its local z) and v = w × u — joint-local, so one template gives
the same joint at both member ends; templates saved before keep the
member-local v (frame "member"). A plate's position on its normal is its
contact face (default) or its mid-plane ("centred"). Geometry:
[CONNECTION_GEOMETRY.md §4.4, §5.1](CONNECTION_GEOMETRY.md). Presets (saved
from the library, the Apply dialog or the properties panel) are named
parameter sets of any type and appear in the same library category.

## Placement rules

`applyConnection(project, memberIds, { type, params, replace })`:

- Types that need a main member go on every end of a selected member that
  meets another (non-collinear) member; the main member is the one passing
  through, else the other member at the node.
- `COLLINEAR_TYPES` (`splicePlates`, `endPlateSplice`, `sleeveSplice`) join a
  member to the collinear member at its end. `ONE_PER_NODE` (splices,
  `crossBrace`) are placed once per node.
- Types without a main member follow `APPLY_END`: `upper` for brackets just
  below a slab level and soffit restraints (`helpingHand`, `adjustableBracket`,
  `soffitHanger`, edge-mounted `castInChannel` / `embedPlate`), `lower` for
  base plates and top-mounted brackets, `free` for `endCap`, `freeOrLower` for
  wall fixings (`wallAngle`, `anchorPlate`). Slab brackets keep the mullion
  rules of auto-connect.
- Existing connections on a member end are kept unless `replace` is set.
- The world-up parameters of the placed connections are written as
  member-local values (`ConnectionDef.pin`, see "Member operations" below).

### Splices across a drawn gap

The splices (`sleeveSplice`, `splicePlates`, `endPlateSplice`) also join two
collinear members whose ends do not share a node: a stack joint drawn with its
gap (the wireframe check keeps such gaps, [WIREFRAME_CHECK.md §3](WIREFRAME_CHECK.md)).
The connection sits at one member's end node; the joint centre is the middle
of the gap, and each end is cut back only by what the joint needs beyond the
drawn gap (`max(0, amount − gap/2)`, nothing below 0.05 mm). With the gap
parameter equal to the measured gap the members keep their drawn ends. A
joint parameter smaller than the drawn gap leaves the gap as drawn (warning).
The slab bracket's stack-joint cut-back works the same way. Members sharing a
node derive exactly as before.

## Auto-connect

Joints → **Auto** (tool rail), the assistant's `auto_connect`, and new sample
projects. Auto-connect places connections by the **member roles** and the
**joint topology** — the classification and surface normals the wireframe
check leaves ([WIREFRAME_CHECK.md](WIREFRAME_CHECK.md)) — so a sloped,
V-shaped or folded facade is connected like a vertical one. Direction (plumb =
mullion) is only the fallback for unclassified lines (roles other, beam,
outrigger). Existing connections are kept; only members with a profile take
part; the selection limits it.

Roles: mullion / post = main member; transom / rail = secondary; bracket =
stub; brace. The **mullion lengths** are the chains of collinear mullions
joined at nodes; a stack joint (gap) separates two lengths.

| Rule | Where | Default type | Notes |
| --- | --- | --- | --- |
| Transom joints | A transom / rail end at a node with a mullion / post (T-junction): main = the mullion passing through, else the piece continuing upwards, else any | `angleCleat` (picker: fin plate, end plate, double angle, tee cleat, seated angle, U-saddle, shear block, welded) | Oriented by the members' local axes (so by the surface normals). Cleats / fins go on the side of the transom where the mullion continues: `side = sign(ŷ·d)` when the main ends at the node and `\|ŷ·d\| > 0.7` (`d` from the node into the main) — the old rule on vertical facades, up the slope on sloped ones |
| Fold joints | Transoms meeting one mullion at more than 2° to each other (a fold, a building corner, a raking edge) | `finPlate` (fold joint picker: fin plate, welded, shear block, or the transom joint) | Only when the transom joint bolts through the mullion (angle cleat, end plate, double angle, tee cleat, seated angle): their through-bolts would cross inside it |
| Mullion ends | A mullion end on an edge member that passes through the node (nothing continues the mullion) | the transom joint type | |
| Brace joints | Role brace ending on a member | `gussetPlate` (flat, angle, hollow braces), else the transom joint | as before |
| Stack joints | Two collinear mullion line ends facing each other across a gap of the stack-joint size (wireframe setting, 10–60 mm), lateral offset ≤ the junction tolerance | `sleeveSplice`, sliding, gap = the measured gap rounded up to 0.1 mm; `splicePlates` when the section is not hollow | One per joint; the lower length is the main member, the upper one slides (`slides: supported`). Picker: sleeve, splice plates, end-plate splice (pack = gap − 2t) |
| Structure brackets | With reference models (visible IFC / Rhino .3dm triangles): where each mullion length comes nearest to each structure element within the distance (600 mm) | `slabBracket` (picker: helping hand, 3-way bracket, cast-in channel, embed plate) | See below |
| Stack brackets (option) | A stack joint within reach of a structure bracket on its lower length | `slabBracket` carrying both lengths | Off by default; replaces the splice and moves the bracket to the joint node |
| Bracket stubs | Role bracket, profiled, one end on a mullion and the other free | free end: `anchorPlate` (picker: wall angle, base plate); mullion end: `endPlate` (picker: fin plate, angle cleat, welded) | The mullion length counts as supported |
| Level brackets | Fallback for vertical mullion lengths without structure or stub support: chain ends; a node where two mullion pieces meet when it is at a level (± 50 mm) or, without levels, when no other member meets there; a level the length passes without a node (bracket on the piece across it, at level − 100 mm) | `slabBracket` (edge / top mount) | Not for sloped mullions. **Fix:** a transom junction where the wireframe check cut the mullion is not a support |
| Post bases | Bottom end of a vertical post | `baseplate` | as before |

**Structure brackets.** The mullion length is sampled every 50 mm against the
reference triangles (BVH, `core/clash`); along each run of samples nearest to
one element the support is the middle of the stretch within 5 mm of the
smallest distance (the middle of a slab edge the mullion runs past), refined
until the structure point is square to the axis. Supports closer than 300 mm
along the length, or reaching structure points within 500 mm of each other,
are one support. The bracket is turned to the structure by the member's own
frame — `side` = the sign of the structure direction on the mullion's local z,
`standoff` = its distance along it, the height offset along the mullion axis
(`dz` / `along`) and `upSign` along local x — never by world up. It sits on
the piece containing the support point, at least 150 mm from nodes where other
members meet (transom joints), 240 mm from a stack joint and 90 mm from a
plain split; a support that cannot move clear by up to 400 mm is reported. A
structure beside the mullion (not along its depth), beyond its end, or closer
than half its depth + 20 mm gets no bracket (reported). Lengths already held by
a bracket are skipped.

**The dialog** shows, before anything is placed, each rule with an on/off
switch, its type picker and the count it would place, the connections by
type, how the mullion lengths are held (already, at the structure, on stubs,
at levels, without support), the reference models it reads and plain-language
notes (bracket lines without a profile, fold joints, unsupported lengths and
how to give the structure). The 3D view shows a marker per connection in the
rule's colour, and a line from each structure bracket to the point it
reaches. Settings: structure distance, fold joint, stack-joint gap range,
sliding / fixed sleeves, level-bracket slab side and stand-off. **Place** runs
the plan again on the model as it is, as one undo step.

**Assistant** `auto_connect`: `joint`, `stackJoint`, `structureBracket`,
`structureDistance`, `stubEnd`, `stubJoint`, `levelBrackets`, `slabSide`,
`standoff`, `dryRun`; returns the counts per rule and type, how the lengths are
held, and the notes.

## Member operations, mirror and flip side

Connections follow the modify operations ([MODIFY.md §10](MODIFY.md)): they
move with the end of their supported member, keep or take the main member
that meets that end, and are copied with copied members. Mirror, rotate,
reverse and **Flip connection side** (right-click a connection, its properties,
or the assistant's `connection_flip_side`) transform the parameters so the
parts are the mirror / rotated image or stay in place
([CONNECTION_GEOMETRY.md §15](CONNECTION_GEOMETRY.md)). For that every type
declares which parameters are signed along a member axis (`ParamSpec.flip`):

- sides: `side` of fin plates, cleats, tee cleats, wall angles, gussets, centre
  plates; `side` (concrete, local z) and `finSide` (local y) of the brackets;
- bolt head sides `boltSide` of double angles, shear blocks, splice plates,
  sleeve splices and U-saddles; the lug side `side` of hanger rods and
  tie-backs; `finSide` of the anchor plate fin and of soffit hanger fins (twin
  fins: the bolt head side); `surveyAlong` of slab brackets;
- custom templates: per-connection flags `mirrorV` / `mirrorW` that reverse the
  template's v / w axis.

The defaults give the geometry of earlier versions.

**World up, made member-local.** Seven types have parameters whose default is
referenced to world up: the slab bracket, helping hand, cast-in channel, embed
plate and 3-way bracket (`upSign`: the bracket's vertical, `auto` = world up
projected on the mullion axis; the slab bracket's edge-mount height `dz` is a
world-Z offset in auto), the seated angle (`seat`: auto = the downward-most
face of the secondary) and the sleeve splice (`slides`: auto = the upper
member). `ConnectionDef.pin` turns them into member-local values that give the
same parts — `upSign` ±1 along the supported member's local x (`dz` becomes
the same offset along the axis, unchanged on a plumb mullion), the seat face
`±y` / `±z` of the secondary's section, the sliding member `supported` /
`main`. Auto-connect, Apply and Joints → Add write them; mirror, rotate,
reverse, copy and Flip connection side pin them first (from the joint before
the operation) and then transform them (`upSign` flips with x, the seat face
with y or z), so these brackets follow the member frames on sloped members
and under a mirror about any plane. The slab bracket's movement provisions
(highest = fixed bracket, stack-joint gap, slab deflection) measure heights
along the same `upSign` axis. Connections left on `auto` (older files, the
library preview) derive exactly as before.

## Detailing rules used by the defaults

All defaults pass `runCodeChecks` with no errors for both EN 1993-1-8 and
AISC 360 on their representative joints (tested in
`tests/connectionLibrary.test.ts`). Helpers in `kit.ts`:

- `edgeDist(bolt, { slot, towards })` — the larger of EN 1993-1-8 Table 3.3
  (1.2 d0; slots 1.5 d0 measured from the slot end) and AISC 360 Table J3.4(M)
  + J3.5(M) C2, rounded up to 5 mm.
- `pitchFor(bolt, inLineSlot)` — max(EC3 p2 = 2.4 d0, AISC preferred 3 d) plus
  the slot length when slots are in line.
- `longSlot(bolt)` — slot extra length so the overall slot is 2.5 d (EN 1090-2
  Table 11 long slot = AISC Table J3.3 long slot for M12–M24).
- Bolt holes use the EN 1090-2 normal clearance (also within the AISC standard
  hole); anchor fixture holes follow EN 1992-4 Table 6.1 via the fasteners
  library; oversize anchor holes where stated.
- Holes in hollow-section walls stay on the flat of the wall; bolts through
  hollow members are through-bolts across the section.
- Weld size is the project default (drawing settings, a4 ISO). Defaults keep
  at least one welded part ≤ 13 mm so a4 (leg 5.7 mm) satisfies AISC 360
  Table J2.4; parallel (lap) welded plates are ≥ 8 mm (AISC 360 J2.2b leg
  ≤ t − 2 mm).
- Plate thickness minima (typical practice): load-carrying bracket plates and
  lugs ≥ 10 mm, base plates ≥ 15 mm, slide / clamp plates ≥ 10 mm, serrated
  washer plates ≥ 6 mm, end caps ≥ 5 mm (seal weld). EN 1090-2 6.6.3:
  punch only where t ≤ d0 (reported by the checks).
- Slots are placed where facades need adjustment: vertical (slab deflection,
  level tolerance), in / out of the facade plane, along the facade (anchors in
  channels or slotted wall angles), and along members for thermal movement.

### Expected warnings (by design)

`CatalogEntry.expectedWarnings` lists the code-check rules a type may warn about
with default parameters on its typical joint; the test suite fails on any other
warning.

- `coat.vent` — a welded plate closes a hot-dip galvanized hollow section (base
  plates, end plates, end caps, stub end plates, end-plate splices, flange-clamp
  top plates, tie-back end caps, anchor end plates): add vent / drain holes per
  EN ISO 14713-2 guidance (the warning gives sizes) and agree with the
  galvanizer.
- `ec3.maxSpacing` — `endPlate` and `teeCleat` bolts straddle a 50 mm transom on
  a 5 mm mullion wall (spacing 80–90 mm > 14 t = 70 mm, EN 1993-1-8 Table 3.3).
  Use a thicker-walled main member or accept per the engineer.

Non-default variants can produce errors on purpose when the geometry does not
fit (e.g. a 100 mm helping-hand leg at 120 mm stand-off, a T 80 tee with M12
bolts clear of a 50 mm transom); the connection also reports a plain-language
warning, shown in the preview.

## Assistant

`describe_connection_types` and `apply_connection` list and apply every
registered type automatically. `src/assistant/modules/connections.ts` adds:

- `connection_library` — categories, use, members, standards notes and key
  parameters (with options), filtered by category or search words;
- `preview_connection` — dry run of a type with parameters on a typical joint
  or the selection: parts, bolts, member holes and the detailing errors /
  warnings, without changing the model.

## How to add a connection type

1. Add the name to the `ConnectionType` union in `src/core/model/types.ts`.
2. Write the `ConnectionDef` in the family file (or a new file per family) in
   `src/core/connections/`:
   - `params`: `P.num`, `P.sel` (variants, shapes from a list of profile
     names), `P.bool`, `P.bolt`, `P.grade()`, `P.anchorType()` from `kit.ts`;
   - `trims(ctx)` for member cut-backs (computed from the untrimmed geometry);
   - `build(ctx)`: get the joint with `jointOf` / `memberOf` / `bracketFrame`,
     create plates with `addPlate` (contact plane point, outward direction,
     in-plane axes, outline), add holes from world points with `holeAt`
     (slots along a world direction), member holes with `memberHole`, angles /
     tees with `placeAngle` / `placeTee` + `profileHole`, bolts with `addBolts`
     (head-side face of the grip, shank direction, grip — every hole must lie
     on a bolt axis so the checks match it), welds via `weldedTo` / `out.welds`;
   - use `edgeDist`, `pitchFor`, `longSlot` for defaults and push a plain
     warning to `out.warnings` when the geometry does not fit;
   - give every parameter signed along a member axis a `flip` rule
     (`P.side(key, label, d, ['z'])`, `flips(spec, …)`); avoid world up — when
     a default must use it, make it an `auto` parameter with a member-local
     value (`P.up()` for a bracket's vertical), set `gravity` and a `pin` that
     returns that value; set `faceGap` when the trim is face + a gap
     ([CONNECTION_GEOMETRY.md §15](CONNECTION_GEOMETRY.md)); avoid hard-coded
     sides (`+ŷ` bolt heads): make them a ±1 parameter.
3. Register it in `CONNECTIONS` (`registry.ts`); add it to `COLLINEAR_TYPES`,
   `ONE_PER_NODE` or `APPLY_END` if it needs a placement rule.
4. Add a `CATALOG` entry (`catalog.ts`): category, summary, use, members,
   standards notes, key parameters, preview joint (an existing `JointKind`
   or a new one in `preview.ts`), `concrete` hint for anchored types,
   `previewProfiles`, `expectedWarnings`.
5. Run `npm test`: `tests/connectionLibrary.test.ts` derives the new type on
   its joint, checks both codes, every select / bool variant, application via
   `applyConnection` and the catalogue entry; `tests/connectionsFollow.test.ts`
   mirrors, reverses, rotates, moves, extends and flips it and compares the
   parts with their image. Check it in the library preview.
6. Add a row to the catalogue above.

## Limits

- Detailing only: no bolt, weld, plate, anchor, channel or member resistance.
- Anchor, channel and stud data are typical (fasteners library); concrete edge
  distances to the real slab edge are not known to the model.
- Plates are flat; bent plates and proprietary products (clamps, channels,
  clevises) are represented by fabricated equivalents or bolt-list items.
- Plates inserted into a member end (knife fin plate, gusset knife in a tube
  brace, tie-back tongue, a tee stem wider than the inside of a hollow
  secondary) cut a rectangular end slot through the member: width plate
  t + 2 mm, length insert + 5 mm (typical clearances, fixed). It is in the 3D
  view, the IFC (opening), DSTV (notch in the outer contours of the faces it
  cuts), the machining steps and the part drawing. Slots on members with an
  angled / coped end preparation at the same end are not drawn in 3D.
- A user extension at a member end that a connection supports or trims is
  ignored (with a warning): the connection sets that end.
- `addConnectionFromSelection` (Joints → Add) places types without a main
  member at the selected node or the lower member end; use the library or
  Apply for the `APPLY_END` rules.
- Auto-connect: the bracket parts stay in the mullion's frame. On a sloped
  mullion against a vertical slab edge the back plate touches the edge line
  only (pack it, or use the 3-way bracket); the structure's own face
  orientation is not used. Structure brackets need reference triangles: IFC
  geometry or Rhino meshes (render meshes, own tessellation, or boxes).
  Mullion–mullion meetings at a kink (other than stack joints) get no
  connection. The fold rule turns joints that would bolt through the mullion
  into fin plates; two fins on the same face (transoms meeting from one side
  at an angle) are not checked for overlap. Through-bolts of a transom meeting
  a mullion skew keep the bounding-box grip length.
