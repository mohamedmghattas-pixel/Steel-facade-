# Drawing standards

FacadeSteel produces a numbered drawing set:
- a drawing register
- general arrangement (GA) drawings, with an unfolded (developed) elevation of folded facades
- section and detail sheets cut on the GA
- erection drawings: bracket setting-out plans, anchor schedules and erection sequences
- assembly drawings
- part (fabrication) drawings

Every sheet can be edited by hand on top of what is generated (see *Editing drawings*), and the title block can follow a company template (see *Sheet templates*). Every sheet is laid out by one layout engine that keeps its blocks apart, continues long tables on further sheets and checks the result (see *Sheet layout*). Large facades are divided into zones, one sheet per zone (see *Large facades: zones*); folded facades also get an unfolded elevation (see *Unfolded elevation*), and bent plates and folded sections their flat patterns (see *Flat patterns*). Sheets are made when they are viewed or exported, not all at once (see *Drawings on demand*).

By default the sheets follow the ISO technical-drawing standards and EN 1090-2 for steel execution. You can switch the set to an **ASME / AISC** profile under *Outputs → Drawings → Drawing settings*.

The table below shows how each standard is applied. The implementation follows the published scope and summaries of these standards. Check it against your licensed copies and any project specification before relying on it contractually.

## ISO profile (default)

| Topic | Standard | How it is applied |
|---|---|---|
| Sheet sizes and layout | ISO 5457 (A-series, ISO 216) | The frame has a 20 mm filing margin on the left and 10 mm on the other sides, drawn as a 0.7 mm line. A grid reference border runs outside the frame, with numbers along the top and bottom and letters down the sides (I and O are not used). Centring marks run from the trimmed edge to 5 mm inside the frame. Default sheet is A3 landscape; A2, A1 and A0 are available for GA drawings. |
| Title block | ISO 7200 | The title block is 180 mm wide, bottom right. Its fields are: legal owner, identification number (drawing no.), revision index, date of issue, sheet n/N, title and supplementary title, created/checked/approved by, document type, document status, project, project no. and client. |
| Document status | ISO 7200 | In preparation → In approval → Released → Withdrawn. |
| Revisions | ISO 7200 revision index | The revision table sits directly above the title block: Rev, description, date, drawn, checked, approved, showing the latest four entries. The index runs A, B … Z, AA … or 0, 1, 2 …. A sheet whose content changes after an issue is flagged as changed and goes back to *In preparation* until it is issued again. |
| Projection method | ISO 5456-2, ISO 128-3 | First-angle projection. The plan view is placed below the front view, and the view from the left is placed on the right. The projection symbol (truncated cone) is shown in the title block. |
| Views | ISO 128-3 | Every part and assembly sheet has ELEVATION, PLAN and SECTION A–A, labelled. Long members use **interrupted views** with narrow break lines, so the cross-section stays at true scale. Dimensions always show true lengths. |
| Sections | ISO 128-3, ISO 128-50 | The cutting-plane line (long-dash dotted, wide at the ends) carries arrows for the viewing direction and the letter A. Cut material gets 45° hatching, with adjacent parts at a different angle or spacing. |
| Line types and widths | ISO 128-2 (line group 0.5) | Visible outlines are continuous wide 0.5 mm. Dimension, extension and leader lines are continuous narrow 0.25 mm. Hidden edges are dashed narrow (12d dash, 3d gap). Centre lines are long-dash dotted narrow. The title block and grid use 0.35 mm, the frame 0.7 mm. DXF layers are named after these line types. |
| Lettering | ISO 3098 | Lettering is a type-B style at heights of 1.8, 2.5, 3.5, 5 and 7 mm. The drawing number uses 5 mm bold. Notes and tables are at least 1.8 mm high on paper, marks and item references at least 2.5 mm (checked by the layout check). |
| Dimensioning | ISO 129-1 | Dimension lines end in closed filled arrowheads, with the value above the line, readable from the bottom or the right. Hole positions use chain dimensions. Coordinate positions use running dimensions, with the origin marked by a small circle. |
| Scales | ISO 5455 | Only 1:1, 1:2, 1:5, 1:10, 1:20, 1:50, 1:100, 1:200, 1:500 … are used. The main scale appears in the title block. |
| Item references | ISO 6433 | Each part mark sits in a balloon, with a leader ending in a dot on the part. Identical parts share one reference. Balloons above a view sit in a row 11 mm apart, further where long marks make larger balloons, so they never overlap. Assembly marks on GA and erection views are placed clear of each other (see *Mark placement*). |
| Parts lists | ISO 7573 | Columns are item, quantity, designation (profile – length, ISO 5261 style), material, mass, and the referenced part drawing number. |
| Welding symbols | ISO 2553 (system A), ISO 4063 | The symbol has an arrow line and a continuous reference line with a dashed identification line. The fillet symbol sits on the arrow side with the throat **a** (for example `a4`). A circle marks weld-all-round, and the process number (e.g. 135 MAG) goes in the tail. |
| Execution and fabrication notes | EN 1090-2 and referenced standards | General notes cover these points (each only where relevant to the sheet):<ul><li>Execution class and steel grades: EN 10025-2, EN 10219-1.</li><li>Holes and deburring, normal clearance.</li><li>Thermal cutting to EN ISO 9013.</li><li>Welding to EN ISO 3834-3, welders to EN ISO 9606-1, quality level ISO 5817 C.</li><li>Welded-assembly tolerances: ISO 13920-BF.</li><li>Galvanizing to EN ISO 1461, with vent and drain holes to EN ISO 14713-2.</li><li>Painting to ISO 12944.</li><li>Bolts EN ISO 4014/4017, nuts EN ISO 4032, washers EN ISO 7089.</li></ul> |

## ASME / AISC profile

- **Projection:** third-angle (ASME Y14.3). The plan view goes above the front view, and the view from the right goes on the right.
- **Weld symbols:** AWS A2.4. A single reference line, the arrow-side symbol below it, and a leg size.
- **Notes:**
  - AISC 303 Code of Standard Practice and AISC 360
  - AWS D1.1
  - ASTM A123 / A153 galvanizing
  - ASTM F3125 bolts
- **Sheet layout:** sheet layout, title block and revision table stay as in the ISO profile.

## What each sheet contains

### Drawing register
- Every sheet in the set: drawing number, title, document type, sheet size, scale, current revision, date of issue and status.
- Changed sheets are marked with `*`.

### General arrangement (front elevation and plan)
- Grids with bubbles and spacing dimensions.
- Levels.
- Every assembly with its mark.
- An assembly schedule (mark → quantity → main part → mass → **assembly drawing number**).
- The site bolt and anchor schedule.
- The cutting planes of section cuts and the circles of detail callouts, each with its letter and the number of the sheet that shows it.
- When the elevation or plan is divided into zones (see *Large facades: zones*), the GA sheet becomes the overall view: the whole facade at the scale that fits, the zone outlines with their labels (Z1, Z2 …) and sheet numbers, and a **zone index** (zone → drawing → view → extent → assemblies) instead of the assembly schedule. Each zone sheet (`-GA-01-Z2` …) shows its part of the view with grids, levels and marks and lists its own assemblies.

### Section and detail sheets
See *Sections and details* below.

### Erection drawings
See *Erection drawings* below.

### Assembly drawings
- Three views of the whole assembly in the main part's axes: **ELEVATION**, **PLAN** and **SECTION A–A**, arranged per the projection method.
  - The section cuts across the main part where a secondary part is attached.
  - The cutting-plane line is marked on the elevation and cut parts are hatched (ISO 128-50); adjacent parts are hatched at different angles.
- Item balloons and weld symbols for shop-welded parts.
- Positioning dimensions.
- A parts list with the **part drawing number** of every item.
- The GA sheets that show the assembly.

### Part (fabrication) drawings
- Always three views: **ELEVATION**, **PLAN** and **SECTION A–A**.
  - The section is cut through the main hole group and hatched, with hole voids left open.
  - A small section is enlarged to a larger ISO 5455 scale, and its label states that scale.
  - Plates get a face view, an edge view from above, and a section through the hole column.
- Hole and slot positions dimensioned on the views.
- A **hole table** with coordinates from the part datum. These are the same coordinates as the DSTV NC file.
- **Machining / fabrication steps** in shop order:
  - saw cut or profile cut
  - drilling
  - slotting
  - deburring
  - marking
  - galvanizing (with vent holes where needed)
  - painting
- A **"Used in" table** linking back to the assembly drawings.
- Bent plates and folded (cold-formed) sections show their flat pattern: see *Flat patterns*.

## Sections and details

Section cuts and detail callouts can be placed anywhere on the GA front elevation or plan: in the Drawings tab, on a GA sheet, with the **Section cut** / **Detail** tools (two clicks), or by coordinates in the **Cuts…** list, where they can also be edited and deleted.

| Topic | Standard | How it is applied |
|---|---|---|
| Cutting plane | ISO 128-40 (now consolidated in ISO 128-3), ISO 128-2 | Long-dash dotted narrow line, wide at both ends. Arrows at the ends show the viewing direction; the section letter stands beside each arrow. The number of the section sheet is written next to the letter at the end of the line. By default the section looks to the right of the line drawn from the first to the second point; it can be flipped. |
| Section view | ISO 128-40 | Labelled `SECTION B–B` with its scale. It shows the parts cut by the plane and the parts beyond it, up to the look depth (default 1000 mm), as visible outlines. Parts between the viewer and the plane are left out. The view keeps to the extent of the cut line. Grid lines crossing the plane are drawn as centre lines with bubbles; levels (vertical sections) as level lines with their values. |
| Hatching | ISO 128-50 | Cut material gets continuous narrow 45° hatching; adjacent cut parts are hatched at another angle or spacing. Thin walls are hatched at the minimum spacing so they read as solid; hole voids stay open. |
| Detail callout | ISO 128 (elements on a larger scale; now ISO 128-3) | The area is encircled with a continuous narrow line on the GA and identified by a capital letter (I, O and Q are not used) and the detail sheet number. |
| Detail view | ISO 128-3, ISO 5455 | Labelled `DETAIL C` with its scale (ISO 5455, automatic or chosen). Part outlines, plate holes and bolts/anchors (end-on with centre lines, side-on as the shank) are clipped to the detail circle, which is drawn as the view boundary. Item references (ISO 6433) name the parts inside. |
| Dimensions | ISO 129-1 | Sections carry the overall dimensions of the cut parts. |

Each cut gets its own sheet (`-SD-NN`), listed in the register after the GA sheets. Adding, moving or deleting a cut changes the GA's content, so the GA is flagged as changed.

## Erection drawings

There is no ISO standard for the content of facade erection drawings. FacadeSteel follows **typical facade-contractor practice** for what is shown, and applies the ISO conventions above for how it is drawn: lines ISO 128-2, lettering ISO 3098, dimensions ISO 129-1, scales ISO 5455, item references ISO 6433, title block ISO 7200. The erection drawings can be left out of the set under *Drawing settings*.

### Bracket setting-out plans (`-E-NN`)
- One plan per level (the project levels, or the slab-bracket elevations when there are none) and slab edge direction. Long edges are split over several sheets so that the plan stays at 1:20 where possible. The sheets of one split edge are zones of it: the title says *zone 1 of 3*, match lines at the ends of the plan refer to the sheets before and after (*MATCH LINE — SEE DRAWING …-E-04*), and a schematic key plan above the notes shows the edge divided into the sheets, this one hatched.
- The plan is turned so that the slab edge runs along the sheet, slab side up, and shows:
  - the slab edge (continuous wide line, hatched band on the concrete side) and the facade setting-out line (mullion wire line, long-dash dotted);
  - the grid lines crossing the edge, with bubbles;
  - every slab bracket: the mullion cut at bracket height and hatched, the bracket plates, and the anchors — top-mounted anchors as holes with centre lines, edge-mounted anchors as the anchor body inside the slab (hidden lines) with the drilling point on the slab face;
  - **running dimensions** (ISO 129-1: origin circle on the grid line, values at the arrowheads) from the nearest grid line to every anchor, both sides of the grid line, and the grid spacing below them;
  - the distance from the facade setting-out line to the slab edge (stand-off) at every bracket, and for top-mounted brackets the edge distance of the anchors;
  - the bracket marks in balloons (ISO 6433).
- A bracket table (mark, grid reference, X / Y, anchor level, stand-off, fixing, anchors) and setting-out notes, including the project's tolerances (Project settings → movement and tolerances) and a reference to the anchor schedule.
- When the project has **site survey** points, each bracket is matched with the nearest surveyed slab-edge point on its level (within the survey match radius). The surveyed position is marked with × and the deviation from the design is written next to it as Δe (along the edge), Δn (into the slab) and Δz (vertical). A survey table checks the deviations against the slab-edge tolerances.

### Anchor schedules (`-AS-NN`)
- One row per anchor (every bolt of kind *anchor*), ordered by level and along the facade: anchor id, bracket mark, grid reference (nearest grid line and offset), level reference (nearest level and height above or below it), X / Y / Z of the drilling point, fixing (slab top / slab edge), anchor type, size, length and the quantity per bracket.
- Totals by type, size and length, and installation notes. Long schedules continue on further sheets.
- The same schedule exports as CSV (*Anchor schedule → CSV* in the Drawings tab).

### Erection sequences (`-ES-NN`)
- One sheet per erection phase, in the phases' sequence order, showing the GA front elevation with grids and levels: the assemblies of the phase drawn **extra wide** (0.7 mm), those erected in earlier phases narrow, later phases left out. Only the phase's assemblies are marked.
- A sequence legend (all phases with assembly count, mass and status), a line key and the list of assemblies in the phase with their drawing numbers. A list that does not fit continues on sheet 2/N of the same drawing.
- Assemblies take the phase of their main member; brackets that of the mullion they support. Assemblies in no phase go on a final sheet *Not assigned to a phase*.
- Without phases, a **default sequence by floor, bottom-up** is used (each assembly goes to the floor its lowest point lies on), and the sheets say so.
- When the front elevation is divided into zones, there is one sheet per **phase × zone** (`-ES-01-Z2`: phase 1, zone 2), only where the phase has assemblies in the zone. Each has the key plan, the legend, the line key and the phase's assemblies in that zone. Its match lines refer to the same phase's sheet of the adjacent zone, or to the GA zone sheet where the phase has nothing there.

## Sheet layout

There is no ISO standard for where blocks go on a sheet; FacadeSteel keeps to ISO 5457 (frame, title block position) and ISO 7200 (title block, revision table) and applies these rules to every sheet.

- **One layout engine** places all blocks of a sheet — views, tables, legends, notes, key plans — in the free regions of the frame. Reserved regions are kept clear: the frame margins and centring marks, the title block and the revision table above it. Notes and legends go into the column above the revision table (title block width), tables into columns along the bottom; views get the free area that remains. Every placement is checked against the reserved regions and the blocks already placed.
- **Nothing is drawn over anything else.** A block that does not fit is not squeezed in: tables and notes are split at a row or line (the rest titled *(cont.)*), and what is left **continues on the next sheet of the same drawing**, where it flows in columns from the top left, clear of the title block.
- **Multi-sheet drawings (ISO 7200):** the sheets of one drawing share its identification number and are told apart by the sheet number in the title block (*Sheet 2/3*). The register lists every sheet, multi-sheet drawings as `FS-001-ES-01 (2/3)`; exported files are named `<number>_sh2_rev<rev>`. Each sheet has its own id (`seq-floor-1#2` for sheet 2; the first sheet keeps the drawing's id), so revisions, fingerprints and manual edits are kept per sheet. Single-sheet drawings keep their ids and numbers.
- **Layout check** (`checkSheetLayout`): every sheet is checked for blocks that overlap each other, blocks outside the frame or over the title block / revision table, lettering below 1.8 mm (notes, tables, dimensions) or 2.5 mm (marks and item references, ISO 3098 guidance), and marks overlapping other text. Problems are shown above the sheet in the Drawings tab, and the list marks such sheets with ⚠ (filter *Layout*) once they have been made — when viewed, or by the background check (see *Drawings on demand*). Manual edits (moved blocks, notes) are checked too.

### Mark placement

Assembly marks on GA, zone and erection views are 2.5 mm high (ISO 3098) and placed one by one, avoiding every mark and text already placed (grid bubbles, level and dimension text, the view label): first beside the mark's point (up and to the right, as before, then the other sides), then further away with a narrow leader line ending in a dot (ISO 6433 style). A mark that finds no free position inside the view is left out; the view then says so under its label (*20 of 115 marks not shown — no legible position at 1:200; see the assembly table*) and the sheet's assembly table still lists the assembly. A larger sheet or a smaller zone scale avoids this.

## Large facades: zones

A GA elevation or plan, or an erection sequence, of a large facade is not legible on one sheet. It is divided into **zones**, one sheet per zone (*Drawing settings → Large facades — zones*).

| Topic | Rule |
|---|---|
| When | The legible scale is the largest ISO 5455 scale at which the assembly marks find free positions (a placement test with 2.5 mm marks: at most 2 % left out in dense corners, at most a quarter on leaders). When the whole view on one sheet would be at a smaller scale than that, or the facade is drawn normal to an inclined facade, the view is divided. Small facades (the sample project) stay on one sheet exactly as before. |
| Scale | *Auto* (the legible scale, or a larger one when every facade part fits one sheet at it) or a preferred ISO 5455 scale. When more zones than *Most zones per view* (default 12) would be needed, the next smaller ISO scale is used. |
| Where | Zones are divided at **grid lines** (columns) and **levels** (rows) where possible, else at member lines (mullions for columns, transoms for rows), else in equal widths — as evenly as possible, each zone fitting the view area of the zone sheet. *Divide at: Equal widths* skips the grid and member lines. Zones without assemblies of their own (an empty corner of a sloped facade) are left out. |
| Overlap | Beyond each match line the view shows the neighbouring zone for the overlap (default 1000 mm), drawn narrow. |
| Assemblies | Every assembly belongs to exactly one zone — the one its mark lies in. Only those are marked and listed on the zone sheet; parts of other zones are drawn narrow. |
| Numbers | Zone sheets take the drawing's number with `-Z<n>`: `…-GA-01-Z2`, `…-GA-02-Z1` (plan), `…-ES-01-Z3` (phase 1, zone 3). Ids: `ga-front-z2`, `seq-<phase>-z3`. The overall GA sheet keeps its number and id. |
| Title | *General arrangement – Elevation – Zone 2 of 6*, with the zone name (*Zone 2 of 6 — grids 8–14, levels L02–L05*; without grids *facade A, strip 1/2, upper*) in the supplementary title, the view label and the notes. |
| Sheet size | GA and erection sequence sheets use *GA & erection sequence sheets*. For big facades A1 is suggested (fewer, larger zones); the settings show how the current model is divided. |

### Key plans and match lines

- **Key plan** (top of the right-hand column of every zone sheet, not to scale): the whole facade as member centre lines in the front elevation (or the plan), every zone outlined and labelled Z1, Z2 …, the zone of the sheet hatched.
- **Match lines** at the zone edges: long-dash dotted wide lines (0.7 mm) with *MATCH LINE — SEE DRAWING <number>* along them, naming the sheet of the adjacent zone. Where a facade folds (see below), the match line at the fold is marked *MATCH LINE (FOLD)* and refers to the zone across the fold.
- The zone width between its match lines is dimensioned below the view (true length in the view plane), with the grid spacing where grids cross the zone.

### Views normal to the facade

Elevation views have a view direction (*Elevation view direction*):

- **Front elevation (world)** — looking north, as before.
- **Normal to the facade** — the view looks along the normal of the facade's best-fit plane, so the facade appears in true shape and dimensions are true lengths in the facade plane. Paper up is world up projected onto the plane.
- **Auto** (default) — normal to the facade where its best-fit plane is inclined more than 10° from vertical or is not aligned with X; else the front elevation.

A folded facade (V-shaped or polygonal in plan, or with parts at different inclinations) is first split where the best-fit planes of its parts differ by more than 10° (recursive two-plane fits along the facade); each part (*facade A, B* …) gets its own view and zones, and the zones meet at the fold with match lines. The view label states the direction (*VIEW NORMAL TO FACADE A — ZONE 2*) and a note gives the plane's inclination. Levels are drawn where they cut the plane (horizontal lines with their true heights); grid lines are projected onto the plane; both are omitted where they do not cross the zone. Section cuts and details are placed on world-projection GA views only.

## Unfolded elevation

A folded, V-shaped, faceted or curved facade gets an **unfolded (developed) elevation**: its facade planes laid out flat side by side, in plan order, as one continuous strip (`src/core/drawings/unfolded.ts`). It is a GA sheet, `<prefix>-GA-04`, after the GA front and plan; *Drawing settings → Unfolded elevation* switches it off (default *When folded*). A planar facade, vertical or inclined, has no unfolded elevation: the GA's view normal to the facade already shows its true shape.

| Topic | Rule |
|---|---|
| Facade planes | The facade parts of the views normal to the facade (*facade A, B* …: recursive best-fit planes, split where they differ by more than 10°, see *Views normal to the facade*). Each plane is refitted on the axes of its members (brackets behind the facade do not tilt it) and taken as vertical when it is within 1° of vertical. |
| Development | Facade A keeps its view normal to its plane. Each next facade part is turned about the **fold line** it shares with the previous one (the intersection of the two planes) into the drawing plane, on the far side of the fold. Each plane keeps its true shape and true lengths, and neighbouring planes join exactly along their fold line. The strip is then turned so that its fold lines are as near vertical as possible: exactly vertical with one fold, so the developed widths read across the strip. Every part is projected onto the plane of its facade part. The view is seen from the side the views normal to the facade are seen from (*looking N* …, stated in the notes). |
| Fold lines | Chain lines (ISO 128-2, long-dash dotted narrow) across the strip, labelled *FOLD F1 13.7°*: the **fold angle** is the deflection between the two planes (0° = flat). The *Folds* table gives each fold's facade parts, its developed position from the strip start, the angle, the **included angle** (180° less the fold angle) and whether it is seen as a **ridge** (pointing towards the viewer) or a **valley**. |
| Dimensions | Below the strip: the developed grid spacing (where grids cross the facade), the **developed width** of each facade part between its fold lines (end parts: to the extent of their steel) and the **overall developed length**. Widths are measured across the folds. The *Facade planes (developed)* table lists each part's developed width, its inclination from vertical and its assemblies, with the total. |
| Grids and levels | Where the grid planes and the level planes cut each facade plane: grid lines with bubbles above the strip; levels with their markers at the left, continuous across the folds. On a leaning folded facade the levels are horizontal in each plane but kink at the folds on the development (the strip is a chevron). |
| Marks | Assembly marks placed clear of each other and of the view's text, as on the GA (see *Mark placement*); they carry the navigation tags (mark → assembly drawing, instance → 3D). |
| One sheet or zones | On one GA sheet when the strip is legible there (the legible scale of the marks, as for the GA). Otherwise, with *Divide large views* on, the strip is divided like a GA view (same settings): the first sheet becomes the **overall sheet** (the whole strip at the scale that fits, zone outlines with their numbers, the zone index, the planes and folds tables, no marks), followed by **zone sheets** `<prefix>-GA-04-Z<n>` (*Unfolded elevation – Zone 2 of 6*). Zones are rectangles on the strip, divided at fold lines and grid lines (else member lines) and at levels, with the overlap beyond each match line. Each zone sheet has a **key plan** of the strip (facade planes, folds, every zone, this one hatched), match lines referring to the adjacent zone sheets, the folds in the zone and the assemblies whose mark lies in it (every assembly in exactly one zone). |
| On demand | Listed in the register without drawing it (the development and zones are worked out in steps while the register is built); each sheet is made when viewed or exported and keyed by what it shows (see *Drawings on demand*). In the export package it belongs to the GA elevations. |

On the client's V-shaped facade (two leaning planes, 29° from vertical, 1,170 assemblies) the unfolded elevation is an overall sheet at 1:500 and six zone sheets at 1:200: developed widths 52,962 + 52,965 mm, developed length 105,927 mm, one fold F1 of 13.7° (included 166.3°), seen as a ridge.

**Limits.** Curved facades are developed as the polygon of their best-fit planes (at most eight, the GA's facade parts), so a member on a curve is projected onto the chord plane of its facade part (a fraction of a millimetre per metre on usual radii). An assembly belongs to one facade part as a whole: a part of it on the other side of a fold is drawn in the plane of its assembly's part. Several non-parallel folds cannot all be vertical: the strip is turned to the best average and the developed widths are measured horizontally on the sheet at mid-height of each fold. Section cuts and details are placed on the GA, not on the unfolded elevation.

## Flat patterns

Bent plates and folded (cold-formed) sections show what is cut before bending on their part drawings, by the method of the bent plates (DIN 6935 with a neutral-axis K-factor, [MODELLING.md](MODELLING.md) §2): bend allowance BA = θ·(Ri + K·t), outside leg dimensions to the outer mould lines, K = 0.33 unless set on the plate.

**Bent plates** (`FreePlate` with bends):
- The elevation is the **FLAT PATTERN** (developed blank) with its holes, the bend lines as chain lines at the centre of each bend zone and the zone edges (zone width = BA) as thin lines, each bend labelled *UP 90° Ri 5* / *DOWN 90° Ri 5* beside its line, clear of the holes. UP: the far side bends towards the viewer of the flat pattern.
- The positions of the bend lines from the datum are dimensioned (running dimensions, between the hole dimensions and the overall size) where the bend lines are parallel to an edge.
- A **bend table** *Bends (flat pattern, K = 0.33)*: bend, direction, angle, inner radius, bend allowance and the bend line from the datum (`x = 55.2`, or its end points for an oblique bend).
- **Flat pattern notes**: the developed size, the bend allowance formula with the K-factor ("confirm K with the press brake tooling before cutting") and the meaning of UP / DOWN.
- The plan is replaced by the **FORMED SHAPE** seen along the bend lines (`formedProfile` in `src/core/geometry/bentPlate.ts`): both faces with the bend arcs, tangent lines at the arcs, the **outside leg dimensions** (the legs the plate was bent from) and the bend angles. Bends at another direction than the first are not in this view (the notes say so). The section A–A stays a section through the blank.

**Folded sections** — lipped C and Z (EN 10162), cold-formed L and U (an outer corner radius `ro`), and POLY thin-wall open outlines with a sheet thickness `t`: the part drawing gets a **FLAT STRIP (DEVELOPED)** block, *375 × 3000* — the strip (broken when long) with its bend lines along the length (B1, B2 …), the developed width and the length dimensioned, a bend table (direction, angle, inner radius, bend allowance, position from the first edge) and the K-factor note. Parametric sections are developed from their outside legs (C 200×75×20×2: 20 + 75 + 200 + 75 + 20 less four bend deductions = 374.7 mm); a POLY outline from its mid-line (the two end caps of length t, the mid-line between the sides, its bends where it turns, less the shift of the neutral fibre from mid-thickness to K·t at each bend) — within 0.3 mm of the parametric development for the catalogue sections drawn as POLY. Hot-rolled sections (root radii, no `ro`) and closed sections have no flat strip. Holes are not drawn on the strip (see the elevation and the hole table).

Both are written to the flat-patterns DXF of the export package (see [FABRICATION.md](FABRICATION.md) §1). Code: `src/core/geometry/bentPlate.ts` (`profileStrip`, `formedProfile`), `src/core/drawings/flatPattern.ts`, `partDrawing.ts`. Tests: `tests/flatPatterns.test.ts`.

## Drawings on demand

A large facade has thousands of sheets (a 24,000-member facade about 7,000, most of them setting-out plans and anchor schedules). They are not drawn all at once: the drawing set is listed first and each sheet is made when it is viewed or exported (`src/core/drawings/onDemand.ts`).

**The register (drawing index).** `drawingIndex(p, dm)` lists every sheet without drawing it: id, number, title, type, zone, sheet n/N, size, revision, and the scale where it is known without drawing (zone sheets, setting-out plans, schedules). Each generator builds and packs the sheet's tables and notes on a *measuring* sheet and leaves out the views; what continues on sheet 2/N depends only on those blocks, so ids, numbers, titles and sheet counts are exactly those of the drawn set. The zone partition, the slab brackets and the anchor rows are worked out once per model state, in steps, so the Drawings tab builds the register in slices that never hold up the page for long; while the register of a new model state is being measured (after an edit), the previous one stays on screen with *Updating the register…*.

**Sheets.** `drawSheet(p, dm, id)` makes one drawing (its first sheet and any continuation sheets) and keeps it in a cache of about 200 MB, least recently used out. A drawing is keyed by its id and what it shows:

| Sheet | Made again when … changes |
|---|---|
| Part drawing | the part (geometry, holes, profile, material, finish), its quantity, the assemblies it is used in |
| Assembly drawing | the assembly, its parts, its quantity, the shop bolts of its joints |
| Bracket setting-out plan | its brackets (with their plates, anchors and mullions), its place along the slab edge, the grids, the survey, the tolerances |
| Anchor schedule | its rows (and on sheet 1 the totals) |
| GA, zone, erection sequence, section / detail sheets | anything in the model (they show all of it) |
| Unfolded elevation sheet / zone sheet | the development (facade planes, folds, grids, levels), the zones, and the geometry and marks of the parts it draws (the overall sheet: all of them; a zone sheet: those in the zone and its overlap) |
| Register | the number, title, scale or status of any sheet |
| Every sheet | the drawing settings, the title block fields, the sheet template, its own edits and revisions |

So after an edit only the drawings whose inputs changed are made again, and only when they are viewed or exported; undo and redo find the sheets of the earlier state in the cache. The eager `allDrawings(p, dm)` still draws the whole set (same sheets, same fingerprints).

**Changed since issue.** A sheet that has never been issued is always *changed*. For an issued sheet the flag needs its fingerprint, which is known once the sheet has been made; fingerprints, scales and layout results are kept for many more sheets than the cache holds, by the same key without the revisions — so issuing does not lose them, and sheets an edit did not touch keep their flag. In the Drawings tab a background check makes the sheets one at a time in idle time (issued sheets first) until every flag and layout badge is known; a rev shown with `?` has not been checked since the last edit. On models with more than 15,000 parts the GA, zone and sequence sheets (the slowest, made again after every edit) and the unfolded elevation are left to *Check all*.

**The register sheet** lists the scale and status of every sheet, so viewing or exporting it first makes the sheets whose facts are not known yet (the background check, with progress).

**In the Drawings tab** the list shows only the rows in view; search (number, title or mark) and the filters work on the register. Selecting a sheet makes it (a spinner shows while it is made); its neighbours in the list are made in idle time. PDF and DXF exports make the sheets one by one with progress and Cancel; each sheet is painted into PDF once (see [EXPORT_PACKAGE.md](EXPORT_PACKAGE.md)). The issue dialog makes the sheets it needs fingerprints of, with progress. 3D → drawing navigation makes only the view sheets that can show the part's assembly (see [ASSEMBLIES.md](ASSEMBLIES.md)).

Code: `src/core/drawings/onDemand.ts` (index, cache, facts), `families.ts` (plan items per family), `src/ui/drawingJobs.ts` (sliced index, background check, streamed exports). Tests: `tests/drawingsOnDemand.test.ts`.

**Limits.** A single sheet is made in one piece: on a 24,000-member facade a GA or zone sheet takes about a second, during which the page does not respond. Building the register of such a model takes several seconds of work after each model edit (spread over slices); the derived model itself is still computed in one piece. Fingerprints and the cache live for the session; after reloading a project, issued sheets are checked again.

## Editing drawings

Generated items carry stable ids — views (`view:elevation`, `view:front` …), tables and notes blocks (`table:parts-list`), dimensions (`dim:elevation:3`), balloons, weld symbols, cutting planes — so manual edits survive regeneration of the sheet. Edits are stored per drawing in the project and are undoable.

In the Drawings tab (select a sheet, then work on the preview):
- **Select and drag** a view or table to move it as a whole — its dimensions, balloons and symbols move with it. Drag a dimension to offset its dimension line perpendicular to itself; extension lines follow (ISO 129-1). Moves snap to 1 mm; Esc cancels.
- **Delete** hides the selected item (a dimension, balloon, symbol, or a whole view). *Show hidden* brings them back; *Reset edits* removes every edit of the sheet.
- **Note**: free text in ISO 3098 lettering (2.5 mm by default). **Leader note**: click the feature, then where the note goes; the leader line (ISO 128-22) has a short reference line at the note and ends in a closed filled arrowhead on the feature.
- **Revision cloud**: drag a rectangle around the change; the scalloped cloud carries a revision triangle with the revision index (default: the next one), matching the revision table (ISO 7200).

Edits count as content: an edited sheet gets a new fingerprint and is flagged as changed until it is issued again. Sheets without edits keep exactly their generated content.

Marks, balloons, list rows and part outlines also carry navigation data (the assembly or part they name). In the Drawings tab a click on them selects the part or assembly in the 3D view, a double-click on a mark opens its assembly drawing, and *Show in 3D* selects what the sheet shows. This data is not drawn and does not change the fingerprint; see [ASSEMBLIES.md](ASSEMBLIES.md).

## Sheet templates

The title block can follow a company template (*Drawing settings → Sheet template → Design…*): the client's own title block imported from DXF, a block drawn in the template designer, or a grid of fields. The built-in default is the ISO 7200 title block described above and reproduces it exactly. The active template is used for every sheet of the set (A0–A4, ISO and ASME profiles) in the preview, PDF, DXF and SVG.

### What a template holds

- **Field cells** (the grid template): a grid of cells (grid cell size in mm; column 0 at the left, row 0 at the bottom edge), each with a label (1.8 mm lettering, top left of the cell) and a value. Cell divisions are drawn 0.35 mm.
- **Linework**: lines, rectangles, polylines and circles, with an ISO 128-2 line weight (0.25, 0.35, 0.5 or 0.7 mm) and optionally filled.
- **Texts** placed anywhere (baseline point, ISO 3098 height 1.8 – 10 mm, left / centre / right, bold, rotation). A text shows fixed text, a field, or text with **placeholders** filled per sheet, e.g. `Sheet {SHEET_N} of {SHEETS}`. A field value longer than its room (up to the next cell line or text) is shortened with "…".
- **Values**: a project field (name, number, client, designer, legal owner), a drawing field (title, supplementary title, identification number, revision index, date of issue, scale, sheet n/N, sheet number n, number of sheets N, document type, document status, created / checked / approved by, drawing standard), the ISO 5456-2 projection symbol (with the scale in a field cell), the logo, or fixed text.
- **Logo**: a PNG, JPEG or SVG image (up to 400 KB) embedded in the sheet (SVG and PDF), fitted into a logo cell or a logo rectangle. DXF has no embedded images, so a frame marks where the logo sits.
- **Outer border** 0.7 mm (as the ISO 7200 block; can be switched off), **fixed notes** printed after the general notes on every sheet.

The block sits at the bottom right of the ISO 5457 frame, at its actual size; a block wider than the frame of a sheet (or too tall for the revision table above it) is scaled down to fit that sheet. The revision table sits directly above it and takes its width (rev, description and date only on blocks narrower than 126 mm). The sheet layout keeps views, tables and notes clear of both (*Sheet layout*). The title block is not part of a sheet's fingerprint, so changing the template does not mark sheets as changed. Continuation sheets show the drawing's identification number, *sheet n/N*, scale, their own revision and status.

### Your own title block from DXF

*Sheet templates → Import title block (DXF)* reads an ASCII DXF of the title block alone (no sheet frame). The extents of the drawing become the block size.

| DXF content | Imported as |
|---|---|
| LINE, LWPOLYLINE, 2D POLYLINE (with arcs), ARC, CIRCLE, ELLIPSE, SPLINE | Linework; curves as chords within 0.02 mm. Line weights from the entity (0.25 / 0.35 / 0.5 / 0.7 mm), else 0.35 mm |
| SOLID, TRACE, solid-fill HATCH | Filled areas (hatches with islands are drawn as outlines) |
| TEXT, MTEXT | Texts at their alignment point, height and rotation; MTEXT formatting codes are stripped and each paragraph becomes a line; `\f…\|b1` gives bold |
| INSERT | Blocks exploded with insertion point, scale, rotation, mirror (texts stay readable), arrays and nesting |
| ATTDEF, ATTRIB | Texts with their tag; the attribute values of an insert replace its definitions (constant attributes stay); invisible attributes are left out |
| IMAGE | Not imported (DXF images are external files): its frame is offered as the logo rectangle |
| Pattern hatches, dimensions, leaders, points, 3D entities, external references | Left out and listed in the review |

- **Units**: $INSUNITS, else $MEASUREMENT; a file without units is guessed from its size (mm, inches or metres) and the review offers the choice. Everything is converted to mm.
- **Fields**: a text that is a placeholder — `{PROJECT}`, `{DRAWING_NO}`, `{TITLE}`, `{SCALE}`, `{DATE}`, `{REV}`, `{SHEET}`, `{DRAWN}`, `{CHECKED}`, `{CLIENT}` …, also written `<…>` or `[…]` — becomes that field, filled per sheet; a text containing placeholders keeps its other words (`Scale {SCALE}`); an attribute whose tag names a field (`DWG_NO`, `DRAWN_BY`, `REV` …) becomes that field. Names are matched without regard to case, spaces, dots, dashes and underscores, and also as the field names of the template (`drawing.number`, *Drawing title*). Every other text and all linework stay fixed.
- **Review**: a preview with sample data, every text with what it shows on the sheets (a field, fixed text, its placeholders filled, or left out), the units, the size (scale it by its width), the outer border, and the logo (upload a PNG / SVG and drag its rectangle on the preview). *Save template* adds it to the project; *Use for all sheets* makes it active.
- **Not carried over**: CAD fonts (texts are drawn in ISO 3098 type B lettering, Arial in SVG / PDF, the standard DXF font), text width factors and oblique angles, colours and line types (all lines continuous), pattern hatches, images (upload the logo), fields (AutoCAD FIELD codes show their last value as fixed text).
- The assistant can import a title block from DXF text and change what each text shows (*sheet_templates*: `import_dxf`, `map_texts`).

### Template designer

The designer shows the block at full size with sample data. Tools: *Select* (drag to move, corner handles resize, arrow keys nudge 1 mm, Shift 5 mm, Delete removes), *Line*, *Rectangle*, *Text* (click to place), *Field cell* and *Logo area* (drag). Positions snap to 1 mm (field cells to the template grid). The properties of the selection set the text value, height, alignment, bold, rotation and position, line weight and fill, cell label and value, logo rectangle. Every change is one undo step (Ctrl+Z). Templates can be duplicated, deleted, set active for all sheets, and imported and exported as JSON (older template files load unchanged; free content is kept). Keep the ISO 7200 identification fields (identification number, revision index, date of issue, title, document status, legal owner) in a company template if the drawings must conform to ISO 7200.

## Drawing numbers

`<prefix>-DR-01` register, `<prefix>-GA-01/02` GA, `<prefix>-GA-04` unfolded elevation (zones `<prefix>-GA-04-Z<n>`), `<prefix>-SD-NN` section / detail sheets (in the order of the GA cuts), `<prefix>-E-NN` bracket setting-out plans, `<prefix>-AS-NN` anchor schedules, `<prefix>-ES-NN` erection sequences, `<prefix>-A-<assembly mark>` assembly, `<prefix>-P-<part mark>` part. Zone sheets of a divided view add `-Z<n>` (`<prefix>-GA-01-Z2`, `<prefix>-ES-01-Z3`).

The sheets of a multi-sheet drawing share its number (ISO 7200) and carry *Sheet n/N*; the register lists them as `<number> (n/N)`.

The prefix defaults to the project number. Exported files are named `<drawing number>_rev<revision>`, sheets of multi-sheet drawings `<drawing number>_sh<n>_rev<revision>`.
