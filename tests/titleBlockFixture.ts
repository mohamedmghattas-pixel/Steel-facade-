/**
 * A synthetic company title block as ASCII DXF (written here, no client files):
 * 180 × 50 mm, drawn in inches ($INSUNITS 1) at an offset from the origin, with
 * - linework: outer border (LWPOLYLINE, 0.7 mm), cell lines (LINE, 0.35 mm), an ARC,
 *   a CIRCLE, an ELLIPSE, a SOLID triangle and a solid-fill HATCH;
 * - fixed labels (TEXT), placeholders ({PROJECT}, {DRAWING_NO}, "Scale {SCALE}"),
 *   MTEXT with formatting codes ({TITLE} in bold, two fixed lines, two lines with
 *   placeholders);
 * - a block with ATTDEFs inserted with ATTRIB values (DRAWN_BY, CHECKED, an unknown tag,
 *   a constant attribute), a block with an ATTDEF inserted without ATTRIBs (SHEET),
 *   a mirrored block (scale x −1) and an IMAGE frame for the logo.
 *
 * Plain TypeScript without imports, so a browser check can run it with
 * `node --experimental-strip-types`.
 */
export interface TitleBlockFixtureOptions {
  /** Write $INSUNITS / $MEASUREMENT (default true). */
  units?: boolean;
  /** Drawing units per mm (default 1 / 25.4: inches). */
  perMm?: number;
}

export function titleBlockFixtureDxf(o: TitleBlockFixtureOptions = {}): string {
  const k = o.perMm ?? 1 / 25.4;
  const OX = 100;
  const OY = 50;
  const out: string[] = [];
  const g = (code: number, v: string | number) => out.push(String(code), String(v));
  const X = (mm: number) => (mm + OX) * k;
  const Y = (mm: number) => (mm + OY) * k;
  const L = (mm: number) => mm * k;
  const ent = (type: string, ...pairs: [number, string | number][]) => {
    g(0, type);
    for (const [c, v] of pairs) g(c, v);
  };
  const line = (x1: number, y1: number, x2: number, y2: number, lw = 35, X0 = X, Y0 = Y) => ent('LINE', [8, 'TB-LINES'], [370, lw], [10, X0(x1)], [20, Y0(y1)], [30, 0], [11, X0(x2)], [21, Y0(y2)], [31, 0]);
  const text = (x: number, y: number, h: number, s: string, extra: [number, string | number][] = [], X0 = X, Y0 = Y) => ent('TEXT', [8, 'TB-TEXT'], [10, X0(x)], [20, Y0(y)], [30, 0], [40, L(h)], [1, s], ...extra);
  const mtext = (x: number, y: number, h: number, attach: number, s: string) => ent('MTEXT', [8, 'TB-TEXT'], [10, X(x)], [20, Y(y)], [30, 0], [40, L(h)], [41, 0], [71, attach], [72, 1], [1, s]);
  const local = (mm: number) => mm * k;

  g(0, 'SECTION');
  g(2, 'HEADER');
  g(9, '$ACADVER');
  g(1, 'AC1015');
  if (o.units !== false) {
    g(9, '$INSUNITS');
    g(70, 1);
    g(9, '$MEASUREMENT');
    g(70, 0);
  }
  g(0, 'ENDSEC');

  g(0, 'SECTION');
  g(2, 'BLOCKS');
  // Attributes of the "created / checked" row.
  ent('BLOCK', [8, '0'], [2, 'TB_ATTR'], [70, 2], [10, 0], [20, 0], [30, 0], [3, 'TB_ATTR']);
  ent('LINE', [8, '0'], [10, local(30)], [20, 0], [30, 0], [11, local(30)], [21, local(8)], [31, 0]);
  const attdef = (x: number, y: number, h: number, tag: string, def: string, flags = 0) =>
    ent('ATTDEF', [8, '0'], [10, local(x)], [20, local(y)], [30, 0], [40, local(h)], [1, def], [3, tag.toLowerCase()], [2, tag], [70, flags]);
  attdef(1, 1, 2.5, 'DRAWN_BY', 'XX');
  attdef(31, 1, 2.5, 'CHECKED', 'XX');
  attdef(61, 1, 2.5, 'UNKNOWN_TAG', 'Fixed value');
  attdef(1, 5, 1.8, 'CONST', 'ISO 7200', 2);
  ent('ENDBLK', [8, '0']);
  // The sheet number box: an ATTDEF only (inserted without ATTRIBs).
  ent('BLOCK', [8, '0'], [2, 'SHEETBOX'], [70, 2], [10, 0], [20, 0], [30, 0], [3, 'SHEETBOX']);
  ent('LINE', [8, '0'], [10, 0], [20, 0], [30, 0], [11, 0], [21, local(10)], [31, 0]);
  attdef(2, 2, 2.5, 'SHEET', '1/1');
  ent('ENDBLK', [8, '0']);
  // A mark: a line and a text, inserted mirrored.
  ent('BLOCK', [8, '0'], [2, 'MARK'], [70, 0], [10, 0], [20, 0], [30, 0], [3, 'MARK']);
  ent('LINE', [8, '0'], [10, 0], [20, 0], [30, 0], [11, local(10)], [21, 0], [31, 0]);
  ent('TEXT', [8, '0'], [10, 0], [20, local(1)], [30, 0], [40, local(2.5)], [1, 'MK']);
  ent('ENDBLK', [8, '0']);
  g(0, 'ENDSEC');

  g(0, 'SECTION');
  g(2, 'ENTITIES');
  // Outer border (0.7 mm).
  ent('LWPOLYLINE', [8, 'TB-BORDER'], [370, 70], [90, 4], [70, 1], [10, X(0)], [20, Y(0)], [10, X(180)], [20, Y(0)], [10, X(180)], [20, Y(50)], [10, X(0)], [20, Y(50)]);
  line(0, 10, 180, 10);
  line(0, 30, 180, 30);
  line(60, 0, 60, 30);
  line(120, 0, 120, 10);
  line(90, 30, 90, 50);
  ent('ARC', [8, 'TB-LOGO'], [10, X(20)], [20, Y(40)], [30, 0], [40, L(6)], [50, 0], [51, 180]);
  ent('CIRCLE', [8, 'TB-LOGO'], [10, X(20)], [20, Y(40)], [30, 0], [40, L(4)]);
  ent('ELLIPSE', [8, 'TB-LOGO'], [10, X(45)], [20, Y(40)], [30, 0], [11, L(8)], [21, 0], [31, 0], [210, 0], [220, 0], [230, 1], [40, 0.5], [41, 0], [42, 2 * Math.PI]);
  ent('SOLID', [8, 'TB-LOGO'], [10, X(170)], [20, Y(42)], [30, 0], [11, X(178)], [21, Y(42)], [31, 0], [12, X(174)], [22, Y(48)], [32, 0], [13, X(174)], [23, Y(48)], [33, 0]);
  ent(
    'HATCH',
    [8, 'TB-LOGO'],
    [10, 0],
    [20, 0],
    [30, 0],
    [210, 0],
    [220, 0],
    [230, 1],
    [2, 'SOLID'],
    [70, 1],
    [71, 0],
    [91, 1],
    [92, 2],
    [72, 0],
    [73, 1],
    [93, 4],
    [10, X(160)],
    [20, Y(42)],
    [10, X(166)],
    [20, Y(42)],
    [10, X(166)],
    [20, Y(48)],
    [10, X(160)],
    [20, Y(48)],
    [97, 0],
    [75, 0],
    [76, 1],
    [98, 0],
  );
  // Labels (fixed) and placeholders.
  text(2, 46, 1.8, 'PROJECT');
  text(2, 33, 3.5, '{PROJECT}');
  text(62, 7.5, 1.8, 'DRAWING No.');
  text(62, 2, 5, '{Drawing_No}');
  text(0, 0, 2.5, 'Scale {SCALE}', [
    [72, 1],
    [11, X(135)],
    [21, Y(2)],
    [31, 0],
  ]);
  text(152, 7.5, 1.8, 'SHEET');
  mtext(62, 28, 3.5, 1, '{\\fArial|b1|i0|c0|p34;\\{TITLE\\}}');
  mtext(92, 48, 2.5, 1, 'ACME Facades Ltd\\P{\\H0.8x;London}');
  mtext(140, 22, 2.5, 7, 'Client: {CLIENT}\\PRev {REV}');
  // Created / checked row: block with attributes.
  ent('INSERT', [8, 'TB-ATTR'], [66, 1], [2, 'TB_ATTR'], [10, X(0)], [20, Y(10)], [30, 0]);
  const attrib = (x: number, y: number, h: number, tag: string, v: string) => ent('ATTRIB', [8, '0'], [10, X(x)], [20, Y(y)], [30, 0], [40, L(h)], [1, v], [2, tag], [70, 0]);
  attrib(1, 11, 2.5, 'DRAWN_BY', 'MG');
  attrib(31, 11, 2.5, 'CHECKED', 'AB');
  attrib(61, 11, 2.5, 'UNKNOWN_TAG', 'Some text');
  ent('SEQEND', [8, '0']);
  // Sheet box (ATTDEF only) and a mirrored mark.
  ent('INSERT', [8, 'TB-ATTR'], [2, 'SHEETBOX'], [10, X(150)], [20, Y(0)], [30, 0]);
  ent('INSERT', [8, 'TB-MARK'], [2, 'MARK'], [10, X(100)], [20, Y(15)], [30, 0], [41, -1], [42, 1]);
  // The logo: an image (external file in DXF) 30 × 16 mm.
  ent('IMAGE', [8, 'TB-LOGO'], [10, X(125)], [20, Y(32)], [30, 0], [11, L(0.1)], [21, 0], [31, 0], [12, 0], [22, L(0.1)], [32, 0], [13, 300], [23, 160]);
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return out.join('\n') + '\n';
}

/** A plain 180 × 40 mm title block in millimetres: the ISO 7200 size, with a few fields. */
export function isoSizeTitleBlockDxf(): string {
  const out: string[] = [];
  const g = (code: number, v: string | number) => out.push(String(code), String(v));
  const ent = (type: string, ...pairs: [number, string | number][]) => {
    g(0, type);
    for (const [c, v] of pairs) g(c, v);
  };
  g(0, 'SECTION');
  g(2, 'HEADER');
  g(9, '$INSUNITS');
  g(70, 4);
  g(0, 'ENDSEC');
  g(0, 'SECTION');
  g(2, 'ENTITIES');
  ent('LWPOLYLINE', [8, '0'], [90, 4], [70, 1], [10, 0], [20, 0], [10, 180], [20, 0], [10, 180], [20, 40], [10, 0], [20, 40]);
  ent('LINE', [8, '0'], [10, 0], [20, 20], [30, 0], [11, 180], [21, 20], [31, 0]);
  ent('TEXT', [8, '0'], [10, 2], [20, 2], [30, 0], [40, 5], [1, '{DWG_NO}']);
  ent('TEXT', [8, '0'], [10, 2], [20, 24], [30, 0], [40, 3.5], [1, '<TITLE>']);
  ent('TEXT', [8, '0'], [10, 120], [20, 2], [30, 0], [40, 2.5], [1, 'Sheet [SHEET_N] of [SHEETS]']);
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return out.join('\n') + '\n';
}

/**
 * A whole drawing sheet exported from a detailing package (synthetic): blocks for the
 * frame, a view with dimensions, a part list at the top and the title block — a strip
 * 790 × 80 mm along the bottom with a logo cell (an OLE2FRAME "Paintbrush Picture"
 * holding a 4 × 2 px bitmap, its frame running over the cell), a revision table
 * (REV / ACTION / DATE header at the bottom, five rows above) and filled-in cells:
 * label and value in one cell (JOB NAME, PROJECT NO., DRAWN BY, DRAWING TITLE, REV.,
 * PART NO.) and SHEET with no value. Millimetres ($INSUNITS 4).
 */
export function sheetTitleBlockDxf(): string {
  const out: string[] = [];
  const g = (code: number, v: string | number) => out.push(String(code), String(v));
  const ent = (type: string, ...pairs: [number, string | number][]) => {
    g(0, type);
    for (const [c, v] of pairs) g(c, v);
  };
  const line = (x1: number, y1: number, x2: number, y2: number) => ent('LINE', [8, '0'], [10, x1], [20, y1], [30, 0], [11, x2], [21, y2], [31, 0]);
  const text = (x: number, y: number, h: number, s: string, rot = 0) => ent('TEXT', [8, '0'], [10, x], [20, y], [30, 0], [40, h], [1, s], ...(rot ? ([[50, rot]] as [number, number][]) : []));
  const rect = (x0: number, y0: number, x1: number, y1: number) => {
    line(x0, y0, x1, y0);
    line(x1, y0, x1, y1);
    line(x1, y1, x0, y1);
    line(x0, y1, x0, y0);
  };
  const block = (name: string, body: () => void) => {
    ent('BLOCK', [8, '0'], [2, name], [70, 0], [10, 0], [20, 0], [30, 0], [3, name]);
    body();
    ent('ENDBLK', [8, '0']);
  };
  // A 4 × 2 px 24-bit bitmap: red, green, blue, white / black, grey, yellow, cyan (rows bottom up).
  const bmp = (() => {
    const w = 4;
    const h = 2;
    const stride = 12;
    const px = [
      [0, 0, 0, 128, 128, 128, 0, 255, 255, 255, 255, 0], // bottom row (BGR): black, grey, yellow, cyan
      [0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255], // top row: red, green, blue, white
    ];
    const size = 54 + stride * h;
    const b: number[] = [0x42, 0x4d, ...le(size, 4), 0, 0, 0, 0, ...le(54, 4), ...le(40, 4), ...le(w, 4), ...le(h, 4), ...le(1, 2), ...le(24, 2), ...le(0, 4), ...le(stride * h, 4), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const r of px) b.push(...r);
    return b;
  })();
  // OLE header bytes (any), then the compound-file signature and the bitmap.
  const ole = [0x80, 0x55, 0x01, 0x02, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...Array.from({ length: 40 }, (_, i) => (i * 7) & 0xff), ...bmp, 0, 0, 0, 0];
  const hex = ole.map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join('');

  g(0, 'SECTION');
  g(2, 'HEADER');
  g(9, '$ACADVER');
  g(1, 'AC1032');
  g(9, '$INSUNITS');
  g(70, 4);
  g(0, 'ENDSEC');
  g(0, 'SECTION');
  g(2, 'BLOCKS');
  block('SHEET_FRAME', () => {
    rect(5, 0, 800, 560);
    text(2, 2, 4, 'CAD system', 90);
  });
  block('VIEW_FRONT', () => {
    rect(100, 250, 500, 400);
    line(100, 240, 500, 240);
    text(290, 242, 7, '5596');
    text(260, 230, 8, 'FRONT VIEW');
  });
  block('PART_LIST', () => {
    rect(5, 520, 305, 560);
    line(5, 540, 305, 540);
    text(10, 545, 6, 'MARK');
    text(80, 545, 6, 'QTY');
    text(140, 545, 6, 'PROFILE');
    text(10, 525, 6, 'L09-X');
    text(80, 525, 6, '138');
  });
  block('COMPANY_TB', () => {
    rect(10, 0, 800, 80);
    // Logo cell, revision table, job, names / title, sheet / rev / part no.
    line(150, 0, 150, 80);
    line(170, 0, 170, 80);
    line(290, 0, 290, 80);
    line(330, 0, 330, 80);
    for (const y of [12, 24, 36, 48, 60]) line(150, y, 330, y);
    text(152, 4, 4, 'REV');
    text(175, 4, 4, 'ACTION');
    text(295, 4, 4, 'DATE');
    line(330, 30, 550, 30);
    text(335, 70, 4, 'JOB NAME:');
    text(380, 45, 6, 'Demo Tower');
    text(335, 20, 4, 'PROJECT NO.');
    text(420, 10, 5, 'P-100');
    line(550, 0, 550, 80);
    line(550, 40, 800, 40);
    text(555, 70, 4, 'DRAWN BY:');
    text(600, 50, 3, 'J.D');
    text(555, 30, 4, 'DRAWING TITLE:');
    text(580, 10, 4, 'BRACKET');
    line(680, 0, 680, 80);
    line(740, 40, 740, 80);
    text(685, 70, 4, 'SHEET');
    text(745, 70, 4, 'REV.');
    text(770, 50, 8, '0');
    text(685, 30, 4, 'PART NO.');
    text(700, 10, 4, 'M1');
    // The logo: upper-left and lower-right corners, running above the strip.
    g(0, 'OLE2FRAME');
    g(8, '0');
    g(70, 2);
    g(3, 'Paintbrush Picture');
    g(10, 20);
    g(20, 90);
    g(30, 0);
    g(11, 140);
    g(21, 10);
    g(31, 0);
    g(71, 2);
    g(72, 1);
    g(73, 2);
    g(90, ole.length);
    for (let i = 0; i < hex.length; i += 254) g(310, hex.slice(i, i + 254));
    g(1, 'OLE');
  });
  g(0, 'ENDSEC');
  g(0, 'SECTION');
  g(2, 'ENTITIES');
  for (const b of ['SHEET_FRAME', 'VIEW_FRONT', 'PART_LIST', 'COMPANY_TB']) ent('INSERT', [8, '0'], [2, b], [10, 0], [20, 0], [30, 0]);
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return out.join('\n');
}

function le(v: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => (v >>> (8 * i)) & 0xff);
}
