# FacadeSteel — what it takes to be the #1 facade steel software

Facade secondary steel is a niche that the big detailing packages serve only generically. It has its own needs:
- brackets to slab edges
- tolerance slots
- movement joints
- galvanizing rules
- dense repetitive sub-frames
- fast change cycles driven by the architect and the cladding supplier

Becoming #1 means doing that niche better than the general tools, while being easier to learn and quicker to produce correct, standards-compliant output.

## Where we are (done)

| Area | Status |
|---|---|
| Wireframe modelling | Lines and polylines on work planes, snapping, typed coordinates, facade grid generator, move/copy/array/split, undo/redo; work planes from 3 points, arcs and curved facade grids |
| Geometry | End preparations (cuts, mitres, copes, fitting); polygon plates, bent plates and stiffeners as parts — see [MODELLING.md](MODELLING.md) |
| Model management | Manual marks, mark locking, phases/zones/delivery batches, clash detection with BCF 2.1, editable steel from IFC, sub-frame from the architect's panel layout, instanced rendering and spatial index for 100k+ parts — see [MODEL_MANAGEMENT.md](MODEL_MANAGEMENT.md) |
| Movement and site | Thermal movement, slab-deflection and drift checks, slot lengths from the tolerance stack, survey-driven bracket adjustment with setting-out tables — see [MOVEMENT.md](MOVEMENT.md) |
| References | IFC concrete/main steel (web-ifc), DXF linework, PDF/image underlay with 2-point calibration |
| Libraries | EN, BS, AISC profiles; steel, stainless and aluminium grades; metric and imperial bolts; anchors; custom profiles |
| Connections | 30 parametric types (steel to concrete, steel to steel, splices and movement joints, bracing, hangers) plus **custom templates**; library browser with a **live 3D preview**; presets; apply to selected members; auto-connect — see [CONNECTIONS.md](CONNECTIONS.md) |
| Derivation | Parts, assemblies, holes, weights, numbering of identical parts and assemblies |
| Code rules | Detailing checks per AISC 360 / EN 1993-1-8 / EN 1090-2 / EN ISO 1461 (edge distance, spacing, holes, welds, coating) |
| Outputs | IFC4, BOM (XLSX/CSV), DSTV NC1, bar and plate nesting (stock on hand first), plate CNC DXF per part and per nested sheet, labels with QR/Code 128, packing lists, galvanizing lists with dip checks, paint areas, MIS/ERP export — see [FABRICATION.md](FABRICATION.md) |
| Drawings | ISO drawing set:<ul><li>register, GA, assembly and part sheets</li><li>3 views and sections</li><li>revisions</li><li>cross-references</li><li>hole tables</li><li>machining steps</li><li>interactive editing (views, dimensions, notes, leaders, revision clouds)</li><li>company templates and a title-block designer</li><li>erection drawings: bracket setting-out plans, anchor schedules, erection sequences</li><li>section cuts and detail views anywhere on the GA</li></ul> |
| AI | Chat assistant that operates the whole application through tools |

## The balance (what is still missing)

Priority: **P1** = needed to win real projects, **P2** = needed to beat the incumbents, **P3** = differentiators.

### 1. Engineering (P1)
- **Facade member design:**
  - wind load on mullions and transoms (EN 1991-1-4 / ASCE 7), dead load of cladding, and load combinations
  - bending, shear, combined and stability checks to EN 1993-1-1 / AISC 360 Ch. E–H
  - deflection limits common in facades (e.g. L/200, L/175 and absolute limits per project spec)
  - automatic profile sizing from the catalogue
- **Connection capacities:**
  - bolts in shear and bearing (AISC J3.6/J3.10, EN 1993-1-8 Table 3.4)
  - fillet welds (AISC J2.4, EN 1993-1-8 4.5)
  - plates in bending
  - anchors to EN 1992-4 / ACI 318 Ch. 17, with a manufacturer data import

### 2. Modelling (P2)
- Saddle cuts for tube-to-tube fitting; rolled (truly curved) members.
- DWG import through a licensed converter (detection and guidance are in place).
- Incremental scene updates for very large models (today the scene is rebuilt on each edit).

### 3. Drawings (P2)
- Hidden-line removal in sections and details; multi-line notes in the editor.

### 4. Fabrication and supply chain (P2)
- Cost estimation: material, fabrication hours per operation, coating, bolts and anchors.
- Remnant / offcut tracking in plate nesting; CAM lead-ins and kerf compensation.

### 5. Collaboration and platform (P2)
- Cloud projects with multi-user access, permissions, version history and review comments on drawings.
- Approval workflow: architect / engineer / fabricator markups → revisions.
- Imperial display units; localisation (e.g. Arabic, French, German).
- Offline desktop app (PWA) and a plugin / scripting API.

### 6. AI (P3, our edge)
- The assistant reads architect PDFs and IFC models and **proposes the sub-frame layout and bracket scheme**.
- Natural-language design reviews: "why is bracket BK3 failing?", "make all brackets EXC2-compliant".
- Learned company standards: preferred profiles, bolt sizes and detail types applied automatically.
- Voice input on site and tablet.

### 7. Trust (P1, continuous)
- Verify every catalogue table against the mill and supplier data; publish data sources.
- Benchmark outputs (weights, IFC, NC) against established tools on reference projects.
- Have code-check implementations reviewed by chartered and licensed engineers; document limits clearly.
- User documentation, tutorials and certified training.

## Suggested next milestones

1. **Facade engineering:**
   - wind and dead load input
   - mullion/transom design and deflection checks
   - bracket and anchor capacity checks
   - automatic sizing
2. **Platform:**
   - cloud projects and sharing, approval workflow
   - cost estimation
   - imperial display units and localisation
3. **Trust:** verify catalogue data, DSTV conventions (saw-angle signs, SI marking) and dip rules against suppliers and machines on a reference project.
