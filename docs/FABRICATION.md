# Fabrication and supply-chain outputs

FacadeSteel turns the derived model (parts, assemblies, bolts — `src/core/derive/model.ts`)
into the files a fabrication shop, galvanizer, paint shop, logistics and an MIS/ERP system
need. Everything is computed in the browser from the same derived model as the drawings,
IFC and material list, so all outputs agree with each other.

Where to find it:

- **Outputs → Fabrication** tab: plate CNC options and exports, part labels, packing lists,
  galvanizing (bath size, dip checks), paint system and areas, MIS/ERP export.
- **Outputs → Cut optimisation**: *Bars* shows stock on hand (import / edit / export) and the
  purchase list; *Plates* has the plate DXF / nested DXF / NC1 buttons.
- **Outputs → Material list**: painted area and coating litres next to the totals.
- **Export** menu (top bar): every export below.
- **Assistant**: tools `fabrication_export`, `fabrication_report`, `set_stock`,
  `set_fabrication_settings` (`src/assistant/modules/fabrication.ts`).

Code: `src/core/fabrication/` (pure logic, no DOM), `src/core/optimize/`, UI in
`src/ui/FabricationPanel.tsx` and `src/ui/fabricationActions.ts`. Tests:
`tests/fabrication*.test.ts`.

Settings live in `project.settings.fabrication` (only changed keys are stored; defaults in
`src/core/fabrication/settings.ts`), the bath in `settings.galvBath` and stock on hand in
`settings.stock`.

---

## 1. Plate CNC DXF (laser / plasma / waterjet)

**Per part** (`Plate DXF per part`): one file per unique plate mark, in a folder per
thickness and material (`PL10-S355/pl3.dxf`), plus `plates.csv` (mark, qty, thickness,
material, size, round holes, slots, unit weight, file).

**Nested sheets** (`Nested plate sheets`): one file per sheet from the plate nesting
(`PL10-S355/sheet-01.dxf`) with every placed part, plus `nesting.csv` (sheet, mark, part
reference, x / y of the placement, rotated yes/no, size).

Conventions (what CAM importers such as SigmaNEST, Lantek, ProNest or a laser's own
software expect):

| Item | Convention |
|---|---|
| Format | ASCII DXF R12 (AC1009), `$INSUNITS` = 4 (mm), 1 drawing unit = 1 mm, full size |
| Position | Part in the first quadrant, bounding box at (0, 0) |
| `OUTLINE` layer | Outer contour, one closed `POLYLINE`, counter-clockwise |
| `HOLES` layer | Round holes as `CIRCLE`; slots as closed `POLYLINE`s: two straight sides and two 180° arc segments (vertex bulge ±1), clockwise (inner contour) |
| `MARKING` layer | Part mark as `TEXT` for ink-jet / etch / punch marking (optional: *Part mark on MARKING layer*, text height setting). Placed inside the plate, clear of holes; left out when the plate is too small |
| `SHEET` layer | Nested files only: sheet frame and a caption below the sheet. Never cut |
| Not included | Dimensions, title block, hatching, lead-ins/outs, kerf compensation |

Slot geometry: a hole `{x, y, d, slot, angle}` is an obround centred at (x, y), `slot` mm
of straight travel along `angle`, overall length `d + slot`.

Nesting: rectangular MaxRects (best short-side fit, 0° / 90° rotation) per thickness and
material, on the sheet sizes in Project settings. The gap between parts is the plate
spacing **plus the cutting kerf** (Fabrication tab, *Kerf*). Rotation is honoured in the
nested DXF (a rigid 90° counter-clockwise rotation — never a mirror; slots and the mark
text rotate with the part). The DXF geometry is nominal; kerf compensation (G41/G42 or the
CAM's kerf table), lead-ins and pierce points are set in CAM.

Limits: parts are nested by their bounding rectangle (no true-shape / common-line nesting),
no remnant tracking. Bent plates are cut as their flat pattern (the stored, developed
outline); their bend lines are not on the cutting layers (see *Flat patterns* below).

**Flat patterns** (`Flat patterns, all plates`, `flatPatternsDxf`): every unique plate's
flat pattern in one DXF, largest first, labelled on the SHEET layer (`pl1  PL10 S355  x4
160x150`), for checking and quoting:

- Bent plates carry their **bend lines** on layer `BEND` (long-dash dotted, colour 2,
  never cut) with a note per bend on SHEET (`UP 90 R5`, `DOWN 90 R5`).
- Parts bent from sheet — lipped C and Z, cold-formed L and U, POLY open strips of constant
  thickness, and any profile set to *bent from sheet*; never extruded or rolled sections
  ([PROFILES.md](PROFILES.md) §3.2) — follow as **developed strips**: the blank developed
  width × cut length on OUTLINE, the bend lines along the length on BEND, labelled
  `a1  C 200x75x20x2 t2 S355  x1  375x3000 developed`. Developed by the fold method of the
  *Unfold* settings: bend allowance with K = 0.33 (press brake, default) or the outside
  dimensions end to end (V-groove) (`profileStrip`, `src/core/geometry/bentPlate.ts`; see
  DRAWING_STANDARDS.md, *Flat patterns*). Holes and end cuts of the strips are not drawn.
- The heading counts both: `… flat patterns - 12 plate marks, 3 folded profile marks`.
  Without bends or folded sections the file is as before (no BEND layer).

### 1.1 Unfold DXF per bent part

*Fabrication → Unfold → Unfold DXF per part* (and the package output `unfold-dxf`, folder
`06-Exports/CNC/Unfold`): one file per unique bent part — bent plates and parts bent from
sheet — named by its mark, plus `unfold.csv` (mark, qty, kind, thickness, material, blank
width and length, folds, file). It is laid out as a folding shop's own unfold:

| Item | Convention |
|---|---|
| Format | ASCII DXF R12, mm, full size, bounding box at (0, 0) |
| Blank layer (default `CUT`, colour 3) | The blank as one closed `POLYLINE`; holes of bent plates as `CIRCLE` / slot polylines |
| Fold layer (default `BEND`, colour 1, `DASHED`) | Fold lines across the blank: along the length of a folded section, at the bend lines of a bent plate |
| Mark layer (default `TEXT`, colour 6) | The part mark centred on the blank, height 20 % of its smaller side (3–120 mm) |

The layer names are set in the *Unfold* card, or read from a sample unfold of the folding
shop (*From sample DXF…*: the layer of its closed outline, of its lines and of its text —
`CUT`, `Grouve`, `Text` for the client's file). The *fold method* sets how folded sections
are developed: *Press brake (K-factor)* or *V-groove (outside dims)* — the outside dimensions
end to end with the fold lines at the outer corners (a 2 mm lipped U 88 × 177 with 13 mm lips:
468 wide, folds at 13, 190, 278, 455). Extruded and rolled sections have no unfold. Holes of
folded sections are not mapped onto their strip (see the part drawing's hole table). Code:
`unfoldDxfFiles`, `unfoldToDxf`, `unfoldLayersFromDxf` in `src/core/fabrication/plateDxf.ts`.
Settings: `settings.fabrication.unfoldMethod`, `unfoldLayers`.

## 2. DSTV NC1 for plates

`Plate NC1` writes one `.nc1` per unique plate mark (the general *CNC files* export
continues to cover every part):

- `ST` header: order (project no.), drawing (assembly), phase, part mark, steel grade,
  quantity, profile `PL<t>*<height>`, **profile code `B`** (plate), length, height,
  thickness, mass/m and surface/m, finish, name.
- `AK` outer contour on face `v`, coordinates from the bounding-box corner, closed (first
  point repeated).
- `BO` holes on face `v`: x, y, diameter; slots add the elongation (`l` with x / y travel
  and angle).
- `SI` marking: face `v`, position (same placement as the DXF marking text), angle 0,
  letter height, `r` + part mark. Writing the SI block follows the *Part mark* setting.
- `EN`.

The SI reference letter and the slot convention vary between post-processors — check the
first files on the machine.

A DSTV file per **nested sheet** is not produced: NC1 describes single parts, while sheet
programs are machine- and CAM-specific (lead-ins, pierce order, kerf, bridges). Use the
nested DXF and `nesting.csv`, or nest the NC1 parts in CAM.

## 3. Part labels (QR + Code 128)

PDF label sheets, one label per **physical piece** (piece *i* of *n*) or one per **unique
mark and delivery batch** (with its quantity):

| Layout | Page | Labels |
|---|---|---|
| `a4-3x8` | A4 portrait | 3 × 8 = 24, 70 × 37 mm, no gaps, 0.5 mm top margin |
| `a4-2x7` | A4 portrait | 2 × 7 = 14, 99 × 38 mm, 4.75 mm left, 15.5 mm top, 2.5 mm column gap |
| `thermal-100x50` | 100 × 50 mm | one label per page (roll printers) |

Content: part mark (large), profile and length (or plate size), assembly, weight each,
material, finish, phase and delivery batch, project number and piece number / quantity.
Print at 100 % ("actual size").

- **QR code** (error correction M, 4-module quiet zone), compact JSON:
  `{"p":"FS-001","m":"pl3","a":"BK1","q":5,"i":2}` — `p` project number (or name),
  `m` part mark, `a` assembly mark(s), `q` quantity, `i` piece number (per-piece labels).
  A typical payload fits QR version 3–4. Generated with `qrcode-generator` (MIT).
- **Code 128** (code set B, ISO/IEC 15417) of the part mark: start B (104), data values
  (ASCII − 32), check symbol = (104 + Σ position × value) mod 103, stop; 10-module quiet
  zones. The encoder is in `src/core/fabrication/code128.ts`. The module width follows the
  label (≈ 0.25–0.5 mm for short marks).

PDF text uses the standard Helvetica font (Windows-1252); other characters in names are
replaced by `?`.

## 4. Packing lists (per delivery batch)

One list per delivery batch (`project.batches`; members carry `batch`; members without a
batch go to **Unassigned**, empty batches are skipped). Connection parts and bolts follow
their connection's main member (or the supported member when the support is concrete).
Each list has:

- **Assemblies**: shipping pieces — every assembly whose main part is a member, or that has
  welded parts. Mark, description, qty, unit / total weight, overall dimensions L × W × H,
  finish, a *Checked* column.
- **Loose parts**: single-part assemblies that are not a member (loose cleats, plates).
- **Bolts and anchors**: size, grade, length, qty and an estimated set weight (bolt + nut
  + 2 washers, or anchor stud + nut + washer, from the library dimensions and steel density).
- Totals (pieces, steel weight, fastener weight) and signature boxes (packed / checked /
  received).

Overall dimensions are the bounding box of all parts of the assembly measured in the main
part's own frame (so an inclined member still reads length × section), from member frames
and section sizes, plate outlines and thicknesses.

Formats: XLSX (a summary sheet plus one sheet per batch) and PDF (A4 landscape, one
document per batch, page numbers per batch).

## 5. Galvanizing batch lists and dip checks

Items are the HDG assemblies (finish *HDG* or *HDG + paint* on any part) — they are dipped
as fabricated, after welding — grouped per delivery batch (= galvanizing batch). For each:
overall dimensions, qty, unit / total black-steel weight, dip classification, suggested
orientation, and a vent/drain reminder.

Dip classification against `settings.galvBath` (inside length × width × depth) with a
**clearance** kept free on every dimension (default 100 mm, for jigs and hanging):

- **Single dip** — the item fits the usable bath in some orientation (all six tried).
- **Double (progressive) dip** — two dimensions fit and the third exceeds the usable bath
  *length or depth* by up to ≈ 2 × that usable dimension (dip one end, then the other).
- **Oversize** — anything larger: split, bolt on site, or use another galvanizer.

This is a **typical rule — confirm with the galvanizer** (their maximum sizes, lifting
capacity and whether they double-dip at all).

**Vent and drain holes**: every assembly containing a hollow section (RHS / SHS / CHS) gets
the reminder "vent and drain holes to EN ISO 14713-2 (size and position agreed with the
galvanizer) unless both ends stay open". Hole sizes are not generated — they depend on the
section, the length and the galvanizer.

Weights are black (uncoated) steel; zinc typically adds a few percent. Format: XLSX
(summary per batch with counts and largest dimensions; item list).

## 6. Paint areas

For parts finished **Paint** and **HDG + paint** (duplex), per unique assembly (each and
× qty) and in total, split by finish:

- Area = derived part surface: members and cleats = section perimeter × length (outside
  only — the inside of hollow sections is not painted; cut ends excluded); plates = both
  faces (edges excluded).
- Coating system (Fabrication tab or assistant): coats with dry film thickness DFT (µm) and
  volume solids VS (%), and an application loss (%).
- **Theoretical spreading rate** TSR (m²/L) = VS (%) × 10 / DFT (µm).
  Litres per coat = area / TSR / (1 − loss). With loss 0 this is the theoretical
  consumption. Example: 80 µm at 60 % VS → TSR 7.5 m²/L; 30 m² → 4.0 L.

The default system (primer 80 µm / 60 %, topcoat 60 µm / 55 %) is a placeholder — enter
the project coating specification. Format: XLSX (summary, by assembly, coats); the material
list shows the total area and litres.

## 7. Export for MIS / ERP

`Export for MIS/ERP` downloads a zip with:

- `facadesteel-mis.json` — the document below,
- `csv/parts.csv`, `assemblies.csv`, `bolts.csv`, `operations.csv`, `welds.csv`,
  `coatings.csv` — the same content flattened,
- `<project>.ifc` — the IFC4 model (unchanged existing export).

### JSON schema (`facadesteel.mis`, version 1)

Units: length mm, mass kg, area m², angles degrees. Marks are the drawing marks.

```text
{
  schema: "facadesteel.mis", version: 1, generated: ISO-8601 string,
  units: { length: "mm", mass: "kg", area: "m2", angle: "deg" },
  project: { id, name, number, client, designer },
  phases:  [ { id, name, sequence } ],
  batches: [ { id, name, date?, phase? (name) } ],
  parts: [ {
    mark, qty, type: "member" | "profile" | "plate", name, profile, material,
    finish: "none" | "hdg" | "paint" | "hdg+paint",
    length, width, thickness,          // linear: cut length, section width; plate: bbox w, h, t
    dims: [L, W, H],                   // overall, longest first
    unitMass, unitArea,
    assemblies: [mark],                // assemblies the part occurs in
    batches: [ { batch, qty } ],       // pieces per delivery batch ("Unassigned" if none)
    holes: { count, round: [ { d, qty } ], slots: [ { d, length (overall), qty } ] },
    cuts?: { start: Cut, end: Cut },   // linear parts
    contourLength?                     // plates: cut contour length
  } ],
  Cut = { kind: "square" | "bevel" | "mitre" | "cope" | "fit", angleWeb, angleFlange,
          copeDepth?, copeLength? }    // saw angles from square, from the member end preparation
  assemblies: [ { mark, qty, main (part mark), parts: [ { mark, qty } ], unitMass,
                  dims: [L, W, H], finish, batches: [ { batch, qty } ], phases: [name] } ],
  bolts: [ { batch, kind: "bolt" | "anchor", size, grade, length, qty, unitMassEstimate } ],
  operations: [ {                      // per part mark, in shop order (seq 10, 20, …)
    part, seq, op: "saw" | "cope" | "thermal-cut" | "drill" | "slot" | "mark" | "galvanize" | "paint",
    qty, end?: "start" | "end", d?, length?, angleWeb?, angleFlange?, detail
  } ],
  welds: [ { assembly, partA, partB, type: "fillet", size, length } ],
                                       // one row per shop-weld joint of each assembly mark;
                                       // size = drawing weld size (throat ISO / leg ASME);
                                       // length = estimate or null
  coatings: [ { assembly, qty, finish, areaEach, areaTotal } ],
  totals: { parts, assemblies, mass, bolts }
}
```

Notes and limits:

- Saw angles come from the members' end preparations (`startPrep` / `endPrep`); square
  ends report 0 / 0.
- Weld lengths are **estimates**: the length of a plate's edges that bear on the other
  part (sampled at mid-thickness, partial contact counted) × 2 for a fillet each side.
  Joints where no plate edge bears on the other part (e.g. member-to-member) report `null`.
- Bolt masses are estimates (see packing lists).

## 8. Stock on hand and purchase list

Stock is a list of `{ profile, length, qty, material? }` (`qty -1` = unlimited, blank
material = any grade). Import a CSV (*Import stock CSV* in Cut optimisation, or the
assistant's `set_stock`), edit it in the table, export it again.

CSV parsing is tolerant:

- delimiter `,`, `;` or tab; quoted fields; blank lines and `#` / `//` comments skipped;
- optional header row in any column order: profile / section / designation / size,
  length, qty / quantity / pcs / on hand / stock, material / grade;
- without a header, columns are recognised by content (profile text, grade such as S355,
  the larger number or the one with a unit is the length, the other the quantity);
- lengths in mm, or metres with `m` (`6 m`, `7,5m` with `;`/tab files); a bare value
  ≤ 30 is taken as metres;
- quantity `-1`, `unlimited`, `inf`, `∞`, `*` = unlimited; a missing quantity is taken as
  1 (warning);
- profile names are matched to the library (`shs100x100x5` → `SHS 100x100x5`); unknown
  names are kept as typed (warning); duplicate rows are merged.

Bar nesting with stock (`planBars`, used everywhere bars are nested):

1. Per profile and material, pieces longest first are placed best-fit into bars already
   opened from stock; a new bar is opened from the **longest stock length on hand that
   fits**; quantities are shared across groups (an item without material serves every
   grade).
2. Every stock bar is then swapped for the **shortest on-hand length that still holds its
   cuts** (the longer bar goes back to stock).
3. Pieces that fit no bar on hand are nested into the standard `stockLengths` (the
   existing best-fit-decreasing optimiser) — that is the **purchase list**.

The cut-optimisation tab marks bars from stock with ◆ and lists *from stock* / *buy* per
profile; *Purchase list* exports an XLSX (purchase, taken from stock, remaining stock).
Saw kerf and end trim apply to stock bars like to purchased bars. Offcuts are not returned
to stock automatically.

## 9. Assistant tools

| Tool | Does |
|---|---|
| `fabrication_export` | Downloads `plate_dxf`, `nested_dxf`, `plate_nc`, `labels_pdf` (layout, per piece/mark), `packing_xlsx`, `packing_pdf`, `galvanizing_xlsx`, `paint_xlsx`, `mis_zip`, `purchase_xlsx`, `stock_csv` |
| `fabrication_report` | Returns data: packing lists, galvanizing checks, paint areas/litres, stock plan, nested plates, label counts, MIS totals |
| `set_stock` | Replace / append / clear stock on hand from CSV text or items |
| `set_fabrication_settings` | DXF marking and text height, plate kerf, label layout and per piece/mark, bath size and clearance, paint coats and loss |

All edits go through the undo history.
