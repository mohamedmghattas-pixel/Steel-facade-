# Profile assemblies (composite sections)

A **profile assembly** is several profiles linked to one assembly insertion point, the
**base point**: a curtain-wall mullion made of a steel box, an aluminium casing, a back
profile, a pressure plate, a cover cap, gaskets and packers. This document covers:

- the data model (`ProjectLibrary.profileAssemblies`, `Member.profileAssembly`)
- uploading assembly details from DXF and the review step
- how a member carrying an assembly is derived: one part per fabricated component in one
  assembly, gaskets and packers as accessories
- profiles by role, the member properties, numbering
- outputs (3D, IFC, NC, lists) and drawings
- the assistant tools, the tests and the limits.

| Part | File |
| --- | --- |
| Types | `src/core/model/types.ts` (`ProfileAssembly`, `ProfileAssemblyComponent`, `ComponentLengthRule`, `Member.profileAssembly`, `RoleProfile.assembly`) |
| Model helpers and project operations (pure) | `src/core/library/profileAssembly.ts` |
| DXF upload | `src/core/library/profileAssemblyDxf.ts` (reads with `src/core/io/dxfReader.ts` and the planar collector of `profileDxf.ts`) |
| Derivation | `src/core/derive/model.ts` (`compositeParts`, `accessorySolids`), `src/core/derive/memberGeom.ts` (the composite shift) |
| Drawings | `src/core/drawings/assemblyDrawing.ts` (composite section, detail, accessories list) |
| NC and lists | `src/core/fabrication/dstv.ts` (`hasDstv`), `src/core/fabrication/extrusions.ts`, `src/core/reports/bom.ts` (`accessoryTables`) |
| IFC | `src/core/io/ifcExport.ts` (accessories as proxies) |
| UI | `src/ui/ProfileAssemblyDialog.tsx` (review), `ProfileAssembliesPanel.tsx` (Library), `AssemblyPreview.tsx`, `profileAssemblyActions.ts`, `RoleProfilesPanel.tsx`, `SidePanel.tsx` (member properties) |
| Assistant | `src/assistant/modules/profileAssemblies.ts` |
| Tests | `tests/profileAssemblies.test.ts` |

## 1. Data model

```ts
interface ProfileAssembly {
  id: Id;
  name: string;                 // "CW Mullion A"
  prefix?: string;              // assembly mark prefix ("MA"); absent: the role prefix
  basePoint?: string;           // note: "glazing line, front face of the back profile"
  components: ProfileAssemblyComponent[];
  main: string;                 // key of the main component (the main part)
  orientations?: { name: string; rotation: number; mirror?: boolean }[];  // other drawn orientations
  source?: string;              // file it came from
}

interface ProfileAssemblyComponent {
  key: string;                  // "c1" …
  name: string;                 // "Steel", "Gasket 2" …
  profile: string;              // a custom POLY profile in base-point coordinates, or a catalogue profile + offset
  offset?: Vec2;                // where the profile's insertion point (else box centre) sits from the base point
  material: string;             // S355, 6063 T6 … or a non-metal (EPDM, HDPE, PVC, Silicone, Neoprene, PA66 GF25)
  kind: 'structural' | 'cladding' | 'gasket' | 'shim' | 'accessory';
  fabricate: boolean;           // true: a part with NC and drawings; false: listed only
  lengthRule: ComponentLengthRule;
  finish?: Finish;              // default: the member's finish for steel, none for the rest
  layer?: string;               // source layer / block
}

type ComponentLengthRule =
  | { kind: 'full'; start?: number; end?: number }     // L + start + end (cap: −2 / −2)
  | { kind: 'percent'; percent: number }               // L × (1 + p/100) (gaskets +2 %)
  | { kind: 'pieces'; length: number; spacing?: number; edge?: number; at?: 'spacing' | 'nodes' };
```

- **Coordinates.** Every component is placed in the assembly's section drawing coordinates
  (x → member local y, y → member local z, [PROFILES.md §2](PROFILES.md)) with the base point
  at (0, 0). A DXF-uploaded component is a custom POLY profile named
  `<assembly> / <component>` whose vertices are in exactly those coordinates and whose
  insertion point is the base point. A catalogue profile can be a component too, placed by
  `offset`.
- **Where they live.** `project.library.profileAssemblies`; the component profiles are
  ordinary custom profiles in `project.library.profiles` (family `Assembly <name>`).
- **Members.** `Member.profileAssembly` names the assembly; `Member.profile` stays the main
  component's profile, so everything that needs one section (connections, end preparations,
  the properties panel, lists) keeps working. The composite applies only while the member's
  profile **is** the main profile: giving the member another profile (properties, Match,
  any tool) makes it a single profile again (`changeProfile` also clears the field).
- **Role profiles.** `RoleProfile.assembly` makes the role's members carry the assembly
  (`profile` is then the main profile).
- **Migration.** Projects without assemblies get `profileAssemblies: []`; stored assemblies are
  sanitised (`sanitizeProfileAssemblies`: unknown kinds → structural, missing rules → the
  kind's default, a missing main → the first component). Nothing about older members changes.

**Non-metals** (EPDM 1300, Silicone 1200, Neoprene 1300, PVC 1400, HDPE 950,
PA66 GF25 1300 kg/m³) are typical densities for listed components. They are not catalogue
materials, so their profile definitions carry no material.

## 2. Uploading an assembly detail (DXF)

Library → **Profile assemblies → Import assembly detail (DXF)…**, or **Import as profile
assembly…** in the profile import review of a DXF.

`parseAssemblyDxf(text, { fileName, unitScale, markerBlocks, clusterGap })`:

| Step | Rule |
| --- | --- |
| Reading | ASCII DXF, model space; blocks exploded (insertion, scale, mirror, rotation, nesting); OCS ±Z (extrusions within 10⁻⁴ of ±Z count as planar: CAD noise on mirrored inserts) |
| Base points | POINT entities (model space, or inside a marker block); **marker blocks** — a block named CP / BP / BASE (POINT) / INS(ERT) / REF / MARKER / ORIGIN / DATUM / WP, or whose definition is a small crosshair and / or circle (lines, circles, hatches only, within 50 units) — at their insertion point; circles on a layer named INS… / BP / CP / BASE / REF / DATUM. Points closer than 1 mm are one base point (a POINT's position wins). The review lists every inserted block with a *marker* tick |
| Outlines | Closed LWPOLYLINE / 2D POLYLINE (bulges kept as arcs), CIRCLE, and chains of LINE / ARC / open polylines **on one layer** (0.05 mm). Marker geometry is left out. Vertices closer than 0.1 µm are merged (`cleanLoop`) |
| Holes | Loops on one layer (and block) are nested by containment: a loop inside an outline is its hole (the steel box gets its hollow), a loop inside a hole is a new outline. Loops on other layers never become holes |
| Details | Outlines whose boxes are within `clusterGap` (5 mm) form clusters (single linkage); each cluster goes to the nearest base point (box distance). A cluster containing two base points is split outline by outline. A cluster further than max(100 mm, 1.5 × its size) from every base point is left unassigned. One detail = one base point with its outlines, in reading order (left to right) |
| No base point | One detail; the DXF origin when it lies near the drawing, else the box centre — the review says so |
| Layer → material, kind | `defaultLayerRule` on the block name (for block geometry) else the layer: *gasket / EPDM / rubber / seal / wedge / silicone* → EPDM gasket (listed, +2 %); *shim / pack* → HDPE shim (listed, 100 mm pieces every 600 mm, 150 from the ends); *thermal / break / polyamide* → PA66 GF25 accessory; *alu…extru / extru / profil* → 6063 T6 structural; *alu / aluminium* → 6063 T6 cladding; *steel / S355 / SHS / RHS* → S355 structural; layer *0* → HDPE shim; anything else → listed accessory |
| Turned copies | A detail whose outlines all match another detail turned by 0 / 90 / 180 / 270° (and / or mirrored) about their base points — same layer, area within 1 %, centroid within max(0.5 mm, 0.5 % of the size) — is a **duplicate** (`duplicateOf`). When at least half match it is **similar** (`similarTo`, with the layers that differ): usually its own assembly (e.g. the same glazing on another steel section) |
| Not read (reported) | REGION / 3DSOLID / BODY (ACIS), HATCH, DIMENSION, SPLINE, ELLIPSE, open contours (axis lines, leaders), tilted entities |

**Review dialog** (one tab per detail): preview with the base point (click an outline to find
it in the list), the base-point source, *Turn −90° / +90°* and *Flip* about the base point,
assembly name, mark prefix, base-point note, and the components: include, name, layer, material,
kind, area, kg/m, fabricate, length rule, main part (default: the largest-area fabricated
structural component), and the detail it belongs to (move an outline to another detail). For a
duplicate or similar detail: **Same assembly, other orientation** (default for duplicates; the
detail is saved as an orientation of the other one with its rotation), **Keep as its own
assembly** (default for similar details) or **Skip**. Units and marker blocks re-read the file
and keep the names, prefixes and turns.

**Save** (`buildDetailAssembly` + `addProfileAssembly`, one undo step): each component becomes a
POLY profile `<assembly> / <component>` (insertion point (0, 0) = the base point; the material
when it is a catalogue one), and the assembly is added (replacing one of the same name after
asking). Invalid outlines are listed and left out. The main component is always fabricated with
the full length.

## 3. Modelling

### 3.1 Placement on the wire line

`memberGeom` places the main component and `compositeParts` every other one with
`componentShift(m, mainProfile, mainComponent, component, profile)`:

```
ins(c)  = (profile.insertion ?? 0) − (c.offset ?? 0)     base point from the component's box centre
base    = (offsetY, offsetZ)                             alignMode 'insertion' or absent: BP on the wire line
base    = grid(main) + ins(main)                         alignMode 'grid': the main on its 3×3 grid, the rest follow
shift   = base − ins(c)                                  box centre of the component from the wire line (local y, z)
mirrored section: shift.y → −shift.y (the whole composite mirrors about local z)
```

Every component uses the member's frame (`memberAxes`: surface normal, rotation), its
extensions, connection trims and end preparations (re-evaluated on the component's own
section), then its length rule. A mirrored section is the plain part in the reversed frame, as
for single profiles ([ARCHITECTURE.md D33](ARCHITECTURE.md)). Assigning an assembly sets
`alignMode: 'insertion'`.

**Orientation.** Drawing y is the member's local z. On a vertical facade without surface normals
mullions have local z = +Y; transoms along +X have local y = +Y and local z = +Z, so a transom
detail drawn with its depth along drawing x needs rotation 0, and a mullion detail turned
for transoms needs the rotation reported for the copy (e.g. −90°). With surface normals
(wireframe check) local z points to the exterior: a detail drawn with the building side up
needs rotation 180° (or turn it in the review).

### 3.2 Parts, accessories and the assembly

| Component | Becomes |
| --- | --- |
| Main | The member's own part `m:<id>` (`component.main`, `assemblyMain`) |
| Fabricated, full / percent rule | A part `mc:<memberId>:<key>`, kind `member`, the member's id and role; length per the rule (`full`: start / end allowances move the cut planes) |
| Fabricated, pieces | One part per piece `mc:<memberId>:<key>:<n>` |
| Not fabricated | An **accessory** (`DerivedModel.accessories`): metres (`full` / `percent`, with the allowance) or pieces, its geometry per piece for 3D, IFC and drawings; never a part, so NC, numbering and part lists do not see it |

- All parts of a composite member are unioned into **one assembly** with the main component as
  main part (`compositeParts` links, unioned with the shop welds; manual assembly groups still
  work on top). Component parts are not welded: the drawing shows no weld symbols for them.
- **Pieces.** `rulePieces`: with a spacing, n = ⌊(L − 2·edge − length) / spacing⌋ + 1 pieces
  (at least one), centred on the part; `at: 'nodes'`: one centred at each node of a connection
  of the member, kept inside the part and at least a piece apart.
- **Mass.** Area × run length × the component material's density. Finish: the member's for
  steel components, none for the rest (the part drawing says *Mill finish*).
- **Numbering.** Component parts get part marks with the assembly's prefix in lower case
  (`ma1`, `ma2` …), else the role's. The assembly signature is the usual one (main mark plus the
  marks and placements of the other parts) plus the accessories (key, profile, quantity), so
  identical composite members share an assembly mark and the marks are stable.
- **Warnings.** A member whose assembly is missing, or whose profile is not the main profile:
  *"only <profile> is modelled"*.

### 3.3 Connections (decision)

Connections use the **main component's section** (the member's own `MemberGeom`): face
distances, trims, holes and cut-backs are those of the main component, normally the steel
box the bracket or cleat is bolted to. The union bounding box was not used because it would
move every fin plate and cleat to the face of the aluminium casing or cover, which is not what
carries the load. Consequences:

- connection holes are drilled in the main part only;
- other components are trimmed at the same planes as the member ends (plus their allowances);
  fitting a transom's aluminium to the mullion's outline is not modelled (use end allowances);
- check the connection geometry against the composite (e.g. a bracket stand-off chosen for a
  smaller tube, a fin plate through the casing).

### 3.4 Profiles by role and member properties

- Library → **Profiles by role**: under each role's profile picker, an assembly picker
  (*Single profile* or one entry per assembly and drawn orientation, e.g.
  *CW Mullion A · Transom (−90°)*). Choosing one sets the role profile to the main profile with
  the assembly, the insertion point and the orientation's rotation, asks whether to update the
  existing members, and shows the composite preview (turned by the role's rotation) with its
  base point. Picking a single profile clears the assembly.
- New members of the role (drawing, facade grid, role change) and **Apply** get it; the
  wireframe check gives unprofiled lines their role profile, assembly included.
- Properties → **Profile assembly (composite section)** on members; Library → *Profile
  assemblies* → **Assign to selected**.
- Library → *Profile assemblies*: preview, size, kg/m, members using it; **Components…** edits
  the name, prefix, base-point note, main component and per component material, kind,
  fabricate and length rule; × removes the assembly (members keep the main profile; component
  profiles nothing else uses are removed).

## 4. Outputs

| Output | What happens |
| --- | --- |
| 3D | Every component is drawn: parts as usual (instanced by profile), accessories as solids of their member (selecting the member highlights them; Isolate and assembly selection include them). Components are coloured by material: steel keeps the role colour, aluminium silver, rubber black, plastics amber |
| IFC4 | One `IfcElementAssembly` per assembly with one `IfcMember` (or `IfcBeam`) per fabricated component, arbitrary profiles (with voids); **accessories as `IfcBuildingElementProxy`** (ObjectType *Gasket* / *Shim*, pset `FacadeSteel_Accessory`), aggregated in the same assembly (decision: they are physical and matter for coordination and clashes; `includeAccessories: false` leaves them out). Non-metal `IfcMaterial`s keep their own description and category (Rubber / Plastic) |
| DSTV NC1 | Steel components: NC1 as every linear part (POLY → profile code **SO**, the outline as comment lines). Aluminium / non-steel components: **no NC1 by default** (`hasDstv`); fabrication setting `dstvAluminium: true` writes them too. The NC export adds `extrusions/cutting-list.csv` (mark, qty, profile, material, cut length, saw angles, kg, assemblies) and one `extrusions/<profile>.dxf` section per profile (base point as the insertion marker) |
| BOM | Component parts are parts. New tables (only when there are accessories): **Accessories** per assembly mark (item, kind, profile, material, unit, qty per assembly, total, rule, kg) and the **Gasket list** (totals per profile and material); sheets in the XLSX, `accessories.csv` and `gasket-list.csv` in the CSV ZIP |
| STEP / OBJ / 3dm, nesting, packing, MIS | Through the derived parts (accessories are not in STEP / OBJ or bar nesting; extrusions are nested like other bars) |

## 5. Drawings

- **Assembly drawing** of a composite member (`assemblyDrawing`, the set is generated as
  before): elevation and plan with every fabricated component and its balloon, and **section
  A–A** through every component and accessory (the cut goes through a packer when one is
  there), hatched **per material** (steel 45°, aluminium 135°, EPDM / rubber cross-hatched,
  plastics cross-hatched wide; thin walls blackened; adjacent parts of one material vary the
  spacing — ISO 128-50 leaves the patterns free, these follow common practice). The section is
  enlarged when it is small (ISO 5455: up to 90–150 mm on paper), the **base point (BP)** is
  marked and **running dimensions** (ISO 129-1) run from BP to the outer edges of the composite
  and of the main component, the overall size outside them.
- **Detail B**: when the small components around the base point (glazing profiles, gaskets) are
  tiny at the section's scale, they are drawn again at 2:1, 1:1 or 1:2 to the right of the
  section, clipped to their zone with a narrow frame, BP and running dimensions; the zone is
  circled on the section with the letter.
- Blocks: the parts list (component designations without the assembly name), a **Composite
  section** note (BP, hatching legend) and the **Accessories (not fabricated)** list (item, kind,
  material, qty, unit, rule).
- Entity ids: `section:component:<key>`, `detail:component:<key>`, `section:basepoint`,
  `section:detail-callout`, `dim:section:bp-…`, `dim:detail:bp-…` (edits can hide or move them).
- **Part drawings**: every fabricated component is a derived part, so it gets its own part
  drawing from the existing generator; POLY sections draw their outline and hollows in the
  section and end views (tested for every component).

## 6. Assistant (`src/assistant/modules/profileAssemblies.ts`)

| Tool | Does |
| --- | --- |
| `profile_assembly_list` | Assemblies with components (material, kind, fabricate, rule), size, kg/m, members and roles using them |
| `profile_assembly_import_dxf` | DXF text → details (base points, components, duplicates / similar); `dryRun: false` saves one assembly per detail (`names`, `prefixes`), turned copies merged as orientations unless `keepCopies` |
| `profile_assembly_assign` | To roles (role profile, `apply` updates their members) and / or members (`members` ids or `selection`), with a rotation; `""` clears |
| `profile_assembly_set` | Name, prefix, base-point note, main component, and per component name, material, kind, fabricate, length rule |

Every edit is one undo step.

## 7. Tests (`tests/profileAssemblies.test.ts`)

A synthetic DXF built in the test: two details of one composite (the second turned −90°), base
points by POINT + CP marker block and by marker block only, a hollow steel box, aluminium
profiles, a gasket with an arc, a shim block, a hatch, a region, a dimension and an axis line.
Covered: base points and markers, skipped entities, clustering, holes, layer mapping, duplicate
detection and relative orientation, assembly building in base-point coordinates, CAD-noise
cleaning, derivation on a vertical mullion and a sloped member with a surface normal (rotation,
mirror), end allowances, gasket metres with the allowance, shim pieces (spacing, nodes, as
parts), the single-profile fallback, role profiles, numbering (shared and stable marks), BOM,
NC1 / cutting list / DXF sections, IFC (re-read with web-ifc: assemblies, members, proxies,
aggregation), the assembly drawing (every component in section A–A, BP, dimensions, accessories,
layout check), part drawings of every component, library operations, migration, and the
assistant tools (size limits, import, assign, set, undo).

## 8. Limits

- **Connections** use the main component (§3.3); the other components are not fitted to their
  neighbours at joints, and connection parameters chosen for another section need checking.
- **Identical components** within a detail (left and right gaskets) are separate profiles, so
  they get separate marks and list lines; a catalogue profile with an offset can be shared by
  hand.
- **Components are placed unrotated**: a catalogue component is placed by its offset only; draw
  a turned one as a POLY component.
- **Main component** with an offset: end preparations against other members use the main
  profile's own insertion point for their centre line.
- **Turned copies** are matched in 90° steps; other angles are separate details. Partly matching
  details are reported as similar, not merged automatically.
- **DXF**: REGION / 3DSOLID (ACIS), SPLINE, ELLIPSE, HATCH boundaries and open contours are not
  read; outlines that cross themselves after cleaning are listed and left out.
- **Drawings**: the part drawing's general notes are the steel notes (EN 1090-2) also for
  aluminium components; check the extrusion standard (EN 755 / EN 12020) and finish on the
  sheet. Accessories appear in section A–A and detail B, not in the elevation and plan.
- **NC for aluminium** (`dstvAluminium`) uses the same DSTV SO conventions as steel; check
  them with the aluminium machine's post-processor. The cutting list does not include
  machining of extrusions (drainage slots, end milling).
- **Densities** of non-metals are typical; gasket masses are indicative.
- **Gaskets** are not in STEP / OBJ or clash detection (they are in IFC).
