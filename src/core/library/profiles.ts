import { sectionProps, shapeBox, validateShape, type SectionProps, type Shape, type ShapeType } from './shapes';
import * as EN from './sections/en';
import * as BS from './sections/bs';
import * as US from './sections/aisc';

/**
 * Profile library: EN (European), BS (British), AISC (American) and custom sections.
 *
 * Rolled I/U/T sections carry their catalogue mass (massSource 'catalogue');
 * for everything else the mass is computed from the drawn cross-section
 * (including corner/root radii), which matches catalogue values to about 1 %.
 * Always verify critical values against the mill or supplier tables before
 * fabrication. `spec` names the dimensional standard (see standards.ts).
 */

export type Standard = 'EN' | 'BS' | 'AISC' | 'Custom';

/** Standards in display order, with labels for pickers. */
export const STANDARDS_LIST: readonly { value: Standard; label: string; description: string }[] = [
  { value: 'EN', label: 'EN (European)', description: 'IPE, HE, IPN, UPN, UPE, T, angles, hollow sections, bars, cold-formed' },
  { value: 'BS', label: 'BS (British)', description: 'BS 4-1 universal beams, universal columns, parallel flange channels' },
  { value: 'AISC', label: 'AISC (US)', description: 'W, WT, S, C, MC, angles, HSS and pipe (US customary sizes)' },
  { value: 'Custom', label: 'Custom', description: 'User-defined and imported sections' },
];

export type MassSource = 'catalogue' | 'computed' | 'user';

export interface Profile extends SectionProps {
  /** Unique name, also used as the profile id (e.g. "SHS 100x100x5", "HSS4x4x1/4"). */
  name: string;
  standard: Standard;
  family: string;
  shape: Shape;
  /** kg per metre. */
  mass: number;
  /** Overall section height (local z) and width (local y), mm. */
  h: number;
  b: number;
  /** 'catalogue' = tabulated mass, 'computed' = from the drawn section, 'user' = given on import. */
  massSource?: MassSource;
  /** Dimensional/product standard of the section, e.g. 'EN 10365', 'EN 10219-2', 'ASTM A500'. */
  spec?: string;
  /** AISC design wall thickness for HSS and pipe (0.93 × nominal for ASTM A500/A53), mm. */
  tdes?: number;
  /** Alternative designations that getProfile/searchProfiles also accept. */
  aliases?: string[];
  /** True for user-registered (custom/imported) profiles. */
  custom?: boolean;
}

export const STEEL_DENSITY = 7850; // kg/m³
const IN = 25.4;
/** lb/ft → kg/m */
const LBFT = 1.48816394;

const all: Profile[] = [];
const byName = new Map<string, Profile>();

interface BuildOpts {
  mass?: number;
  massSource?: MassSource;
  spec?: string;
  tdes?: number;
  aliases?: string[];
  custom?: boolean;
}

function buildProfile(name: string, standard: Standard, family: string, shape: Shape, o: BuildOpts = {}): Profile {
  const props = sectionProps(shape);
  const box = shapeBox(shape);
  const p: Profile = {
    name,
    standard,
    family,
    shape,
    ...props,
    mass: o.mass ?? (props.area * STEEL_DENSITY) / 1e6,
    h: box.h,
    b: box.w,
    massSource: o.massSource ?? (o.mass === undefined ? 'computed' : 'catalogue'),
  };
  if (o.spec) p.spec = o.spec;
  if (o.tdes !== undefined) p.tdes = o.tdes;
  if (o.aliases?.length) p.aliases = o.aliases;
  if (o.custom) p.custom = true;
  return p;
}

function addProfile(name: string, standard: Standard, family: string, shape: Shape, o: BuildOpts = {}) {
  const p = buildProfile(name, standard, family, shape, o);
  all.push(p);
  byName.set(name, p);
}

/** Trim trailing zeros for names: 3.0 → "3", 2.5 → "2.5". */
const n = (v: number) => String(Number(v.toFixed(2)));

// ---------------------------------------------------------------------------
// EN hot-rolled

for (const [s, h, b, tw, tf, r, m] of EN.IPE) addProfile(`IPE ${s}`, 'EN', 'IPE', { type: 'I', h, b, tw, tf, r }, { mass: m, spec: 'EN 10365' });
for (const [s, h, b, tw, tf, r, m] of EN.HEA)
  addProfile(`HEA ${s}`, 'EN', 'HEA', { type: 'I', h, b, tw, tf, r }, { mass: m, spec: 'EN 10365', aliases: [`HE ${s} A`] });
for (const [s, h, b, tw, tf, r, m] of EN.HEB)
  addProfile(`HEB ${s}`, 'EN', 'HEB', { type: 'I', h, b, tw, tf, r }, { mass: m, spec: 'EN 10365', aliases: [`HE ${s} B`] });
for (const [s, h, b, tw, tf, r, m] of EN.HEM)
  addProfile(`HEM ${s}`, 'EN', 'HEM', { type: 'I', h, b, tw, tf, r }, { mass: m, spec: 'EN 10365', aliases: [`HE ${s} M`] });
for (const [s, h, b, tw, tf, r, m] of EN.IPN)
  addProfile(`IPN ${s}`, 'EN', 'IPN', { type: 'I', h, b, tw, tf, r, r2: Number((0.6 * tw).toFixed(2)) }, { mass: m, spec: 'EN 10365', aliases: [`I ${s}`] });
for (const [s, h, b, tw, tf, r, m] of EN.UPN)
  addProfile(`UPN ${s}`, 'EN', 'UPN', { type: 'U', h, b, tw, tf, r, r2: r / 2 }, { mass: m, spec: 'EN 10365', aliases: [`U ${s}`] });
for (const [s, h, b, tw, tf, r, m] of EN.UPE) addProfile(`UPE ${s}`, 'EN', 'UPE', { type: 'U', h, b, tw, tf, r }, { mass: m, spec: 'EN 10365' });
for (const [h, t, m] of EN.T_EN)
  addProfile(`T ${h}x${h}x${n(t)}`, 'EN', 'T', { type: 'T', h, b: h, tw: t, tf: t, r: t, r2: t / 2, r3: t / 4 }, { mass: m, spec: 'EN 10055', aliases: [`T ${h}`] });

// EN 10056-1 angles (toe radius r2 = r1/2)
for (const [a, r, ts] of EN.L_EQUAL) {
  for (const t of ts) addProfile(`L ${a}x${a}x${n(t)}`, 'EN', 'L', { type: 'L', h: a, b: a, t, r, r2: r / 2 }, { spec: 'EN 10056-1' });
}
for (const [a, b, r, ts] of EN.L_UNEQUAL) {
  for (const t of ts) addProfile(`L ${a}x${b}x${n(t)}`, 'EN', 'L', { type: 'L', h: a, b, t, r, r2: r / 2 }, { spec: 'EN 10056-1' });
}

// ---------------------------------------------------------------------------
// EN hollow sections

/** EN 10219-2 cold-formed hollow section outer corner radius (used for mass and properties). */
export const en10219Radius = (t: number) => (t <= 6 ? 2 * t : t <= 10 ? 2.5 * t : 3 * t);
/** EN 10210-2 hot-finished outer corner radius (inner radius = t). */
export const en10210Radius = (t: number) => 1.5 * t;

for (const [b, ts] of EN.SHS_CF) {
  for (const t of ts) addProfile(`SHS ${b}x${b}x${n(t)}`, 'EN', 'SHS', { type: 'RHS', h: b, b, t, ro: en10219Radius(t) }, { spec: 'EN 10219-2' });
}
for (const [h, b, ts] of EN.RHS_CF) {
  for (const t of ts) addProfile(`RHS ${h}x${b}x${n(t)}`, 'EN', 'RHS', { type: 'RHS', h, b, t, ro: en10219Radius(t) }, { spec: 'EN 10219-2' });
}
for (const [b, ts] of EN.SHS_HF) {
  for (const t of ts) addProfile(`SHS ${b}x${b}x${n(t)} HF`, 'EN', 'SHS HF', { type: 'RHS', h: b, b, t, ro: en10210Radius(t), ri: t }, { spec: 'EN 10210-2' });
}
for (const [h, b, ts] of EN.RHS_HF) {
  for (const t of ts) addProfile(`RHS ${h}x${b}x${n(t)} HF`, 'EN', 'RHS HF', { type: 'RHS', h, b, t, ro: en10210Radius(t), ri: t }, { spec: 'EN 10210-2' });
}
for (const [d, ts] of EN.CHS_EN) {
  for (const t of ts) addProfile(`CHS ${n(d)}x${n(t)}`, 'EN', 'CHS', { type: 'CHS', d, t }, { spec: 'EN 10219-2 / EN 10210-2' });
}

// ---------------------------------------------------------------------------
// EN bars

for (const h of EN.FLAT_WIDTHS) {
  for (const t of EN.FLAT_THICKNESSES) {
    if (t * 2 > h || t * 50 < h) continue;
    addProfile(`FL ${h}x${t}`, 'EN', 'FL', { type: 'FL', h, t }, { spec: 'EN 10058' });
  }
}
for (const a of EN.SQUARE_BARS) addProfile(`SQ ${a}`, 'EN', 'SQ', { type: 'FL', h: a, t: a }, { spec: 'EN 10059' });
for (const d of EN.ROUND_BARS) addProfile(`RD ${d}`, 'EN', 'RD', { type: 'RD', d }, { spec: 'EN 10060' });

// ---------------------------------------------------------------------------
// EN cold-formed (inner bend radius = t)

for (const [h, b, c, ts] of EN.CF_LIPPED) {
  for (const t of ts) {
    addProfile(`C ${h}x${b}x${c}x${n(t)}`, 'EN', 'C (cold-formed)', { type: 'C', h, b, c, t, r: t }, { spec: 'EN 10162' });
    addProfile(`Z ${h}x${b}x${c}x${n(t)}`, 'EN', 'Z (cold-formed)', { type: 'Z', h, b, c, t, r: t }, { spec: 'EN 10162' });
  }
}
for (const [h, b, ts] of EN.CF_CHANNELS) {
  for (const t of ts) {
    addProfile(`CU ${h}x${b}x${n(t)}`, 'EN', 'U (cold-formed)', { type: 'U', h, b, tw: t, tf: t, r: t, ro: 2 * t }, { spec: 'EN 10162' });
  }
}
for (const [h, b, ts] of EN.CF_ANGLES) {
  for (const t of ts) addProfile(`CL ${h}x${b}x${n(t)}`, 'EN', 'L (cold-formed)', { type: 'L', h, b, t, r: t, ro: 2 * t }, { spec: 'EN 10162' });
}

// ---------------------------------------------------------------------------
// British BS 4-1

for (const [des, h, b, tw, tf, r, m] of BS.UB)
  addProfile(`UB ${des}`, 'BS', 'UB', { type: 'I', h, b, tw, tf, r }, { mass: m, spec: 'BS 4-1', aliases: [`UKB ${des}`] });
for (const [des, h, b, tw, tf, r, m] of BS.UC)
  addProfile(`UC ${des}`, 'BS', 'UC', { type: 'I', h, b, tw, tf, r }, { mass: m, spec: 'BS 4-1', aliases: [`UKC ${des}`] });
for (const [des, h, b, tw, tf, r, m] of BS.PFC)
  addProfile(`PFC ${des}`, 'BS', 'PFC', { type: 'U', h, b, tw, tf, r }, { mass: m, spec: 'BS 4-1', aliases: [`UKPFC ${des}`] });

// ---------------------------------------------------------------------------
// AISC (dimensions in inches, converted). Mass of rolled shapes comes from the
// nominal weight in the designation; fillet radii are estimated from tf.

const wFillet = (tf: number) => Math.max(6, tf * IN * 0.8);
const cFillet = (tf: number) => Math.max(5, tf * IN * 0.7);
const lbft = (name: string) => Number(name.split('x')[1]);

for (const [name, d, bf, tw, tf] of US.W) {
  const shape: Shape = { type: 'I', h: d * IN, b: bf * IN, tw: tw * IN, tf: tf * IN, r: wFillet(tf) };
  addProfile(name, 'AISC', 'W', shape, { mass: lbft(name) * LBFT, spec: 'ASTM A6' });
}
for (const [name, d, bf, tw, tf] of US.W) {
  const nominal = Number(name.slice(1).split('x')[0]);
  const wt = `WT${n(nominal / 2)}x${n(lbft(name) / 2)}`;
  const shape: Shape = { type: 'T', h: (d / 2) * IN, b: bf * IN, tw: tw * IN, tf: tf * IN, r: wFillet(tf) };
  addProfile(wt, 'AISC', 'WT', shape, { mass: (lbft(name) / 2) * LBFT, spec: 'ASTM A6' });
}
for (const [name, d, bf, tw, tf] of US.S) {
  addProfile(name, 'AISC', 'S', { type: 'I', h: d * IN, b: bf * IN, tw: tw * IN, tf: tf * IN, r: wFillet(tf) }, { mass: lbft(name) * LBFT, spec: 'ASTM A6' });
}
for (const [name, d, bf, tw, tf] of US.C) {
  addProfile(name, 'AISC', 'C', { type: 'U', h: d * IN, b: bf * IN, tw: tw * IN, tf: tf * IN, r: cFillet(tf) }, { mass: lbft(name) * LBFT, spec: 'ASTM A6' });
}
for (const [name, d, bf, tw, tf] of US.MC) {
  addProfile(name, 'AISC', 'MC', { type: 'U', h: d * IN, b: bf * IN, tw: tw * IN, tf: tf * IN, r: cFillet(tf) }, { mass: lbft(name) * LBFT, spec: 'ASTM A6' });
}

/** "2-1/2" → 2.5, "1/4" → 0.25, "4" → 4 */
export function parseInch(s: string): number {
  const m = s.match(/^(?:(\d+(?:\.\d+)?)-)?(\d+)\/(\d+)$/);
  if (m) return (m[1] ? Number(m[1]) : 0) + Number(m[2]) / Number(m[3]);
  return Number(s);
}

for (const [a, b, ts] of US.L) {
  const h = parseInch(a) * IN;
  const w = parseInch(b) * IN;
  const r = h <= 3 * IN ? 0.25 * IN : h <= 4 * IN ? 0.375 * IN : 0.5 * IN;
  for (const t of ts) addProfile(`L${a}x${b}x${t}`, 'AISC', 'L', { type: 'L', h, b: w, t: parseInch(t) * IN, r }, { spec: 'ASTM A6' });
}

// HSS: weight from the nominal wall with outer corner radius 2t (AISC Manual basis);
// design properties per AISC 360 B4.2 use tdes = 0.93 t for ASTM A500.
for (const [a, b, ts] of US.HSS_RECT) {
  for (const t of ts) {
    const tt = parseInch(t) * IN;
    addProfile(`HSS${a}x${b}x${t}`, 'AISC', 'HSS rect', { type: 'RHS', h: parseInch(a) * IN, b: parseInch(b) * IN, t: tt, ro: 2 * tt }, { spec: 'ASTM A500', tdes: 0.93 * tt });
  }
}
for (const [d, ts] of US.HSS_ROUND) {
  for (const t of ts) {
    addProfile(`HSS${d.toFixed(3)}x${t.toFixed(3)}`, 'AISC', 'HSS round', { type: 'CHS', d: d * IN, t: t * IN }, { spec: 'ASTM A500', tdes: 0.93 * t * IN });
  }
}
for (const [nps, d, std, xs] of US.PIPE) {
  addProfile(`Pipe${nps}STD`, 'AISC', 'Pipe', { type: 'CHS', d: d * IN, t: std * IN }, { spec: 'ASTM A53', tdes: 0.93 * std * IN });
  addProfile(`Pipe${nps}XS`, 'AISC', 'Pipe', { type: 'CHS', d: d * IN, t: xs * IN }, { spec: 'ASTM A53', tdes: 0.93 * xs * IN });
}

// ---------------------------------------------------------------------------
// Lookup

export const PROFILES: readonly Profile[] = all;
const builtIn = new Set(all.map((p) => p.name));

/** Normalised key: case, spaces, "*" and "×" are ignored. */
const norm = (s: string) => s.toLowerCase().replace(/[\s*]/g, '').replace(/×/g, 'x');

/** Normalised name/alias → profile name ('' when ambiguous). */
let byKey = new Map<string, string>();
function rebuildKeys() {
  byKey = new Map();
  const put = (k: string, name: string) => {
    const hit = byKey.get(k);
    byKey.set(k, hit === undefined || hit === name ? name : '');
  };
  for (const p of all) {
    put(norm(p.name), p.name);
    for (const a of p.aliases ?? []) put(norm(a), p.name);
  }
}
rebuildKeys();

/** Exact name first, then a unique case/space-insensitive match on name or alias ("hea200", "HE 200 A"). */
export function getProfile(name: string | null | undefined): Profile | undefined {
  if (!name) return undefined;
  const hit = byName.get(name);
  if (hit) return hit;
  const k = byKey.get(norm(name));
  return k ? byName.get(k) : undefined;
}

export function profileFamilies(standard?: Standard): string[] {
  return [...new Set(all.filter((p) => !standard || p.standard === standard).map((p) => p.family))];
}

/** Loose search: "shs100", "SHS 100x100", "hss4x4" all match. Names starting with the query come first. */
export function searchProfiles(q: string, standard?: Standard): Profile[] {
  const k = norm(q);
  const hits = all.filter(
    (p) => (!standard || p.standard === standard) && (!k || norm(p.name).includes(k) || (p.aliases ?? []).some((a) => norm(a).includes(k))),
  );
  if (!k) return hits;
  const starts = (p: Profile) => norm(p.name).startsWith(k) || (p.aliases ?? []).some((a) => norm(a).startsWith(k));
  return [...hits.filter(starts), ...hits.filter((p) => !starts(p))];
}

// ---------------------------------------------------------------------------
// Custom / imported profiles

/** A user-defined section. Dimensions in mm; mass (kg/m) is computed from the shape when omitted. */
export interface ProfileDef {
  name: string;
  /** Defaults to 'Custom'. */
  standard?: Standard;
  /** Defaults to "Custom <type>". */
  family?: string;
  shape: Shape;
  mass?: number;
  spec?: string;
}

/** Build a Profile from a definition (throws on an invalid shape or name). */
export function profileFromDef(def: ProfileDef): Profile {
  const name = def.name?.trim();
  if (!name) throw new Error('Profile name is required');
  if (!def.shape || typeof def.shape !== 'object') throw new Error(`${name}: shape is required`);
  const err = validateShape(def.shape);
  if (err) throw new Error(`${name}: ${err}`);
  if (def.mass !== undefined && !(Number.isFinite(def.mass) && def.mass > 0)) throw new Error(`${name}: mass must be > 0`);
  return buildProfile(name, def.standard ?? 'Custom', def.family?.trim() || `Custom ${def.shape.type}`, { ...def.shape }, {
    mass: def.mass,
    massSource: def.mass === undefined ? 'computed' : 'user',
    spec: def.spec,
    custom: true,
  });
}

const customDefs = new Map<string, ProfileDef>();
/** Built-in profiles temporarily replaced by a custom one (restored on unregister). */
const shadowed = new Map<string, Profile>();
const listeners = new Set<() => void>();
let revision = 0;

function changed() {
  revision++;
  rebuildKeys();
  for (const fn of listeners) fn();
}

/** Increments whenever custom profiles are registered or removed (for memo dependencies). */
export function profileLibraryRevision(): number {
  return revision;
}

/** Subscribe to catalogue changes; returns an unsubscribe function. */
export function subscribeProfiles(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/**
 * Add or replace profiles in the live catalogue so getProfile/searchProfiles/PROFILES
 * find them. Built-in names are protected unless `replaceBuiltIn` is set; invalid
 * definitions are skipped (use parseProfileCsv for messages). Returns how many were registered.
 */
export function registerProfiles(defs: readonly ProfileDef[], opts: { replaceBuiltIn?: boolean } = {}): number {
  let count = 0;
  for (const def of defs) {
    let p: Profile;
    try {
      p = profileFromDef(def);
    } catch {
      continue;
    }
    const existing = byName.get(p.name);
    if (existing && builtIn.has(p.name) && !customDefs.has(p.name)) {
      if (!opts.replaceBuiltIn) continue;
      shadowed.set(p.name, existing);
    }
    if (existing) all[all.indexOf(existing)] = p;
    else all.push(p);
    byName.set(p.name, p);
    customDefs.set(p.name, { ...def, name: p.name, shape: { ...def.shape } });
    count++;
  }
  if (count) changed();
  return count;
}

/** Remove custom profiles by name (built-ins they replaced come back). Returns how many were removed. */
export function unregisterProfiles(names: Iterable<string>): number {
  let count = 0;
  for (const name of names) {
    if (!customDefs.has(name)) continue;
    const p = byName.get(name)!;
    const i = all.indexOf(p);
    const orig = shadowed.get(name);
    if (orig) {
      all[i] = orig;
      byName.set(name, orig);
      shadowed.delete(name);
    } else {
      all.splice(i, 1);
      byName.delete(name);
    }
    customDefs.delete(name);
    count++;
  }
  if (count) changed();
  return count;
}

/** Definitions of all registered custom profiles (e.g. to store with a project). */
export function customProfileDefs(): ProfileDef[] {
  return [...customDefs.values()].map((d) => ({ ...d, shape: { ...d.shape } }));
}

export function isCustomProfile(name: string): boolean {
  return customDefs.has(name);
}

/**
 * CSV format for custom profiles — one header row, then one profile per row:
 *
 *   name,family,type,h,b,tw,tf,r,t,d,c,mass
 *   Rail C120,Rails,C,120,50,,,2,2,,15,
 *   Bracket tee,Tees,T,80,100,8,10,6,,,,
 *   Tube 60x3,,CHS,,,,,,3,60,,4.22
 *
 * - Columns are matched by header name in any order (case-insensitive); unused cells stay
 *   blank. Optional extra columns: `standard` (EN, BS, AISC or Custom — default Custom) and
 *   `spec`. Unknown columns are ignored.
 * - Delimiter is comma, semicolon or tab, taken from the header row. With semicolon or tab,
 *   decimal commas ("2,5") are accepted. Fields may be double-quoted. Blank lines and lines
 *   starting with # are skipped.
 * - Dimensions in mm, mass in kg/m. A blank mass is computed from the section at 7850 kg/m³.
 * - `type` and the columns it needs:
 *     I, U, T   h, b, tw, tf    r = root radius (optional)
 *     L         h, b, t         r = root radius (optional)
 *     RHS       h, b, t         r = OUTER corner radius (default 2t); SHS also accepted (b defaults to h)
 *     CHS       d, t
 *     RD        d               solid round bar
 *     FL        h, t            flat / plate strip; SQ also accepted (square bar, h only)
 *     C, Z      h, b, c, t      lipped cold-formed; r = inner bend radius (optional)
 */
export const PROFILE_CSV_COLUMNS = ['name', 'family', 'type', 'h', 'b', 'tw', 'tf', 'r', 't', 'd', 'c', 'mass'] as const;

function splitCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const TYPE_ALIASES: Record<string, ShapeType | 'SHS' | 'SQ'> = {
  I: 'I', H: 'I', U: 'U', CHANNEL: 'U', T: 'T', TEE: 'T', L: 'L', ANGLE: 'L',
  RHS: 'RHS', SHS: 'SHS', CHS: 'CHS', TUBE: 'CHS', PIPE: 'CHS', RD: 'RD', ROUND: 'RD',
  FL: 'FL', FLAT: 'FL', PL: 'FL', SQ: 'SQ', C: 'C', Z: 'Z',
};

const STANDARD_VALUES = new Set<string>(STANDARDS_LIST.map((s) => s.value));

export function parseProfileCsv(text: string): { defs: ProfileDef[]; errors: string[] } {
  const defs: ProfileDef[] = [];
  const errors: string[] = [];
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  let header: string[] | null = null;
  let delim = ',';
  const seen = new Set<string>();
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const ln = li + 1;
    if (!header) {
      delim = raw.includes(';') ? ';' : raw.includes('\t') ? '\t' : ',';
      header = splitCsvLine(raw, delim).map((h) => h.toLowerCase());
      if (!header.includes('name') || !header.includes('type')) {
        errors.push(`line ${ln}: header must include "name" and "type" columns`);
        return { defs, errors };
      }
      continue;
    }
    const cells = splitCsvLine(raw, delim);
    const cell = (k: string) => {
      const i = header!.indexOf(k);
      return i >= 0 ? (cells[i] ?? '') : '';
    };
    const bad: string[] = [];
    const num = (k: string): number | undefined => {
      const s = cell(k);
      if (!s) return undefined;
      const v = Number(delim === ',' ? s : s.replace(',', '.'));
      if (!Number.isFinite(v)) bad.push(k);
      return v;
    };
    const name = cell('name');
    if (!name) {
      errors.push(`line ${ln}: missing name`);
      continue;
    }
    if (seen.has(name)) {
      errors.push(`line ${ln}: duplicate name "${name}"`);
      continue;
    }
    const type = TYPE_ALIASES[cell('type').toUpperCase()];
    if (!type) {
      errors.push(`line ${ln} (${name}): unknown type "${cell('type')}"`);
      continue;
    }
    const [h, b, tw, tf, r, t, d, c, mass] = ['h', 'b', 'tw', 'tf', 'r', 't', 'd', 'c', 'mass'].map(num);
    if (bad.length) {
      errors.push(`line ${ln} (${name}): not a number in ${bad.join(', ')}`);
      continue;
    }
    const need = (vals: Record<string, number | undefined>): boolean => {
      const missing = Object.entries(vals).filter(([, v]) => v === undefined).map(([k]) => k);
      if (missing.length) errors.push(`line ${ln} (${name}): ${type} needs ${missing.join(', ')}`);
      return !missing.length;
    };
    let shape: Shape | null = null;
    switch (type) {
      case 'I':
      case 'U':
      case 'T':
        if (need({ h, b, tw, tf })) shape = { type, h: h!, b: b!, tw: tw!, tf: tf!, r: r ?? 0 };
        break;
      case 'L':
        if (need({ h, b, t })) shape = { type, h: h!, b: b!, t: t!, r: r ?? 0 };
        break;
      case 'RHS':
      case 'SHS':
        if (need({ h, t })) {
          if (type === 'RHS' && b === undefined) need({ b });
          else shape = { type: 'RHS', h: h!, b: b ?? h!, t: t!, ro: r ?? 2 * t! };
        }
        break;
      case 'CHS':
        if (need({ d, t })) shape = { type, d: d!, t: t! };
        break;
      case 'RD':
        if (need({ d })) shape = { type, d: d! };
        break;
      case 'FL':
        if (need({ h, t })) shape = { type, h: h!, t: t! };
        break;
      case 'SQ':
        if (need({ h })) shape = { type: 'FL', h: h!, t: h! };
        break;
      case 'C':
      case 'Z':
        if (need({ h, b, c, t })) shape = { type, h: h!, b: b!, c: c!, t: t!, ...(r ? { r } : {}) };
        break;
    }
    if (!shape) continue;
    const err = validateShape(shape);
    if (err) {
      errors.push(`line ${ln} (${name}): ${err}`);
      continue;
    }
    if (mass !== undefined && !(mass > 0)) {
      errors.push(`line ${ln} (${name}): mass must be > 0`);
      continue;
    }
    const std = cell('standard');
    if (std && !STANDARD_VALUES.has(std)) {
      errors.push(`line ${ln} (${name}): unknown standard "${std}"`);
      continue;
    }
    const def: ProfileDef = { name, shape };
    if (std) def.standard = std as Standard;
    if (cell('family')) def.family = cell('family');
    if (cell('spec')) def.spec = cell('spec');
    if (mass !== undefined) def.mass = mass;
    seen.add(name);
    defs.push(def);
  }
  if (!header) errors.push('no header row found');
  return { defs, errors };
}

/** Write definitions in the parseProfileCsv format (extra radii such as r2/ro are not representable). */
export function profileDefsToCsv(defs: readonly ProfileDef[]): string {
  const withStd = defs.some((d) => d.standard && d.standard !== 'Custom');
  const withSpec = defs.some((d) => d.spec);
  const cols: string[] = [...PROFILE_CSV_COLUMNS, ...(withStd ? ['standard'] : []), ...(withSpec ? ['spec'] : [])];
  const q = (s: string) => (/[",;\t\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const f = (v: number | undefined) => (v === undefined ? '' : String(Number(v.toFixed(4))));
  const rows = defs.map((d) => {
    const s = d.shape;
    const v: Record<string, string> = { name: q(d.name), family: q(d.family ?? ''), type: s.type, mass: f(d.mass), standard: d.standard ?? '', spec: q(d.spec ?? '') };
    switch (s.type) {
      case 'I':
      case 'U':
      case 'T':
        Object.assign(v, { h: f(s.h), b: f(s.b), tw: f(s.tw), tf: f(s.tf), r: f(s.r) });
        break;
      case 'L':
        Object.assign(v, { h: f(s.h), b: f(s.b), t: f(s.t), r: f(s.r) });
        break;
      case 'RHS':
        Object.assign(v, { h: f(s.h), b: f(s.b), t: f(s.t), r: f(s.ro) });
        break;
      case 'CHS':
        Object.assign(v, { d: f(s.d), t: f(s.t) });
        break;
      case 'RD':
        Object.assign(v, { d: f(s.d) });
        break;
      case 'FL':
        Object.assign(v, { h: f(s.h), t: f(s.t) });
        break;
      case 'C':
      case 'Z':
        Object.assign(v, { h: f(s.h), b: f(s.b), c: f(s.c), t: f(s.t), r: f(s.r) });
        break;
    }
    return cols.map((k) => v[k] ?? '').join(',');
  });
  return [cols.join(','), ...rows].join('\n') + '\n';
}
