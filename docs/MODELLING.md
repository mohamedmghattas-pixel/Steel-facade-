# Geometry modelling

End preparations (cuts, mitres, copes, fitting), free / bent plates and
stiffeners, and non-orthogonal and curved facades. All geometry is derived in
`src/core` and flows through the `DerivedModel`, so the 3D view, IFC, DSTV NC,
drawings, material lists and nesting always agree.

| Area | Code |
| --- | --- |
| End cuts, mitre / fit planes, copes, mass | `src/core/geometry/endPrep.ts`, `src/core/derive/memberGeom.ts` |
| Bend allowance, flat pattern, folding | `src/core/geometry/bentPlate.ts` |
| Stiffener outlines | `src/core/geometry/stiffener.ts` |
| Arcs and chord segmentation | `src/core/geometry/arc.ts` |
| Operations (undoable through `apply`) | `src/core/model/ops.ts` |
| Parts (members with `ends`, free plates) | `src/core/derive/model.ts` |
| 3D meshes | `src/viewer/meshes.ts` |
| UI | `src/ui/dialogs/ModellingDialogs.tsx`, `src/ui/dialogs/modellingActions.ts` |
| Assistant tools | `src/assistant/modules/modelling.ts` |

## 1. End preparations

`Member.startPrep` / `Member.endPrep` (absent = square). Every end resolves to a
planar cut in the member frame (x along the member, y / z across the section,
origin on the section centre line) plus optional copes.

| Kind | Cut plane |
| --- | --- |
| `square` | Perpendicular to the axis at the end (after extensions and connection trims). |
| `bevel` | Through the axis end point, at the given saw angles. |
| `mitre` | Bisects the two member axes at their shared end node, through the intersection of the section centre lines. Saw angle = 90° − θ/2 for an included angle θ (90° → 45°, 120° → 30°). A gap g leaves g/2 on each member. |
| `fit` | The face of the other member's section that faces this end, offset by the gap: the web face of I / U sections (members framing in from the web side), otherwise the section envelope (bounding box; tangent plane for CHS / round bar). |
| `cope` | Square end plus a notch through one or both flanges. |

Mitre and fit planes replace the nominal end position (they override
extensions and connection trims at that end) and follow the members when they
move. Copes are applied for `cope` and `fit` ends.

**Saw angles (DSTV convention).** Measured from the square cut, |angle| < 85°
(DSTV allows ±89.9°; cuts steeper than 60° get a warning — typical band-saw
limit). `angleWeb` is the cut seen in the web / side view (local x–z): positive
makes the top (+z, face *o*) edge shorter at that end. `angleFlange` is the cut
seen from above (local x–y): positive makes the +y (face *h*) edge shorter. With
both angles the start plane is x = x₀ + y·tan(aF) + z·tan(aW) (mirrored at the
end) — a compound cut. Verify the sign convention against the saw's
post-processor before the first production run.

**Cut length convention.** `Part.length` of a prepared member is the *overall*
length: between the extreme points of the two cuts over the section outline —
the length of stock to saw. The part frame starts at the extreme start point,
so DSTV coordinates, hole tables and drawing dimensions all measure from there.
Bar nesting uses this length.

**Mass.** The volume of a prism between two planes equals the section area
times the axis distance between the planes at the section centroid (exact for
planar cuts), so mass = kg/m × centroid length. Copes subtract their notch
volume (section area inside the cope band × cope length, by polygon clipping);
the material left in the cope's corner radius is ignored (< 0.1 % of the notch).
Surface uses the same length.

**Copes.** Rectangular notch with a re-entrant corner radius (default 15 mm,
≥ 13 mm per AISC 360 J1.6; EN 1090-2 rounds re-entrant corners). Depth is
measured from the outer flange face, length from the end at the axis. Limited to
45 % of the section depth and to open sections (I, U, C, Z, T, L). `fitEnd(…,
cope)` sizes copes automatically for an open section fitted to the web of an I /
U member with parallel section axes: depth clears the other member's flange and
root radius + 5 mm, length its flange outstand − gap + 10 mm, both rounded up to
5 mm.

**Operations.** `setEndPrep`, `setBevel`, `setCope`, `mitreMembers(p, a, b, gap)`,
`fitEnd(p, member, end | 'auto', toMember, gap, cope)`, `sharedNode`. Splitting a
member keeps each preparation with its end (and re-targets mitres against the
split member); deleting a member reverts mitres / fits against it to square;
copying a mitred pair mitres the copies with each other.

**Outputs.**
- *3D*: angled cuts are exact (end-cap vertices moved onto the cut planes);
  copes are notched slabs with the corner radius stepped in four slices.
- *DSTV NC1*: ST header web start / end and flange start / end saw angles;
  length and saw length = overall length. Coped parts also get AK outer
  contours of the web (face v) and of each coped flange (o / u), radii as
  polylines.
- *IFC4*: the member body is the full-length `IfcExtrudedAreaSolid` clipped by
  one `IfcBooleanClippingResult(.DIFFERENCE.)` per angled end with an
  `IfcHalfSpaceSolid` on the cut plane (normal into the waste, AgreementFlag
  `.F.`), and one per cope with an `IfcPolygonalBoundedHalfSpace` (notch outline
  incl. radius as the boundary, bounded across the section width).
  Representation type `Clipping`. Checked with web-ifc in `tests/modelling.test.ts`.
- *Drawings*: part elevation and plan show the angled end lines (the extreme
  silhouette, plus the cut edge on the other face of compound cuts: visible on
  the near side, hidden on the far side), cope notches with radii, the step
  where a coped flange ends, and an ISO 129-1 angular dimension of each saw
  angle (web angle in the elevation, flange angle in the plan). Interrupted
  views keep the end features. The machining list gives the saw cut ("L = 2077,
  start 30.0° web mitre, end 45.0° web mitre") and one *Cope* line per cope.
  Assembly drawings show the main member's prepared ends (no angle dimensions).
- *Numbering*: end cuts and copes are part of the part signature, so mirrored or
  differently cut members get their own marks.

**UI.** Properties → *End preparation* for the selected member(s): start / end
kind (square, saw angle, cope; mitre / fit when set), angles, cope size / side /
radius, gaps; buttons *Mitre* (two selected members), *Fit to 2nd* (select the
member to cut, Shift+click the one to fit to), *Square ends*, *Add stiffeners…*.
The tool rail has *Mitre* and *Fit to* under Members.

## 2. Free plates, bent plates and stiffeners

`Project.plates: Record<Id, FreePlate>` become parts `p:<id>` of kind `plate`:
outline = flat (unfolded) outline, holes / slots, thickness, material, finish,
mass = flat area × t × density (holes deducted; for bent plates the flat
pattern conserves the neutral-fibre area, so this is exact), surface = 2 × area.
`weldedTo` a member joins that member's assembly; loose plates form their own
assembly (prefix = bracket prefix). Plate frame: `origin`, `xAxis`, `yAxis`,
normal = x × y, the plate occupies 0 ≤ z ≤ t.

**Bent plates.** Bend lines (`PlateBend.a → b`, outline coordinates) are the
centre lines of the bend zones in the flat pattern. Flat pattern by bend
allowance with a neutral-axis K-factor (DIN 6935 / sheet-metal practice):

```
BA   = θ · (r + K·t)          θ in radians, r = inner radius
OSSB = tan(θ/2) · (r + t)     outside set-back
BD   = 2·OSSB − BA            bend deduction
L    = Σ outside legs − Σ BD  flat length
```

K = 0.33 by default (`FreePlate.kFactor`), typical for structural plate on a
press brake with r ≈ t…2t; use 0.40–0.45 for r ≥ 3t. Example: legs 100 + 100,
90°, t = r = 10 → BA = 20.89, BD = 19.11, L = 180.89 mm.

Folding: the piece containing the plate origin stays put; a positive angle
folds the far side towards +z (inner radius on the +z face). Each bend zone
(width BA) is wrapped on a cylinder about an axis at the inner radius, the far
side is translated back by BA and rotated rigidly — so the neutral fibre keeps
its flat length. Bend lines act as straight lines across the plate: bends may
follow each other (angle, channel, Z, hat) or fold separate flanges (trays —
with corner reliefs), but must not cross inside the plate; holes must lie in
flat pieces.

- *3D*: top / bottom faces of every flat piece and bend strip (8 per bend),
  walls only on real edges and holes — smooth, seamless bends.
- *IFC*: `IfcPlate` with extruded segments: each flat piece an
  `IfcExtrudedAreaSolid` with its holes as voids (exact), each bend strip a
  tangent-plane segment at its mid angle.
- *DSTV / nesting*: the flat pattern (AK contour, plate nesting).
- *Drawings*: flat pattern with bend lines (chain line), bend-zone edges (thin)
  and "UP 90° Ri 12" notes; machining list gets a *Bend* line per bend type.
- Mark signature includes the bends and K-factor.

**Stiffeners** (`addStiffeners(p, member, distances, { t, sides, snip, inset })`):
full-depth web stiffeners for parallel-flange I / H sections (both sides) and
channels (open side). Outline: clear depth h − 2·tf × outstand to the flange tip
less `inset`, 45° corner snips at the web–flange junctions with leg ≥ root
radius (rounded up to 5 mm, min 10 mm). Both sides share one outline (mirrored
frame), so all stiffeners of a size get one mark. Distances run from the
member's start node; plates are welded to the member.

**Polygon plates** (`addPolygonPlate`): from ≥ 3 coplanar world points (Newell
normal, oriented towards the work-plane normal; x axis along the first edge).

**UI.** Members → *Plate* tool: click corners on the work plane; double-click,
click the first corner or type `c` to close. *Bent plate…* dialog: legs, angles,
radius, thickness, width, K, on the work plane (first leg along u, width along
v). *Stiffener* dialog: equal spaces or distances, thickness, sides, inset,
snip. Properties for selected plates: name, thickness, material, finish,
shop-weld to one of the nearest members, bends (angle, radius, position,
K-factor), holes, delete. Plates are picked and box-selected in 3D.

## 3. Non-orthogonal and curved facades

**Named work planes** (`Project.workPlanes`, `addWorkPlane(p, name, origin,
xPoint, inPlane)`): x = unit(xPoint − origin), normal = unit(x × (inPlane −
origin)), y = normal × x — orthonormal, right-handed. `WorkPlane` gained
`kind: 'custom'` with `planeId` and a copy of the axes (so `planeAxes`,
`planeToWorld`, `worldToPlane` need no lookup); `offset` shifts along the
normal. The *Plane* tool picks the three points; the work-plane control lists
named planes (select, *+ From 3 points*, rename ✎, delete ×) and keeps the active
plane in step with edits and undo. The facade grid dialog offers the active
custom plane: mullions get their depth along the plane normal
(`rotationForDepth`).

**Arc members** (`arcFrom3Points`, `planeArc`, `arcPoints`, `addArcMembers`):
circle through start, end and a point on the arc (any 3D plane), or centre /
radius / start and end angles on a work plane. Straight segments: a count, or
the fewest chords whose sagitta R·(1 − cos(φ/2)) stays within a maximum
deviation (default 5 mm): n = ⌈|sweep| / (2·acos(1 − δ/R))⌉. *Arc* tool (3
points) and *Curved → Arc members…* dialog.

**Curved facade grid** (`curvedFacadeGrid`): bays laid along a plan arc
(centre, radius, start → end angle counter-clockwise from +X); bay widths are
arc lengths (or N equal bays). Vertical mullions at the bay points, split at
floor lines, rotated so their depth (local z) points at the centre — the local
facade normal, same convention as XZ facades; transoms are straight chords
between mullions, subdivided to keep the chord deviation within the limit,
depth along the outward normal when "depth normal" is on. *Curved → Curved
facade grid…* dialog.

## 4. Assistant tools

`set_end_prep`, `mitre_members`, `fit_member_end`, `add_stiffeners`, `add_plate`,
`add_bent_plate`, `define_work_plane`, `create_arc_members`,
`create_curved_facade_grid`, `get_modelling_info`. Every edit goes through
`apply` (undoable); replies carry cut lengths, saw angles and warnings.

## Limits

- Cuts are planar. Fitting to a round section uses its tangent plane (no
  saddle / fish-mouth cut); fitting is to the section envelope, not to fillets.
- Copes: open sections only, rectangular notch with one corner radius, one
  depth / length per end (both flanges equal); the radius is stepped in 3D.
- Free plates and stiffeners are placed in world coordinates: they move and
  copy with the member they are welded to, but do not follow node edits of that
  member.
- Bent plates: straight bends that do not cross inside the plate; no bend
  relief or K-factor tables per material; holes in bend zones are not shown in
  3D; drawings show the flat pattern (assembly / GA views draw the plate flat).
- DSTV: no KO marking of bend lines; copes as AK contours (polylines).
- Stiffeners assume parallel flanges (IPN / UPN use the nominal tf).
- Curved facades are polygonal (straight chords); no rolled members.
