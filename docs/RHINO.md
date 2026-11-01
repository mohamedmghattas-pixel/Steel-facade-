# Rhino .3dm import and export

Architects deliver Rhino. FacadeSteel reads and writes `.3dm` files in the
browser with **rhino3dm.js 8.35.0** (McNeel's official openNURBS build for
JavaScript / WebAssembly, MIT licence).

| Part | File |
| --- | --- |
| Engine loader (lazy, provider for browser / Node) | `src/core/io/rhinoLoader.ts`, browser loader in `src/viewer/rhinoReference.ts` |
| Reading a file (units, layers, blocks, curves, meshes, points) | `src/core/io/rhinoImport.ts` |
| Per-layer actions, summary, wire segments, reference set, panels, survey (pure) | `src/core/io/rhinoLayers.ts` |
| Segments → wireframe (shared with DXF) | `src/core/io/wireImport.ts` |
| Mesh reference models (blob format, clash elements) | `src/core/io/refMesh.ts` |
| Writing a file | `src/core/io/rhinoExport.ts` |
| Panel outlines → panels | `src/core/io/panelLayout.ts` (`panelLayoutFromOutlines`, `detectOutlinePlane`) |
| Commands, dialog state | `src/ui/rhinoActions.ts` |
| Dialogs | `src/ui/dialogs/RhinoDialogs.tsx` |
| 3D view of a Rhino reference | `src/viewer/rhinoReference.ts` |
| Assistant | `src/assistant/modules/rhino.ts` |
| Tests (rhino3dm in Node, synthetic files) | `tests/rhino3dm.test.ts` |

## 1. Where to find it

- **Import → Import Rhino (.3dm)…** opens the import dialog (§3).
- **Export → Rhino model (.3dm)** writes the model (§6).
- **Export → Export package…**: item *Rhino model* in `07-Model` as
  `{package} Model.3dm`; the imported `.3dm` itself goes to `00-References` with
  the other reference files (§7).
- **Import → Panel layout → sub-frame…**: *Rhino .3dm…* as a panel source (§4.3).
- **Import → Survey points…**: accepts `.3dm` (§4.4).
- **Assistant:** `rhino_import_summary`, `rhino_export` (§8).

## 2. Loading the engine

rhino3dm is about 75 kB of JavaScript (minified) and a 2.7 MB WebAssembly
module. Both are **dynamic imports**: nothing of the library is in the main
bundle; it loads the first time a `.3dm` is imported or exported (a few hundred
milliseconds), and so do FacadeSteel's own reader and writer
(`rhinoImport.ts`, `rhinoExport.ts`). The browser passes the bundled `.wasm`
URL to the module (`locateFile`), as it does for web-ifc. A test checks that the
app imports `rhino3dm` only dynamically and, after a build, that the main chunk
holds neither the library nor its wasm.

| Build | How the wasm is found |
| --- | --- |
| `npm run build` | `assets/rhino3dm-<hash>.wasm` next to the chunk |
| `npm run build:offline` | inlined as a `data:application/wasm` URL in `FacadeSteel.html` (about 14.4 MB in all, 3.5 MB of it rhino3dm); works from `file://` |
| Tests (Node) | the package's own loader reads `node_modules/rhino3dm/rhino3dm.wasm` |

The library's Emscripten glue requires the Node-only `ws` package on a code
path the browser never takes; the Vite configs replace it with an empty module
(`noNodeWs` in `vite.config.ts`).

## 3. Reading a file

`readRhino3dm(rhino, bytes, options)` reads the file once into plain data in
**world millimetres**; the WebAssembly objects are freed straight away, so the
dialog, the assistant and the per-layer logic work without the engine.

- **Units:** the model unit system (`settings().modelUnitSystem`): millimetres
  ×1, centimetres ×10, metres ×1000, inches ×25.4, feet ×304.8 and every other
  Rhino unit. A file without a length unit (or custom units) is read as
  millimetres with a warning. The dialog shows the file unit and can override
  it (the file is read again).
- **Layers:** full paths (`Parent::Child`), colours, visibility. A layer is
  visible only if its parents are. Hidden layers are unticked by default.
- **Objects:** name, layer, colour (object or layer), user strings (attribute
  user text and geometry user strings), hidden state. Hidden objects are
  skipped unless *Include hidden objects* is ticked.
- **Blocks:** every top-level `InstanceReference` is expanded through its
  `InstanceDefinition`, with the composed transform (nested blocks, rotation,
  scale, mirroring). Nesting stops at 16 levels and at a block that contains
  itself (reported). Block contents count on **their own layer** (Rhino's
  rule); *Block contents: on the instance's layer* is an option. They inherit
  the instance's name and user strings where they have none, and are hidden
  with an instance on a hidden layer. Each definition object is read once and
  placed per instance. Ids of block contents are `<instance id>/<object id>`.

### 3.1 Object types

| Rhino type | Becomes | How |
| --- | --- | --- |
| LineCurve | polyline (2 points) | end points |
| PolylineCurve, degree-1 NurbsCurve, PolyCurve of lines | polyline | its vertices (`tryGetPolyline`) |
| PolyCurve | polyline | segment by segment (`explode`) |
| NurbsCurve, ArcCurve, other curves | polyline | segmented so no chord is further than the **chord tolerance** (default 2 mm) from the curve: midpoint test, recursive subdivision, at least 4 samples per span |
| Mesh | triangles | quads split in two; double-precision vertices kept |
| Brep (polysurface, trimmed surface) | triangles | the render mesh stored with each face; see §3.2 without one |
| Extrusion | triangles | its stored render mesh; else as a Brep (`toBrep`) |
| Surface (NURBS, plane, revolution …) | triangles | as a single-face Brep |
| SubD | triangles | the control net (`Mesh.createFromSubDControlNet`, approximate); else bounding box |
| Point | point | location |
| PointCloud | points | every point |
| InstanceReference | its contents | §3 Blocks |
| Text, dimensions, leaders, text dots | — | skipped: *text and dimensions are not imported* |
| Hatch, Light | — | skipped with the reason |
| Clipping planes, details, others | — | skipped: *unsupported object type* |

Planar faces also give **panel outlines** (their outer trimmed loop), largest
first; a planar mesh gives its vertices.

### 3.2 Breps without render meshes

Rhino saves render meshes with each Brep face unless the file was saved with
*Save small* or written by a program without a mesher (rhino3dm.js has none).
For those faces FacadeSteel meshes the geometry itself:

1. **Planar faces:** the outer loop and the holes, each edge sampled by the
   chord tolerance, chained into polygons and triangulated by ear clipping in
   the face plane. Exact, trims and openings included.
2. **Curved faces:** the surface sampled on a UV grid, refined (up to 128 × 128)
   until the centre of every cell is within the chord tolerance of the grid's
   bilinear patch. Exact for untrimmed faces (extrusion walls, cylinders,
   lofts). **Trims and holes of curved faces are not applied** (the binding
   gives no access to the 2D trim curves or a closest point): those objects are
   marked approximate and counted in a warning.
3. **Anything that fails:** an axis-aligned bounding-box placeholder with a
   warning.

`Mesh.createFromBrep` does not exist in rhino3dm.js (it is a RhinoCompute
call). The dialog's summary shows how many reference objects have meshes from
the file, how many were tessellated (approximate) and how many are boxes.

## 4. The import dialog

| Field | Meaning |
| --- | --- |
| Units → mm | file units (shown) or an override |
| Chord tolerance | curves and meshless surfaces (default 2 mm) |
| Block contents | own layer / instance's layer (files with blocks) |
| Shift X / Y / Z, *Move model to origin* | added to every coordinate (site coordinates) |
| Layers | tick, objects by type, action, role and profile (wireframe) |
| Join tolerance, Split lines, Merge collinear pieces | the wireframe step, as for DXF |
| Include hidden objects | off by default |
| Keep the original .3dm with the project | on: the file is stored with the project and copied to `00-References` |
| Summary | what will be created; what is skipped and why |

### 4.1 Layers → actions

| Action | Takes | Creates |
| --- | --- | --- |
| **Wireframe** | curves | wireframe lines (role and profile of the layer; profile *none* = construction lines) |
| **Reference** | surfaces, polysurfaces, extrusions, meshes, SubD; curves | one reference model (kind `3dm`) of the file: triangles, and curves as reference lines |
| **Panels** | planar surfaces / faces, planar meshes, closed planar curves | panel outlines for *Panel layout → sub-frame* |
| **Survey** | points, point clouds | survey points (names from the object names; clouds `name-1`, `name-2` …) |
| **Ignore** | — | — |

Defaults: a layer with more curves than surfaces / meshes → *Wireframe*, with
surfaces or meshes → *Reference*, points only (or nothing usable) → *Ignore*;
hidden layers are unticked. The role is guessed from the layer name, as for DXF
(`mull` → mullion, `trans` → transom, `post` / `col` → post, `rail`, `brace`,
`brack`); everything else is *other* and the wireframe check sets it from the
topology. Objects that an action does not take are listed as skipped with the
reason (*not used on a Reference layer*, *panels need closed planar curves*,
*not planar (no panel outline)*, *hidden object*, *layer not imported* …).

**User strings win over the layer.** A curve with a `role` (a FacadeSteel role)
or `profile` (a known profile) user string keeps them, and a curve with a
FacadeSteel `memberId` stays its own line (never merged with its neighbours),
so a FacadeSteel export comes back line for line, with the same roles and
profiles, and with the same wireframe fingerprint (tested).

### 4.2 Wireframe

The curves of the wireframe layers become segments in world millimetres and go
through the **same step as a DXF import** (`importWireSegments`, shared): ends
within the join tolerance (2 mm) become one node, existing model nodes
included; duplicates and overlaps merge; *Merge collinear pieces* turns
polylines drawn with extra vertices into whole lines; *Split lines* is
*Mullion–transom junctions* by default, so nothing is split on import and the
**Wireframe check** opens next, scoped to the imported lines. Arcs stay chords
(see WIREFRAME_CHECK.md §13).

### 4.3 Reference model (kind `3dm`)

One reference per import, named like the file:

- **Storage:** the original `.3dm` bytes under the reference id, and the
  triangles and lines under `<id>.mesh` (both in IndexedDB, like IFC / DXF
  references). The mesh blob is `FSRM` + a JSON header + float32 positions
  relative to an origin (so site coordinates keep their precision) + uint32
  indices (`refMesh.ts`).
- **3D view:** translucent, double-sided, one draw call per colour; curves as
  lines; opacity, visibility and offset in *Model → Reference models*.
  **Snapping** works on the triangles (ray) and the vertices (up to 50,000).
- **Clash detection** reads every visible Rhino reference: one element per
  object (`3dm:<reference id>:<object id>`, type `Rhino Brep` …, the object
  name or layer). BCF viewpoints list the steel only (Rhino objects have no
  IFC GlobalId).
- **Surface orientation:** the exterior side's rule *away from the centre of
  the loaded reference models* uses Rhino references like IFC ones; after an
  import the wireframe check waits until the reference is in the 3D view.
- **Export package:** the original goes to `00-References` (item *Reference
  files*). With *Keep the original* ticked and no reference layer, the reference
  holds only the original file (hidden, *original file only*).

### 4.4 Panels and survey

- Panel outlines go to **Panel layout → sub-frame**, which opens next when no
  wireframe was imported (otherwise its source list offers *Rhino*). The dialog
  also reads a `.3dm` itself (*Rhino .3dm…*, all visible layers, with layer
  ticks) or a Rhino reference of the project. Each outline becomes its bounding
  rectangle in the facade plane; outlines more than 30° off the facade plane or
  further than 1.5 m from it are left out with a warning. The facade plane is
  suggested from the outline normals.
- Survey points replace or are added to the project's survey (a choice in the
  dialog). The survey dialog reads `.3dm` too: the points of one layer or of
  every visible layer.

## 5. Units and coordinates

FacadeSteel works in millimetres, Z up, X east, Y north — the same axes as
Rhino. Import multiplies by the unit factor and adds the shift; export writes
millimetres (`modelUnitSystem = Millimeters`, absolute tolerance 0.01 mm), so
Rhino opens the model at its true size and position.

## 6. Export

`exportRhino3dm(rhino, project, derived, options)`:

| Layer | Objects |
| --- | --- |
| `FacadeSteel::Wireframe` | one LineCurve per member (wire line) |
| `FacadeSteel::Members::<role>` | member parts (`mullion`, `transom`, `bracket` …), one mesh each |
| `FacadeSteel::Connections` | connection profile parts (cleats, angles …) |
| `FacadeSteel::Plates` | connection plates and free / bent plates |
| `FacadeSteel::Bolts` | bolts and anchors (shank + hex head mesh; anchors in their own colour) |
| `FacadeSteel::References::<name>` | optional: the visible Rhino reference models, meshes and curves |

Layer colours are the 3D view's role colours. Solids are **meshes** from the same
builders as OBJ / STEP (`core/export/meshes.ts` → `viewer/meshes.ts`: profile
extrusions, end preparations, copes, slots, plates with holes, bent plates),
double-precision vertices, normals computed. Extrusion objects were not used:
end cuts, copes and holes would be lost.

**Part objects** are named by their mark and carry these user strings:

| Key | Value |
| --- | --- |
| `mark`, `assembly` | part mark, assembly mark |
| `profile`, `material`, `finish` | as in the material list |
| `length` | mm (cut length; plates: bounding width), 0.1 mm |
| `weight` | kg, 0.01 kg |
| `role`, `kind` | member role (or `plate` / `cleat`), `member` / `profile` / `plate` |
| `phase`, `zone`, `batch` | names |
| `normal`, `rotation` | the member's surface normal (x,y,z) and section rotation (°) |
| `wireframeFingerprint` | the wireframe fingerprint at export (WIREFRAME_CHECK.md §8) |
| `partRef`, `memberId`, `connectionId` | FacadeSteel references |

**Wire lines** are named by the member name or part mark and carry `memberId`,
`role`, `profile` (empty for construction lines), `material`, `mark`,
`rotation`, `normal`, `startNode`, `endNode` and `sourceLayer` (the layer the
line came from).

**Bolts** carry `kind`, `size`, `grade`, `length`, `grip`, `connectionId`.

**Document user text:** `FacadeSteel.project`, `FacadeSteel.number`,
`FacadeSteel.units` (`mm`), `FacadeSteel.wireframeFingerprint`,
`FacadeSteel.exportedAt`.

**Assemblies as blocks** (option): one block definition `ASM <mark>` per
assembly mark — identical assemblies share it — holding the part meshes in the
main part's frame; one instance per assembly placed by that frame, on the main
part's layer, with `assembly`, `mainPart`, `parts`, `weight`, `phase`, `zone`,
`batch` and the fingerprint. Instance-specific part keys (`partRef`,
`memberId`) are then not written. Re-importing expands the blocks to the same
number of part meshes over the same extent (tested to 0.01 mm).

The dialog (*Export → Rhino model (.3dm)*) has *Wire lines*, *Bolts and
anchors*, *Assemblies as blocks* and *Rhino reference models*.

## 7. Export package

| Item | Folder (default template) | File |
| --- | --- | --- |
| *Rhino model* (`rhino-3dm`, category Models) | `07-Model` | `{package} Model.3dm` — wire lines, parts, bolts; no references |
| *Reference files* (`references`) | `00-References` | the imported `.3dm` as it was, e.g. `sample.3dm` |

## 8. Assistant

| Tool | What it does |
| --- | --- |
| `rhino_import_summary` | The file loaded in the import dialog: units, layers with object counts and their actions, what will be created and what is skipped. `layers` changes actions / roles / profiles; `includeHidden`, `keepOriginal`; `apply: true` imports (one undo step) and opens the wireframe check. |
| `rhino_export` | Downloads the `.3dm`; `wireframe`, `bolts`, `blocks`, `references`. |

## 9. Tests

`tests/rhino3dm.test.ts` builds every file with rhino3dm in Node:

- lines, a degree-1 NURBS mullion, a polyline transom and an arc on nested
  layers in metres → millimetres, layer paths / colours / visibility, chord
  deviation of the arc ≤ 2 mm, user strings, hidden objects, a skipped text dot;
- nested blocks with translation, rotation and scale → world coordinates, the
  depth guard, block contents on the instance's layer;
- planar surfaces and a closed polyline → panel outlines → panel layout and
  joints;
- points and a point cloud → survey points;
- a mesh (vertex count), a Brep with render meshes, Breps / extrusions / a
  cylinder without → tessellated within the tolerance; the blob round trip and
  clash elements;
- export → re-import: millimetres, layers, one mesh per part with its user
  strings, the same wire lines with roles, profiles and fingerprint; blocks;
- the export package item and the original in `00-References`;
- the assistant summary / apply;
- `rhino3dm` imported only dynamically; after a build, not in the main chunk.

## 10. Limits

- Trims and holes of **curved** faces without a render mesh are not applied
  (§3.2); planar faces are exact. Files saved with render meshes are exact to
  their meshes.
- SubD objects are shown by their control net.
- Curves are polylines: arcs and splines become chords within the chord
  tolerance and stay chords in the wireframe (WIREFRAME_CHECK.md §13).
- Text, dimensions, hatches, lights, clipping planes, details and annotation
  are not imported (counted in the summary). Materials, textures, linetypes,
  groups, named views and embedded files are not read.
- Layer visibility per viewport and per-viewport layer colours are ignored.
- Panels are bounding rectangles in a vertical facade plane (XZ or YZ), as for
  DXF and IFC panel layouts.
- The export is meshes (faceted), not NURBS solids; bolts are simplified
  (shank and hex head, no thread or nut).
- Instances in a block export keep part data that is the same for every
  assembly of a mark; per-instance part ids are only in the plain export.
- **rhino3dm.js typings** (8.35.0) differ from the binding in places; the code
  uses the binding: `BrepFace.setMesh(mesh, type)` (typed `(type, mesh)`),
  `new InstanceReference(definitionId, transform)` (no constructor typed),
  `Mesh.createFromSubDControlNet(subd)` (typed without arguments),
  `File3dmStringTable.get / getvalue(key)` (typed with an index),
  `Transform.rotation(angle, axis, centre)` (typed with sine and cosine),
  `BrepLoopType` (exported but not typed on the module).
- The 3D view, snapping and clash detection hold the whole mesh in memory;
  very large architectural models (millions of triangles) are slow — import
  only the layers you need as reference.
