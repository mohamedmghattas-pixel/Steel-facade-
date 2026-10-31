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
| `src/core/connections/registry.ts` | `CONNECTIONS`, placement rules (`applyConnection`, `APPLY_END`, `COLLINEAR_TYPES`, `ONE_PER_NODE`), `autoConnect` |
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
| `slabBracket` | Slab bracket | Curtain-wall mullions to slab edge / top at stack joints | Mullion(s); slab | mount edge / top, standoff 150, fin / back plate 10, M12 bolts and anchors, fin slot 17 | Long fin slots ≤ 2.5 d |
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
| `sleeveSplice` | Sleeve (spigot) splice | Stack joints with thermal / deflection movement | Two collinear hollow members | sliding / fixed; sleeve auto-fit (largest same-shape section ≥ 1.5 mm inside); length 400; gap 20; M12; slot = long slot | Lower member fixed, upper member slides on long slots in the sleeve |

### Bracing & gussets

| Type | Name | Use | Members | Key parameters | Standards notes |
| --- | --- | --- | --- | --- | --- |
| `gussetPlate` | Gusset plate | Wind bracing of facade frames | Column / beam / mullion + brace (FL, L, CHS, RHS) | t 10; M12 × 2; slotted gusset holes along the brace; knife 10 and insert (tubes) | Gusset outline = convex hull of the weld base and the bolt group with its edge distances; tube slot length = knife insert |
| `crossBrace` | Cross-bracing centre plate | X-bracing of flats / angles | Two crossing braces | t 10; M12 × 2 per brace; end clearance 20 | One plate per crossing |

### Hangers & ties

| Type | Name | Use | Members | Key parameters | Standards notes |
| --- | --- | --- | --- | --- | --- |
| `hangerRod` | Hanger rod end | Hung facades and canopies | Supporting beam + rod (RD) / tube | fork + lug (pinned) / tab + lug (bolted); pin M20; lug 12; lug slot | Pin holes sized as bolt holes; proprietary tension-rod systems by their supplier |
| `tieBack` | Tie-back strut end | Struts tying facade frames back | Mullion / column / beam + strut | tongue (single shear) / fork on end cap (double shear); M16; lug slot 22 | Tongue insert = tube slot length |

### Custom templates & presets

`custom` connections are built from formula templates in the project library
(Joints → Custom). Presets (saved from the library, the Apply dialog or the
properties panel) are named parameter sets of any type and appear in the same
library category.

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

`autoConnect` is unchanged except for one unambiguous default:
`AUTO_DEFAULTS.braceJoint = 'gussetPlate'` — members with role `brace` and a
flat, angle or hollow section get a gusset plate where they end on another
member (set `braceJoint: 'none'` to switch it off).

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
     warning to `out.warnings` when the geometry does not fit.
3. Register it in `CONNECTIONS` (`registry.ts`); add it to `COLLINEAR_TYPES`,
   `ONE_PER_NODE` or `APPLY_END` if it needs a placement rule.
4. Add a `CATALOG` entry (`catalog.ts`): category, summary, use, members,
   standards notes, key parameters, preview joint (an existing `JointKind`
   or a new one in `preview.ts`), `concrete` hint for anchored types,
   `previewProfiles`, `expectedWarnings`.
5. Run `npm test`: `tests/connectionLibrary.test.ts` derives the new type on
   its joint, checks both codes, every select / bool variant, application via
   `applyConnection` and the catalogue entry. Check it in the library preview.
6. Add a row to the catalogue above.

## Limits

- Detailing only: no bolt, weld, plate, anchor, channel or member resistance.
- Anchor, channel and stud data are typical (fasteners library); concrete edge
  distances to the real slab edge are not known to the model.
- Plates are flat; bent plates and proprietary products (clamps, channels,
  clevises) are represented by fabricated equivalents or bolt-list items.
- The tube slot for knife / tongue plates and slots in member ends are
  fabrication notes (insert length), not modelled cuts.
- `addConnectionFromSelection` (Joints → Add) places types without a main
  member at the selected node or the lower member end; use the library or
  Apply for the `APPLY_END` rules.
