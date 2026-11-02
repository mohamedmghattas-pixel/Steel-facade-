/**
 * Rendered PDF pages, reused (docs/EXPORT_PACKAGE.md, "Drawing PDFs").
 *
 * A drawing sheet is painted once (SVG → svg2pdf.js → a one-page jsPDF document)
 * and its page is lifted out of that PDF: the compressed content stream and every
 * object its resources refer to (fonts, images, graphic states). Any number of
 * PDFs is then assembled from such pages without painting again: the per-sheet
 * file, the combined set and the group books. Identical objects (the standard
 * fonts, a logo) are written once per file.
 *
 * The parser reads the regular structure jsPDF writes (classic xref table,
 * direct stream lengths); pages it cannot read are reported as errors so the
 * caller can paint them the usual way.
 */
import { sheetsToPdf, bookmarkText, PdfCancelled, type PdfSheet, type SvgPainter } from './pdfBook';

/** A page lifted out of a PDF: content stream, resources and the objects they refer to. */
export interface PdfPage {
  /** MediaBox in points ("[0 0 w h]") and its size. */
  box: string;
  w: number;
  h: number;
  /** Content stream as stored (compressed) and its dictionary entries besides /Length. */
  content: Uint8Array;
  contentDict: string;
  /** The page's resource dictionary; references to `objs[i]` are written `#i#`. */
  resources: string;
  /** Further page dictionary entries (annotations, groups …), references as in `resources`. */
  extra: string;
  /** Objects the resources (and their objects) refer to. */
  objs: PdfObject[];
  /** Approximate heap size (bytes). */
  bytes: number;
}

export interface PdfObject {
  /** Dictionary (or other value) text; references to other objects of the page written `#i#`. */
  dict: string;
  stream?: Uint8Array;
}

// ---------------------------------------------------------------------------
// Reading jsPDF output

const latin1 = (b: Uint8Array, from: number, to: number) => {
  let s = '';
  for (let i = from; i < to; i += 8192) s += String.fromCharCode(...b.subarray(i, Math.min(to, i + 8192)));
  return s;
};

const encodeLatin1 = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

class PdfReader {
  private offsets = new Map<number, number>();
  root = 0;
  constructor(private b: Uint8Array) {
    const tail = latin1(b, Math.max(0, b.length - 1024), b.length);
    const sx = tail.lastIndexOf('startxref');
    if (sx < 0) throw new Error('no startxref');
    const xref = Number(/startxref\s+(\d+)/.exec(tail.slice(sx))?.[1]);
    const head = latin1(b, xref, Math.min(b.length, xref + 64));
    const m = /^xref\s+(\d+)\s+(\d+)\s+/.exec(head);
    if (!m) throw new Error('no xref table');
    const first = Number(m[1]);
    const count = Number(m[2]);
    const start = xref + m[0].length;
    const table = latin1(b, start, Math.min(b.length, start + count * 20 + 4096));
    const re = /(\d{10}) (\d{5}) ([nf])/g;
    for (let i = 0; i < count; i++) {
      const e = re.exec(table);
      if (!e) throw new Error('short xref table');
      if (e[3] === 'n') this.offsets.set(first + i, Number(e[1]));
    }
    const trailer = latin1(b, start + (re.lastIndex || 0), b.length);
    const root = /\/Root\s+(\d+)\s+0\s+R/.exec(trailer);
    if (!root) throw new Error('no /Root');
    this.root = Number(root[1]);
  }

  /** Object `id`: its dictionary text and, for a stream, the stream bytes. */
  obj(id: number): PdfObject {
    const at = this.offsets.get(id);
    if (at === undefined) throw new Error(`object ${id} not in the xref table`);
    const head = latin1(this.b, at, Math.min(this.b.length, at + 4096));
    const m = new RegExp(`^${id}\\s+0\\s+obj\\s*`).exec(head);
    if (!m) throw new Error(`object ${id} not at its offset`);
    let pos = m[0].length;
    let text = head;
    // Dictionaries may be long (resources): read on until the dictionary closes.
    const end = () => {
      if (!text.startsWith('<<', pos)) {
        const e = text.indexOf('endobj', pos);
        return e;
      }
      let depth = 0;
      for (let i = pos; i < text.length - 1; i++) {
        if (text[i] === '<' && text[i + 1] === '<') {
          depth++;
          i++;
        } else if (text[i] === '>' && text[i + 1] === '>') {
          depth--;
          i++;
          if (depth === 0) return i + 1;
        }
      }
      return -1;
    };
    let e = end();
    for (let more = 16384; e < 0 && at + text.length < this.b.length; more *= 2) {
      text = latin1(this.b, at, Math.min(this.b.length, at + more));
      e = end();
    }
    if (e < 0) throw new Error(`object ${id}: unterminated`);
    const dict = text.slice(pos, e).trim();
    pos = e;
    const after = latin1(this.b, at + pos, Math.min(this.b.length, at + pos + 32));
    const sm = /^\s*stream(\r\n|\n)/.exec(after);
    if (!sm || !dict.startsWith('<<')) return { dict };
    const len = /\/Length\s+(\d+)(?!\s+0\s+R)/.exec(dict);
    if (!len) throw new Error(`object ${id}: stream length is not direct`);
    const s0 = at + pos + sm[0].length;
    return { dict, stream: this.b.subarray(s0, s0 + Number(len[1])) };
  }
}

const refsIn = (text: string) => [...text.matchAll(/(\d+)\s+0\s+R/g)].map((m) => Number(m[1]));
const dictValue = (dict: string, key: string) => new RegExp(`/${key}\\s*(\\[[^\\]]*\\]|\\d+\\s+0\\s+R|<<[\\s\\S]*>>|/\\w+|[\\d.]+)`).exec(dict)?.[1];

/** The pages of a PDF written by jsPDF, with what they need to be put into another PDF. */
export function extractPages(pdf: Uint8Array): PdfPage[] {
  const r = new PdfReader(pdf);
  const catalog = r.obj(r.root).dict;
  const pagesRef = /\/Pages\s+(\d+)\s+0\s+R/.exec(catalog);
  if (!pagesRef) throw new Error('no /Pages');
  const kids = dictValue(r.obj(Number(pagesRef[1])).dict, 'Kids');
  if (!kids) throw new Error('no /Kids');
  return refsIn(kids).map((pid) => {
    const page = r.obj(pid).dict;
    if (!/\/Type\s*\/Page\b/.test(page)) throw new Error(`object ${pid} is not a page`);
    const box = dictValue(page, 'MediaBox') ?? '[0 0 595.28 841.89]';
    const nums = box.replace(/[[\]]/g, '').trim().split(/\s+/).map(Number);
    const contentsRef = /\/Contents\s+(\d+)\s+0\s+R/.exec(page);
    if (!contentsRef) throw new Error(`page ${pid}: contents are not one stream`);
    const content = r.obj(Number(contentsRef[1]));
    if (!content.stream) throw new Error(`page ${pid}: contents are not a stream`);
    // Resources: a reference (jsPDF) or a direct dictionary.
    const resRef = /\/Resources\s+(\d+)\s+0\s+R/.exec(page);
    const resources = resRef ? r.obj(Number(resRef[1])).dict : (dictValue(page, 'Resources') ?? '<<>>');
    const extra = page
      .replace(/^<<|>>$/g, '')
      .replace(/\/Type\s*\/Page\b/, '')
      .replace(/\/Parent\s+\d+\s+0\s+R/, '')
      .replace(/\/Resources\s+(\d+\s+0\s+R|<<[\s\S]*?>>)/, '')
      .replace(/\/MediaBox\s*\[[^\]]*\]/, '')
      .replace(/\/Contents\s+\d+\s+0\s+R/, '')
      .trim();
    // Every object reachable from the resources (and the extra entries), renumbered as #i#.
    const objs: PdfObject[] = [];
    const index = new Map<number, number>();
    const visit = (id: number): number => {
      const known = index.get(id);
      if (known !== undefined) return known;
      const i = objs.length;
      index.set(id, i);
      objs.push({ dict: '' });
      const o = r.obj(id);
      objs[i] = { dict: o.dict.replace(/(\d+)\s+0\s+R/g, (_, n) => `#${visit(Number(n))}#`), ...(o.stream ? { stream: o.stream.slice() } : {}) };
      return i;
    };
    const renum = (t: string) => t.replace(/(\d+)\s+0\s+R/g, (_, n) => `#${visit(Number(n))}#`);
    const res = renum(resources);
    const ex = renum(extra);
    const contentDict = content.dict
      .replace(/^<<|>>$/g, '')
      .replace(/\/Length\s+\d+/, '')
      .trim();
    if (/\d+\s+0\s+R/.test(contentDict)) throw new Error(`page ${pid}: content stream refers to other objects`);
    const bytes = content.stream.length + objs.reduce((t, o) => t + o.dict.length + (o.stream?.length ?? 0), 0) + res.length + 200;
    return { box, w: nums[2] - nums[0], h: nums[3] - nums[1], content: content.stream.slice(), contentDict, resources: res, extra: ex, objs, bytes };
  });
}

// ---------------------------------------------------------------------------
// Writing

export interface AssembleOptions {
  title?: string;
  /** Bookmark of each page (same order); pages of the same group are nested under one group bookmark. */
  bookmarks?: ({ title: string; group?: string } | undefined)[];
}

const pdfString = (s: string) => `(${bookmarkText(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;

function fnv53(b: Uint8Array): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < b.length; i++) {
    h1 = Math.imul(h1 ^ b[i], 2654435761);
    h2 = Math.imul(h2 ^ b[i], 1597334677);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}:${b.length}`;
}

const pdfDate = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-00'00'`;
};

/** A PDF of the given pages (in order), with bookmarks; identical resource objects are written once. */
export function assemblePdf(pages: PdfPage[], o: AssembleOptions = {}): Uint8Array {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const offsets: number[] = [0];
  const put = (b: Uint8Array) => {
    chunks.push(b);
    size += b.length;
  };
  const text = (s: string) => put(encodeLatin1(s));
  // Object ids: 1 = page tree, then pages, contents, shared objects, outline, info, catalog.
  let next = 2;
  const alloc = () => next++;
  const objects = new Map<number, { dict: string; stream?: Uint8Array }>();
  const shared = new Map<string, number>();
  const pageIds: number[] = [];
  for (const pg of pages) {
    // Shared objects of this page: children first, deduplicated by content.
    const ids = new Map<number, number>();
    const mapObj = (i: number): number => {
      const known = ids.get(i);
      if (known !== undefined) return known;
      ids.set(i, -1); // cycle guard (jsPDF writes none)
      const ob = pg.objs[i];
      const dict = ob.dict.replace(/#(\d+)#/g, (_, n) => `${mapObj(Number(n))} 0 R`);
      const key = `${dict}|${ob.stream ? fnv53(ob.stream) : ''}`;
      let id = shared.get(key);
      if (id === undefined) {
        id = alloc();
        shared.set(key, id);
        objects.set(id, { dict, ...(ob.stream ? { stream: ob.stream } : {}) });
      }
      ids.set(i, id);
      return id;
    };
    const sub = (t: string) => t.replace(/#(\d+)#/g, (_, n) => `${mapObj(Number(n))} 0 R`);
    const res = sub(pg.resources);
    const extra = sub(pg.extra);
    let resId = shared.get(`res|${res}`);
    if (resId === undefined) {
      resId = alloc();
      shared.set(`res|${res}`, resId);
      objects.set(resId, { dict: res });
    }
    const pid = alloc();
    const cid = alloc();
    pageIds.push(pid);
    objects.set(pid, { dict: `<</Type /Page\n/Parent 1 0 R\n/Resources ${resId} 0 R\n/MediaBox ${pg.box}\n/Contents ${cid} 0 R${extra ? `\n${extra}` : ''}\n>>` });
    objects.set(cid, { dict: `<<\n/Length ${pg.content.length}${pg.contentDict ? `\n${pg.contentDict}` : ''}\n>>`, stream: pg.content });
  }
  // Outline (as jsPDF writes it: groups first, then their items).
  type Node = { title: string; page: number; children: Node[]; id: number };
  const root: Node = { title: '', page: 0, children: [], id: 0 };
  let group: { name: string; node: Node } | null = null;
  (o.bookmarks ?? []).forEach((bm, i) => {
    if (!bm) return;
    let parent = root;
    if (bm.group) {
      if (group?.name !== bm.group) {
        const g: Node = { title: bm.group, page: i, children: [], id: 0 };
        root.children.push(g);
        group = { name: bm.group, node: g };
      }
      parent = group.node;
    } else group = null;
    parent.children.push({ title: bm.title, page: i, children: [], id: 0 });
  });
  const marked = root.children.length > 0;
  let outlineId = 0;
  if (marked) {
    // Ids in the order jsPDF writes the items (a level's items, then each one's children), so the file reads the same.
    root.id = alloc();
    const ids = (n: Node) => {
      for (const c of n.children) c.id = alloc();
      n.children.forEach(ids);
    };
    ids(root);
    outlineId = root.id;
    const count = (n: Node): number => n.children.reduce((t, c) => t + 1 + count(c), 0);
    objects.set(root.id, { dict: `<<\n/Type /Outlines\n/First ${root.children[0].id} 0 R\n/Last ${root.children[root.children.length - 1].id} 0 R\n/Count ${count(root)}\n>>` });
    const items = (n: Node) => {
      n.children.forEach((c, i) => {
        const L = [`/Title ${pdfString(c.title)}`, `/Parent ${n.id} 0 R`];
        if (i > 0) L.push(`/Prev ${n.children[i - 1].id} 0 R`);
        if (i < n.children.length - 1) L.push(`/Next ${n.children[i + 1].id} 0 R`);
        if (c.children.length) L.push(`/First ${c.children[0].id} 0 R`, `/Last ${c.children[c.children.length - 1].id} 0 R`);
        const k = count(c);
        if (k > 0) L.push(`/Count ${k}`);
        L.push(`/Dest [${pageIds[c.page]} 0 R /XYZ 0 ${pages[c.page].h} 0]`);
        objects.set(c.id, { dict: `<<\n${L.join('\n')}\n>>` });
      });
      n.children.forEach(items);
    };
    items(root);
  }
  const infoId = alloc();
  objects.set(infoId, { dict: `<<\n/Producer (FacadeSteel)\n${o.title ? `/Title ${pdfString(o.title)}\n` : ''}/Creator (FacadeSteel)\n/CreationDate (${pdfDate(new Date())})\n>>` });
  const catalogId = alloc();
  objects.set(catalogId, {
    dict: `<<\n/Type /Catalog\n/Pages 1 0 R${marked ? `\n/OpenAction [${pageIds[0]} 0 R /Fit]\n/PageLayout /OneColumn\n/PageMode /UseOutlines\n/Outlines ${outlineId} 0 R` : ''}\n>>`,
  });
  objects.set(1, { dict: `<</Type /Pages\n/Kids [${pageIds.map((id) => `${id} 0 R `).join('')}]\n/Count ${pageIds.length}\n>>` });

  text('%PDF-1.3\n%\xba\xdf\xac\xe0\n');
  for (let id = 1; id < next; id++) {
    const ob = objects.get(id);
    if (!ob) continue;
    offsets[id] = size;
    if (ob.stream) {
      text(`${id} 0 obj\n${ob.dict}\nstream\n`);
      put(ob.stream);
      text('\nendstream\nendobj\n');
    } else text(`${id} 0 obj\n${ob.dict}\nendobj\n`);
  }
  const xref = size;
  const L = ['xref', `0 ${next}`, '0000000000 65535 f '];
  for (let id = 1; id < next; id++) L.push(`${String(offsets[id] ?? 0).padStart(10, '0')} 00000 ${offsets[id] !== undefined ? 'n' : 'f'} `);
  text(`${L.join('\n')}\ntrailer\n<<\n/Size ${next}\n/Root ${catalogId} 0 R\n/Info ${infoId} 0 R\n>>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Painting each sheet once

/** A sheet to paint (SVG made on demand). */
export interface PageSource {
  /** Key of the page content (e.g. the sheet id with its fingerprint): the same key paints once. */
  key: string;
  sheet: () => PdfSheet;
}

/**
 * Paints sheets into reusable pages, each once, keeping the pages within a byte
 * budget (least recently used first out; an evicted page is painted again when
 * needed). A sheet whose page cannot be lifted out (a resource the reader does not
 * know) is marked so that books containing it are painted the usual way.
 */
export class PdfPageCache {
  private map = new Map<string, PdfPage>();
  bytes = 0;
  painted = 0;
  constructor(
    private paint: SvgPainter,
    public budget = 256 * 1024 * 1024,
  ) {}

  async page(src: PageSource): Promise<PdfPage> {
    const hit = this.map.get(src.key);
    if (hit) {
      this.map.delete(src.key);
      this.map.set(src.key, hit);
      return hit;
    }
    const bytes = await sheetsToPdf([src.sheet()], this.paint, { compress: true });
    this.painted++;
    const [pg] = extractPages(bytes);
    this.map.set(src.key, pg);
    this.bytes += pg.bytes;
    for (const [k, v] of this.map) {
      if (this.bytes <= this.budget || this.map.size <= 1) break;
      this.map.delete(k);
      this.bytes -= v.bytes;
    }
    return pg;
  }

  has(key: string) {
    return this.map.has(key);
  }

  clear() {
    this.map.clear();
    this.bytes = 0;
  }
}

/** Bookmark entry of a page in a book. */
export interface BookPage {
  src: PageSource;
  bookmark?: { title: string; group?: string };
}

/**
 * A book (one PDF) of pages from the cache: each page is painted at most once per cache.
 * `onPage` is called after each page; return false to stop (throws PdfCancelled).
 */
export async function bookFromPages(
  cache: PdfPageCache,
  list: BookPage[],
  o: {
    title?: string;
    onPage?: (i: number, n: number) => boolean | void;
    yieldTo?: () => Promise<void>;
    /** Pages painted after all others (in book order still), e.g. register sheets that list the others; `beforeLater` runs first. */
    later?: (bp: BookPage, i: number) => boolean;
    beforeLater?: () => Promise<unknown>;
  } = {},
): Promise<Uint8Array> {
  const pages: PdfPage[] = new Array(list.length);
  let lastYield = Date.now();
  let done = 0;
  const paint = async (i: number) => {
    pages[i] = await cache.page(list[i].src);
    if (o.onPage?.(done++, list.length) === false) throw new PdfCancelled();
    if (o.yieldTo && Date.now() - lastYield > 50) {
      await o.yieldTo();
      lastYield = Date.now();
    }
  };
  const later = list.map((bp, i) => !!o.later?.(bp, i));
  for (let i = 0; i < list.length; i++) if (!later[i]) await paint(i);
  if (later.some(Boolean)) {
    await o.beforeLater?.();
    for (let i = 0; i < list.length; i++) if (later[i]) await paint(i);
  }
  return assemblePdf(pages, { title: o.title, bookmarks: list.map((b) => b.bookmark) });
}
