# FacadeSteel: architecture, process cycle and decision record

This document is for technical designers and senior programmers who will
review, maintain or extend FacadeSteel. It explains:
- how the software was built (the process cycle)
- how it is implemented
- the decisions behind it, with the alternatives considered and their consequences.

For the geometry of members and connection parts (frames, points, planes),
see [CONNECTION_GEOMETRY.md](CONNECTION_GEOMETRY.md). Facts below are as of
commit `f40691b` (2026-10-31).

## 1. System at a glance

| Item | Value |
| --- | --- |
| Product | Browser-based detailing for facade secondary steel: mullions, transoms, rails, brackets, bracing |
| Runtime | Browser only: no server and no account. Delivered three ways (§3.12). |
| Language / stack | TypeScript 5.9 (strict), React 19, Three.js 0.187, Zustand 5, Vite 8, Vitest 5 |
| Third-party runtime libraries | web-ifc 0.0.78 (IFC reading), dxf-parser, pdfjs-dist, jsPDF + svg2pdf.js, qrcode-generator (MIT), @anthropic-ai/sdk |
| History | 29 commits over two days on `main` (feature branch `claude/brave-euler-eo03km`) |
| Tests | 414 Vitest tests in 32 files; strict type-check; production build; CI on every push |
| Libraries | 2,047 profiles (EN, BS, AISC), 68 materials, 28 bolt sizes plus anchors and screws |
| Connections | 30 parametric types plus user templates with formula parameters |
| Detailing rules | 46 catalogued rules (AISC 360-22, EN 1993-1-8, EN 1090-2, EN ISO 1461, ASTM A123) plus 8 movement rules |
| Assistant | 53 tools: 23 core tools plus 6 feature modules |

Source size by area (TypeScript lines):

| Area | Lines | Responsibility |
| --- | ---: | --- |
| `src/core/model` | 1,971 | Types, geometry helpers, wireframe operations, facade grid |
| `src/core/library` | 2,932 | Profiles, section properties, materials, bolts, fasteners, standards |
| `src/core/connections` | 5,587 | Connection framework, 30 types, registry, templates, catalogue |
| `src/core/derive` | 733 | Wireframe + connections → parts, holes, bolts, assemblies, marks |
| `src/core/geometry` | 901 | End preparations, bent plates, stiffeners, arcs |
| `src/core/codes` | 2,120 | Detailing-rule engine and tables |
| `src/core/movement`, `survey` | 1,982 | Thermal / deflection / tolerance stack, slot sizing, survey matching |
| `src/core/drawings` | 6,213 | ISO drawing set, edits, templates, erection sheets, cuts, SVG/DXF |
| `src/core/io` | 2,608 | IFC4 writer and reader, DXF reader and writer, BCF, DWG detection, ZIP, GUIDs |
| `src/core/fabrication`, `optimize`, `reports` | 2,984 | DSTV, plate CNC, labels, packing, galvanizing, paint, MIS, nesting, BOM |
| `src/core/clash`, `management` | 1,398 | Clash detection, phases/batches, marks |
| `src/viewer` | 2,492 | Three.js scene, instancing, spatial index, picking, snapping, previews |
| `src/state` | 446 | Store, undo/redo, autosave, IndexedDB blobs |
| `src/ui` | 8,976 | React panels, dialogs, drawing editor, connection library |
| `src/assistant` | 2,894 | Chat sessions, tool definitions, feature tool modules |
| `src/platform` | 79 | claude.ai host bridge |

## 2. Process cycle

### 2.1 The cycle

Every change, from a one-line fix to a milestone, went through the same eight steps.

1. **Intake.** Read the request literally and classify it: question, feature,
   fix or delivery. Ask only questions whose answer changes the direction. At the
   start that meant three: which design-code family (EN + AISC), what scope
   (a thin end-to-end slice) and where it runs (browser only). Everything else
   got a stated default.
2. **Plan.** Write down the architecture, data model, milestone scope and how
   it will be verified before writing code. The first plan fixed the layers and
   the "one derived model" rule that everything else rests on.
3. **Contracts first.** Define types and interfaces before features:
   - `Project`, `ConnectionDef`, `DerivedModel` and `Part`
   - `Drawing` and `DEnt`
   - `ToolModule`
   
   New fields get defaults in `createProject` and `migrateProject`, so saved
   projects always load.
4. **Implement core, then UI.** Pure logic goes in `src/core` (no DOM, unit
   tested). React and Three.js only present it and call `store.apply`.
5. **Verify.** In order: strict type-check, unit tests, production build, a
   real browser (Playwright: interact, screenshot, zero console errors), then
   CI on GitHub (§2.4).
6. **Integrate.** Commit with attribution, push the feature branch, then
   fast-forward `main`.
7. **Deliver.** Rebuild the hosted builds: GitHub Pages workflow, claude.ai
   artifact, offline single file.
8. **Document.** Each area has a doc with the standards clauses it relies on,
   typical-value labels and honest limits. Inconsistencies found while
   documenting are listed, not hidden.

Feedback from the user then starts the next cycle.

### 2.2 Iterations

| # | Request (user) | Result | Commits |
| --- | --- | --- | --- |
| 1 | Tekla-like but easy, for facade secondary steel; plan first | Plan, then a thin slice: wireframe, profiles, connections, derivation, IFC, BOM, DSTV, nesting, drawings, viewer | `6a24ac4`, `9ba41ba`, `2abc49c` |
| 2 | Drawings to international standards, revisions, assembly relations, machining | ISO 5457/7200/128/129/5455/6433/7573 sheet set, register, revision workflow, cross-references, hole tables, machining steps | `55bef11` |
| 3 | Three views per sheet, huge libraries, custom connections, code limits, chat-first control | Three views + section on every sheet, 2,047 profiles, templates and presets, code-rules engine, assistant | `7064401`, `7204489`, `72638af`, `f7ae581` |
| 4 | CI warnings (Node 20, Ubuntu 26) | Node 24 action majors, runner pinned to `ubuntu-24.04` | `9d7d46f` |
| 5 | "Run it on your computer" | claude.ai artifact build: host downloads, host-backed assistant, in-app dialogs | `4c03ef9` |
| 6 | P1–P2 roadmap list + richer connection library with a live viewer | Foundation contracts, six parallel workstreams, sequential merges | `e0828b2` … `cb6712d`, `d0e158a` |
| 7 | Run on my PC instead of GitHub | Offline single-file build | `c1edbfd` |
| 8 | Docs on positioning (points, planes) | Connection geometry reference with real-output worked example | `f40691b` |

### 2.3 Parallel milestone method (iteration 6)

About twenty features across six areas were built at the same time by
separate workers, each in its own git worktree. The method:

1. **Foundation commit (`e0828b2`).** The lead added every shared type the
   features needed to `types.ts`, with defaults and migration:
   - end preparations, free plates, named work planes
   - movement settings, survey, phases, batches, mark locks, clashes
   - drawing edits, cuts, templates
   - stock and the galvanizing bath
   
   It also added a tool-module registry (`src/assistant/modules`), so each
   area adds assistant tools without touching a shared file. The one new
   dependency (`qrcode-generator`) was installed up front, so no workstream
   would edit `package-lock.json`.
2. **Briefs with ownership.** Each workstream got:
   - its scope
   - files it owns, and files it must not touch
   - integration points
   - test expectations, a docs file, a browser check
   - commit rules
3. **Isolated execution.** Six worktrees: movement/survey, geometry modelling,
   model management/interop/performance, drawings, fabrication, connection
   library. Each finished with its own tests passing on top of the foundation.
4. **Sequential merge by the lead.** After every merge the whole suite,
   type-check and build ran, and the merged app was smoke-tested in a
   browser. Conflicts were almost all additive lists (union types, menus,
   tabs, the module registry), as planned.
5. **Integration fixes found only at merge time.** These show why the merge
   step needs an engineer and not just git:
   - The instanced renderer (management) would have drawn cut and coped
     members as plain bars and dropped free plates from selection. Its
     geometry lookup was wired to the modelling builders, and free plates
     became their own selectable instanced items.
   - The movement code re-validated a connection index on every bracket,
     which made derivation quadratic: a 20k-member model took 18 s against a
     15 s budget. Validation is now once per derivation pass (6k members:
     2.3 s → 0.5 s).
   - The connection-library test required every type to produce zero
     warnings, while the movement rules correctly warn that the default
     tolerances exceed the default bracket's slot capacity. The test now
     keeps project-dependent movement rules out of the per-type detailing
     check.
   - Joints → Add now places types with their own end rule (upper end, free
     ends) where Apply puts them.
   - A dialog's plane typing was fixed once custom work planes existed.
6. **Close-out.** Roadmap updated, `main` fast-forwarded, the claude.ai build
   republished, worktrees removed.

### 2.4 Verification gates

| Gate | Tool | Catches | When |
| --- | --- | --- | --- |
| Types | `tsc -b` (strict) | Contract breaks across layers, unhandled union cases (e.g. `WorkPlane.kind: 'custom'`) | Every change |
| Unit | Vitest (414 tests) | Geometry, numbering, code rules, writers (IFC re-read with web-ifc), parsers, nesting, assistant loop with a fake model, host adapters | Every change |
| Build | `vite build` | Bundling, dynamic imports, asset handling | Every merge |
| Browser | Playwright on `vite preview` or `file://` | Runtime errors, broken UI paths, picking, downloads, IFC/PDF loading, preview updates | Every UI change and every merge |
| Performance | Benchmark test (20k members < 15 s) and profiling | Quadratic hot spots | Merges touching derivation |
| CI | GitHub Actions (`ubuntu-24.04`, Node 22) | Clean-checkout reproducibility | Every push to `main` and every PR |

### 2.5 Definition of done

A change is done when:
- types, tests and the build pass
- the feature works in a browser with no console errors
- it is undoable (every model edit goes through `store.apply`)
- the assistant can drive it, where it is a model operation
- it is documented with sources and limits
- it is pushed.

Numbers and claims in docs come from running code, not from memory.

## 3. Implementation

### 3.1 Layers and data flow

```
             user (UI, keyboard, viewport)            assistant (53 tools)
                         │                                    │
                         ▼                                    ▼
              store.apply(label, fn) ◄───────────────── runTool(name, input)
                         │   structuredClone → fn(draft) → snapshot (80-step undo)
                         ▼
                 Project (plain JSON) ──► autosave (localStorage) / .json file
                         │
                         ▼  derived(p): WeakMap cache by project identity
                 deriveModel(p) → DerivedModel { parts, assemblies, bolts, holes, marks, warnings }
                         │
   ┌──────────┬──────────┼───────────┬────────────┬────────────┬────────────┐
   ▼          ▼          ▼           ▼            ▼            ▼            ▼
 3D viewer   IFC4      drawings   BOM/XLSX     DSTV/CNC     nesting      code checks,
 (instanced) writer    SVG/PDF/DXF  lists      labels, MIS  bar/plate    movement, clashes
```

Every output reads the same `DerivedModel`, so the 3D view, IFC, drawings,
lists and NC files cannot disagree.

### 3.2 Data model

- **`Project`** is plain JSON:
  - `nodes`, `members` (wire lines; `profile: null` means a construction line; an optional surface `normal` sets the section depth perpendicular to the facade), `connections` at nodes
  - `grids`, `levels`, `references` (IFC/DXF; bytes in IndexedDB), `underlays`
  - `settings` (stock, kerf, prefixes, auto rules, design code, movement, galvanizing bath, stock on hand)
  - `drawings` (settings, revisions, edits, cuts, templates)
  - `library` (presets, templates, custom profiles)
  - `workPlanes`, `plates`, `survey`, `phases`, `batches`, `markLocks`, `clashes`
  - `wireframe` (check rules and client confirmations against a wireframe fingerprint, see [WIREFRAME_CHECK.md](WIREFRAME_CHECK.md))
- **Units** are millimetres and degrees. World axes: X east, Y north, Z up.
- **Migration:** `migrateProject` fills every new field. Older files load
  unchanged apart from documented default changes (auto slots).

### 3.3 State and undo

- `store.apply(label, fn)` clones the project with `structuredClone`, runs `fn`
  on the draft, and pushes the previous project onto `past` (80 steps).
- Undo and redo swap snapshots.
- Custom profiles are re-registered after every replace, undo and redo, so the
  catalogue always matches the project.
- `derived(p)` caches the derived model per project object. Because edits
  always produce a new object, the cache never goes stale.

### 3.4 Derivation pipeline (`src/core/derive/model.ts`)

1. **Pass 1, trims:** connection `trims()` run on untrimmed member geometry.
2. **Pass 2, geometry:** trimmed member geometry, end preparations, then each
   connection's `build()` → plates, profile parts, bolts, member holes, welds,
   warnings.
3. **Parts:**
   - members, connection plates and profiles, free / bent plates and stiffeners
   - holes converted to part-local coordinates (face selection by direction)
   - mass and surface area
4. **Assemblies:** union-find over shop welds. The main part is a member, or the
   plate flagged `assemblyMain`.
5. **Numbering:**
   - Marks come from geometric signatures, so identical parts and assemblies share marks.
   - Manual overrides and locked marks are honoured, and locked numbers are never reused.
   - Phase, zone and batch are inherited from the main member.

### 3.5 Connections framework (`src/core/connections`)

- **`ConnectionDef`:** `type`, `label`, `description`, `needsMain`, parameter
  specs (`params`, or `paramsFor` for templates), an optional `trims(ctx)` and
  a `build(ctx)`. The `ctx` holds the project, the connection, the node,
  resolved parameters and member geometry.
- **Output:** plates (frame + 2D outline + holes + thickness), profile parts,
  bolts (positions, direction, grip, length), member holes, welds, warnings.
- **Placement:** `applyConnection` and `autoConnect` choose nodes and member
  ends by rule: the `APPLY_END` table, collinear splices, one per node.
- **Custom templates:** plates and bolt groups defined by formulas, evaluated
  by a small safe expression evaluator (no `eval`).
- **Catalogue and preview:** category metadata, plus a live Three.js preview
  that runs the real `deriveModel` on a mini project.

### 3.6 Rules engine (`src/core/codes`, `src/core/movement`)

- **Rules are data:** each rule has an id, a clause reference and a severity.
  Checks evaluate holes, edge and end distances, spacing, slots, welds,
  coating, venting and bimetallic contact against per-code tables.
- **Code choice:** with `designCode: 'auto'`, `codeForProject` takes a vote of
  the profiles and bolts in use: AISC sections and imperial bolts count for
  AISC 360, EN/BS sections and metric bolts for EN. A tie follows the
  drawing standard (ASME → AISC 360).
- **Movement** adds thermal and slab-deflection demand and a tolerance stack
  (linear or RSS). Slot length is `L = d0 + 2·(T + M) + c`, rounded up to 5
  mm and capped at the code long-slot limit (2.5d) and by edge distance.
- **Survey** matching adjusts each bracket's out-of-plane, vertical and along offsets.

### 3.7 Drawings pipeline (`src/core/drawings`)

- **Context:** shared numbering, cross-references and the projection method
  (first angle ISO / third angle ASME).
- **Sheets:**
  - register and GA
  - assembly and part sheets, each with elevation, plan and section
  - erection setting-out plans, anchor schedules and sequence sheets
  - section and detail sheets
- **Entities** carry stable ids (`view:front`, `dim:front:3` …). User edits
  are stored per drawing and applied after generation.
- **Fingerprint:** a content hash (with edits, without title block and revision
  table) drives "changed since issue" and the revision workflow.
- **Rendering:** one entity model renders to SVG (preview, PDF through
  svg2pdf.js) and DXF R12.

### 3.8 Outputs

- **IFC4 STEP writer:**
  - profile definitions, clipping for end cuts, plates and fasteners, assemblies, psets
  - deterministic GlobalIds per part reference (used by BCF)
  - re-read in tests with web-ifc
- **Fabrication files:** DSTV NC1 for members and plates (saw angles, cope contours, slots, marking).
- **CNC DXF:** per plate and per nested sheet.
- **XLSX/CSV/ZIP writers** written in-house.
- **Nesting:** bar nesting (stock on hand first, then purchase) and MaxRects plate nesting.
- **Labels:** QR and Code 128 (own encoder).
- **Lists:** packing, galvanizing with dip checks, paint, MIS JSON/CSV, BCF 2.1.

### 3.9 Viewer (`src/viewer`)

- **Rendering:** imperative Three.js, Z-up.
  - Parts with the same geometry key share an `InstancedMesh`; one-off geometries are merged.
  - Selection and colour modes repaint instance colours and never rebuild geometry.
- **Picking:** a BVH and spatial index serve picking, snapping and box select;
  exact ray tests run on candidates only.
- **Level of detail:**
  - above 15k parts, sharp-cornered profiles
  - above 20k parts, no edges
  - above 1,500 members, labels on the selection only

### 3.10 Assistant (`src/assistant`)

- **Tools:** 53 tools defined as JSON schemas. `runTool` calls the same store
  actions as the UI, so every assistant change is undoable. Feature areas
  register a `ToolModule`.
- **API-key session** (normal browser):
  - `@anthropic-ai/sdk` streaming with adaptive thinking
  - effort Quick / Balanced / Thorough
  - prompt caching and server-side fallbacks
  - client-side schema validation before each tool runs
  - append-only transcript, 30-step loop limit
- **claude.ai session** (artifact): the host `sample` capability with page
  tools runs on the viewer's own Claude account, so no key is needed.

### 3.11 Platform adapters

- **Host bridge** (`src/platform/claudeHost.ts`): host capability lookup, saves
  through `downloads.save`. Formats the host does not accept (IFC, DXF) are
  delivered inside a ZIP.
- **In-app dialogs:** `askConfirm` and `askText` replace `window.confirm` and
  `window.prompt`, which sandboxed frames block.

### 3.12 Delivery

| Channel | How | Notes |
| --- | --- | --- |
| GitHub Pages | `.github/workflows/deploy.yml`: test, build, deploy from `main` | Needs the `github-pages` environment to allow `main` |
| claude.ai artifact | `dist/` published as a multi-file artifact with `downloads` and `sample` capabilities | Exports by confirmation; assistant on the viewer's account |
| Offline single file | `npm run build:offline` → `dist-offline/FacadeSteel.html` (~10 MB) | Code, CSS, web-ifc WASM and pdf.js worker inlined; runs from `file://` in Chrome/Edge; tested |
| From source | `npm install && npm run dev` | Development |

## 4. Decision record

| ID | Decision | Why | Alternatives considered | Consequences |
| --- | --- | --- | --- | --- |
| D01 | Browser-only, no backend | User choice; zero operations; projects stay on the user's machine | Node/Python backend with a database | No multi-user or cloud sync yet; storage is per browser plus `.json` files |
| D02 | TypeScript strict across core, UI and tests | Geometry and file formats need exact contracts; parallel work needs compile-time integration | JavaScript, loose TS | Merge breaks surface at `tsc -b`, not in production |
| D03 | Wireframe-first model (members are lines; a profile turns a line into steel) | Matches how facade engineers sketch and how DXF and survey data arrive | Solid-first modelling | Construction lines and members share tools; imports become editable steel directly |
| D04 | One derived model feeds every output | Consistency between 3D, IFC, drawings, lists, NC | Each output computing its own geometry | Adding a part type once makes it appear everywhere |
| D05 | Plain-JSON project with snapshot undo (`structuredClone`, 80 steps) | Simple, robust, serialisable, diff-friendly | Command pattern with inverse operations | Memory cost per step; acceptable at current sizes |
| D06 | Imperative Three.js viewer (not react-three-fiber) | Full control of picking, snapping, instancing, performance | react-three-fiber | Viewer code is explicit and longer; React stays out of the render loop |
| D07 | Units mm, Z-up, X east / Y north | Industry norm for steel detailing and IFC | Metres, Y-up (Three.js default) | Three.js configured Z-up; one convention everywhere |
| D08 | Connections are pure parametric functions with explicit outputs | Testable, deterministic, the same in preview and model | Hand-modelled plates per joint | New types are code; custom templates cover one-offs |
| D09 | Custom templates use a safe expression evaluator | User formulas without code-injection risk | `eval` / `Function` | Limited function set (max, min, abs, round, floor, ceil, ceilto, sqrt) |
| D10 | Write IFC4, DXF, DSTV, XLSX and ZIP ourselves; read IFC with web-ifc | Small, auditable, testable writers; reading IFC needs a full geometry engine | Large writer libraries | Format coverage grows with need; writers are unit-tested and IFC is re-read in tests |
| D11 | Section properties from the drawn section (catalogue masses for rolled) | Uniform handling of 2,047 sections and custom profiles | Hard-coded tables only | 1–2 % deviation from supplier tables for computed values (documented) |
| D12 | EN and AISC both; code chosen automatically by library | User requirement; mixed markets | One code family | Every rule exists in two tables; `designCode` setting overrides |
| D13 | Detailing rules as data with clause references; capacity design out of scope | Explainable checks; clear liability boundary | Silent auto-fixing; built-in capacity checks | Users see why a rule fires; engineer of record checks capacity (roadmap item) |
| D14 | ISO drawing set (5457, 7200, 128, 129, 5455, 6433, 7573), three views always | International acceptance; user requirement | Free-form sheets | Strict layout code; ASME variant through projection and weld symbols |
| D15 | Content fingerprint drives revisions | Detect real changes since issue; ignore title-block noise | Manual revision bumps | Edits count as content; unedited sheets keep stable fingerprints |
| D16 | Stable ids on drawing entities; edits stored as overlays | Manual edits survive regeneration | Editing generated output directly | Generators must keep ids stable |
| D17 | Marks from geometric signatures, with overrides and locks | Identical parts share marks; marks stay stable through edits | Sequential numbering | Changed locked assemblies get new marks with a warning |
| D18 | Deterministic IFC GlobalIds | BCF issues and re-exports reference the same objects | Random GUIDs | GUIDs derive from part references |
| D19 | Chat assistant as a first-class controller (tools over store actions) | User requirement: chat as the point of contact; every change undoable | Separate scripting API only | Every feature also needs a tool; feature modules keep that manageable |
| D20 | Bring-your-own Anthropic key, browser-direct; claude.ai host mode without a key | No backend (D01); privacy | Proxy server | Key lives in browser storage; artifact mode uses the viewer's account |
| D21 | Movement slots derived from a tolerance stack: `L = d0 + 2(T + M) + c`, RSS by default, capped by the code long-slot limit | Slots follow the specification instead of guesses; the code limit is respected | Manual slot entry only | Defaults are typical values and must be replaced by the project specification; warnings show shortfalls |
| D22 | No GPL dependencies (DWG reading deferred) | Keep commercial licensing open | LibreDWG WASM (GPL-3.0) | DWG is detected and explained; a licensed converter can plug in |
| D23 | Performance: instancing by geometry key, spatial index, cached collators, connection index validated once per pass | 100k-part models | Naive per-mesh scene | Measured by the workstream: derive of 100k members 7.7 s → 3.5 s, and a 48k-member scene loads in about 2.4 s of JavaScript (headless Chromium). At merge, a 6k-member facade derives in 0.5 s. |
| D24 | Native `confirm` / `prompt` banned; in-app dialogs | Work inside sandboxed frames (claude.ai) | Native dialogs | One dialog component for every question |
| D25 | Three delivery channels (Pages, artifact, offline file) | Users without hosting or Node can still run it | Hosting only | Offline build inlines WASM and the worker; ~10 MB file |
| D26 | CI pinned to `ubuntu-24.04` and Node 24 action majors | Remove deprecation warnings; avoid silent runner migration | `ubuntu-latest` | Runner upgrades are deliberate |
| D27 | Parallel development: foundation contracts, worktrees with file ownership, lead merges | About 20 features in one milestone without trampling each other | Sequential implementation | Integration fixes are expected and done by the lead at merge (§2.3) |
| D28 | Typical values labelled as such; limits documented per area | Trust: users must know what to verify | Silent defaults | Docs carry "typical practice" and caveat lists |
| D29 | Wireframe check: roles from topology (T-junctions and crossings 2-coloured on a maximum spanning forest), direction only as a tie-break; cuts only at mullion–transom junctions; client confirmation stored against a content fingerprint | Imported 3D facades are fragmented and often sloped, so "vertical = mullion" fails; the client must confirm the line model before detailing | Direction rules; splitting at every crossing | One reviewable plan (merge, cut, roles, issues) applied as one undo step; any later edit of geometry, roles or profiles shows "changed since verification" |
| D30 | Arbitrary outline profiles (`POLY`, bulge arcs) are centred on their bounding box like every other shape; the insertion point is a shift of the section (`sectionShift`), not a new frame origin | Every consumer (meshes, IFC, DSTV, drawings, clash, connections) keeps working on box-centred outlines and the section centre line | Frame origin at the insertion point | Old models derive unchanged; connections use the box faces of outline profiles ([PROFILES.md](PROFILES.md)) |
| D31 | Profiles by role as project settings plus a pure `assignProfilesByRole` in core | One place to say "mullions are X, transoms are Y"; other features (wireframe classification, assistant) reuse it | Per-member edits only | New members of a role get its profile; changing it asks whether to update existing members |
| D32 | Profiles perpendicular to the facade surface: an optional `Member.normal` (local z = the normal projected perpendicular to the member, rotation on top), set from surfaces detected in the wireframe topology (junction normals → patches by connectivity and a 10° similarity → consistent sign through folds → exterior side by rule, user flips); all member axes go through one function (`memberAxes`) | A "world Z is up" rule twists sections on sloped, V-shaped and curved facades; the junctions already describe the surface, and the user wants "always perpendicular to the surface" | Per-member rotations computed once (lost on any edit, no notion of a surface); a user-picked plane per region (fails on curved and folded facades) | Models without normals derive bit for bit as before; copy / split / merge carry the normal, mirror reflects it; the fingerprint includes normals of oriented members only, so earlier confirmations stay valid; the exterior side is a heuristic the user can flip ([WIREFRAME_CHECK.md §5a](WIREFRAME_CHECK.md)) |

## 5. Known limits and open items

- **Engineering:** no member or connection capacity design yet (wind, dead load,
  bolts, welds, anchors). This is the next milestone (see [ROADMAP.md](ROADMAP.md)).
- **Geometry:** the fourteen placement inconsistencies found while documenting
  the geometry are fixed; [CONNECTION_GEOMETRY.md §14](CONNECTION_GEOMETRY.md)
  lists what changed and where. Remaining approximations are noted there per
  section (e.g. skewed secondaries meet the face at their axis; end slots on
  prepared ends are not drawn in 3D).
- **Shop data:** DSTV saw-angle signs and plate marking blocks must be
  verified on the target machines. Galvanizing dip rules are typical and must
  be confirmed with the galvanizer.
- **Platform:** no cloud projects, sharing or approval workflow; GitHub Pages
  needs one repository setting.

## 6. How to extend

- **Connection type:**
  1. Write a `ConnectionDef` in `src/core/connections/` and register it in
     `registry.ts`, the `ConnectionType` union and `catalog.ts`.
  2. Make sure the defaults pass `runCodeChecks` for EN and AISC.
  3. Add tests; the connection-library tests already cover every registered type.
  
  The full checklist is in CONNECTION_GEOMETRY.md §13.
- **Output format:** read the `DerivedModel` only; write a pure writer in
  `src/core/io` or `fabrication`, with a test that re-reads or parses the
  output; add a menu entry and an assistant tool.
- **Assistant tool:** add it to a `ToolModule` in `src/assistant/modules`. Keep
  the schema under 4 KB and the description under 1 KB. Edits go through
  `store.apply`.
- **Detailing rule:** add a catalogue entry with its clause and severity, and
  the per-code table values. Add a check with a test for the pass and the
  fail case.
