/**
 * Drawing set bookkeeping: identification numbers, cross-references between GA,
 * assembly and part drawings, and revision status (ISO 7200 revision index and
 * document status).
 */
import type { DocStatus, DrawingRevision, Project } from '../model/types';
import { uniqueAssemblies, type DerivedModel } from '../derive/model';
import type { DEnt } from './types';

export function numberPrefix(p: Project): string {
  return (p.drawings.settings.numberPrefix || p.info.number || 'DWG').trim().replace(/\s+/g, '-');
}

export const GA_VIEWS = ['front', 'plan', 'side'] as const;

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * ISO 7200 identification number of a sheet. Sheets numbered by their place in
 * a generated series (setting-out plans, erection sequences) get their number
 * from the generator; this covers the ones derivable from the id.
 */
export function drawingNumber(p: Project, id: string): string {
  const pre = numberPrefix(p);
  if (id.startsWith('register-')) return `${pre}-DR-${id.slice(9).padStart(2, '0')}`;
  if (id.startsWith('ga-')) return `${pre}-GA-${String(GA_VIEWS.indexOf(id.slice(3) as (typeof GA_VIEWS)[number]) + 1).padStart(2, '0')}`;
  if (id.startsWith('asm-')) return `${pre}-A-${id.slice(4)}`;
  if (id.startsWith('part-')) return `${pre}-P-${id.slice(5)}`;
  if (id.startsWith('anchors-')) return `${pre}-AS-${pad2(Number(id.slice(8)) || 1)}`;
  if (id.startsWith('cut-')) {
    const i = (p.drawings.cuts ?? []).findIndex((c) => c.id === id.slice(4));
    return `${pre}-SD-${pad2(i + 1)}`;
  }
  return `${pre}-${id}`;
}

/**
 * Identification number with the sheet of a multi-sheet drawing, as listed in the
 * register: "FS-001-ES-01 (2/3)". Sheets of one drawing share the identification
 * number (ISO 7200) and are told apart by the sheet number.
 */
export function sheetLabel(d: { number: string; sheetIndex?: number; sheetCount?: number }): string {
  return d.sheetCount && d.sheetCount > 1 ? `${d.number} (${d.sheetIndex}/${d.sheetCount})` : d.number;
}

/** File name stem of a sheet: the identification number, plus "_sh2" for sheet 2 of a multi-sheet drawing. */
export function sheetFileStem(d: { number: string; sheetIndex?: number; sheetCount?: number }): string {
  return d.sheetCount && d.sheetCount > 1 ? `${d.number}_sh${d.sheetIndex}` : d.number;
}

/** Series numbers: "<prefix>-E-01", "<prefix>-ES-03" … */
export function seriesNumber(p: Project, code: string, n: number): string {
  return `${numberPrefix(p)}-${code}-${pad2(n)}`;
}

export interface UsedIn {
  assembly: string;
  perAssembly: number;
  assemblies: number;
}

/** For every part mark: the assemblies it belongs to, with quantities. */
export function partUsage(dm: DerivedModel): Map<string, UsedIn[]> {
  const out = new Map<string, UsedIn[]>();
  for (const { assembly, qty } of uniqueAssemblies(dm)) {
    const counts = new Map<string, number>();
    for (const r of assembly.parts) {
      const m = dm.partByRef.get(r)?.mark;
      if (m) counts.set(m, (counts.get(m) ?? 0) + 1);
    }
    for (const [mark, n] of counts) {
      const arr = out.get(mark) ?? [];
      arr.push({ assembly: assembly.mark, perAssembly: n, assemblies: qty });
      out.set(mark, arr);
    }
  }
  return out;
}

/** FNV-1a hash of the drawing content (rounded coordinates). */
export function fingerprint(ents: DEnt[]): string {
  const r = (v: number) => Math.round(v * 100);
  let h = 0x811c9dc5;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  for (const e of ents) {
    switch (e.t) {
      case 'line':
        feed(`l${e.layer}${r(e.a.x)},${r(e.a.y)},${r(e.b.x)},${r(e.b.y)}`);
        break;
      case 'circle':
        feed(`c${e.layer}${r(e.c.x)},${r(e.c.y)},${r(e.r)}`);
        break;
      case 'poly':
        feed(`p${e.layer}${e.pts.map((q) => `${r(q.x)},${r(q.y)}`).join(';')}`);
        break;
      case 'text':
        feed(`t${r(e.p.x)},${r(e.p.y)}${e.text}`);
        break;
      case 'image':
        feed(`i${r(e.p.x)},${r(e.p.y)},${r(e.w)},${r(e.h)},${e.href.length}${e.href.slice(-64)}`);
        break;
    }
  }
  return h.toString(16).padStart(8, '0');
}

export interface RevisionState {
  rev: string;
  status: DocStatus;
  date: string;
  revisions: DrawingRevision[];
  changed: boolean;
}

export function revisionState(p: Project, id: string, fp: string): RevisionState {
  const revisions = p.drawings.revisions[id] ?? [];
  const last = revisions[revisions.length - 1];
  const changed = !last || last.fingerprint !== fp;
  return {
    rev: last ? last.rev : '-',
    status: !last ? 'In preparation' : changed && last.status !== 'Withdrawn' ? 'In preparation' : last.status,
    date: last?.date ?? '—',
    revisions,
    changed,
  };
}

/** Next revision index: A, B … Z, AA, AB … (ISO 7200) or 0, 1, 2 … */
export function nextRev(prev: string | undefined, scheme: 'alpha' | 'numeric'): string {
  if (!prev || prev === '-') return scheme === 'alpha' ? 'A' : '0';
  if (scheme === 'numeric' || /^\d+$/.test(prev)) return String((Number(prev) || 0) + 1);
  const chars = prev.split('');
  let i = chars.length - 1;
  while (i >= 0) {
    if (chars[i] !== 'Z') {
      chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
      return chars.join('');
    }
    chars[i] = 'A';
    i--;
  }
  return `A${chars.join('')}`;
}

export interface IssueInfo {
  description: string;
  status: DocStatus;
  date: string;
  drawn: string;
  checked: string;
  approved: string;
}

/** Record a new revision for each drawing (mutates the project draft). Returns the number issued. */
export function issueDrawings(p: Project, drawings: { id: string; fingerprint: string }[], info: IssueInfo): number {
  let n = 0;
  for (const d of drawings) {
    const list = (p.drawings.revisions[d.id] ??= []);
    const last = list[list.length - 1];
    list.push({ rev: nextRev(last?.rev, p.drawings.settings.revisionScheme), fingerprint: d.fingerprint, ...info });
    n++;
  }
  return n;
}
