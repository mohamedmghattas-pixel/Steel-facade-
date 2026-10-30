# Code rules: detailing limits and model checks

FacadeSteel checks bolt holes, edge distances, spacing, weld sizes and galvanizing against
**AISC 360** or **Eurocode 3 (EN 1993-1-8 with EN 1090-2)**. The rules live in
`src/core/codes/`:

| File | Contents |
| --- | --- |
| `tables.ts` | Numeric tables and lookups: `holeSize`, `minEdgeDistance`, `edgeIncrementC2`, `minSpacing`, `maxEdgeDistance`, `maxSpacing`, `minFilletWeld`, `maxFilletWeld`, `minFilletWeldLength`, `minCoatingThickness`, `ventHoleGuidance`, `classifyHole`, `suggestConnectionDefaults` |
| `rules.ts` | `RULES` registry (id, title, code, clause, edition, description, values, verification, sources) and ISO 12944, EXC and ISO 13920 constants |
| `checks.ts` | `runCodeChecks(project, derivedModel, code?)` returning `CheckResult[]` |
| `project.ts` | `codeForProject(p)`: `settings.designCode`, or inferred from profiles, materials and bolts |

All lengths are in mm and coatings in µm. AISC fillet sizes are **legs**; EC3 sizes are **effective throats a**.

## How the values were verified

The primary documents could not be opened from the build environment: aisc.org is blocked by
the network policy, and CEN/ISO/ASTM texts are paywalled. Each value was encoded from the
code text and then cross-checked against independent reproductions found by web search
(university notes, software manuals, galvanizer and fastener-maker datasheets).

| Status | Meaning |
| --- | --- |
| **cross-checked** | Matches at least one independent reproduction of the table or text |
| **unconfirmed** | Encoded from the code text as known, but no online reproduction confirmed every number. Check against the standard before relying on it. |
| **guidance** | Industry guidance or geometry, not a code requirement |

Where sources disagreed, the value from the code text was used. The disagreements are listed under "Conflicts and choices".

---

## AISC 360-22 (values identical in 360-16)

### Table J3.3 / J3.3M: nominal hole dimensions (`aisc.holeSize`, `aisc.slotLength`)

Status: **cross-checked** for 1/2–1 in. and M16/M20/M24. M22, M27 and M30 are **unconfirmed** but follow the same table.

| Bolt | Standard | Oversized | Short slot (w × L) | Long slot (w × L) |
| --- | --- | --- | --- | --- |
| 1/2 in. | 9/16 | 5/8 | 9/16 × 11/16 | 9/16 × 1-1/4 |
| 5/8 in. | 11/16 | 13/16 | 11/16 × 7/8 | 11/16 × 1-9/16 |
| 3/4 in. | 13/16 | 15/16 | 13/16 × 1 | 13/16 × 1-7/8 |
| 7/8 in. | 15/16 | 1-1/16 | 15/16 × 1-1/8 | 15/16 × 2-3/16 |
| 1 in. | 1-1/8 | 1-1/4 | 1-1/8 × 1-5/16 | 1-1/8 × 2-1/2 |
| ≥ 1-1/8 in. | d + 1/8 | d + 5/16 | (d + 1/8) × (d + 3/8) | (d + 1/8) × 2.5d |
| M16 | 18 | 20 | 18 × 22 | 18 × 40 |
| M20 | 22 | 24 | 22 × 26 | 22 × 50 |
| M22 | 24 | 28 | 24 × 30 | 24 × 55 |
| M24 | 27 | 30 | 27 × 32 | 27 × 60 |
| M27 | 30 | 35 | 30 × 37 | 30 × 67 |
| M30 | 33 | 38 | 33 × 40 | 33 × 75 |
| ≥ M36 | d + 3 | d + 8 | (d + 3) × (d + 10) | (d + 3) × 2.5d |

The table does not cover M10, M12, M14 or bolts under 1/2 in. For those, the engine uses the
smallest row's clearances (metric: std d+2, oversized d+4, short slot d+6, long slot 2.5d) and
marks the result "size extrapolated" in messages.

Sources: [AISC standards](https://www.aisc.org/publications/steel-standards/) ·
[steelcalculator J3.3](https://steelcalculator.pages.dev/reference/aisc-bolt-hole-sizes/) ·
[AISC 13th Table J3.3 copy](https://pdfcoffee.com/aisc-13th-table-j33-nominal-hole-dimensions-pdf-free.html) ·
[eng-tips: 1 in. hole in 360-16](https://eng-tips.com/threads/aisc-360-16-hole-diameter.479924) ·
[ideCAD AISC 360-16 hole sizes](https://idecad.atlassian.net/wiki/x/bgBDkg)

### J3.2: use of oversized and slotted holes (`aisc.holeUse`), status **unconfirmed**

- Oversized holes are allowed only in slip-critical connections.
- In bearing-type connections, short and long slots must be normal to the load.
- Long slots are allowed in only one ply at each faying surface.
- A long slot in an outer ply needs a plate washer or continuous bar at least 5/16 in. (8 mm) thick.

The engine reports these as info.

Source: [bolt-hole and washer study notes](https://open-exam-prep.com/study-guides/icc-structural-steel-bolting-inspector/preinstallation-and-faying-surfaces/bolt-holes-and-washers)

### J3.4, Table J3.4 / J3.4M: minimum edge distance from the centre of a standard hole (`aisc.minEdge`), status **cross-checked**

| in. | 1/2 | 5/8 | 3/4 | 7/8 | 1 | 1-1/8 | 1-1/4 | > 1-1/4 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| e min | 3/4 | 7/8 | 1 | 1-1/8 | 1-1/4 | 1-1/2 | 1-5/8 | 1.25 d |

| mm | M16 | M20 | M22 | M24 | M27 | M30 | M36 | > M36 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| e min | 22 | 26 | 28 | 30 | 34 | 38 | 46 | 1.25 d |

Footnote: smaller edge distances are allowed only where J3.10 and J4 are satisfied, and never
less than d without EOR approval. The app does not run the bearing and tear-out checks, so it
reports a shortfall as an error. Below the table (for example M12), 1.5 d is used, which matches
the 1/2 in. row ratio, and the result is marked extrapolated.

Sources: [study notes](https://open-exam-prep.com/study-guides/icc-structural-steel-bolting-inspector/connection-details-and-callouts/hole-dimensions-and-spacing) ·
[steelcalculator spacing](https://steelcalculator-dev.pages.dev/reference/bolt-spacing/) ·
[ideCAD](https://idecad.atlassian.net/wiki/x/bgBDkg)

### Table J3.5 / J3.5M: edge distance increment C2 (`aisc.edgeIncrement`), status **unconfirmed**

| Bolt | Oversized | Short slot ⟂ edge | Long slot ⟂ edge | Slot ∥ edge |
| --- | --- | --- | --- | --- |
| ≤ 7/8 in. (≤ M22) | 1/16 in. (2 mm) | 1/8 in. (3 mm) | 0.75 d | 0 |
| 1 in. (M24) | 1/8 in. (3 mm) | 1/8 in. (3 mm) | 0.75 d | 0 |
| ≥ 1-1/8 in. (≥ M27) | 1/8 in. (3 mm) | 3/16 in. (5 mm) | 0.75 d | 0 |

Footnote [a]: when a long slot is shorter than the maximum, C2 may be reduced by half the
difference between the maximum and actual slot lengths. The engine also applies this in reverse:
a slot longer than the maximum adds half the excess. A worked example online
(M20, 26 + 0.75 × 20 = 41 mm) agrees with this table.

### J3.3: minimum spacing (`aisc.minSpacing`), status **cross-checked**

- Centre-to-centre spacing s ≥ 2-2/3 d. The preferred value is 3 d (User Note).
- The clear distance between holes or slots must be at least d.

Source: [steelcalculator spacing](https://steelcalculator-dev.pages.dev/reference/bolt-spacing/)

### J3.5: maximum edge distance and spacing (`aisc.maxEdge`, `aisc.maxSpacing`), status **cross-checked**

- **Edge:** from the centre of any bolt hole to the nearest edge of parts in contact, ≤ 12 t and ≤ 6 in. (150 mm).
- **Spacing, painted or not subject to corrosion:** ≤ 24 t (t = thinner part) and ≤ 12 in. (305 mm).
- **Spacing, unpainted weathering steel:** ≤ 14 t and ≤ 7 in. (180 mm).

Sources: [Purdue CE470 notes](https://engineering.purdue.edu/~ahvarma/CE%20470/BACKUP/Bolted%20Connections/CE470Ch3Bolts_Part1.doc) ·
[steelcalculator spacing](https://steelcalculator-dev.pages.dev/reference/bolt-spacing/)

### J2.2b and Table J2.4: fillet welds (`aisc.minWeld`, `aisc.maxWeld`, `aisc.minWeldLength`)

| Thinner part joined | Minimum leg (Table J2.4) |
| --- | --- |
| ≤ 1/4 in. (6 mm) | 1/8 in. (3 mm) |
| > 1/4 to 1/2 in. (6–13 mm) | 3/16 in. (5 mm) |
| > 1/2 to 3/4 in. (13–19 mm) | 1/4 in. (6 mm) |
| > 3/4 in. (19 mm) | 5/16 in. (8 mm) |

- **Maximum along an edge (J2.2b):** leg ≤ t where t < 1/4 in. (6 mm); otherwise leg ≤ t − 1/16 in. (2 mm). Status **cross-checked**.
- **Minimum length:** 4 × the leg size. Status **unconfirmed**.

Single-pass welds are required. Imperial projects use the inch thresholds; metric projects use the
mm table. Table J2.4 status is **cross-checked** for the imperial values.

Sources: [fillet weld chart](https://steelcalculator.pages.dev/reference/fillet-weld-size-chart/) ·
[360-16 copy](https://www.scribd.com/document/485890011/a360-16-spec-and-commentary)

### M2.5: bolt holes (`aisc.thermalHoles`), status **cross-checked**

Thermally cut holes are allowed with surface roughness ≤ 1,000 µin. (25 µm, ASME B46.1) and
gouges ≤ 1/16 in. (2 mm). Water-jet holes are also allowed. The engine reports this as info when
the model has slots.

Source: [AISC Modern Steel quiz](https://www.aisc.org/globalassets/modern-steel/archives/2013/10/2013v10_quiz.pdf)

---

## Eurocode 3: EN 1993-1-8:2005+AC:2009 and EN 1090-2

### EN 1090-2 Table 11: nominal clearances (`ec3.holeSize`, `ec3.slotLength`)

| d (mm) | 12 | 14 | 16 | 18 | 20 | 22 | 24 | ≥ 27 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Normal round | 1 | 2 | 2 | 2 | 2 | 2 | 2 | 3 |
| Oversize round | 3 | 4 | 4 | 4 | 4 | 6 | 6 | 8 |
| Short slot (on length) | 4 | 6 | 6 | 6 | 6 | 8 | 8 | 10 |
| Long slot (on length) | 1.5 d | | | | | | | |

- Slot width is the normal-hole clearance. The overall long-slot length is therefore 2.5 d.
- For towers and masts, the normal clearance is 0.5 mm smaller.
- d < 12 is not tabulated; the 12 column is used and the result is marked extrapolated.
- Status: normal holes **cross-checked** (M12 → 13 mm). The oversize and slot rows are **unconfirmed**.
  They agree with AISC J3.3M at M16 (22 and 40 mm).

Sources: [NSC AD 413 (M12 → 13 mm)](https://www.newsteelconstruction.com/wp/ad-413-shear-resistances-of-m12-bolts/) ·
[SCI GN 5.08](https://steelconstruction.info/images/9/9f/GN-5-08.pdf)

### EN 1993-1-8 Table 3.3: distances, d0 = hole diameter, t = thinner outer part (`ec3.minEdge`, `ec3.minEdgeSlot`, `ec3.minSpacing`, `ec3.maxEdge`, `ec3.maxSpacing`), status **cross-checked**

| Distance | Minimum | Maximum (exposed steel) | Weathering steel EN 10025-5 |
| --- | --- | --- | --- |
| e1, e2 | 1.2 d0 | 4 t + 40 mm | max(8 t, 125 mm) |
| e3, e4 (slots) | 1.5 d0 | — | — |
| p1 | 2.2 d0 | min(14 t, 200 mm); inner rows in tension p1,i min(28 t, 400 mm) | min(14 t, 175 mm) |
| p2 | 2.4 d0 | min(14 t, 200 mm) | min(14 t, 175 mm) |

The maxima apply to exposed members and to compression members. Facade steel is treated as
exposed by default; `{ exposed: false }` removes the limits. In staggered rows, p2 may be reduced
to 1.2 d0 if L ≥ 2.4 d0.

Sources: [steelcalculator EU spacing](https://steelcalculator.pages.dev/reference/eu-bolt-spacing/) ·
[eurocodeapplied](https://eurocodeapplied.com/design/en1993/bolt-design-properties) ·
[SDC Verifier](https://sdcverifier.com/software/help/eurocode3-bolts.html) ·
[corrigendum AC:2009](https://standards.iteh.ai/catalog/standards/cen/33a5595e-f250-48a9-b319-30032712578e/en-1993-1-8-2005-ac-2009) ·
[NSC AD 359 weathering bolts](https://www.newsteelconstruction.com/wp/ad-359-weathering-steel-bolts/)

### EN 1993-1-8 Table 3.4 notes (`ec3.holeUse`), status **cross-checked**

Bearing resistance is multiplied by 0.8 in oversize holes, and by 0.6 in slots perpendicular to
the load. The engine reports this as info.

Sources: [ArcelorMittal Orange Book](https://orangebook.arcelormittal.com/node/170) ·
[eurocodeapplied](https://eurocodeapplied.com/design/en1993/bolt-design-properties)

### EN 1993-1-8 welds (`ec3.minThroat`, `ec3.minWeldLength`, `ec3.maxWeld`)

- **4.5.2(2):** effective throat a ≥ 3 mm. Status **cross-checked**.
- **4.5.1(2):** a load-carrying fillet weld needs an effective length ≥ max(30 mm, 6 a). Status **cross-checked**.
- **Maximum:** EN 1993-1-8 has no clause. The engine uses the geometric limit a ≤ t/√2 (leg ≤ t),
  and only for lap joints along a plate edge (**guidance**). T-joints get no upper limit, because
  full-strength welds on hollow sections (EN 1993-1-8 7.3.1) need a ≈ 0.92–1.11 t, which is more
  than t/√2 (**unconfirmed**).

Source: [structville fillet welds](https://structville.com/design-of-fillet-weld-connections)

### EN 1090-2 fabrication

- **6.6.3 punching (`en1090.punching`):** punching is allowed only where t ≤ d0 (for slots, the
  minimum dimension). The engine reports this as info. The extra EXC3/EXC4 limits on punching
  without reaming are not encoded. Status **cross-checked** (secondary summary).
  Source: [steelcalculator UK holes](https://steelcalculator.pages.dev/reference/uk-bolt-hole-sizes/)
- **Execution classes (`en1090.exc`):** EXC1–EXC4. Facade secondary steel is normally EXC2.
- **ISO 13920 general tolerances (`iso13920.tolerances`):** classes A–D for lengths and angles,
  and E–H for straightness, flatness and parallelism. The designation looks like "ISO 13920-BF".
  The 2023 edition replaces 1996.
  Source: [Modulus Metal](https://www.modulusmetal.com/iso-13920-welding-general-tolerances-for-welded-constructions)

### EN 1993-1-8:2024

EN 1993-1-8:2024 has been published, and the 2005 edition was withdrawn in March 2024
([Genorma](https://genorma.com/en/standards/en-1993-1-8-2005)). Its spacing and edge distance
table could not be checked. The values above are understood to be unchanged, but this is
**not verified**. National Annexes may also modify values; for example, the German NA recommends
a ≥ 5 mm for t ≥ 30 mm. National Annex values are not encoded.

---

## Galvanizing and corrosion (both codes)

### Coating thickness (`coat.iso1461`, `coat.a123`)

**EN ISO 1461:2022 Table 3** (articles not centrifuged; values unchanged from 2009). Status **cross-checked**.

| Steel thickness | Local min (µm) | Mean min (µm) |
| --- | --- | --- |
| > 6 mm | 70 | 85 |
| > 3 to ≤ 6 mm | 55 | 70 |
| ≥ 1.5 to ≤ 3 mm | 45 | 55 |
| < 1.5 mm | 35 | 45 |
| Castings ≥ 6 mm / < 6 mm | 70 / 60 | 80 / 70 |

**ASTM A123/A123M Table 1** gives the minimum average coating grade in µm. Any single specimen
may be one grade lower (Table 2 grades: 35, 45, 50, 55, 60, 65, 75, 80, 85, 100). Status
**unconfirmed**: the 45 and 100 values were cross-checked; the middle values were not.

| Thickness (mm) | < 1.6 | 1.6–< 3.2 | 3.2–4.8 | > 4.8–< 6.4 | ≥ 6.4 |
| --- | --- | --- | --- | --- | --- |
| Structural shapes and plate | 45 | 65 | 75 | 75 | 100 |
| Pipe and tubing (used for HSS) | 45 | 45 | 75 | 75 | 75 |

Sources: [Higalv: changes to ISO 1461](https://www.higalv.co.uk/?p=3371) ·
[Galvanizers Association ISO 1461](https://galvanizing.org.uk/galvanizing-standards/iso-1461/) ·
[Wedge HDG to EN 1461](https://www.wedge-galv.co.uk/wp-content/uploads/2024/10/4b-HDG-to-EN-1461-2024.pdf) ·
[AGA A123](https://galvanizeit.org/knowledgebase/article/astm-a123-a123m) ·
[AGA A123 course](https://galvanizeit.org/inspection-course/galvanizing-standards/astm-a-123-for-structural-steel-products)

### Vent and drain holes (`coat.vent`), status **guidance** (EN ISO 14713-2, ASTM A385)

Closed hollow sections must be vented and drained before hot-dip galvanizing. Place holes at
each closed end, diagonally opposite and as close to the closure weld as possible. A sealed
section can burst in the bath.

Rule of thumb used: one hole per closed end of 25 % of the internal section diagonal, or two
holes with the same total area. Never less than 10 mm, rounded up to 5 mm. For example,
SHS 100×100×5 gives 1× Ø35 or 2× Ø25. EN ISO 14713-2 Table A.2 could not be read, so agree the
sizes with the galvanizer.

The engine flags HDG RHS/CHS members whose end is closed by a shop-welded plate (end plate or
base plate), or that are welded onto another member.

Sources: [Galvanizers Association venting](https://galvanizing.org.uk/design-for-galvanizing/filling-venting-and-drainage/) ·
[10 mm minimum note](https://thomas-graham.co.uk/files/ww/Minimum-Hole-Size-Note-with-Table-1.pdf) ·
[GAA venting guide](https://gaa.com.au/venting-draining-guide/) ·
[AGA HSS vent holes](https://galvanizeit.org/knowledgebase/article/required-vent-drain-holes-for-hollow-structural-sections-handrail-tubing) ·
[HDG community](https://hdgcommunity.com/articles/vent-and-drain-holes/)

### ISO 12944 (`coat.iso12944`; constants only), status **cross-checked**

| Category | C1 | C2 | C3 | C4 | C5 | CX |
| --- | --- | --- | --- | --- | --- | --- |
| Zinc first-year loss (µm) | ≤ 0.1 | 0.1–0.7 | 0.7–2.1 | 2.1–4.2 | 4.2–8.4 | 8.4–25 |

Durability ranges (ISO 12944-1:2017; these are not guarantee times):

- L: up to 7 years
- M: 7–15 years
- H: 15–25 years
- VH: more than 25 years

Source: [ISO 12944 categories](https://wittfan.de/files/pdf/Know-how%20Center/Normen%20und%20Richtlinien/02_Corrosivity%20Categories%20and%20Durability%20Ranges%20ISO%2012944_EN.pdf)

### Bimetallic contact (`coat.bimetallic`), status **guidance** (EN ISO 14713-1, PD 6484)

The engine reports a warning in these cases:

- stainless bolts or anchors (A2/A4, 1.4xxx, F593) in carbon or galvanized steel
- carbon or galvanized bolts in stainless parts
- stainless and carbon steel parts in one connection
- aluminium in contact with steel

The advice is to isolate the metals with insulating washers, sleeves or pads where an electrolyte
can bridge them (wet locations, C4+). Small stainless fasteners in large galvanized parts are low
risk in dry air. Galvanized fasteners in stainless parts corrode quickly.

Sources: [GAA design manual](https://designmanual.gaa.com.au/?p=398) ·
[Galvanizers Association datasheet](https://wedge-galv.co.uk/wp-content/uploads/2024/10/10-Bimetallic-Corrosion-2024.pdf)

### High-strength bolts on galvanized work (`coat.hydrogen`, `coat.a490`, `coat.nuts`), status **cross-checked**

- **10.9:** risk of hydrogen embrittlement. Use only assemblies galvanized under the bolt maker's
  control (EN 14399 / EN ISO 10684), never re-galvanize, or use 8.8. Reported as a warning.
- **12.9:** EN ISO 10684 covers bolts only up to 10.9, so 12.9 must not be hot-dip galvanized. Reported as an error.
- **ASTM F3125 Grade A490 and F2280:** hot-dip (F2329) and mechanical (B695) galvanizing are not
  permitted. Zn/Al coating to F3393 is allowed. Reported as an error.
- **Nuts:** must be tapped oversize after galvanizing.
  - ISO: 6AZ, or 6AX with a higher nut class.
  - ASTM: A563 DH or A194 2H, galvanized, overtapped and lubricated, supplied as a tested assembly.
  - Reported once per project as info.

Sources: [Portland Bolt: A490](https://www.portlandbolt.com/technical/faqs/can-a490-bolts-be-galvanized/) ·
[Portland Bolt: galvanizing HS bolts](https://www.portlandbolt.com/technical/faqs/galvanizing-high-strength-bolts/) ·
[ISO 10684 scope](https://standards.iteh.ai/catalog/standards/iso/c552ca38-988c-4e06-8752-5fa012e100af/iso-10684-2004) ·
[ISO 10684 nut classes](https://www.boltport.com.ferrobend.com/standards/iso-10684/strength-of-hot-dip-galvanized-bolt-or-screw-and-nut-assemblies) ·
[nuts study notes](https://open-exam-prep.com/study-guides/icc-structural-steel-bolting-inspector/fasteners-and-joint-mechanics/nuts-washers-and-coatings) ·
[AGA overtapping](https://galvanizeit.org/hot-dip-galvanized-steel-bridges-online-seminar/connection-concerns/overtapping-guidelines)

### Geometry (`geom.holeOutside`, `geom.holeInFlat`), status **guidance**

- A hole centre outside the plate outline is an error.
- A hole in an RHS wall must stay clear of the corner radius:
  |offset| + d0/2 ≤ (wall width)/2 − outer radius.

---

## How `runCodeChecks` applies the rules

1. **Plates.** Each plate hole is matched to the bolt or anchor that passes through it, using
   bolt positions and directions from the derived model. If no bolt passes through, the engine
   falls back to the connection's bolt with the smallest clearance, and then to a library size
   (shown as "(assumed)").
   - **AISC:** edge distance is measured from the hole centre against Table J3.4 + C2. The
     perpendicular or parallel case is decided per edge from the slot axis.
   - **EC3:** edge distance is measured from the slot centre line against 1.2 d0 (round) or
     1.5 d0 (slot), using the actual d0.
   - **Maximum edge distance:** the nearest edge from each bolt hole centre is checked against
     the maximum. Anchors are excluded.
2. **Spacing.** All hole pairs in a plate, and pairs on the same face of a member, are checked.
   - **AISC:** centre-to-centre ≥ 2-2/3 d, and clear distance ≥ d.
   - **EC3:** the distance between slot centre lines must be ≥ 2.2 d0 (error). Between 2.2 d0
     and 2.4 d0 is a warning, because the load direction is not known.
   - **Maximum spacing:** the largest nearest-neighbour distance within one bolt group is checked
     against the maximum for the plate or wall thickness.
3. **Members and cleats.** End distance is checked against both member ends; slots run along the
   axis. Edge distance across the section is checked where the section has a free edge: angle
   legs, flats, I/T flanges, T stems. Holes in RHS walls are checked against the flat width.
4. **Hole size.** Each hole is classified as standard, oversize, short slot or long slot from the
   code table for its bolt. A hole smaller than the bolt is an error. A hole larger than
   oversize, a slot wider than the standard hole, or a slot longer than a long slot is a warning.
   Oversize holes and slots also produce info on their limitations. Anchor holes are not checked
   here, because base-plate anchor holes are sized for setting tolerance.
5. **Welds.** The project weld size (`drawings.settings.weldSize`) means the throat a for ISO
   drawings and the leg for ASME drawings. It is checked for every shop weld (`weldedTo` and
   connection welds):
   - **AISC:** Table J2.4 minimum leg for the thinner part.
   - **EC3:** a ≥ 3 mm.
   - **Lap joints only:** the J2.2b maximum along the edge (AISC), or the geometric limit (EC3).
6. **Coatings.** The engine reports:
   - vent/drain holes for closed HDG hollow sections
   - bimetallic contacts per connection
   - 10.9, 12.9 or A490 bolts on HDG work
   - HDG nut requirements
   - minimum zinc thickness per thickness band
   - for EC3, punching limits
7. Identical findings on identical parts are merged, with "(N×)" appended to the message and a
   `count` field. Results are sorted error → warning → info.

## Conflicts and choices

- **AISC 1 in. bolt, standard hole.** 360-10 and RCSC give 1-1/16 in.; 360-16 and 360-22 give
  1-1/8 in. The engine uses 1-1/8 in.
- **AISC M24 standard hole.** 27 mm (Table J3.3M, which allows a 1 in. bolt). EN 1090-2 and
  AS 4100 use 26 mm. The engine uses each code's own value.
- **Table J3.4M.** One reproduction listed 25 mm for M22 and 27 mm for M24. Those look like the
  pre-2010 sheared/rolled-edge columns. The engine uses the single-column 360-10+ values: 28 and 30 mm.
- **C2 values.** One guide gave 3/5 mm for short and long slots. The engine uses Table J3.5M
  (long slot ⟂ edge = 0.75 d), which matches a worked example: M20, 26 + 15 = 41 mm.
- **Table J2.4 thresholds.** The metric table uses 6/13/19 mm; the inch table uses
  1/4, 1/2 and 3/4 in. Each is used for its own unit system.
- **EN 1993-1-8 minimum weld length.** The 2000 draft said 40 mm; the published 2005 text says
  30 mm. The engine uses 30 mm.
- **ISO 1461 thickness bands.** IS 4736 uses different bands; the engine uses EN ISO 1461.
- **Vent-hole rules.** ASTM A385 uses area rules (25–30 % of the section area for single
  openings); the GAA uses 25 % of the diagonal. The engine uses the GAA rule because it gives a
  single diameter. Treat it as guidance only.

## Wiring into the app

- **Checks tab:**
  `runCodeChecks(project, derivedModel)`. Show `severity`, `message` and `count`. Select by
  `partRef`, `memberId` or `connectionId`. `ruleById(r.rule)` gives the full description,
  edition, values and sources for a details popover.
- **Design-code setting:** `codeForProject(p)` reads `settings.designCode` (`'auto'`,
  `'AISC360'` or `'EC3'`).
- **Connection defaults:** `suggestConnectionDefaults(bolt, code, t)` returns
  `{ edge, pitch, gauge }`, rounded up to 5 mm and within the code maxima. Use `holeSize(bolt,
  'standard', code).d0` for hole diameters. The current library uses EN 1090-2 holes for both
  codes; AISC M24 should be 27 mm.
- **Default slab-bracket slot:** the default slot is 30 mm extra length. For M12 that gives a
  43 mm overall slot, longer than a long slot (2.5 d = 30 mm) in both codes, so the checks report
  a warning. Use a slot of at most 17 mm, or a larger bolt, to stay within the codes.
