# FacadeSteel

A browser-based steel detailing tool for **facade secondary steel**: the brackets, mullions, transoms, rails, posts and bracing that carry cladding back to a concrete or main-steel frame. It aims to do the parts of Tekla that facade sub-frames need, with far less setup.

Everything runs in the browser. There is no server: projects autosave to the browser and can be saved and opened as `.json` files.

**Talk to it.** The **Assistant** tab (or press `/`) lets you operate the whole application in plain language. For example: "create a 4-bay, 2-storey facade with SHS 100 mullions", "put end plates on the selected rails", "check edge distances and fix them", "issue all drawings for approval".
- It runs on Claude (`claude-opus-5-5`) with your own Anthropic API key, which is stored only in your browser.
- Every change it makes can be undone like a normal edit.

## Workflow

1. **Reference.** Bring in what you design against:
   - **IFC** concrete or main-steel models from Revit or Tekla, shown translucent and snappable.
   - **DXF** architect or shop drawings, imported either as wireframe lines or as reference linework.
   - **PDF or image** shop drawings as an underlay you can calibrate and trace over.
2. **Wireframe.** Draw centre lines on a work plane: XZ or YZ elevations, or the XY plan.
   - **Line** and **Polyline** tools with snapping to ends, midpoints, grid and reference geometry.
   - Typed coordinates: `x,y,z` for world, `u,v` for work-plane, `@dx,dy` for relative, or a single length.
   - **Facade grid** generates every mullion and transom from bay widths and row heights.
3. **Members.** Assign profiles from the **EN** and **AISC** libraries by hand, or let **Auto-assign** pick by direction or by DXF layer. Then set rotation, face alignment, offsets and extensions.
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
5. **Outputs.** Parts and assemblies are numbered automatically, with identical items sharing a mark.
   - IFC4 model export
   - Material lists (XLSX, or CSV in a zip)
   - Cut optimisation for bars (1D) and plates (2D nesting)
   - A numbered drawing set (PDF / DXF) to ISO drawing standards: drawing register, GA, assembly and part drawings with revision tables, cross-references, hole tables and machining steps. See [docs/DRAWING_STANDARDS.md](docs/DRAWING_STANDARDS.md).
   - DSTV NC1 files for CNC
   - Checks (warnings, clashing bolt holes, unassigned lines)

Mouse: right-drag orbits, middle-drag (or Shift + right-drag) pans, the wheel zooms.

Keys:
- `S` select, `L` line, `P` polyline
- `M` move, `C` copy
- `O` ortho, `F` fit
- `1`–`4` views
- `Del` delete, `Esc` cancel
- `Ctrl+Z` / `Ctrl+Y` undo / redo

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (Vitest)
npm run build      # type-check + production build into dist/
```

`.github/workflows/deploy.yml` runs the tests and build on every push and pull request. Pushes to `main` are also published to GitHub Pages once Pages is enabled with the source set to *GitHub Actions*.

## Architecture

```
src/core/            pure TypeScript, no DOM, unit-tested
  model/             types, geometry, wireframe operations, facade grid generator
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

Every output is computed from this model by `deriveModel()`, so the 3D view, IFC, drawings, lists and NC files always agree.

## Notes and limits

- Rolled-section masses come from catalogue values. All other section properties are computed from the drawn cross-section (including corner radii), which lands within about 1–2 % of supplier tables. Check critical values against the mill or supplier.
- Connection geometry is for detailing. Have a structural engineer check member sizes, bolts and anchors.
- DSTV slotted-hole syntax varies between machines. Verify NC files with your post-processor before cutting.
- DXF import reads LINE, LWPOLYLINE and POLYLINE. Arcs, blocks and text are ignored. DWG is not supported yet: save as DXF first.

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md) for the gap analysis — what is still missing to be the leading facade steel tool — and the next milestones. Short version:

- Drawing control: editable view placement, section cuts, company sheet templates
- More connections: splices, knife plates, cast-in channels, beam clamps for main steel
- Facade design checks: wind load on mullions and transoms, deflection limits, automatic profile sizing
- Clash detection, DWG import, cloud projects and team sharing
