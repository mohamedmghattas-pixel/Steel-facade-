# Custom profiles, insertion points and profiles by role

This document covers:
- custom cross-sections: parametric ones and arbitrary outlines with holes and arcs
- the **insertion point**, the point of the section the wire line runs through
- uploading profiles (DXF, JSON, CSV) and the review step
- the **profile sketcher**, for drawing a section on the page
- **profiles by role**: mullions one profile, transoms another
- how every output (3D, IFC, DSTV, drawings, clash, lists) handles outline profiles, and the limits.

Code: `src/core/library/polyShape.ts` (loops and arcs), `shapes.ts` (the `POLY` shape),
`profiles.ts` (definitions, JSON / CSV), `profileDxf.ts` (DXF upload and export),
`sketch.ts` (sketcher geometry), `src/core/model/roleProfiles.ts` (profiles by role),
`src/core/model/geometry.ts` (`sectionShift`). UI: `src/ui/ProfileSketcher.tsx`,
`ProfileImportDialog.tsx`, `RoleProfilesPanel.tsx`, `SectionPreview.tsx`, `profileActions.ts`.
Tests: `tests/profilesCustom.test.ts`, `tests/profileSketch.test.ts`.

## 1. Where custom profiles live

- A custom profile is a `ProfileDef` stored in the project (`project.library.profiles`).
  It travels with the project file, and every change is one undo step.
- The store registers the definitions in the global catalogue (`syncCustomProfiles`), so pickers,
  `getProfile` and every output see them. Only added, changed and removed definitions are
  rebuilt on each edit.
- A custom profile can replace another custom profile of the same name. It cannot take the
  name of a catalogue profile (EN / BS / AISC).

```ts
interface ProfileDef {
  name: string;
  family?: string;        // default "Custom outline" (POLY) or "Custom <type>"
  standard?: 'EN' | 'BS' | 'AISC' | 'Custom';
  shape: Shape;           // parametric (I, U, L, T, RHS, CHS, RD, FL, C, Z) or POLY
  mass?: number;          // kg/m in `material` (computed from the area when absent)
  material?: string;      // e.g. "6063 T6": density for the mass; new members get it
  insertion?: { x: number; y: number };  // drawing coordinates (§2)
  spec?: string;
  sketch?: unknown;       // the editable sketch the outline was drawn from
}
```

**Mass and material.** `Profile.mass` stays on the steel basis (7850 kg/m³), because member
masses multiply it by the density ratio of the *member's* material (`densityFactor`).
- A profile with `material` shows and exports its mass in that material (`profileMassIn`).
- A given `mass` is read as kg/m in that material.
- Members that get the profile from a role, or from the properties panel, also get its material.

## 2. Coordinates and the insertion point

### 2.1 Profile drawing coordinates

A section is drawn looking at the member end, with the member axis x̂ toward the viewer:
- drawing `x` runs along member local **y** (the width `b`)
- drawing `y` runs along member local **z** (the height `h`, "up" for horizontal members).

For which way local y and z point on a member, see
[CONNECTION_GEOMETRY.md §3.1](CONNECTION_GEOMETRY.md):
- **Vertical mullions** (drawn upwards): local y = +X, local z = +Y.
- **Horizontal members:** local z = up (+Z), local y = left of the direction the line was drawn.
- **Facade grid transoms** with "depth normal to the facade": rotation 90°, so local z = −Y.

On an XZ facade whose slab lies at +Y, the top of a mullion sketch therefore faces the
building and the bottom faces the outside. Rotate a member 180° to flip its section, or mirror it (*Mirrored section*, `Member.mirrorSection`) to open an asymmetric outline the other way; see [MODIFY.md §8](MODIFY.md).

| Shape | Drawing coordinates |
| --- | --- |
| Parametric (I, U, …) | The outline coordinates: origin at the centre of the bounding box |
| `POLY` | Whatever the vertices use (a DXF's own coordinates, the sketcher's grid) |

Every outline the app works with (`shapeOutline`) is centred on its bounding box. For a POLY,
`shapeDrawCentre(shape)` is the offset between the two:

```
outline point = drawing point − shapeDrawCentre(shape)
Profile.insertion = ProfileDef.insertion − shapeDrawCentre(shape)     (relative to the box centre)
```

### 2.2 How a member sits on its wire line

`Member.alignMode` chooses between the 3×3 grid and the profile's insertion point:

| alignMode | Section centre (box centre) relative to the wire line, in local (y, z) |
| --- | --- |
| `'grid'` | `(−alignY·w/2 + offsetY, −alignZ·h/2 + offsetZ)` (unchanged) |
| `'insertion'` | `(−insertion.x + offsetY, −insertion.y + offsetZ)` |
| absent | `'insertion'` when the profile has an insertion point, else `'grid'` |

- `'insertion'` on a profile without an insertion point behaves like `'grid'`.
- Models made before insertion points existed load and derive unchanged: no member had an
  `alignMode`, and no profile had an insertion point.
- The offsets add on top in both modes.
- Rotation turns the section about the wire line, so in `'insertion'` mode the section turns
  about the insertion point.

```
 Section looking at the member end (x̂ toward the viewer): drawing x → local y, drawing y ↑ local z.

        ┌──────────────────────┐ ← box (w × h)                    •  = wire line
        │   ┌──────────────┐   │                                  c  = box centre (frame origin)
        │   │              │   │                                  ⊕  = insertion point
        │   │      c       │   │      alignMode 'insertion':  • = ⊕
        │   │              │   │                              c = • − (⊕ − c)
        │   └──┐        ┌──┘   │      alignMode 'grid':       • on one of the 9 grid points
        └──────┤   ⊕    ├──────┘                              (corners, edge middles, centre)
               └────────┘
           front nose, insertion point on the outer face
```

`sectionShift(m, w, h, profile)` in `src/core/model/geometry.ts` computes the shift.
`memberGeom` (derived model) and `centreLine` (end preparations) both pass the profile, and
`MemberGeom.shift` carries the result.

What uses it:
- **Connections** place their parts from the section centre line (`centreAt`) and the
  bounding-box faces (`w/2`, `h/2`, `faceDistance`). They therefore follow the section,
  wherever the insertion point puts it.
  - Test: a transom with its insertion point at the bottom-left corner of a 40 × 80 box. Its fin
    plate lies on the transom's +y face (Y 40–50), starts on the mullion face X = 50, and spans
    the section depth Z 1500–1580.
- **Slab brackets** measure their standoff from the wire line (`vWire = −shift.y`), so the
  standoff runs from the insertion point.
- **Base plates** centre on the section.

### 2.3 In the app

Properties → *Position on the wire line* shows the section with its 3×3 grid and the
insertion point (the red cross):
- Click a grid point to use the grid at that point.
- Click the cross to use the insertion point.
- Or use the *Insertion point / 3×3 grid* switch.

The *Across* and *Depth* buttons also switch the member to the grid.

## 3. Outline profiles (`POLY`)

```ts
{ type: 'POLY', outer: PolyVertex[], holes?: PolyVertex[][], t?: number }
interface PolyVertex { x: number; y: number; b?: number }   // b = bulge of the segment to the next vertex
```

- **Bulge** (DXF convention): `b = tan(θ/4)`, where θ is the included angle of the arc from this
  vertex to the next. `b > 0` turns counter-clockwise, `b < 0` clockwise, `|b| = 1` is a half
  circle. A circle is two vertices with `b = 1`.
- Arcs stay exact in IFC and DXF. Everything else flattens them (`flattenLoop`): at most 6° per
  chord for outlines and meshes, 1° for section properties. Every arc is split at 0°, 90°,
  180° and 270°, so the flattened polygon has the exact bounding box.
- `t` is an optional nominal wall thickness: thin-wall sketches with one thickness set it. DSTV
  writes it in the header.
- **Validation** (`validateLoops`) requires:
  - at least 3 distinct points (or 2 with an arc) and an area
  - no loop crossing itself
  - every hole inside the outline without touching it
  - holes that do not overlap.

### 3.1 Section properties

They come from the same polygon formulas as every other section (`sectionProps`), on the
signed area of the outline and its holes:

| Property | Method |
| --- | --- |
| A | Sum of the signed polygon areas (outer counter-clockwise, holes clockwise) |
| Centroid | First moments / A (`Profile.cy`, `cz` from the box centre) |
| Iy, Iz | Second moments about the centroid. Iy is about the horizontal axis (local y), Iz about the vertical one |
| Wy, Wz | I divided by the distance to the extreme fibre |
| Wpl | Equal-area axis by bisection |
| iy, iz | √(I / A) |
| Iu, Iv, α | Principal values (angles, Z-like shapes) |
| Surface | Outer perimeter / 1000, m²/m (insides of hollow sections are not painted) |
| Mass | A × 7850 / 10⁶ kg/m on the steel basis (§1) |

Accuracy, from the tests:
- rectangle and hollow rectangle: exact
- a full circle drawn with bulges: area within 5·10⁻⁵ (1° chords)
- an IPE 200 drawn as an outline with root-radius fillets: area, Iy, Iz and Wy within 1 % of
  the parametric IPE 200, and within 2 % of the catalogue mass.

## 4. Uploading profiles

Library → **Import profiles (DXF / JSON / CSV)…** opens the file, finds the profiles and shows
the **review step**. For each profile it shows:
- a section preview with the insertion point
- size, area, kg/m, Iy and Iz
- where the name and the insertion point came from
- warnings, or why the profile cannot be added.

In the review step you can rename profiles, untick them, set the family and the material for
all of them, and change the DXF drawing units. *Edit in sketcher…* opens an outline in the
sketcher before it is added.

**One base point per detail.** When the drawing holds assembly details (POINTs or base-point
marker blocks such as `CP`, the same rule as the assembly import, [PROFILE_ASSEMBLIES.md
§2](PROFILE_ASSEMBLIES.md)), every outline of a detail is re-based on that detail's base point:
all of them get it as their insertion point, so they are extruded and cut about one line, as
they sit in the detail (`shareDetailBasePoints` in `core/library/profileAssemblyDxf.ts`). Before,
each outline looked for a marker within a quarter of its own size, so outlines away from the
base point (covers, gaskets, packers) fell back to the DXF origin or their own centre. The
outlines get a group (`ProfileDef.group`, e.g. `profiles · detail 1`), and the review and the
library show each one in its detail: the other outlines dimmed, the base point marked. The
marker itself (a tiny loop on a base point) is listed but not imported. *Insertion point → Each
outline its own* in the review goes back to the per-outline rule. A drawing without base points
is read as before. For details with gaskets in grooves (loops inside other loops), *Import as
profile assembly…* is still the right path: the profile upload reads an inner loop as a hole.

### 4.1 JSON (all shapes)

`profileDefsToJson` / `parseProfileJson`:

```json
{ "format": "facadesteel-profiles", "version": 1, "profiles": [
  { "name": "Alu mullion 50x150", "family": "Aluminium", "material": "6063 T6",
    "shape": { "type": "POLY", "t": 3,
      "outer": [ { "x": -25, "y": 0 }, { "x": 25, "y": 0 }, { "x": 25, "y": 150 }, { "x": -25, "y": 150 } ],
      "holes": [ [ { "x": -22, "y": 3 }, { "x": 22, "y": 3 }, { "x": 22, "y": 147 }, { "x": -22, "y": 147 } ] ] },
    "insertion": { "x": 0, "y": 0 } }
] }
```

- A bare array of definitions, or a single definition, is accepted too.
- Each definition is checked with `profileFromDef`; invalid ones are listed and skipped.
- Library → **Export JSON** writes every custom profile, sketches included.

### 4.2 CSV (parametric types)

The CSV catalogue format is unchanged: `name,family,type,h,b,tw,tf,r,t,d,c,mass`, see the
comment in `profiles.ts`. Optional columns:
- `material`
- `ix`, `iy`: the insertion point, mm from the box centre.

`POLY` rows are rejected with a pointer to JSON. *Export CSV* leaves outline profiles out and
says so.

### 4.3 DXF upload conventions

`parseProfileDxf(text, { fileName, unitScale, family, material })` reads ASCII DXF, model space only.

| Item | Rule |
| --- | --- |
| Outlines | Closed LWPOLYLINE and 2D POLYLINE (bulges kept as arcs), CIRCLE, and chains of LINE / ARC / open polylines whose ends meet within 0.05 mm. Open chains are reported and ignored |
| Blocks | INSERTs are exploded: insertion point, scale (mirrored too), rotation, nested blocks. Layer 0 inside a block takes the INSERT's layer. MINSERT arrays use the first copy |
| OCS | Plain (0, 0, 1) and flipped (0, 0, −1) extrusions. Tilted entities are skipped and reported |
| Profiles | Loops are nested by containment. Each outermost loop is a profile, and the loops directly inside it are its holes. A loop inside a hole starts a new profile. Several profiles per file are fine; they are listed left to right |
| Name | A TEXT or MTEXT inside the outline (the one nearest its centre), else the nearest unused text within 1.5 × the profile size, else `<file name> <n>`. MTEXT formatting codes are stripped |
| Insertion point | A POINT entity, or a marker on a layer whose name starts with **INS** (INSERT, INSERTION …) or is **REF** / **REFERENCE**, within the profile's box grown by 25 %. The marker is a small circle (its centre), two crossing lines (their crossing) or a small closed polyline (its centre). Markers are not part of the outline |
| Fallback | The DXF origin (0, 0), when it lies within the box grown by the profile size. Otherwise no insertion point: members use the 3×3 grid, and the review step says so |
| Placement | Each outline is moved so its insertion point (or, without one, its box centre) is at (0, 0) |
| Units | `$INSUNITS`, else `$MEASUREMENT`, else millimetres. The review step can override them |
| Not read | SPLINE, ELLIPSE, HATCH, 3D polylines and meshes, paper space (counted in the notes) |

Library → **DXF** next to a custom profile, or *Export DXF* in the sketcher, writes
`profileToDxf`:
- the outline and holes as closed polylines with bulges, on layer PROFILE
- the insertion point as a POINT plus a cross and a circle, on layer INSERT
- the name as TEXT below the outline.

The file reads back to the same profile.

## 5. The profile sketcher

Open the sketcher from:
- Library → **New custom profile…**, or **Edit** next to an outline profile
- the import review step (*Edit in sketcher…*)
- inside the sketcher: *Open custom profile…*.

**Drawing area**
- mm grid; the snap step is 0.5–25 mm and the drawn grid adapts to the zoom.
- Wheel zooms about the cursor. Drag the background or use the right or middle button to pan.
  **Fit** (`F`) frames the drawing.
- The x = 0 and y = 0 axes are drawn as dash-dot lines.

**Snaps.** In order: vertices, segment midpoints, circle centres and quadrants, the insertion
point, the origin, then the axes, ortho from the last point (hold Shift to switch it off), then
the grid. Each snap can be switched off.

**Typed coordinates** (box at the bottom left), parsed by `parseCoord`:
- `x,y` absolute; `x y` or `x;y` work too
- `@dx,dy` relative to the last point
- `@L<angle` polar from the last point (degrees counter-clockwise from +x)
- `L<angle` polar from the origin.

With the select tool, a typed point moves the selected vertex. With the insertion tool, it
sets the insertion point.

**Tools**

| Key | Tool | Use |
| --- | --- | --- |
| `S` | Select / move | Drag vertices. Click a line to select its loop. Alt+click a line adds a vertex. `Del` deletes the vertex or loop |
| `W` | Thin wall | Click the centre line. Enter or double-click ends it open; clicking the first point closes it. Thickness and inner bend radius are set in the tool panel |
| `P` | Polyline | Closed outline. The first closed loop is the outline, later ones are holes (switch per loop) |
| `H` | Hole | Polyline that is always a hole |
| `R` | Rectangle | Two corners |
| `C` | Circle | Centre, then a point on the rim. A hole once an outline exists |
| `I` | Insertion point | Click with snaps |

Common keys: `Enter` finishes, `Esc` cancels or deselects, `Backspace` removes the last
point, `Ctrl+Z` / `Ctrl+Y` undo / redo inside the sketcher. While the sketcher is open the
model's shortcuts are off.

**Thin wall** (`thinWallLoops`)
- The centre line is offset by ±t/2 with mitred corners. Open walls get square ends; a closed
  wall gives an outline and a void.
- A vertex radius is the *inner* bend radius r; the outer side of that bend gets r + t.
- The area equals t × the centre-line length, with bends counted as arcs on the centre line
  (tested).
- Ideal for cold-formed and aluminium mullion and transom sections. Example: draw half a
  mullion with its glazing nose from the axis, then **Mirror ⇆**.

**Fillets** (`filletCorners`)
- A vertex radius on a polyline rounds that corner with an exact tangent arc (stored as a bulge).
- A radius too large for the neighbouring edges is reduced so the tangent points stay on the edges.
- *All corners* sets one radius on every vertex of a loop.

**Mirror ⇆ / ⇅** mirrors about x = 0 or y = 0:
- An open wall with an end on the axis is continued by its mirror image (closed when both ends
  are on the axis).
- A polygon with an edge on the axis is opened there and completed by its mirror image.
- Any other loop gets a mirrored copy, unless it is already symmetric about the axis.

**Insertion point**
- Presets: the 9 bounding-box points and the centroid.
- *Pick on drawing* snaps to any vertex, midpoint or the grid.
- Typed x / y, or *None*.

**Live properties**: box b × h, A, kg/m in the chosen material (steel when none), centroid,
Iy / Iz, Wy / Wz, iy / iz and surface. Validation messages explain what is missing or wrong:
no outline, two outlines, a hole outside, crossing edges, an insertion point far away.

**Save**
- *Save as custom profile* takes the name, family and material.
- On an opened profile the button becomes *Update profile*.
- Saving under a new name renames the profile; members and role profiles that used the old
  name follow.
- Replacing another custom profile asks first.

**Import DXF…** loads an outline from a DXF (pick among several). **Export DXF / JSON**
downloads the current profile.

## 6. Profiles by role (mullions vs transoms)

A role can also carry a **profile assembly** (a composite section: several profiles on one base
point, uploaded from an assembly detail DXF); see [PROFILE_ASSEMBLIES.md](PROFILE_ASSEMBLIES.md).

`ProjectSettings.roleProfiles: Partial<Record<MemberRole, RoleProfile>>`:

```ts
interface RoleProfile { profile: string; rotation?: number; alignMode?: 'grid' | 'insertion'; material?: string }
```

- **Panel:** Library → *Profiles by role*. Each role has a profile picker with a section
  thumbnail, rotation, position (keep / insertion point / 3×3 grid) and material, plus member
  and line counts and how many differ. Mullion and transom are always listed; other roles
  appear when they are used, or through *+ Add a role…*.
  - Changing a role's settings asks (in-app dialog) whether to **update all members** of that
    role. Cancel keeps them, and only new members get the new profile.
  - **Apply to all <role>s** and **Apply to selection** update existing members.
- **New members** get their role's profile:
  - lines drawn with a role and no profile (`addLine`)
  - the facade grid (its profile fields default to the role profiles; rotation, position and
    material follow when the profile matches)
  - changing a member's role in the properties panel (`setMemberRole`)
  - choosing a role in the Library tab makes the role's profile the active one.
- **API:** `assignProfilesByRole(p, memberIds?, roles?)` is pure, in core.
  - It gives every listed member (default: all) the profile, rotation, alignment mode and
    material of its role. Construction lines are included, so lines classified as mullions or
    transoms become steel.
  - It returns the number of members changed.
  - Also exported: `roleProfile`, `roleProfilePatch`, `newMemberPatch`, `setRoleProfile`,
    `setMemberRole`, `roleCounts`, `membersOffRoleProfile`.
- **Auto-assign rules** have a new match, *Has role* (`{ match: 'role', ofRole, profile, role }`).
  Precedence is layer rules, then role rules, then direction rules.
- **Migration:** projects without `roleProfiles` get `{}`; nothing about their members changes.

## 7. Outputs of outline profiles

| Output | What happens |
| --- | --- |
| 3D viewer | The outline (6° arcs) is extruded. Geometry caches are keyed by profile name and a hash of the shape, so editing a profile under the same name refreshes the meshes. Cuts, mitres and end slots use the generic outline code |
| IFC4 | `IfcArbitraryClosedProfileDef`, or `IfcArbitraryProfileDefWithVoids` with holes. Every loop is an `IfcIndexedPolyCurve`: straight runs as `IfcLineIndex`, arcs exactly as `IfcArcIndex` (start, mid-arc point, end). Coordinates are from the box centre, like the parameterised profiles. Re-read with web-ifc in the tests: placement matches within 1.5 mm, and volume = A × length within 1 % |
| DSTV NC1 | Profile code **SO** (special). Header: height h and flange width b of the box, wall thickness t when the profile has one (else 0), radius 0. AK face contours v (length × h) and o (length × b) give the stock, unless a cope or end-slot contour replaces them. The section outline follows as `**` comment lines (mm from the box corner), because DSTV has no cross-section block. Holes, slots and saw angles as for boxes. Check with the machine's post-processor |
| Drawings | The section view draws the outline and holes. Elevation and plan draw the straight edges parallel to the view as inner lines, hidden when material lies in front of them on both sides |
| Clash | Strips at the outline's vertices, at most 16 bands, joined when they line up (`sectionRects`). They cover all material and keep the open side of C-like shapes free |
| Lists, nesting | Profile name, mass in the member's material, surface |
| Connections | Faces are the bounding box (as for U, C, Z sections). Copes are not modelled on outline profiles (a warning says so). Fits cut to the box faces |
| Galvanizing | Outlines with voids count as hollow (vent note) |

## 8. Assistant tools (`src/assistant/modules/profiles.ts`)

| Tool | Does |
| --- | --- |
| `create_custom_profile` | Creates or replaces a profile. Outline mode: an outer loop with holes, points `[x, y]` or `[x, y, bulge]`, optional corner radius. Thin-wall mode: centre line, thickness, closed, bend radius. Insertion point `[x, y]` or a preset (`tl` … `br`, `mc`, `centroid`) and a material. Returns the section properties |
| `import_profiles_dxf` | DXF text → profiles (optional unit scale, family, material, `only` names) |
| `list_custom_profiles` | Profiles with size, kg/m, properties, insertion point and the roles using them; the role profiles and member counts |
| `set_role_profiles` | Sets or clears (`""`) the profile of roles, with rotation, alignMode and material; `apply`: all / selection / none |

`set_member_properties` also takes `alignMode`. Every tool edits through `store.apply`
(undoable).

## 9. Limits

- **One outline per profile.** Two overlapping loops are not merged; draw T-junctions as one
  polyline outline, or as one closed thin wall.
- **Thin walls** are straight segments with bends; curved centre-line segments are drawn straight.
- **Mitres:** the mitred corner of a thin wall is capped at 20 × t/2 from the centre line, so
  hairpin turns (included angle under about 6°) are blunted.
- **Connection faces** of outline profiles are the bounding box. A screw port or nose does not
  change where a fin plate or cleat sits.
- **Not done for outline profiles:** copes; the hole-on-the-flat and vent-hole size rules
  (which need RHS / CHS dimensions).
- **DSTV:** SO with face contours is the common convention, but some saw/drill lines need a
  profile from their own database. Check with the post-processor.
- **IFC:** IfcIndexedPolyCurve with arcs is IFC4 (ADD2). Very old IFC2x3 importers would need
  the flattened polyline.
- **DXF:** SPLINE and ELLIPSE outlines are not read (convert them to polylines in CAD), nor are
  binary DXF and DWG.
