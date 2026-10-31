# Model management, interoperability and performance

This document covers marks and mark locking, erection phases / zones / delivery
batches, clash detection with BCF issues, DWG handling, editable steel from
IFC, sub-frames from panel layouts, and the large-model work in the 3D view.
Pure logic is in `src/core/management`, `src/core/clash` and `src/core/io`; the
UI is in `src/ui/dialogs/ManagementDialogs.tsx` and `src/ui/managementActions.ts`;
assistant tools are in `src/assistant/modules/management.ts`.

## 1. Marks, manual marks and mark locking

Numbering (`number()` in `src/core/derive/model.ts`) is unchanged: identical
parts share a part mark, and identical assemblies share an assembly mark. An
assembly is identified by its main part mark plus the marks and placements of
its secondary parts relative to the main part.

**Manual marks.** `Member.markOverride` forces the mark of the member's assembly
(the main member's override wins, else the first one on the assembly's other
members). Automatic numbering skips manual marks, so an override such as `M2`
is never handed out twice. Identical assemblies without an override keep their
automatic mark. If the same mark ends up on assemblies that differ, the model
shows a warning.

**Mark locking.** *Manage → Lock marks* (or the button in Properties) stores
these entries in `Project.markLocks`:

| key | value |
| --- | --- |
| `P\|<part signature>` | part mark |
| `A\|<assembly signature>` | assembly mark |
| `I\|<main part ref>` | assembly mark (identity, e.g. `I\|m:<memberId>`) |

During numbering, a signature found in the locks keeps its locked mark. Every
locked mark stays reserved, even when its assembly is deleted, so it is never
reused for something else. New signatures get the next free number. If an
assembly's identity is locked but its signature changed (for example, it was
extended or got a different hole), it gets a new mark, `Assembly.lock = 'changed'`,
`Assembly.lockedMark = <old mark>`, and the warning *"Assembly M3 changed since
the marks were locked — it is now M7."* Identical siblings that did not change
keep `M3`. *Re-lock* accepts the current marks; *Unlock* returns to automatic
numbering.

`Assembly.lock` is one of `locked`, `changed`, `new` or `manual`. The Properties
panel shows it next to the assembly mark.

Limit: when marks are locked, the part order of new parts follows the usual
numbering order. That order only affects which free numbers new parts get.

## 2. Phases, zones and delivery batches

- `Project.phases` hold the erection sequence (`sequence` 1..n) and an optional
  colour. `Project.batches` hold delivery batches with an optional date and
  phase. A zone is free text on a member.
- Ops in `src/core/management/grouping.ts`: `addPhase`, `updatePhase`,
  `deletePhase`, `movePhase`, `addBatch`, `updateBatch`, `deleteBatch`,
  `moveBatch` and `setGrouping` (assign or clear on members). Deleting a phase
  or batch clears it on members and plates.
- **Derived model.** `Assembly.phase/zone/batch` come from the main part's
  member. For a loose connection assembly such as a slab bracket, that is the
  connection's secondary member (else its main member). Every part of the
  assembly carries the same values in `Part.phase/zone/batch`, so drawings,
  lists and fabrication can group by them.
- **UI.** Use *Manage → Phases, zones and batches…* to create, rename,
  recolour, reorder and delete, and to see member counts and kg. Each row has
  *Select*, *Filter* and *Assign sel.* buttons. The Properties panel has
  Phase, Delivery batch and Zone fields. In the viewport, *Colour: role /
  phase / delivery batch / zone* sets the colouring and shows a legend.
- **Selection filter.** `store.selectFilter` restricts picking and box select
  to matching members, and to connections that have a matching member. While
  it is on, a chip in the viewport shows it; click × to clear it.

## 3. Clash detection and BCF

**Steel solids** (`src/core/clash/solids.ts`). Each part becomes oriented boxes
in its own frame:

- Linear parts are split into their plate elements: I, U and T sections are
  flanges plus web, L sections are two legs, and C and Z sections are web,
  flanges and lips. The open side of an angle or channel therefore does not
  count as steel.
- Hollow sections, round sections and flats are one box.
- Plates are their outline's bounding rectangle × thickness.

**Reference elements** (`src/core/clash/ifcElements.ts`). Every physical
element of each *visible* IFC reference model becomes a triangle soup in world
millimetres, with the reference's offset applied. The triangles come from
web-ifc (Y-up metres → Z-up mm). Spaces, openings, grids, annotations and
spatial structure are skipped.

**Algorithm** (`src/core/clash/detect.ts`):

1. **Broad phase.** A BVH (`src/core/clash/bvh.ts`, midpoint split with a
   median fallback) over all reference triangles. Each part's AABB, grown by
   the clearance, is queried against it. A second BVH over element AABBs finds
   elements a part may be fully embedded in. Steel against steel uses a BVH
   over part AABBs.
2. **Hard clash.** Exact separating-axis tests: box–triangle with 13 axes and
   box–box with 15 axes. The depth is the smallest overlap over the axes. If a
   box centre is inside a closed element (ray parity), the depth is the
   distance to get the box out. Overlaps up to `touchTolerance` (default 1 mm)
   count as touching.
3. **Clearance.** For pairs without a hard clash, the exact box–triangle
   distance is computed: vertex–box, box corner–triangle and the 36
   edge–edge pairs. A distance below `Project.clashes.clearance` is a
   clearance issue, with the gap stored in `distance`. Parts of connections
   without a main member (slab brackets, base plates) bear on the concrete,
   so they are only checked for hard clashes.
4. **Steel against steel** (on by default). These pairs are skipped as
   intended joints: parts in the same assembly (welded); parts in the same
   connection (bolted or welded together, including that connection's
   members); a connection part and a member ending at the connection's node;
   and members that share a wireframe node.

**Issues.** `ClashIssue.id = clash-<hash(a|b)>` is stable per pair and does not
depend on the order of the pair. On re-run, a known pair keeps its id, BCF
GUID, status, comment and creation date. An issue that no longer occurs is set
to *resolved*. A resolved issue that comes back is reopened. *Ignored* issues
stay ignored. Steel objects are part refs (`m:<member>`, `c:<connection>:<key>`).
Reference objects are `ifc:<referenceId>:<GlobalId>`.

**Outputs → Clashes** has *Run / Re-run* and settings for clearance, touch
tolerance and steel against steel. The list shows status, kind, issue,
location (level, grid), the model it is against, depth or gap, and a comment.
*Zoom* selects the steel, aims the camera at the clash and places a marker.
Other buttons: *BCF (open)*, *BCF (all)* and *Clear resolved*. *Manage → Clash
detection* runs it directly.

**BCF 2.1** (`src/core/io/bcf.ts`). The `.bcfzip` contains:

- `bcf.version` and `project.bcfp`;
- one folder per topic (named by the topic GUID) with `markup.bcf` (header
  file reference, topic, description and the comment if there is one) and
  `viewpoint.bcfv`.

The viewpoint is a perspective camera 2.5 m from the clash, looking at it from
the south-west and above. Coordinates are in metres. Its `Components`
selection and colouring list the steel parts and the reference element.

**Deterministic GUIDs** (`src/core/io/guid.ts`). `exportIfc` writes GlobalIds
from a 128-bit hash, so re-exports are stable and BCF components match:

| entity | seed |
| --- | --- |
| part | project id + part ref (`partGuid`) |
| assembly | project id + main part ref (`assemblyGuid`) |
| project, site, building, storeys, bolts | project id + their own key |

Relationships and property sets still get random GlobalIds. BCF components of
steel parts are therefore the GlobalIds of *Export → IFC model* of the same
project.

Limits:

- Steel uses boxes per plate element, not triangulated meshes. Root radii,
  rounded corners and holes are not modelled, so curved sections are slightly
  conservative.
- Bolts and anchors are not checked.
- Open (non-closed) reference meshes cannot report full embedding.
- DXF references are linework and are not checked.

## 4. DWG import

There is no permissively licensed browser DWG reader. LibreDWG is GPL-3.0 and
is deliberately not included. *Import → DXF / DWG* accepts both file types:

- `detectDwg` reads the six-character version header (`AC1032` …), reports
  the AutoCAD release (R9 … 2018–2025) and flags unknown versions.
- With no converter registered, a dialog explains how to convert the file with
  ODA File Converter (free), AutoCAD / AutoCAD LT, BricsCAD, or
  DraftSight / progeCAD / ZWCAD.
- Binary DXF is detected too, and you are asked to save it as ASCII.
- `registerDwgConverter({ name, supports(info), toDxf(bytes, info) })` plugs in
  a licensed converter (ODA SDK, a server endpoint and so on). With one
  registered, DWG files go straight into the DXF import dialog.

## 5. Editable steel from IFC

Use *Import → IFC steel → editable members…* with a file or with one of the
project's IFC reference models. The importer is `src/core/io/ifcImport.ts`.

- **Elements.** IfcBeam, IfcColumn and IfcMember (and their `StandardCase`
  subtypes) become members. IfcPlate becomes a `FreePlate` (outline, holes,
  thickness, frame); the modelling tools turn free plates into parts.
- **Units.** The length unit comes from IfcUnitAssignment (SI prefixes and
  conversion-based units such as inch or foot).
- **Placement.** The IfcLocalPlacement chain × the representation item
  transforms × the IfcExtrudedAreaSolid position.
  - IfcMappedItem: the mapping target × the mapping origin.
  - IfcBooleanClippingResult / IfcBooleanResult: the first operand.
  - The member axis runs through the profile centre (the profile position)
    along ExtrudedDirection × Depth. Downward extrusions are flipped so the
    section is not mirrored.
  - The rotation about the axis follows from the profile X direction, relative
    to FacadeSteel's default member axes.
  - Without a swept solid (for example a Brep), the `Axis` representation is
    used, as Tekla and Revit write it. The profile then comes from the material
    profile set, ObjectType or a `Profile` property, and a warning asks you to
    check the rotation.
- **Profiles**, in this order:
  1. Library name. Tekla style names such as `SHS100*100*5`, `HEA200` and
     `PL10*200` are accepted. A name match is only used if the dimensions
     agree.
  2. Section type and dimensions: h and b within 0.6 mm, thicknesses within
     0.25 mm. RHS and flats are also tried rotated by 90°.
  3. A new custom profile from the IfcProfileDef parameters, added to
     `project.library.profiles`. Supported types: I, U, L, T, rectangle
     hollow, circle hollow, circle, rectangle, lipped C, and derived profiles.
     Arbitrary profiles must match by name; otherwise the member is imported
     as a wireframe line with a warning.
- **Material** from IfcRelAssociatesMaterial (IfcMaterial, profile or layer
  set usages, lists and constituents). It is matched against the material
  library by name, by token, or by grade (`S355JR` → S355). Otherwise the
  project default is used and a warning is shown.
- **Role** from FacadeSteel's own `Role` property, then IfcColumn → post,
  IfcBeam → beam, the member PredefinedType (MULLION, POST, BRACE …), then the
  direction.
- *Skip FacadeSteel connection parts* drops elements tagged `c:…` when you
  re-import FacadeSteel's own export, because connections are re-created by
  rules.
- **Round trip** (tested). The sample is exported with `exportIfc` and then
  imported. The result has the same member count, lengths, profiles, roles and
  materials, and identical frames (origin, axis and section orientation).
  Connection plates come back as free plates with the same thickness, area and
  holes.

Limits: Brep-only elements without an axis are skipped and reported. Tapered
or oblique extrusions are imported along their direction. Non-circular,
non-slot plate cut-outs are reported and left out. IfcGridPlacement is not
supported.

## 6. Sub-frame from the panel layout

Use *Import → Panel layout → sub-frame…*. The logic is in
`src/core/io/panelLayout.ts`.

**Sources:**

- **DXF:** closed LWPOLYLINE / POLYLINE entities are panels (their bounding
  rectangle). LINEs and open polylines on joint layers are joint lines. By
  default, joint layers are those whose name contains *joint*, *fuge* or
  *jnt*, and they can be ticked in the dialog. If the file has no panels and
  no joint layer, all lines are joints. Units come from `$INSUNITS`, plus a
  shift.
- **IFC:** IfcPlate, IfcCovering, IfcCurtainWall and building element proxies
  near the facade plane (within 1.5 m along its normal) become bounding
  rectangles in the plane. IfcMember elements and slender strips become joint
  lines. `detectFacadePlane` suggests the plane and the panels' back face.

**Joints.** Panel edges and lines within the tolerance (default 30 mm) merge.
An open joint between two panels becomes one line at its centre. Collinear
pieces join across crossing joints. Joints with panels on one side only are
marked *perimeter*; *Frame the outer edges* includes them.

**Members.** Mullions go on vertical joints and transoms on horizontal joints,
on the chosen plane (XZ or YZ). They sit behind the panel face by the cavity
("behind" is away from the front or side view; it can be flipped).

- Transoms are cut at the mullions by default; you can also split both, or
  neither.
- Profiles come from the project's auto-assign rules. Rotations follow the
  facade-grid convention: transom depth is normal to the facade.

The dialog shows a preview drawing and counts (panels, mullions, transom lines,
perimeter lines, total length).

## 7. Large models

- **Derivation.** On 100k members with 100k brackets (200k parts), derivation
  went from 7.7 s to 3.5 s in Node, with identical results (verified against
  the previous implementation). The main costs were the numbering sorts,
  which used `localeCompare` with options (one collator per comparison); they
  now use cached `Intl.Collator`s. Union-find got path compression, which
  keeps long weld chains linear. What remains scales linearly and is mostly
  allocation. Benchmark test: 20k members plus 10k brackets in < 15 s
  (`tests/spatial.test.ts`); about 1 s in practice.
- **Rendering** (`src/viewer/Viewer.ts`, `meshes.ts`):
  - Parts with the same geometry signature (`partGeometryKey`: profile for
    square-cut members, which are unit length and scaled by the instance
    matrix; profile + length + preps for prepared ends; thickness + outline +
    holes for plates) are one `InstancedMesh`. Colours (role, phase, batch,
    zone, selection) are instance colours, so selecting or recolouring never
    rebuilds geometry.
  - Geometries used once are merged into one mesh per group, with vertex
    colours and per-part vertex ranges.
  - Edges of instanced parts are drawn by one `LineSegments` per geometry with
    an instanced-matrix shader. Above 20k parts, edges are off.
  - Above 15k parts, a level of detail applies: sharp-cornered profiles,
    8-sided tubes, plates without holes, and 4-sided bolts (about a fifth of
    the triangles).
  - Wire lines are three batched line sets (with profile, without, selected).
  - Above 1500 members, mark labels are shown for the selection only.
- **Spatial index** (`src/viewer/spatial.ts`). BVHs over nodes, wire segments
  and part / bolt boxes are queried with camera frusta built from screen
  rectangles (snap radius, pick radius, box select) and with rays (solid
  picking with an exact raycast on candidates only). This replaces the linear
  scans in snapping, picking and box select.
- **Measured** in headless Chromium with software WebGL, on 48k members /
  24k brackets (~120k parts):
  - opening and building the scene: 2.4 s of JavaScript;
  - box select of 40k members: 0.7 s;
  - a pick: ~0.1 s.

  The remaining time per frame is software rasterisation; GPUs draw this in
  real time.

Limits:

- The scene is rebuilt on every model edit. It is linear but not incremental:
  about 1–2 s at 100k parts.
- Snapping to reference IFC meshes still uses three.js raycasting of the
  reference meshes.

## 8. Assistant tools

`src/assistant/modules/management.ts`:

| tool | does |
| --- | --- |
| `manage_phases_batches` | list / add / update / delete / reorder phases and batches |
| `assign_phase_zone_batch` | assign by member filter (ids, selection, role, profile, phase, zone, batch); colour by; selection filter; select |
| `assembly_marks` | status, lock, unlock, manual mark override |
| `clash_detection` | run (with clearance / steel–steel), list, set status + comment, export BCF |
| `import_panel_layout` | DXF text → preview counts or mullions / transoms |
| `ifc_steel_import` | summary of the steel in an IFC reference model (or IFC text); `apply` imports it |
