# Movement, tolerances and survey-driven brackets

Facade secondary steel has to absorb three things at its joints: **site tolerances** (the slab
edge is never where the drawing says), **movement in service** (thermal expansion, slab-edge
deflection, storey drift) and, once the frame is cast, the **as-built deviations** measured by
the surveyor. FacadeSteel turns those into slot lengths, gaps and made-to-measure brackets, and
checks every joint against them.

| Code | Contents |
| --- | --- |
| `src/core/movement/settings.ts` | Resolved settings, facade directions, tolerance scope |
| `src/core/movement/thermal.ts` | ΔL = α·ΔT·L, expansion and contraction |
| `src/core/movement/tolerance.ts` | Tolerance stacks (linear / RSS) |
| `src/core/movement/slots.ts` | Slot length from the stack, code and edge-distance caps |
| `src/core/movement/provisions.ts` | Demand and provisions per joint (used by the connection builders) |
| `src/core/movement/report.ts` | `movementReport(p, dm)` |
| `src/core/movement/checks.ts`, `rules.ts` | `move.*` code checks and rule entries |
| `src/core/survey/` | Survey import (CSV / DXF / IFC), matching, adjustment, setting-out table |
| `src/ui/dialogs/MovementDialogs.tsx` | Settings section, connection info, survey dialog, Outputs → Survey |
| `src/assistant/modules/movement.ts` | Assistant tools |

Units: mm, °C. Facade directions at a joint: **out** of plane (positive towards the slab),
**vertical** (up) and **along** the facade (the mullion's local +y).

## Settings (Project → Movement & tolerances)

All defaults are **typical assumptions** to be replaced by the project specification.

| Setting | Default | Meaning |
| --- | --- | --- |
| `tempInstall`, `tempMin`, `tempMax` | 15, −20, 60 °C | Steel temperature at installation and the design extremes (exposed, dark steel can exceed 60 °C) |
| `slabDeflection` | 20 mm | Differential vertical deflection between two slab edges (live load + creep) |
| `storeyDrift` | 10 mm | In-plane inter-storey drift |
| `combine` | RSS | Linear (Σtᵢ, worst case) or root-sum-square (√Σtᵢ², statistical) |
| `tolerances` | 5 items | ± values with a direction (along / vertical / out) and a source |
| `slotIncrement` | 5 mm | Derived slot lengths and gaps are rounded up to this |
| `slotMargin` | 0 mm | Extra clearance added to every derived slot / gap |
| `minGap` | 10 mm | Smallest auto stack-joint gap (gaskets / sealant; typical practice) |
| `surveyAccuracy` | ±3 mm | Total-station accuracy (typical), replaces the slab tolerances where surveyed |

Each tolerance has a **scope**: *structure* (slab edge, anchors — absorbed by the slab
brackets, and replaced by the survey where a bracket is matched) or *steel* (fabrication,
erection — applies at every joint). Without an explicit scope it is inferred from the name
("slab", "anchor", "edge", "concrete" → structure; "steel", "fabrication", "erection" → steel).

## Thermal movement

ΔL = α · ΔT · L, separately for expansion (ΔT⁺ = T_max − T_install) and contraction
(ΔT⁻ = T_install − T_min). α comes from the member material (`src/core/library/materials.ts`):

| Material | α (1/K) | Reference |
| --- | --- | --- |
| Carbon / weathering steel | 12×10⁻⁶ (11.7×10⁻⁶ ASTM grades, from 6.5×10⁻⁶ /°F) | EN 1993-1-1 3.2.6 (T ≤ 100 °C) |
| Austenitic stainless | 16×10⁻⁶ (ASTM 304: 17.3×10⁻⁶) | EN 1993-1-4 / EN 10088-1 |
| Duplex stainless | 13×10⁻⁶ | EN 1993-1-4 / EN 10088-1 |
| Aluminium alloys | 23×10⁻⁶ | EN 1999-1-1 (material constants, 3.2.5) |

The values are encoded from the code texts as known and were not re-checked against the
primary documents (rule `move.thermal`, status *unconfirmed*). Example: a 3 m S355 transom over the defaults: +45 K → ΔL⁺ = 12e-6 × 45 × 3000 = **1.62 mm**;
−35 K → ΔL⁻ = **1.26 mm**. A slot centred at installation must allow the larger of the two each
way.

## Tolerance stacks

In each direction the tolerances that act there are combined:
linear T = Σ|tᵢ|, RSS T = √Σtᵢ². RSS assumes independent, roughly normal deviations (typical
practice for interface tolerances with several items); linear is the conservative choice. With
the defaults: out of plane RSS(25, 5) = ±25.5 mm (linear ±30), vertical ±20, along RSS(10, 2) =
±10.2 mm. At steel-to-steel joints only *steel* items are used; at a surveyed bracket the
*structure* items are replaced by the survey accuracy (out: RSS(5, 3) = ±5.8 mm).

## Slot length from the stack

A bolt centred in a slot at installation can travel ±(L − d0)/2 before bearing on the slot end;
the normal hole clearance d0 − d stays as fit-up play. To absorb ±T (tolerance) and ±M
(movement):

    L = d0 + 2·(T + M) + c        rounded up to the slot increment (5 mm)

i.e. twice the combined tolerance plus movement, plus the bolt with its clearance (d0 = d +
clearance per EN 1090-2 Table 11 / AISC 360 Table J3.3), plus the optional margin c. The model
stores the extra length s = L − d0. Example: M12 (d0 = 13), T = ±20, M = 0 → L = 13 + 40 = 53 →
**55 mm** (s = 42).

Auto slots are capped, and the cap is reported:

- **Code maximum** — long slot overall 2.5 d (EN 1090-2 Table 11; AISC 360 Table J3.3, same
  value for metric bolts): 30 mm for M12. Longer slots are outside both standards. On the slab
  bracket, *Auto fin slot limit → none (special slot)* lifts this cap (a project-specific slot
  with plate washers or serrated plates that the engineer has to justify); the existing
  `slotLength` rule then warns as before.
- **Edge distance** — slot ends at least 1.5 d0 from the plate edge along the slot axis
  (EN 1993-1-8 Table 3.3), so auto slots never create edge-distance errors.

## Joints and their provisions

### Slab brackets

One bracket per mullion carries the dead load (**fixed**); the others are **sliding** (restraint
only). *Support: auto* picks the highest bracket on the mullion — the usual hung stick system;
set *fixed (dead load)* / *sliding* explicitly to change it. A second fixed bracket on the same
member is flagged (`move.restraint`), as is a member with no fixed bracket.

| Provision | Edge mount | Top mount | Absorbs |
| --- | --- | --- | --- |
| Fin slot (along the mullion) | vertical | vertical | T_v; sliding brackets also M = α·ΔT·(distance to the fixed bracket) + slab deflection between the two floors |
| Anchor slot | along the slab edge | out of plane | T in that direction |
| Third direction | packing behind the back plate, out of plane (`packMax`, 20 mm typical) | along: anchors drilled through the plate on site (or cast-in channel) | T in that direction |
| Drift rotation | fin bolt group | fin bolt group | (Δ/h)·(n − 1)·p/2 ≤ (d0 − d)/2; a single bolt pivots |
| Stack-joint gap (when the bracket carries a second mullion) | vertical | — | see below |

Packing is assumed to be detailed with a nominal pack of half the range, so the bracket can move
both ways; packs are loose site items and are not modelled. Bolts through packs thicker than d/3
lose shear resistance by βp = 9d/(8d + 3tp) (EN 1993-1-8 3.6.1(12)); anchors through packs act
in shear with a lever arm (anchor design to EN 1992-4 / the ETA — not checked here).

**Stack-joint gap.** The gap closes when the mullion above comes down (thermal expansion below
its fixed bracket, deflection of the slab it hangs from) or the mullion below grows up:

    gap ≥ α·ΔT⁺·(z_fixed,above − z_joint) + α·ΔT⁺·(z_joint − z_fixed,below) + δ_slab + T_v,steel (+ c)

Auto gap = that, rounded up, but at least `minGap`. The report also gives the opening (with
contraction) so the spigot / sleeve engagement can be checked. Sample: 3.5 m SHS mullions hung
from the slab above → 1.89 + 20 = 21.9 → **25 mm**.

### Transoms and rails (fin plate, angle cleat)

A member jointed at both ends gets **one slotted end** (*Movement end: auto*): the joint at the
member's end node, or the only slottable end if the other joint is an end plate / welded. The slot
is sized for ± (ΔL_max + T_steel) along the member axis. The fin plate gets the slot in the plate;
the angle cleat gets it in the **supported member's** holes (the slot must run along the member
axis; the cleat holes stay round). Sample: 1.5 m bay → 2·(2 + 0.81) = 5.6 → 13 + 5.6 → 20 mm
(**s = 7**). A member jointed at both ends with no slot and ΔL > 1 mm is flagged
(`move.thermalEnd`; ~1 mm is taken by hole clearance and joint flexibility — typical practice).

Every connection with *Auto slots* off uses its manual values unchanged.

### Splices

Splice plates (`splice.ts`) keep their manual gap and slot; they are not in the report yet.

## Movement report and checks

`movementReport(p, dm, { survey })` lists per joint each provision with ±T, ±M, the survey
residual, required vs provided and whether it suffices, plus ΔL per member. It is shown in
Outputs → Survey → Movement / Thermal ΔL, on the selected connection (Properties → Movement &
adjustment) and is exported with the setting-out workbook.

Severities: a design-stage shortfall (`move.slot`, `move.packing`, `move.gap`, `move.drift`,
`move.restraint`, `move.thermalEnd`) is a **warning** — the inputs are project assumptions and
each needs an engineering decision. A surveyed deviation a bracket cannot absorb (`move.survey`)
is an **error**: that bracket cannot be installed as detailed. With the default settings the
sample facade shows warnings: the M12 fin slots cannot take ±20 mm slab level (long slot max
30 mm), the sliding bottom brackets cannot take 20 mm slab deflection, and 20 mm packing cannot
take ±25.5 mm out of plane — which is exactly what the survey workflow addresses.

## Survey-driven brackets

1. **Import** (Import → Survey points, or the assistant `survey` tool):
   - CSV / text: `name, x, y, z [, design x, y, z]`, or `x, y, z [, design x, y, z]` without a
     name (exactly 3 or 6 numbers); any other numeric first column is a point number. Comma, semicolon, tab or whitespace;
     decimal commas with `;` / tab; header and `#` / `//` lines are skipped.
   - DXF: POINT entities, named after the nearest TEXT / MTEXT within five text heights; without
     POINTs, block INSERT positions, then TEXT insertion points (`dxf-parser`).
   - IFC: placements of IfcAnnotation, IfcBuildingElementProxy and IfcVirtualElement (local
     placement chains composed; a lone IfcCartesianPoint in the representation is used), in the
     file's length unit (web-ifc).
   - Units (mm / m / ft) and an origin to subtract (site grid → model).
2. **Match**: each slab bracket's design reference point — on the slab face / edge, at the node
   level, on the fin line — is paired one-to-one, nearest first, with a survey point within
   `matchRadius` (300 mm). A point's design position is used for matching and as the reference
   when given; otherwise the bracket's reference point is.
3. **Decompose** the deviation (surveyed − design) into out (towards the slab), vertical and along.
   *Along* is ignored unless enabled: it only means something when the points mark anchor /
   channel positions rather than any point on the slab edge.
4. **Adjustability left** per direction = provision/2 − (T_residual + M), where T_residual is the
   stack with the slab items replaced by the survey accuracy. The deviation fits if
   |deviation − adjustment| ≤ that.
5. **Apply** (undoable): *Adjust brackets that exceed* makes only the failing directions to measure;
   *Make all matched to measure* adjusts every matched direction. Adjustments are rounded to
   `adjustStep` (5 mm) and written to the bracket's `surveyOut`, `surveyVert`, `surveyAlong`.
   The slab-bracket geometry then moves the back plate to the surveyed slab (stand-off and fin
   length for out; back plate and fin extent for vertical; back plate along the fin for along),
   so the bracket gets its own mark, drawings, NC and BOM line. *Clear adjustments* removes them.

**Setting-out table** (Outputs → Survey, CSV / XLSX): mark, grid / level, design point,
survey point, surveyed point, deviation, adjustment, the site setting (e.g. `pack 12 mm; fin slot
−3 mm vert`) and the status (no survey point / within adjustability / made to measure / exceeds).
The XLSX also holds the survey points, the movement report and a summary.

## Assistant tools

`movement_settings` (get / set, tolerance upsert / remove), `movement_report`, `survey`
(import pasted CSV, status, apply, clear, remove points) and `setting_out_table` (rows, CSV, or
download CSV / XLSX). All edits are undoable.

## Changes to existing results

*Auto slots* is on by default, also for existing projects (their manual values are kept but
not used until it is switched off). On the sample facade: the stack-joint gap becomes 25 mm
(was 20), so the upper mullions are 5 mm shorter; edge-bracket anchor slots 25 mm extra (was
20), top-mount anchor slots 55 mm (was 20, out of plane); the fin slot stays 17 mm (capped at the
M12 long slot); each transom gets a 7 mm slot at its end-node cleat. No existing test needed
changing.

## Limits

- The demand model is a typical-practice simplification: one fixed bracket per mullion, slab
  deflection taken as the full differential between any two floors, symmetric slots centred at
  installation, independent tolerances for RSS. Movement joints in the glazing / panels, bracket
  and anchor strength, and packing structural design are not checked.
- Slab-edge rotation, frame shortening (creep / shrinkage of columns) and wind / seismic
  out-of-plane movement are not modelled; add them as tolerance items or to the deflection value.
- Storey drift is checked only as rotation of the fin bolt group; in-plane racking of panels,
  transom joint rotation and spigot capacity are not checked.
- Packs are not modelled as parts; the nominal pack is an assumption of the check.
- Top mount, slab higher than design: the made-to-measure fin gets shorter below the bolts
  (the mullion holes are fixed); the edge-distance check flags it when it gets too short — use a
  taller fin or a site adjustment instead.
- Survey matching is geometric (nearest point); points far from any bracket are ignored, and a
  bracket with two candidate points takes the nearest. Surveyed along-facade deviations are
  only meaningful for anchor / channel positions.
- IFC import reads placements, not geometry: points carried only as geometry (e.g. IfcPolyline
  vertices) are not read.
- The tolerance values in the defaults are placeholders (sources cited as "typical"); use the
  values of the project's concrete (EN 13670 / ACI 117) and steel (EN 1090-2 / AISC 303)
  specifications.
