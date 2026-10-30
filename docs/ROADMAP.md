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
| Wireframe modelling | Lines and polylines on work planes, snapping, typed coordinates, facade grid generator, move/copy/array/split, undo/redo |
| References | IFC concrete/main steel (web-ifc), DXF linework, PDF/image underlay with 2-point calibration |
| Libraries | EN, BS, AISC profiles; steel, stainless and aluminium grades; metric and imperial bolts; anchors; custom profiles |
| Connections | Slab bracket (edge/top), base plate, fin/knife plate, angle cleat, end plate, welded, splice plates, plus **custom templates** with formula parameters; presets; apply to selected members; auto-connect |
| Derivation | Parts, assemblies, holes, weights, numbering of identical parts and assemblies |
| Code rules | Detailing checks per AISC 360 / EN 1993-1-8 / EN 1090-2 / EN ISO 1461 (edge distance, spacing, holes, welds, coating) |
| Outputs | IFC4, BOM (XLSX/CSV), DSTV NC1, bar and plate nesting |
| Drawings | ISO drawing set:<ul><li>register, GA, assembly and part sheets</li><li>3 views and sections</li><li>revisions</li><li>cross-references</li><li>hole tables</li><li>machining steps</li></ul> |
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
- **Movement and tolerance design:**
  - thermal movement and slab-edge deflection compatibility
  - slot lengths derived from the tolerance stack, not entered by hand

### 2. Modelling (P1–P2)
- Cuts, copes, mitres and fitting between members (true end preparations).
- Bent plates, polygonal plates and stiffeners as first-class parts.
- Non-orthogonal and curved facades: work planes from 3 points, members along arcs, segmented curved mullions.
- **Survey-driven brackets:** import surveyed slab-edge positions (point cloud / CSV) and adjust bracket stand-offs per location, with a setting-out table. This is a facade-specific killer feature.
- Generate the sub-frame from the architect's panel layout (IFC/DXF panel joints → mullion/transom positions).
- Clash detection against the reference model (hard and clearance) with a BCF issue list.
- DWG import; editable steel from IFC (round-trip with Tekla/Revit).
- Manual marks, mark locking, phases/zones, delivery batches.
- Large-model performance: instanced rendering and spatial indexing for 100k+ parts.

### 3. Drawings (P1–P2)
- Interactive drawing editing: move views and dimensions, add notes and leaders, revision clouds.
- Company sheet templates and a title-block designer.
- **Erection drawings for facades:**
  - bracket setting-out plans with anchor positions to grids/levels
  - anchor schedules
  - per-elevation erection sequences
- Section cuts anywhere in the GA, detail callouts and detail views.

### 4. Fabrication and supply chain (P2)
- Plate DXF per part for laser/plasma, and nested sheet DXF/NC output.
- Part labels with QR/barcodes, packing lists, galvanizing batch lists (dip size checks), paint areas.
- Cost estimation: material, fabrication hours per operation, coating, bolts and anchors.
- Exports for fabrication MIS/ERP systems (CSV/JSON/IFC), and import of stock availability.

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
2. **Erection and site:**
   - bracket setting-out drawings and anchor schedules
   - survey-driven bracket adjustment
   - clash detection with BCF
3. **Platform:**
   - cloud projects and sharing
   - drawing editing and templates
   - plate DXF/nesting outputs
   - cost estimation
