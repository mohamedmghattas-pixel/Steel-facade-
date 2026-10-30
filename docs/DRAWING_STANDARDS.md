# Drawing standards

FacadeSteel produces a numbered drawing set:
- a drawing register
- general arrangement (GA) drawings
- assembly drawings
- part (fabrication) drawings

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

## Drawing numbers

`<prefix>-DR-01` register, `<prefix>-GA-01/02` GA, `<prefix>-A-<assembly mark>` assembly, `<prefix>-P-<part mark>` part.

The prefix defaults to the project number. Exported files are named `<drawing number>_rev<revision>`.
