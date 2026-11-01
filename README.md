# FacadeSteel

A browser-based steel detailing tool for **facade secondary steel**: the brackets, mullions, transoms, rails, posts and bracing that carry cladding back to a concrete or main-steel frame. It aims to do the parts of Tekla that facade sub-frames need, with far less setup.

Everything runs in the browser. There is no server: projects autosave to the browser and can be saved and opened as `.json` files.

**Talk to it.** The **Assistant** tab (or press `/`) lets you operate the whole application in plain language. For example: "create a 4-bay, 2-storey facade with SHS 100 mullions", "put end plates on the selected rails", "check edge distances and fix them", "issue all drawings for approval".
- In a normal browser tab it runs on Claude (`claude-opus-5-5`) with your own Anthropic API key, which is stored only in your browser.
- Opened as a claude.ai artifact, it uses the viewer's own Claude account instead, with no key needed.
- Every change it makes can be undone like a normal edit.

## Run it

**One file, no installation.** `npm run build:offline` produces `dist-offline/FacadeSteel.html` (about 10 MB). Everything is embedded in it: the code, the IFC engine (WebAssembly) and the PDF reader. Copy the file anywhere and double-click it to open it in Chrome or Edge.
- It works offline.
- Projects autosave in that browser; use File → Save project to keep a `.json` copy.
- The chat assistant needs an internet connection and an Anthropic API key.

**From source (for development).** Install [Node.js](https://nodejs.org) 22 or newer, then:

```bash
git clone https://github.com/mohamedmghattas-pixel/Steel-facade-.git
cd Steel-facade-
npm install
npm run dev        # then open http://localhost:5173
```

You can also download the repository as a ZIP (GitHub → Code → Download ZIP), unzip it, and run the last two commands in that folder.

**As a claude.ai artifact.** `npm run build` produces `dist/`, which can be published as a multi-file artifact with the `downloads` and `sample` capabilities:
- Exports are saved through the viewer's confirmation. Formats claude.ai does not accept (IFC, DXF) arrive inside a `.zip`.
- The assistant runs on the viewer's Claude account.

**GitHub Pages.** See *Development* below.

## Workflow

1. **Reference.** Bring in what you design against:
   - **IFC** concrete or main-steel models from Revit or Tekla, shown translucent and snappable.
   - **DXF** architect or shop drawings, imported either as wireframe lines or as reference linework.
   - **PDF or image** shop drawings as an underlay you can calibrate and trace over.
2. **Wireframe.** Draw centre lines on a work plane: XZ or YZ elevations, or the XY plan.
   - **Line** and **Polyline** tools with snapping to ends, midpoints, grid and reference geometry.
   - Typed coordinates: `x,y,z` for world, `u,v` for work-plane, `@dx,dy` for relative, or a single length.
   - **Facade grid** generates every mullion and transom from bay widths and row heights.
   - **Wireframe check** (Manage menu, or the status chip next to the project name) cleans an imported or drawn wireframe: whole lines, cut only where mullions and transoms meet, roles set, profiles turned perpendicular to the facade surface, stack joints kept, issues listed, and the client's confirmation recorded. See *Wireframe check* below.
3. **Members.** Assign profiles from the **EN** and **AISC** libraries by hand, or let **Auto-assign** pick by direction, DXF layer or role. Then set rotation, face alignment, offsets and extensions.
   - **Orient profiles to surface** (Members → *Orient*, Manage menu, member properties, or the assistant's `orient_to_surface`): profiles are always perpendicular to the facade. The surfaces are found from where mullions and transoms meet, so sloped, V-shaped, folded and curved facades work: every section's depth (local z) follows the surface normal and its width lies in the surface. Fold members between two surface patches get the bisector (or follow one patch), brackets get their depth along the mullion they stand on, and the exterior side can be flipped for the whole model or per patch.
   - **Custom profiles:** draw your own section in the **profile sketcher** (outlines, holes, thin walls with bend radii, fillets, mirror, typed coordinates), or upload them from **DXF** (closed polylines with holes), JSON or CSV. Each can carry an **insertion point**, the point the wire line runs through.
   - **Profiles by role:** give mullions, transoms and the other roles their own profile in Library → *Profiles by role*, and apply it to all members of a role at once. See [docs/PROFILES.md](docs/PROFILES.md).
   - **Modify:** join (collinear, corner, T), split (point, distance, N parts, stock lengths, level / grid / plane, crossings), extend / trim (distance, length, to a member's axis or face, to a plane), break with a gap, stretch an end, rotate / mirror / offset, reverse, and section operations (rotate, flip, mirror section, next / previous size, match properties). Each is a tool in the rail's *Modify* group with a 3D preview and typed input, in the right-click menu on members and in Properties → *Operations*. See [docs/MODIFY.md](docs/MODIFY.md).
4. **Connections.** Parametric joints that create plates, bolts, anchors, holes and cut-backs.
   - **Steel to concrete:**
     - Slab bracket (edge or top mount, with slotted fin and anchors)
     - Base / wall plate
     - Anchor types: expansion, bonded, screw, cast-in channel, undercut
   - **Steel to steel:**
     - Angle cleat
     - Fin plate or knife plate
     - End plate
     - Splice plates
     - Welded joint
   - **Custom connections:** build your own from plates and bolt groups whose sizes and positions are formulas, e.g. `b_sec + 2*(edge + 25)`. Save them to the project library and apply them anywhere.
   - **Applying connections:**
     - **Apply** puts a connection type, preset or custom template on every relevant end of the selected members.
     - **Presets** save a parameter set.
     - Editing a parameter changes every selected connection of that type.
     - **Auto-connect** places connections by rule.
5. **Assemblies.** Parts shop-welded together form an assembly automatically. You can also group members, plates and connections into a shipping assembly by hand (a mullion with its transoms, a pre-assembled bracket): *Create assembly / Add to / Remove from / Explode / Set main part* in the right-click menu, Properties and Outputs → *Assemblies*. Grouped members joined by a bolted joint stay bolted; the joint is made in the shop.
   - **Part / Assembly selection** (toolbar or `A`; Alt+click in Part mode) selects whole assemblies, highlighted in pink; **Isolate** (`I`) shows only them.
   - **3D ↔ drawings:** right-click a part → *Open part drawing*, *Open assembly drawing*, *Show on GA / erection sheet* (the zone sheet that shows it, mark highlighted). In the Drawings tab, *Show in 3D* selects and zooms to the sheet's parts (*1 of N* steps through instances); clicking a mark, balloon, list row or part outline selects it in 3D, double-clicking a mark opens its drawing. See [docs/ASSEMBLIES.md](docs/ASSEMBLIES.md).
6. **Outputs.** Parts and assemblies are numbered automatically, with identical items sharing a mark.
   - IFC4 model export
   - Material lists (XLSX, or CSV in a zip)
   - Cut optimisation for bars (1D) and plates (2D nesting)
   - A numbered drawing set (PDF / DXF) to ISO drawing standards: drawing register, GA, assembly and part drawings with revision tables, cross-references, hole tables and machining steps. See [docs/DRAWING_STANDARDS.md](docs/DRAWING_STANDARDS.md).
     - **Sheet layout:** one layout engine places every view, table, legend and note clear of each other and of the title block; long tables continue on sheet 2/N of the same drawing, and a layout check (overlaps, frame, lettering heights, overlapping marks) runs on every sheet, with warnings in the Drawings tab.
     - **Large facades:** GA elevations and plans and erection sequences that are not legible on one sheet are divided into zones at a legible ISO scale — at grid lines, else member lines — one sheet per zone with a key plan, match lines (*SEE DRAWING …*) and only that zone's assemblies. Inclined or folded (V-shaped) facades are drawn normal to each facade plane in true shape. Marks are placed without overlapping (leaders where needed). Settings under *Drawing settings → Large facades — zones*; A1 is suggested for big facades.
   - DSTV NC1 files for CNC
   - Checks (warnings, clashing bolt holes, unassigned lines)
   - **Export package** (Export → Export package…): every output in one package folder (`{project}-{code}-{seq}-{rev}`, default layout `00-References` … `10-Quality Check List`) with a combined bookmarked PDF, STEP / OBJ models, QAF / VCF forms (filled into your own workbook if uploaded) and a README manifest; to a folder or as one ZIP, from an editable, shareable template. See [docs/EXPORT_PACKAGE.md](docs/EXPORT_PACKAGE.md).

Mouse: right-drag orbits, middle-drag (or Shift + right-drag) pans, the wheel zooms.

Keys:
- `S` select, `L` line, `P` polyline
- `M` move, `C` copy
- `O` ortho, `F` fit
- `A` Part / Assembly selection mode, `I` isolate the selected assemblies
- `1`–`4` views
- `Del` delete, `Esc` cancel
- `Ctrl+Z` / `Ctrl+Y` undo / redo

## DXF import

Import → **DXF / DWG → wireframe or reference…** reads ASCII DXF (R12 to 2018) into wireframe lines or snappable reference linework.

- **What is read:** LINE, LWPOLYLINE, 2D and 3D POLYLINE, ARC, ELLIPSE and polyline bulges, and block INSERTs. Optional: CIRCLE, SPLINE, and mesh edges (3DFACE, polyface / polygon mesh, MESH). Shared mesh edges are imported once.
- **What is skipped:** text, dimensions, hatches, points, ACIS solids and surfaces (3DSOLID, REGION, SURFACE), XREFs and paper-space entities. The dialog lists every entity type it read or skipped, and why.
- **3D mode:** a drawing with any Z extent or a tilted entity is detected as 3D and keeps its X/Y/Z (with an X/Y/Z shift). 2D drawings are placed on the XZ, YZ or XY work plane as before. The mode can be switched in the dialog.
- **Blocks:** INSERTs are expanded recursively, including nested blocks, base point, X/Y/Z scale (mirrored too), rotation, the insert's extrusion and MINSERT arrays. Entities on layer 0 inside a block take the insert's layer.
- **OCS:** LWPOLYLINE, 2D POLYLINE, ARC, CIRCLE and INSERT coordinates are converted from their Object Coordinate System (DXF arbitrary-axis algorithm, elevation along the extrusion direction). An elevation drawn in a rotated UCS therefore lands in the right plane.
- **Curves:** arcs become straight chords no more than the *arc chord deviation* (default 2 mm) from the curve. Splines follow the NURBS from their control points, or a cubic through the fit points.
- **Join tolerance (default 2 mm):** endpoints closer than this become one node, including existing model nodes. Exact duplicates and overlapping collinear lines are merged.
- **Whole lines (default on):** *Merge collinear polyline pieces* turns a polyline drawn as one straight line with extra vertices into one line.
- **Split lines:** *Mullion–transom junctions only* (default, recommended) splits nothing on import; the Wireframe check opens next, scoped to the imported lines, and proposes cuts only where mullions and transoms meet, for review and confirmation. *Every crossing* breaks lines where they really cross in 3D or where another line ends on them (skew lines that only cross in a projection stay whole). *None* keeps the lines as drawn.
- **Units:** taken from `$INSUNITS` (in, ft, yd, mm, cm, dm, m), else from `$MEASUREMENT`, and can be overridden. *Move drawing to origin* helps with drawings in site coordinates.

Importing 20 000 segments, with joining and splitting, takes well under a second.

## Wireframe check

Manage → **Wireframe check…**, the status chip next to the project name, or the assistant (`wireframe_check`, `wireframe_apply`, `wireframe_status`; `orient_to_surface` and `surface_info` for the orientation alone). It opens on its own after a wireframe DXF import.

- **Whole lines.** Pieces that continue straight through a node become one line. A split is kept only where a mullion and a transom meet, where a connection sits, or where the two pieces differ (profile, material, rotation …; listed for review).
- **Junctions.** A line end whose own axis, extended or trimmed by up to 50 mm, meets another line within the junction tolerance (default 10 mm, the 3D gap between the axes) is snapped onto that axis. Ends that meet one line at one point become one node. Mullions are cut where transoms meet them (switch: *Keep mullions continuous*, then transom ends sit on the mullion as through-nodes); transoms are cut where a mullion crosses them or ends on them.
- **Roles from topology.** The line that receives other lines' ends is the mullion, the lines that end on it are transoms; this works on sloped and V-shaped facades where nothing is vertical. Direction (45° from horizontal), roles already set and length break ties. Short lines with one end on a mullion and the other free are brackets. Each line gets a reason.
- **Orientation (perpendicular to the surface).** Surface patches come from the mullion–transom junctions; every member whose section depth is more than 2° off the surface normal is proposed (accepted by default) and gets the surface normal. The dialog shows the patches, fold members and members left as they are, normal arrows and patch tints in the 3D preview, and *Flip exterior side* (whole model or per patch).
- **Stack joints (kept).** Collinear gaps of 10–60 mm (a setting) between two lengths of one family are listed as kept stack joints, with their sizes and zoom-to; they are never closed and are not issues.
- **Issues for review:** isolated lines (made construction lines or deleted, as chosen), near-misses (10–100 mm, never auto-joined), dangling transom ends, very short lines, duplicates and overlaps, crossings without a node, collinear gaps outside the stack-joint range.
- **Review and confirm.** The dialog shows counts before → after, every change grouped with checkboxes and zoom-to, and a coloured 3D preview (role colours, yellow cuts, red issues). *Apply and confirm* applies the ticked changes as one undo step and records who confirmed (with a note) against a fingerprint of the wireframe. The chip then reads *verified*, turns to *changed* after any edit to node positions, member ends, roles, profiles or the orientation of oriented members, and back to *verified* on undo. *Issue drawings* reminds you when the wireframe is not verified.

Details, rules and limits: [docs/WIREFRAME_CHECK.md](docs/WIREFRAME_CHECK.md). A 21,600-member fragmented facade is checked in about 2 s and cleaned in under 1 s.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (Vitest)
npm run build      # type-check + production build into dist/
```

`.github/workflows/deploy.yml` runs the tests and build on every push and pull request. Pushes to `main` are also published to GitHub Pages once two settings are in place:
- Pages is enabled with the source set to *GitHub Actions*.
- The `github-pages` environment (Settings → Environments) allows deployments from `main`.

## Architecture

```
src/core/            pure TypeScript, no DOM, unit-tested
  model/             types, geometry, wireframe operations, facade grid generator
  wireframe/         wireframe check: whole lines, junction cuts, roles, issues, stack joints, surfaces and
                     orientation (profiles perpendicular to the facade), confirmation fingerprint
  library/           EN + AISC profiles, section properties, materials, bolts
  connections/       parametric connection definitions + rule-based auto-connect
  derive/            wireframe + connections → parts, holes, assemblies, marks, weights
  io/                IFC4 writer, DXF reader/writer, zip
  drawings/          part / assembly / GA drawings → SVG and DXF
  reports/           material lists (CSV, XLSX)
  optimize/          bar nesting (1D) and plate nesting (MaxRects)
  fabrication/       DSTV NC1
src/viewer/          Three.js scene, picking, snapping, reference models, underlays
src/state/           Zustand store with snapshot undo/redo, autosave, IndexedDB blobs
src/ui/              React components
```

The project file is plain JSON:
- **Nodes and members** make up the wireframe. A member with no profile is just a construction line.
- **Connections** sit at nodes.
- **Settings** cover stock lengths, kerf, prefixes and auto-assign rules.
- **Wireframe** holds the check rules and the client confirmations (date, name, note, fingerprint, counts).

Every output is computed from this model by `deriveModel()`, so the 3D view, IFC, drawings, lists and NC files always agree.

Technical documentation:
- [docs/CONNECTION_GEOMETRY.md](docs/CONNECTION_GEOMETRY.md): how members and connection parts are positioned (frames, points, planes, holes, bolts, trims), with a worked example and a checklist for adding connection types.
- Feature references: [PROFILES](docs/PROFILES.md) (custom profiles, insertion points, sketcher, profiles by role), [MODIFY](docs/MODIFY.md) (join, split, extend, trim, break, stretch, rotate, mirror, offset, section operations), [WIREFRAME_CHECK](docs/WIREFRAME_CHECK.md) (wireframe clean-up and client confirmation), [ASSEMBLIES](docs/ASSEMBLIES.md) (automatic and manual assemblies, selection modes, 3D ↔ drawing navigation), [EXPORT_PACKAGE](docs/EXPORT_PACKAGE.md), [CONNECTIONS](docs/CONNECTIONS.md), [MODELLING](docs/MODELLING.md), [MOVEMENT](docs/MOVEMENT.md), [MODEL_MANAGEMENT](docs/MODEL_MANAGEMENT.md), [DRAWING_STANDARDS](docs/DRAWING_STANDARDS.md), [FABRICATION](docs/FABRICATION.md), [CODE_RULES](docs/CODE_RULES.md).

## Notes and limits

- Rolled-section masses come from catalogue values. All other section properties are computed from the drawn cross-section (including corner radii), which lands within about 1–2 % of supplier tables. Check critical values against the mill or supplier.
- Connection geometry is for detailing. Have a structural engineer check member sizes, bolts and anchors.
- DSTV slotted-hole syntax varies between machines. Verify NC files with your post-processor before cutting.
- DXF import reads lines, polylines, arcs, blocks and (optionally) circles, splines and mesh edges in 2D or 3D; see *DXF import* above. ACIS solids, text, dimensions and XREFs are not read, and binary DXF must be saved as ASCII. DWG files are recognised but must be saved as DXF first (see docs/MODEL_MANAGEMENT.md).

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md) for the gap analysis — what is still missing to be the leading facade steel tool — and the next milestones. Short version:

- Drawing control: editable view placement, section cuts, company sheet templates
- More connections: splices, knife plates, cast-in channels, beam clamps for main steel
- Facade design checks: wind load on mullions and transoms, deflection limits, automatic profile sizing
- Clash detection, DWG import, cloud projects and team sharing
