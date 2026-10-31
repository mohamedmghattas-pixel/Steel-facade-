/**
 * DWG handling. There is no permissively licensed DWG reader for the browser
 * (LibreDWG is GPL-3.0 and is deliberately not bundled), so FacadeSteel
 * recognises DWG files by their header, reports the AutoCAD release and
 * explains how to convert them to DXF. A licensed converter (e.g. ODA
 * Drawings SDK, a server endpoint) can be plugged in with registerDwgConverter.
 */

export interface DwgInfo {
  /** Header version string, e.g. "AC1032". */
  version: string;
  /** AutoCAD release(s) that write this format. */
  release: string;
  /** Whether the version is one we know. */
  known: boolean;
}

/** DWG version strings → AutoCAD releases. */
export const DWG_VERSIONS: Record<string, string> = {
  MC0_0: 'AutoCAD 1.0',
  AC1_2: 'AutoCAD 1.2',
  AC1_4: 'AutoCAD 1.4',
  AC1_50: 'AutoCAD 2.0',
  AC2_10: 'AutoCAD 2.10',
  AC1001: 'AutoCAD 2.2',
  AC1002: 'AutoCAD 2.5',
  AC1003: 'AutoCAD 2.6',
  AC1004: 'AutoCAD R9',
  AC1006: 'AutoCAD R10',
  AC1009: 'AutoCAD R11 / R12',
  AC1012: 'AutoCAD R13',
  AC1014: 'AutoCAD R14',
  AC1015: 'AutoCAD 2000 / 2000i / 2002',
  AC1018: 'AutoCAD 2004 / 2005 / 2006',
  AC1021: 'AutoCAD 2007 / 2008 / 2009',
  AC1024: 'AutoCAD 2010 / 2011 / 2012',
  AC1027: 'AutoCAD 2013 – 2017',
  AC1032: 'AutoCAD 2018 – 2025',
};

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, Math.min(to, b.length)));

/** DWG header detection: files start with a 6-character version string ("AC10xx", older "AC1.2" / "MC0.0"). */
export function detectDwg(bytes: Uint8Array | ArrayBuffer): DwgInfo | null {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 6) return null;
  const head = ascii(b, 0, 6);
  if (/^AC10\d\d$/.test(head)) {
    const release = DWG_VERSIONS[head];
    return { version: head, release: release ?? 'a newer AutoCAD release', known: !!release };
  }
  const old = head.replace('.', '_');
  if (/^(AC1_2|AC1_4|AC1_50|AC2_10|MC0_0)/.test(old)) {
    const key = Object.keys(DWG_VERSIONS).find((k) => old.startsWith(k))!;
    return { version: head.replace(/\0.*$/, ''), release: DWG_VERSIONS[key], known: true };
  }
  return null;
}

/** Binary DXF (not supported by the DXF reader either): "AutoCAD Binary DXF\r\n\x1a\0". */
export function isBinaryDxf(bytes: Uint8Array | ArrayBuffer): boolean {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return ascii(b, 0, 18) === 'AutoCAD Binary DXF';
}

/** A DWG → DXF converter (licensed library, desktop helper, server endpoint…). */
export interface DwgConverter {
  name: string;
  /** Whether this converter reads the given DWG version. */
  supports(info: DwgInfo): boolean;
  /** DXF text of the drawing. */
  toDxf(bytes: Uint8Array, info: DwgInfo): Promise<string>;
}

const converters: DwgConverter[] = [];

export function registerDwgConverter(c: DwgConverter): () => void {
  converters.push(c);
  return () => {
    const i = converters.indexOf(c);
    if (i >= 0) converters.splice(i, 1);
  };
}

export function dwgConverterFor(info: DwgInfo): DwgConverter | undefined {
  return converters.find((c) => c.supports(info));
}

export class DwgNotSupportedError extends Error {
  constructor(readonly info: DwgInfo) {
    super(`${info.version} (${info.release}) DWG files cannot be read in the browser. Save the drawing as DXF and import that.`);
    this.name = 'DwgNotSupportedError';
  }
}

/** Convert with a registered converter, or throw DwgNotSupportedError (show dwgConversionHelp). */
export async function convertDwg(bytes: Uint8Array): Promise<string> {
  const info = detectDwg(bytes);
  if (!info) throw new Error('Not a DWG file.');
  const c = dwgConverterFor(info);
  if (!c) throw new DwgNotSupportedError(info);
  return c.toDxf(bytes, info);
}

/** Step-by-step conversion guidance shown to the user. */
export function dwgConversionHelp(info: DwgInfo): { title: string; intro: string; steps: { tool: string; how: string }[]; note: string } {
  return {
    title: `DWG file (${info.version}, ${info.release})`,
    intro:
      'FacadeSteel reads DXF, the open exchange format of the same drawing. DWG is a closed format and the only browser DWG reader is GPL-licensed, so it is not included. Convert the file to DXF with any of these, then import the DXF:',
    steps: [
      {
        tool: 'ODA File Converter (free, Windows / macOS / Linux)',
        how: 'Open Design Alliance → ODA File Converter. Choose the input folder, output version "ACAD2018", output type "DXF" (ASCII), then Start. Batch-converts whole folders.',
      },
      { tool: 'AutoCAD / AutoCAD LT', how: 'Open the drawing → Save As → "AutoCAD 2018 DXF (*.dxf)". Use WBLOCK first to export only the facade linework.' },
      { tool: 'BricsCAD', how: 'File → Save As → file type "DXF 2018 (*.dxf)".' },
      { tool: 'DraftSight / progeCAD / ZWCAD', how: 'File → Save As → choose a DXF type (ASCII, R2000 or newer).' },
    ],
    note: 'Use millimetres or set $INSUNITS so the import picks the right scale. Explode blocks and xrefs you want as lines (the importer reads LINE, LWPOLYLINE and POLYLINE).',
  };
}
