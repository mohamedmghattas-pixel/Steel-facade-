/**
 * Reference documents behind the library data, so the UI can show where a
 * value comes from. `id` matches Profile.spec / Material.standard / bolt spec
 * strings (several ids may be joined with " / " or " + ").
 */

export type StandardTopic = 'sections' | 'materials' | 'fasteners' | 'anchors' | 'design' | 'execution';

export interface StandardDoc {
  id: string;
  title: string;
  /** Edition year the data was taken from (omitted where the current edition applies). */
  year?: number;
  publisher: 'CEN' | 'BSI' | 'DIN' | 'ISO' | 'ASTM' | 'AISC' | 'ACI' | 'ASME' | 'EOTA' | 'ICC-ES';
  topic: StandardTopic;
  scope: string;
}

export const STANDARD_DOCS: StandardDoc[] = [
  // Sections
  { id: 'EN 10365', year: 2017, publisher: 'CEN', topic: 'sections', title: 'Hot rolled steel channels, I and H sections — Dimensions and masses', scope: 'IPE, HEA/HEB/HEM, IPN, UPN, UPE, UB, UC, PFC dimensions and masses' },
  { id: 'DIN 1025-1', year: 2009, publisher: 'DIN', topic: 'sections', title: 'Hot rolled I-beams — Part 1: Narrow flange I-sections (IPN)', scope: 'IPN taper (14 %), r1 = tw, r2 = 0.6 tw' },
  { id: 'DIN 1026-1', year: 2009, publisher: 'DIN', topic: 'sections', title: 'Hot rolled steel channels — Part 1: Taper flange channels (UPN)', scope: 'UPN taper (8 %), r2 = r1/2' },
  { id: 'EN 10055', year: 1995, publisher: 'CEN', topic: 'sections', title: 'Hot rolled steel equal flange tees with radiused root and toes', scope: 'T 20–T 140 equal-leg tees' },
  { id: 'EN 10056-1', year: 2017, publisher: 'CEN', topic: 'sections', title: 'Structural steel equal and unequal leg angles — Part 1: Dimensions', scope: 'Angle legs, thicknesses, root radius r1 and toe radius r2' },
  { id: 'EN 10058', year: 2018, publisher: 'CEN', topic: 'sections', title: 'Hot rolled flat steel bars and steel wide flats for general purposes', scope: 'Flat bar widths and thicknesses' },
  { id: 'EN 10059', year: 2003, publisher: 'CEN', topic: 'sections', title: 'Hot rolled square steel bars for general purposes', scope: 'Square bars' },
  { id: 'EN 10060', year: 2003, publisher: 'CEN', topic: 'sections', title: 'Hot rolled round steel bars for general purposes', scope: 'Round bars' },
  { id: 'EN 10162', year: 2003, publisher: 'CEN', topic: 'sections', title: 'Cold rolled steel sections — Technical delivery conditions', scope: 'Cold-formed C, Z, channels and angles (sizes here are generic; inner bend radius taken as t)' },
  { id: 'EN 10219-2', year: 2019, publisher: 'CEN', topic: 'sections', title: 'Cold formed welded steel structural hollow sections — Part 2: Tolerances, dimensions and sectional properties', scope: 'SHS/RHS/CHS; outer corner radius 2t (t ≤ 6), 2.5t (6 < t ≤ 10), 3t (t > 10)' },
  { id: 'EN 10210-2', year: 2019, publisher: 'CEN', topic: 'sections', title: 'Hot finished steel structural hollow sections — Part 2: Tolerances, dimensions and sectional properties', scope: 'SHS/RHS/CHS "HF"; corner radii outer 1.5t, inner 1.0t' },
  { id: 'BS 4-1', year: 2005, publisher: 'BSI', topic: 'sections', title: 'Structural steel sections — Part 1: Specification for hot-rolled sections', scope: 'UB, UC, PFC' },
  { id: 'ASTM A6', publisher: 'ASTM', topic: 'sections', title: 'Standard Specification for General Requirements for Rolled Structural Steel Bars, Plates, Shapes, and Sheet Piling', scope: 'W, S, M, C, MC, L, WT dimensions and tolerances' },
  { id: 'AISC Manual', year: 2023, publisher: 'AISC', topic: 'sections', title: 'Steel Construction Manual, 16th Edition (and AISC Shapes Database v16.0)', scope: 'Shape dimensions, HSS and pipe weights (nominal wall, outer radius 2t)' },
  { id: 'ASTM A500', publisher: 'ASTM', topic: 'sections', title: 'Cold-Formed Welded and Seamless Carbon Steel Structural Tubing in Rounds and Shapes', scope: 'HSS; AISC design wall thickness 0.93 t' },
  { id: 'ASTM A53', publisher: 'ASTM', topic: 'sections', title: 'Pipe, Steel, Black and Hot-Dipped, Zinc-Coated, Welded and Seamless', scope: 'Pipe STD/XS (dimensions per ASME B36.10M)' },
  { id: 'ASME B36.10M', publisher: 'ASME', topic: 'sections', title: 'Welded and Seamless Wrought Steel Pipe', scope: 'NPS outside diameters and STD/XS wall thicknesses' },

  // Materials
  { id: 'EN 10025-2', year: 2019, publisher: 'CEN', topic: 'materials', title: 'Hot rolled products of structural steels — Part 2: Non-alloy structural steels', scope: 'S235, S275, S355 (JR/J0/J2/K2): ReH by thickness, Rm' },
  { id: 'EN 10025-3', year: 2019, publisher: 'CEN', topic: 'materials', title: 'Part 3: Normalized/normalized rolled weldable fine grain structural steels', scope: 'S275N–S460NL' },
  { id: 'EN 10025-4', year: 2019, publisher: 'CEN', topic: 'materials', title: 'Part 4: Thermomechanical rolled weldable fine grain structural steels', scope: 'S355M–S460ML' },
  { id: 'EN 10025-5', year: 2019, publisher: 'CEN', topic: 'materials', title: 'Part 5: Structural steels with improved atmospheric corrosion resistance', scope: 'Weathering S235J2W, S355J0W/J2W/K2W' },
  { id: 'EN 10025-6', year: 2019, publisher: 'CEN', topic: 'materials', title: 'Part 6: Flat products of high yield strength structural steels in the quenched and tempered condition', scope: 'S460Q, S690Q' },
  { id: 'EN 10210-1', year: 2006, publisher: 'CEN', topic: 'materials', title: 'Hot finished structural hollow sections of non-alloy and fine grain steels — Part 1: Technical delivery conditions', scope: 'S235JRH–S460NH' },
  { id: 'EN 10219-1', year: 2006, publisher: 'CEN', topic: 'materials', title: 'Cold formed welded structural hollow sections of non-alloy and fine grain steels — Part 1: Technical delivery conditions', scope: 'S235JRH–S460MH' },
  { id: 'EN 10088-4', year: 2009, publisher: 'CEN', topic: 'materials', title: 'Stainless steels — Part 4: Sheet/plate and strip of corrosion resisting steels for construction purposes', scope: 'Austenitic and duplex grades' },
  { id: 'EN 1993-1-4', year: 2015, publisher: 'CEN', topic: 'materials', title: 'Eurocode 3 — Part 1-4: Supplementary rules for stainless steels (incl. A1)', scope: 'Table 2.1 nominal fy/fu for C, H, P product forms; E = 200 GPa' },
  { id: 'EN 755-2', year: 2016, publisher: 'CEN', topic: 'materials', title: 'Aluminium and aluminium alloys — Extruded rod/bar, tube and profiles — Part 2: Mechanical properties', scope: 'EN AW-6060/6063/6082/6005A minimum Rp0.2 and Rm (a 2025 edition exists; check for changes)' },
  { id: 'EN 1999-1-1', year: 2007, publisher: 'CEN', topic: 'materials', title: 'Eurocode 9 — Design of aluminium structures — Part 1-1: General structural rules', scope: 'E = 70 GPa, α = 23e-6/K, f0/fu Table 3.2b' },
  { id: 'ASTM A36', publisher: 'ASTM', topic: 'materials', title: 'Carbon Structural Steel', scope: 'Fy 36 ksi, Fu 58 ksi' },
  { id: 'ASTM A572', publisher: 'ASTM', topic: 'materials', title: 'High-Strength Low-Alloy Columbium-Vanadium Structural Steel', scope: 'Grade 50' },
  { id: 'ASTM A992', publisher: 'ASTM', topic: 'materials', title: 'Structural Steel Shapes', scope: 'W shapes, Fy 50 ksi' },
  { id: 'ASTM A1085', publisher: 'ASTM', topic: 'materials', title: 'Cold-Formed Welded Carbon Steel Hollow Structural Sections (HSS)', scope: 'Fy 50 ksi, tight wall tolerance (tdes = tnom)' },
  { id: 'ASTM A588', publisher: 'ASTM', topic: 'materials', title: 'High-Strength Low-Alloy Structural Steel with atmospheric corrosion resistance', scope: 'Weathering steel, Fy 50 ksi' },
  { id: 'ASTM A847', publisher: 'ASTM', topic: 'materials', title: 'Cold-Formed Welded and Seamless HSLA Structural Tubing with Improved Atmospheric Corrosion Resistance', scope: 'Weathering HSS' },
  { id: 'ASTM A240', publisher: 'ASTM', topic: 'materials', title: 'Chromium and Chromium-Nickel Stainless Steel Plate, Sheet, and Strip', scope: 'Types 304, 304L, 316, 316L' },

  // Fasteners
  { id: 'ISO 4014', year: 2022, publisher: 'ISO', topic: 'fasteners', title: 'Hexagon head bolts — Product grades A and B', scope: 'Head height k, across flats s' },
  { id: 'ISO 4017', year: 2022, publisher: 'ISO', topic: 'fasteners', title: 'Hexagon head screws (fully threaded) — Product grades A and B', scope: 'Head height k, across flats s' },
  { id: 'ISO 4032', year: 2023, publisher: 'ISO', topic: 'fasteners', title: 'Hexagon regular nuts (style 1)', scope: 'Nut height m' },
  { id: 'ISO 7089', year: 2000, publisher: 'ISO', topic: 'fasteners', title: 'Plain washers — Normal series — Product grade A', scope: 'Washer thickness h, outside diameter d2' },
  { id: 'ISO 898-1', year: 2013, publisher: 'ISO', topic: 'fasteners', title: 'Mechanical properties of fasteners made of carbon steel and alloy steel — Part 1: Bolts, screws and studs', scope: 'Property classes 4.6–10.9' },
  { id: 'ISO 3506-1', year: 2020, publisher: 'ISO', topic: 'fasteners', title: 'Fasteners — Mechanical properties of corrosion-resistant stainless steel fasteners — Part 1', scope: 'A2/A4 classes 50, 70, 80' },
  { id: 'EN 14399-4', year: 2015, publisher: 'CEN', topic: 'fasteners', title: 'High-strength structural bolting assemblies for preloading — Part 4: System HV', scope: 'HV bolt and nut dimensions' },
  { id: 'EN 14399-6', year: 2015, publisher: 'CEN', topic: 'fasteners', title: 'High-strength structural bolting assemblies for preloading — Part 6: Plain chamfered washers', scope: 'HV washer dimensions' },
  { id: 'ASTM F3125', publisher: 'ASTM', topic: 'fasteners', title: 'High Strength Structural Bolts and Assemblies, Steel and Alloy Steel', scope: 'Grades A325 (120 ksi) and A490 (150 ksi)' },
  { id: 'ASME B18.2.6', publisher: 'ASME', topic: 'fasteners', title: 'Fasteners for Use in Structural Applications', scope: 'Heavy hex structural bolt, nut and washer dimensions' },
  { id: 'ASTM F1554', publisher: 'ASTM', topic: 'fasteners', title: 'Anchor Bolts, Steel, 36, 55, and 105-ksi Yield Strength', scope: 'Anchor rod grades' },
  { id: 'ASTM A307', publisher: 'ASTM', topic: 'fasteners', title: 'Carbon Steel Bolts, Studs, and Threaded Rod 60 000 PSI Tensile Strength', scope: 'Grade A' },
  { id: 'ISO 15480', publisher: 'ISO', topic: 'fasteners', title: 'Hexagon washer head drilling screws with tapping screw thread', scope: 'ST4.2–ST6.3 head dimensions' },

  // Execution / design
  { id: 'EN 1090-2', year: 2018, publisher: 'CEN', topic: 'execution', title: 'Execution of steel structures and aluminium structures — Part 2: Technical requirements for steel structures', scope: 'Table 11 hole clearances (normal, oversize, slotted)' },
  { id: 'AISC 360', year: 2016, publisher: 'AISC', topic: 'design', title: 'Specification for Structural Steel Buildings (ANSI/AISC 360-16; Table J3.3 unchanged in 360-22)', scope: 'Table J3.3 nominal hole dimensions; B4.2 design wall thickness' },
  { id: 'EN 1993-1-1', year: 2005, publisher: 'CEN', topic: 'design', title: 'Eurocode 3 — Design of steel structures — Part 1-1: General rules', scope: 'Table 3.1 nominal fy/fu; E = 210 GPa' },
  { id: 'EN 1993-1-8', year: 2005, publisher: 'CEN', topic: 'design', title: 'Eurocode 3 — Part 1-8: Design of joints', scope: 'Bolt classes fyb/fub (Table 3.1)' },

  // Anchors
  { id: 'EN 1992-4', year: 2018, publisher: 'CEN', topic: 'anchors', title: 'Eurocode 2 — Part 4: Design of fastenings for use in concrete', scope: 'Fixture clearance holes (Table 6.1), s_cr,N = 3 h_ef, c_cr,N = 1.5 h_ef' },
  { id: 'ACI 318', year: 2019, publisher: 'ACI', topic: 'anchors', title: 'Building Code Requirements for Structural Concrete (ACI 318-19), Chapter 17', scope: 'Anchoring to concrete; minimum spacing/edge distances (17.9)' },
  { id: 'EAD 330232', publisher: 'EOTA', topic: 'anchors', title: 'Mechanical fasteners for use in concrete', scope: 'Expansion, undercut and concrete screw anchors (ETA basis)' },
  { id: 'EAD 330499', publisher: 'EOTA', topic: 'anchors', title: 'Bonded fasteners for use in concrete', scope: 'Injection mortar systems with threaded rod (ETA basis)' },
  { id: 'EAD 330008', publisher: 'EOTA', topic: 'anchors', title: 'Anchor channels', scope: 'Cast-in anchor channels with channel bolts (ETA basis)' },
  { id: 'AISC DG1', publisher: 'AISC', topic: 'anchors', title: 'Design Guide 1: Base Connection Design for Steel Structures', scope: 'Anchor rod holes, embedment and edge distance recommendations' },
];

const byId = new Map(STANDARD_DOCS.map((d) => [d.id, d]));

export function getStandardDoc(id: string): StandardDoc | undefined {
  return byId.get(id.trim());
}

/** Documents referenced by a spec string such as "EN 10219-2 / EN 10210-2" or "ISO 4014/4017 + ISO 4032 + ISO 7089". */
export function standardsFor(spec: string | undefined): StandardDoc[] {
  if (!spec) return [];
  const out: StandardDoc[] = [];
  for (const raw of spec.split(/\s+[/+]\s+|,\s*/)) {
    const part = raw.trim();
    const direct = byId.get(part);
    if (direct) {
      out.push(direct);
      continue;
    }
    // "ISO 4014/4017" → ISO 4014, ISO 4017; "ASTM F3125 Gr A325" → ASTM F3125
    const m = part.match(/^([A-Z]+(?:\s[A-Z]+)?)\s([\w.-]+(?:\/[\w.-]+)*)/);
    if (!m) continue;
    for (const num of m[2].split('/')) {
      const d = byId.get(`${m[1]} ${num}`);
      if (d) out.push(d);
    }
  }
  return [...new Set(out)];
}
