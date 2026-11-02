# Export package

**Export → Export package…** writes every output of the project into one package
folder, laid out by an editable **export template**: drawings (per sheet and combined),
models (IFC, STEP, OBJ), NC and CNC files, lists, optimisation, QA forms, records and a
`README.txt` manifest. The package goes either **into a folder** you choose (Chrome / Edge,
also from the offline `file://` build) or into **one ZIP** (every browser, and the only way
inside the claude.ai artifact).

Code: `src/core/export/` (pure: template, catalogue, outputs, package builder, forms,
meshes, OBJ, STEP, PDF book), `src/core/io/zipRead.ts` and `xlsxTemplate.ts` (form
templates), UI in `src/ui/dialogs/ExportPackageDialog.tsx`, `QaFormsTab.tsx` and
`src/ui/exportPackageActions.ts`, assistant tools in `src/assistant/modules/exportPackage.ts`.
Tests: `tests/exportPackage.test.ts`, `tests/exportOutline.test.ts`.

## Default package (the client's layout)

The built-in template reproduces the client's reference package `25122-FWR-001-R00`
(`tree /F`). Document names start with `{code}-{seq}` (e.g. `FWR-001 …`), part and
assembly files are named by mark, NC1 files `{project}-{mark}.nc1`. Folders without
items are created empty, as in the reference.

```
{project}-{code}-{seq}-{rev}                     e.g. FS-001-FWR-001-R00
│   README.txt                                   manifest: every file, source, revision, size; skipped items; errors
│   {code}-{seq} Combined.pdf                    every sheet in register order, bookmarked per drawing and type
├───00-References
│   │   facadesteel-input.json                   design input (info, settings, grids, levels, wireframe, connections, survey…)
│   │   profile-used.json                        profiles in the model with section data (custom definitions included)
│   │   <reference models and underlays>         as imported (IFC / DXF / Rhino .3dm / PDF / images, from the browser's storage)
│   ├───1-Material Submital                      (empty)
│   ├───2-Shop drawings                          (empty)
│   ├───3-Structural Calculation                 (empty)
│   ├───4-Emails                                 (empty)
│   └───5-Survey                                 Survey points.csv (when survey points are imported)
├───01-Setting Out
│       {code}-{seq} Master elevation.pdf        GA elevations + bracket setting-out plans (+ sheet kinds added later)
│       MASTER ELEVATION.dxf                     GA elevation sheets side by side
│       MASTER ELEVATION BK.dxf                  bracket setting-out sheets side by side
│       {code}-{seq} Setting-out.xlsx / .csv     survey setting-out table (when survey points exist)
├───02-Single
│   │   {code}-{seq} Part schedule.pdf
│   │   {code}-{seq} Single Parts (all).pdf
│   ├───CAD   {mark}.dxf per part drawing
│   └───PDF   {mark}.pdf per part drawing
├───03-Assembly
│   │   {code}-{seq} Assemblies (all).pdf
│   ├───CAD   {mark}.dxf per assembly drawing, GENERAL PLAN.dxf (GA plan), DETAILS.dxf (section / detail sheets)
│   └───PDF   the same as PDF
├───04-Erection
│   │   Fixing schedule.csv                      every anchor (bracket, grid / level ref, X Y Z, type, size) and site bolt group
│   │   README.txt                               erection notes: sheets, sequence by phase, fixings, tolerances
│   ├───CAD   {drawingNo}.dxf per erection sheet (setting-out plans, anchor schedules, sequences)
│   └───PDF   {drawingNo}.pdf per erection sheet + {code}-{seq} Erection (all).pdf
├───05-Reports
│   │   Run report.txt                           settings, model counts, fingerprints, files per item, QAF decisions
│   ├───EXCEL Cutting List, Drawing register, Revision log, Packing lists, Galvanizing list, Paint areas,
│   │         Purchase list, Plate nesting (all "{code}-{seq} … .xlsx")
│   └───PDF   Drawing register, Packing list <batch> (one per delivery batch), Part labels
├───06-Exports
│   ├───CAD   {code}-{seq} Flat patterns.dxf     every plate flat pattern, side by side, labelled (mark, PL, grade, qty)
│   ├───CNC
│   │   ├───Plates
│   │   │   ├───DSTV   {project}-{mark}.nc1 per plate
│   │   │   └───DXF    {mark}.dxf per plate, NEST-{nnn}-S{w}x{h}.dxf per nested sheet
│   │   └───Profiles
│   │       ├───DSTV   {project}-{mark}.nc1 per member / profile part
│   │       └───DXF    (empty: profile parts are not unfolded)
│   ├───IFC   {code}-{seq} Model.ifc
│   ├───STP   {code}-{seq} Model.stp
│   └───MIS   {code}-{seq} MIS.json + parts / assemblies / bolts / operations / welds / coatings .csv
├───07-Model   {code}-{seq} Model.json (project file), .obj + .mtl, .stp, {package} Model.3dm (Rhino, docs/RHINO.md)
├───08-Material List   {code}-{seq} Material list.csv (+ .xlsx)
├───09-Optimization    {code}-{seq} Bar cutting plan.csv / .pdf, Sheet nesting.pdf, Stock on hand.csv
└───10-Quality Check List
        QAF-{code}-{seq}-{rev}.xlsx, VCF-{code}-{seq}-{rev}.xlsx, Detailing checks .pdf / .csv,
        Wireframe confirmation .pdf / .txt, Clash report .pdf / .csv, Clashes.bcfzip
```

Additions to the client's tree, all marked as ours: `06-Exports/MIS` (MIS/ERP export), the
clash files in `10-Quality Check List`, the setting-out table in `01-Setting Out`, the
Excel reports beside the cutting list. Packing lists are in `05-Reports` (EXCEL and PDF).

## Changing the template

- **In the dialog** (Template tab): folder tree (add, rename, move up / down, move into
  another folder, delete), the items of the selected folder (add an output, edit its file
  name with a live preview of the resulting paths, limit drawing outputs to drawing types,
  move to another folder, remove), token help. The built-in template is copied on the first
  change; **Save template** keeps it in the project. The **Folder tree** tab shows the
  package as Windows `tree /F` prints it (Copy tree), to compare with a reference folder.
- **Share**: the export / import buttons next to the template picker write and read
  `*.export-template.json`.
- **In code**: `DEFAULT_TEMPLATE_SPEC` in `src/core/export/template.ts` is the built-in
  template as a map of folder paths to `[output, file-name pattern, drawing types]`.
  Nothing else depends on its folder names.

### Template JSON

```json
{ "schema": "facadesteel.exportTemplate", "version": 1,
  "template": { "id": "…", "name": "Client tree",
    "root": { "id": "root", "name": "{project}-{code}-{seq}-{rev}", "items": [],
      "folders": [ { "id": "f-1", "name": "02-Single", "folders": [],
        "items": [ { "id": "drawing-pdf", "output": "drawing-pdf", "pattern": "{mark}.{ext}", "drawings": ["part"] } ] } ] } } }
```

Unknown outputs and drawing types are dropped with a note on import; missing ids are made up.

### Tokens

| Token | Value |
|---|---|
| `{project}` | project number (the name when there is none) |
| `{name}`, `{client}` | project name, client |
| `{code}` | package code (default `FWR`) |
| `{seq}` | package sequence, 3 digits |
| `{rev}` | package revision; default from the drawings: `R00` until the first issue, then `R<n−1>` for the largest number of issues of a sheet |
| `{date}` | export date `YYYYMMDD` |
| `{package}` | the package folder name |
| `{drawingNo}`, `{drawingTitle}`, `{drawingRev}` | drawing number, title, revision index (`0` before the first issue) |
| `{sheet}`, `{sheetSize}`, `{type}` | position in the register (3 digits), sheet size (A3 …; nested sheets `1500x3000`), drawing type |
| `{mark}`, `{assembly}`, `{phase}`, `{zone}`, `{batch}` | part / assembly mark, its assembly, phase, zone, delivery batch |
| `{nest}` | nested sheet number over all thicknesses (3 digits) |
| `{item}` | the file name the output gives the file itself (may contain its own sub-folder, e.g. `PL10-S355/pl3`) |
| `{ext}` | extension (added when the name has none) |

Rules: an empty token takes the separators (`-`, `_`, spaces) on one side with it
(`{phase}-{mark}` → `M1`); `/` makes sub-folders; Windows-invalid characters `<>:"/\|?*`
become `_`, trailing dots and spaces are removed, reserved names (`CON`, `NUL`, `COM1` …)
get a `_` prefix, names are cut at 255 characters; names that clash (case-insensitive)
get `-2`, `-3` …; a warning appears when a path inside the package exceeds 240 characters.

### Drawing types

`register`, `ga` (with `elevation` / `plan` by sheet id), `section`, `setout`, `anchors`,
`sequence`, `erection` (= setout + anchors + sequence), `assembly`, `part`, `other` (sheet
kinds added later). Drawing items read the set through `allDrawings()`, so new sheets flow
in; a warning lists sheets that only the unfiltered combined PDF takes.

## Items

Every output of the program is an item (`OUTPUTS` in `src/core/export/catalog.ts`). Items
that have nothing to export are skipped with the reason in `README.txt` (e.g. no survey →
setting-out table, no open clashes → BCF). Unchecked items are listed as left out. One
failing file does not stop the package; it is listed under ERRORS.

| Group | Outputs |
|---|---|
| Drawings | PDF per sheet; combined PDF (bookmarks per drawing grouped by type); DXF per sheet; several sheets in one DXF; register XLSX / CSV; revision log XLSX / CSV |
| Models / project | IFC4; STEP AP214 (one faceted solid per part, mm, product = mark); OBJ + MTL (group per assembly, object per part, material per role); Rhino 3dm (mesh per part named by mark with user strings, wire lines, bolts; [RHINO.md](RHINO.md)); project JSON; project input JSON; profiles used JSON; reference files |
| Fabrication | NC1 members / plates / all; plate DXF per part; plate list CSV; nested sheet DXF; nesting CSV / XLSX / PDF; flat patterns DXF; part labels PDF; bar cutting plan CSV / XLSX / PDF; purchase list; stock on hand |
| Lists | material list XLSX, one CSV, CSV set; part schedule PDF; packing lists XLSX and PDF per batch; galvanizing; paint; MIS/ERP JSON + CSV |
| Site | fixing schedule CSV; anchor schedule CSV; setting-out table CSV / XLSX; survey points CSV; erection notes |
| Coordination / records | BCF; clash report CSV / PDF; detailing checks CSV / PDF; wireframe confirmation TXT / PDF; QC checklist; QAF; VCF; run report |

The menu exports (Export menu, Outputs panel) use the same builders
(`src/core/export/outputs.ts`), so a single file and the package always agree.

## QA forms (QAF, VCF)

**Built in** (no workbook uploaded): the same layout as the client's forms (sheet
`FWR-GCL-MTO` for the QAF with the 29 check items, `VCF` with its lists), without logo or
client values. The QAF has a second sheet *FacadeSteel checks* with every decision.

**Template fill**: upload the client's workbook once in the *QA forms* tab. It is kept in
the browser's storage (IndexedDB, like reference models) and at every export a copy is
filled: only the mapped cells of the sheet XML change; every other part of the workbook
(logo, styles, merged cells, data validations, conditional formats, form-control check
boxes, printer settings) is copied byte for byte. The mapping is editable (tick columns
Yes / No / N/A, the row of each item, name and date cells; VCF header cells, first table
row and columns) and the tab shows what the workbook has in those cells now; rows whose
text does not match are highlighted.

QAF answers FacadeSteel can decide (the rest stay blank for a manual tick):

| Item | Rule |
|---|---|
| Text ≥ 2.5 mm | every text outside the title block ≥ 2.5 mm (ISO 7200 field labels are 1.8 mm) |
| Project name / number / document numbers | present in the title blocks |
| Quantities with units / area | material list exists |
| Approved shop drawings ref, Dates | every sheet released / issued |
| Dimensions identical | yes (one derived model) |
| Fabrication drawings, optimisation, NC files | the items are in the package |
| Fasteners factory / site | factory N/A (shop connections welded); site = fixing schedule exported |
| Finish type / surface mark | every part has a finish |
| Panel DXF, glass edge | N/A (steel package) |
| Folding | bent plates → part drawings exported, else N/A |
| Powder / anodize allowances, bending clamps | N/A (no such finishes / bent profiles) |
| 50 mm extra length | end trim ≥ 50 mm |
| 5 mm blade | saw kerf ≥ 5 mm |

Every decision with its reason is in *Run report.txt* and on the *FacadeSteel checks*
sheet. **VCF**: each export appends the package revision to `project.exportPackage.history`
(re-exporting a revision replaces it); the form lists them, newest *Last Update*, older
*Superseded*, with an automatic change summary (initial counts, then the drawing revisions
and wireframe confirmations since the previous issue).

## Opening the dialog: outline first, sizes on request

Planning the package makes the drawing set and the cheap outputs, which takes seconds on
large models (it used to freeze the dialog for about 11 s at 4,800 members and about 110 s
at 24,000). The dialog therefore opens on the **outline** (`outlineCurrentPackage`,
`src/ui/exportPackageActions.ts`): every template item with its folder, the package folder
and tokens, the revision from the drawing revisions recorded in the project, and the model
counts (wire lines, parts and marks, assemblies and marks, and the drawing sheets when the
drawing set is already made, e.g. by the Drawings tab — it is shared through the same
cache, `drawingsOf` / `allDrawings`). Nothing is generated. **Calculate sizes** plans the
package (file names, counts, sizes, QA form decisions, folder tree); after a change to the
template, the fields or the model the sizes show as out of date until recalculated. Up to
300 parts the package is planned as the dialog opens and on every change, as before. The
export buttons plan the package themselves, so exporting never needs the calculation first.
Measured in the browser on the client facade after auto-connect (714 wire lines, 1,196
parts): the dialog opens in about 0.14 s, Calculate sizes takes about 2.4 s, a keystroke in
a package field about 0.07 s.

## Writing

- **Export to folder…** (`window.showDirectoryPicker`): files are written one by one as they
  are made (no large memory use); an existing package folder is updated after a
  confirmation (files with the same name are replaced, others kept).
- **Download ZIP**: STORE ZIP assembled from chunks; warning above 500 MB, refused above
  4 GB or 65,535 files (use the folder export). In the claude.ai artifact the ZIP goes
  through the host's `downloads` capability.
- Progress bar with Cancel; the README lists what was written when cancelled.
- The last package fields, template, item choice and history are kept in the project.

## Limits

- STEP solids are faceted (planar triangles), not exact cylinders / B-splines; validated
  structurally (entity references, closed shells) — check the first files in the target CAD.
- OBJ / STEP and per-sheet PDFs are generated in the browser; very large models take time
  (progress shown). The combined and per-sheet PDFs are rendered separately.
- Profile parts are not unfolded (`CNC/Profiles/DXF` stays empty).
- The QAF text-size rule reads the drawing entities (no separate layout validator yet).
- Uploaded form workbooks and reference files live in the browser's storage; on another
  browser they must be uploaded again (the item reports the missing file).
