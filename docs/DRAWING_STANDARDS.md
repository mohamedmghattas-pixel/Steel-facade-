# Drawing standards

FacadeSteel produces a numbered drawing set:
- a drawing register
- general arrangement (GA) drawings
- section and detail sheets cut on the GA
- erection drawings: bracket setting-out plans, anchor schedules and erection sequences
- assembly drawings
- part (fabrication) drawings

Every sheet can be edited by hand on top of what is generated (see *Editing drawings*), and the title block can follow a company template (see *Sheet templates*).

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
| Lettering | ISO 3098 | Lettering is a type-B style at heights of 1.8, 2.5, 3.5, 5 and 7 mm. The drawing number uses 5 mm bold. |
| Dimensioning | ISO 129-1 | Dimension lines end in closed filled arrowheads, with the value above the line, readable from the bottom or the right. Hole positions use chain dimensions. Coordinate positions use running dimensions, with the origin marked by a small circle. |
| Scales | ISO 5455 | Only 1:1, 1:2, 1:5, 1:10, 1:20, 1:50, 1:100, 1:200, 1:500 … are used. The main scale appears in the title block. |
| Item references | ISO 6433 | Each part mark sits in a balloon, with a leader ending in a dot on the part. Identical parts share one reference. |
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
- One plan per level (the project levels, or the slab-bracket elevations when there are none) and slab edge direction. Long edges are split over several sheets so that the plan stays at 1:20 where possible.
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
- A sequence legend (all phases with assembly count, mass and status), a line key and the list of assemblies in the phase with their drawing numbers.
- Assemblies take the phase of their main member; brackets that of the mullion they support. Assemblies in no phase go on a final sheet *Not assigned to a phase*.
- Without phases, a **default sequence by floor, bottom-up** is used (each assembly goes to the floor its lowest point lies on), and the sheets say so.

## Editing drawings

Generated items carry stable ids — views (`view:elevation`, `view:front` …), tables and notes blocks (`table:parts-list`), dimensions (`dim:elevation:3`), balloons, weld symbols, cutting planes — so manual edits survive regeneration of the sheet. Edits are stored per drawing in the project and are undoable.

In the Drawings tab (select a sheet, then work on the preview):
- **Select and drag** a view or table to move it as a whole — its dimensions, balloons and symbols move with it. Drag a dimension to offset its dimension line perpendicular to itself; extension lines follow (ISO 129-1). Moves snap to 1 mm; Esc cancels.
- **Delete** hides the selected item (a dimension, balloon, symbol, or a whole view). *Show hidden* brings them back; *Reset edits* removes every edit of the sheet.
- **Note**: free text in ISO 3098 lettering (2.5 mm by default). **Leader note**: click the feature, then where the note goes; the leader line (ISO 128-22) has a short reference line at the note and ends in a closed filled arrowhead on the feature.
- **Revision cloud**: drag a rectangle around the change; the scalloped cloud carries a revision triangle with the revision index (default: the next one), matching the revision table (ISO 7200).

Edits count as content: an edited sheet gets a new fingerprint and is flagged as changed until it is issued again. Sheets without edits keep exactly their generated content.

## Sheet templates

The title block can follow a company template (*Drawing settings → Sheet template → Design…*). The built-in default is the ISO 7200 title block described above and reproduces it exactly.

- A template is a grid of fields (grid cell size in mm; column 0 at the left, row 0 at the bottom edge). Each field has a label (1.8 mm lettering, top left of the cell) and a value: a project field (name, number, client, designer, legal owner), a drawing field (title, supplementary title, identification number, revision index, date of issue, scale, sheet n/N, document type, document status, created / checked / approved by, drawing standard), the projection symbol with the scale, the logo, or fixed text. Values can use the ISO 3098 heights 1.8 – 7 mm and bold.
- Cell divisions are drawn 0.35 mm, the outer border 0.7 mm (as the ISO 7200 block). The block sits at the bottom right of the ISO 5457 frame; the revision table above it takes its width, and the sheet layout keeps clear of both.
- **Logo**: a PNG, JPEG or SVG image embedded in the sheet (SVG and PDF). DXF has no embedded images, so a frame marks where the logo sits.
- **Fixed notes** are printed after the general notes on every sheet.
- Templates import and export as JSON. Keep the ISO 7200 identification fields (identification number, revision index, date of issue, title, document status, legal owner) in a company template if the drawings must conform to ISO 7200.

## Drawing numbers

`<prefix>-DR-01` register, `<prefix>-GA-01/02` GA, `<prefix>-SD-NN` section / detail sheets (in the order of the GA cuts), `<prefix>-E-NN` bracket setting-out plans, `<prefix>-AS-NN` anchor schedules, `<prefix>-ES-NN` erection sequences, `<prefix>-A-<assembly mark>` assembly, `<prefix>-P-<part mark>` part.

The prefix defaults to the project number. Exported files are named `<drawing number>_rev<revision>`.
