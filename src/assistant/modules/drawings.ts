/**
 * Assistant tools for the drawing set: manual sheet edits (notes, leaders,
 * revision clouds, moved views and dimensions, hidden items), section cuts and
 * detail callouts on the GA, erection drawings (setting-out plans, anchor
 * schedules, erection sequences) and company sheet templates (including the
 * client's title block imported from DXF).
 */
import type { DrawingZoning, GaCut, SheetSize, SheetTemplate, Vec3 } from '../../core/model/types';
import { newId } from '../../core/model/ops';
import {
  DEFAULT_TEMPLATE,
  DEFAULT_TEMPLATE_ID,
  FIELD_SOURCES,
  addCloud,
  addNote,
  anchorRows,
  checkSheetLayout,
  editableItems,
  hideItem,
  makeCtx,
  moveGroup,
  newTemplate,
  nextCutLetter,
  offsetDim,
  rectPts,
  resetEdits,
  readTitleBlockDxf,
  sanitizeTemplate,
  sheetLabel,
  titleBlockSummary,
  titleBlockTemplate,
  unhideItem,
  zonePlanFor,
  zoningSettings,
  type Drawing,
  type SheetEntry,
} from '../../core/drawings';
import { derived, useStore } from '../../state/store';
import { exportAnchorScheduleCsv } from '../../ui/actions';
import { currentDrawingSet } from '../../ui/drawingJobs';
import type { Json, ToolModule } from './types';

const num = { type: 'number' } as const;
const str = { type: 'string' } as const;
const vec3 = { type: 'array', items: num, minItems: 3, maxItems: 3, description: '[x, y, z] world mm' } as const;

const st = () => useStore.getState();

/** The drawing index of the current state (sheets are made on demand). */
const sheetIndex = () => currentDrawingSet().index().entries;

/** One sheet by id, number or "number (n/N)", made now. */
function findDrawing(key: unknown): Drawing {
  const k = String(key ?? '').trim().toLowerCase();
  const ds = sheetIndex();
  const e = ds.find((x) => x.id.toLowerCase() === k || x.number.toLowerCase() === k || sheetLabel(x).toLowerCase() === k);
  const d = e && currentDrawingSet().sheet(e.id);
  if (!d) throw new Error(`No drawing "${key}". Drawings: ${ds.slice(0, 40).map((x) => x.number).join(', ')}${ds.length > 40 ? ' …' : ''}`);
  return d;
}

const n = (v: unknown, name: string): number => {
  const x = Number(v);
  if (!Number.isFinite(x)) throw new Error(`${name} must be a number.`);
  return x;
};
const v3 = (v: unknown, name: string): Vec3 => {
  if (!Array.isArray(v) || v.length !== 3) throw new Error(`${name} must be [x, y, z].`);
  return { x: n(v[0], name), y: n(v[1], name), z: n(v[2], name) };
};
const summary = (d: Drawing | SheetEntry) => {
  if ('drawing' in d) currentDrawingSet().refresh(d, false);
  return {
    id: d.id,
    number: d.number,
    ...(d.sheetCount ? { sheet: `${d.sheetIndex}/${d.sheetCount}` } : {}),
    title: d.title,
    kind: d.kind,
    // Index entries: scale and "changed" are known once the sheet has been made (null: not yet).
    scale: d.scale ?? null,
    rev: d.rev,
    changed: d.changed ?? null,
    edited: !!d.edited,
    ...(d.zone ? { zone: d.zone.name } : {}),
  };
};

const ERECTION = new Set(['setout', 'anchors', 'sequence']);

export const drawingsModule: ToolModule = {
  tools: [
    {
      name: 'drawing_markup',
      description:
        'Edit one drawing sheet by hand. Actions: list_items (editable views, tables, dimensions, balloons, notes with their sheet extents), add_note (text at x,y; optional leaderX/leaderY = point the ISO 128 leader arrow touches), add_cloud (revision cloud around rect [x0,y0,x1,y1] tagged with rev), move (translate a view or table group by dx,dy — its dimensions move with it), offset_dimension (shift a dimension line by offset mm perpendicular to it), hide (an item or group), show_all, reset (remove all edits). Sheet coordinates are mm from the bottom-left corner (A3 = 420 × 297). Edits survive regeneration and mark the sheet as changed for the next issue.',
      input_schema: {
        type: 'object',
        properties: {
          drawing: { type: 'string', description: 'Drawing id (e.g. "asm-M1", "ga-front") or number' },
          action: { type: 'string', enum: ['list_items', 'add_note', 'add_cloud', 'move', 'offset_dimension', 'hide', 'show_all', 'reset'] },
          text: str,
          x: num,
          y: num,
          leaderX: num,
          leaderY: num,
          height: { type: 'number', description: 'Lettering height, mm (ISO 3098: 2.5, 3.5, 5)' },
          rect: { type: 'array', items: num, minItems: 4, maxItems: 4 },
          rev: { type: 'string', description: 'Revision index for the cloud tag' },
          item: { type: 'string', description: 'Item id or group from list_items, e.g. "view:plan", "dim:elevation:2", "table:parts-list"' },
          dx: num,
          dy: num,
          offset: num,
        },
        required: ['drawing', 'action'],
      },
    },
    {
      name: 'ga_cuts',
      description:
        'Section cuts and detail callouts on the GA (each gets its own sheet, numbered -SD-NN). Actions: list, add, update (by id), delete (by id). Section: cut line a→b in world mm drawn on the GA view (front: x/z matter, plan: x/y), looking to the right of the line (flip reverses), depth = how far beyond the plane parts are shown. Detail: centre a and radius. scale = ISO 5455 denominator or 0 for automatic.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'update', 'delete'] },
          id: str,
          kind: { type: 'string', enum: ['section', 'detail'] },
          name: { type: 'string', description: 'Letter, default the next free one' },
          view: { type: 'string', enum: ['front', 'plan'] },
          a: vec3,
          b: vec3,
          depth: num,
          radius: num,
          scale: num,
          flip: { type: 'boolean' },
        },
        required: ['action'],
      },
    },
    {
      name: 'erection_drawings',
      description:
        'Erection drawings for the facade: bracket setting-out plans per level (-E-NN, anchors dimensioned from grid lines and the slab edge, survey deviations), anchor schedules (-AS-NN) and erection sequences per phase (-ES-NN; by floor when no phases are defined). Actions: list (the sheets), anchor_schedule (rows: anchor, bracket, grid/level ref, x/y/z, type, size, length), export_csv (download the anchor schedule), enable / disable (include them in the drawing set).',
      input_schema: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['list', 'anchor_schedule', 'export_csv', 'enable', 'disable'] }, limit: num },
        required: ['action'],
      },
    },
    {
      name: 'drawing_layout',
      description:
        'Sheet layout of the drawing set. Actions: check (layout check of one drawing, or of every sheet when drawing is omitted: overlapping blocks, blocks outside the frame or over the title block / revision table, lettering below 1.8 mm (2.5 mm for marks), overlapping marks), zones (how large GA elevations / plans and erection sequences are divided: scale, facade planes, zones with their sheets, match-line references), set_zoning (enabled, scale = ISO 5455 denominator or 0 for auto, maxZones, overlap mm, splitBy grids|equal, viewDirection auto|world|normal, gaSheet A3|A2|A1|A0 for GA and erection sequences). Tables that do not fit continue on further sheets of the same drawing (same number, sheet n/N).',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['check', 'zones', 'set_zoning'] },
          drawing: { type: 'string', description: 'Drawing id or number (check); omit for all sheets' },
          enabled: { type: 'boolean' },
          scale: num,
          maxZones: num,
          overlap: num,
          splitBy: { type: 'string', enum: ['grids', 'equal'] },
          viewDirection: { type: 'string', enum: ['auto', 'world', 'normal'] },
          gaSheet: { type: 'string', enum: ['A3', 'A2', 'A1', 'A0'] },
        },
        required: ['action'],
      },
    },
    {
      name: 'sheet_templates',
      description:
        'Company sheet templates (title block layout, logo, fixed notes). Actions: list (templates, the active one and the field sources), create (copy of the default ISO 7200 block or of "from"), update (name, width, height, grid, fields, notes of a template), set_active (id, or "iso7200" for the default), delete, import_dxf (the client\'s title block from DXF text "dxf": linework, texts, blocks with attributes; placeholders like {PROJECT} {DRAWING_NO} and attribute tags become fields; optional units mm per drawing unit, name, map, activate), map_texts (id, map: change what free texts show). A field is {label, source, col, row, w, h, textH?, bold?} in grid cells (row 0 = bottom); source is one of the listed sources, "text:<fixed text>", "fmt:<text with {PLACEHOLDERS}>", or "" (leave out, import only). map items: {i (text index from import_dxf / list), source}.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'update', 'set_active', 'delete', 'import_dxf', 'map_texts'] },
          id: str,
          from: str,
          name: str,
          width: num,
          height: num,
          grid: num,
          fields: {
            type: 'array',
            items: {
              type: 'object',
              properties: { label: str, source: str, col: num, row: num, w: num, h: num, textH: num, bold: { type: 'boolean' } },
              required: ['label', 'source', 'col', 'row', 'w', 'h'],
            },
          },
          notes: { type: 'array', items: str },
          activate: { type: 'boolean' },
          dxf: { type: 'string', description: 'DXF file content (import_dxf)' },
          units: { type: 'number', description: 'mm per drawing unit (import_dxf; default from the file)' },
          map: { type: 'array', items: { type: 'object', properties: { i: num, source: str }, required: ['i', 'source'] } },
        },
        required: ['action'],
      },
    },
  ],
  run: {
    drawing_markup(input: Json) {
      const d = findDrawing(input.drawing);
      const action = String(input.action);
      const label = (what: string) => `Assistant: ${what} on ${d.number}`;
      switch (action) {
        case 'list_items':
          return { drawing: summary(d), sheet: d.sheet, items: editableItems(d).slice(0, 200) };
        case 'add_note': {
          const text = String(input.text ?? '').trim();
          if (!text) throw new Error('text is required.');
          const p = { x: n(input.x, 'x'), y: n(input.y, 'y') };
          const leader = input.leaderX !== undefined && input.leaderY !== undefined ? { x: n(input.leaderX, 'leaderX'), y: n(input.leaderY, 'leaderY') } : undefined;
          let id = '';
          st().apply(label('add note'), (q) => void (id = addNote(q, d.id, { p, text, leader, h: input.height ? n(input.height, 'height') : undefined })));
          return { added: id, drawing: d.number };
        }
        case 'add_cloud': {
          const r = input.rect;
          if (!Array.isArray(r) || r.length !== 4) throw new Error('rect must be [x0, y0, x1, y1].');
          const [x0, y0, x1, y1] = r.map((v, i) => n(v, `rect[${i}]`));
          let id = '';
          st().apply(label('add revision cloud'), (q) => void (id = addCloud(q, d.id, rectPts({ x: x0, y: y0 }, { x: x1, y: y1 }), String(input.rev ?? '').trim() || '?')));
          return { added: id, drawing: d.number };
        }
        case 'move': {
          const item = String(input.item ?? '');
          if (!d.entities.some((e) => e.group === item)) throw new Error(`"${item}" is not a view or table group on ${d.number}; use list_items.`);
          st().apply(label(`move ${item}`), (q) => moveGroup(q, d.id, item, { x: Number(input.dx) || 0, y: Number(input.dy) || 0 }));
          return { moved: item };
        }
        case 'offset_dimension': {
          const item = String(input.item ?? '');
          if (!d.entities.some((e) => e.id === item && e.shift)) throw new Error(`"${item}" is not a dimension on ${d.number}; use list_items.`);
          st().apply(label('offset dimension'), (q) => offsetDim(q, d.id, item, n(input.offset, 'offset')));
          return { offset: item };
        }
        case 'hide': {
          const item = String(input.item ?? '');
          if (!d.entities.some((e) => e.id === item || e.group === item)) throw new Error(`No item "${item}" on ${d.number}; use list_items.`);
          st().apply(label(`hide ${item}`), (q) => hideItem(q, d.id, item));
          return { hidden: item };
        }
        case 'show_all':
          st().apply(label('show hidden items'), (q) => unhideItem(q, d.id));
          return { ok: true };
        case 'reset':
          st().apply(label('reset edits'), (q) => resetEdits(q, d.id));
          return { ok: true };
        default:
          throw new Error(`Unknown action ${action}.`);
      }
    },

    ga_cuts(input: Json) {
      const action = String(input.action);
      const p = st().project;
      const cuts = p.drawings.cuts ?? [];
      const show = (c: GaCut) => ({ ...c, sheet: sheetIndex().find((d) => d.id === `cut-${c.id}`)?.number });
      if (action === 'list') return cuts.map(show);
      if (action === 'delete') {
        if (!cuts.some((c) => c.id === input.id)) throw new Error(`No cut "${input.id}".`);
        st().apply('Assistant: delete GA cut', (q) => void (q.drawings.cuts = (q.drawings.cuts ?? []).filter((c) => c.id !== input.id)));
        return { deleted: input.id };
      }
      const patch = (c: GaCut) => {
        if (input.kind) c.kind = input.kind === 'detail' ? 'detail' : 'section';
        if (input.name) c.name = String(input.name).trim().toUpperCase();
        if (input.view) c.view = input.view as GaCut['view'];
        if (input.a) c.a = v3(input.a, 'a');
        if (input.b) c.b = v3(input.b, 'b');
        if (c.kind === 'detail') {
          c.b = { ...c.a };
          if (input.radius !== undefined) c.depth = n(input.radius, 'radius');
        } else if (input.depth !== undefined) c.depth = n(input.depth, 'depth');
        if (input.scale !== undefined) c.scale = Math.max(0, n(input.scale, 'scale'));
        if (input.flip !== undefined) c.flip = !!input.flip;
      };
      if (action === 'add') {
        if (!input.a) throw new Error('a (cut line start or detail centre) is required.');
        const kind = input.kind === 'detail' ? 'detail' : 'section';
        if (kind === 'section' && !input.b) throw new Error('b (cut line end) is required for a section.');
        const c: GaCut = { id: newId('cut'), name: nextCutLetter(p), kind, a: v3(input.a, 'a'), b: v3(input.b ?? input.a, 'b'), depth: kind === 'detail' ? 300 : 1000, scale: 0, view: 'front' };
        patch(c);
        st().apply(`Assistant: add ${kind} ${c.name}`, (q) => void (q.drawings.cuts ??= []).push(c));
        return show(c);
      }
      if (action === 'update') {
        if (!cuts.some((c) => c.id === input.id)) throw new Error(`No cut "${input.id}".`);
        st().apply('Assistant: edit GA cut', (q) => {
          const c = (q.drawings.cuts ?? []).find((x) => x.id === input.id);
          if (c) patch(c);
        });
        return show(st().project.drawings.cuts.find((c) => c.id === input.id)!);
      }
      throw new Error(`Unknown action ${action}.`);
    },

    erection_drawings(input: Json) {
      const action = String(input.action);
      if (action === 'enable' || action === 'disable') {
        st().apply(`Assistant: ${action} erection drawings`, (q) => void (q.drawings.settings.erection = action === 'enable'));
        return { erection: action === 'enable' };
      }
      if (action === 'list') {
        const list = sheetIndex().filter((d) => ERECTION.has(d.kind)).map(summary);
        return { erection: st().project.drawings.settings.erection !== false, sheets: list };
      }
      const p = st().project;
      const dm = derived(p);
      if (action === 'anchor_schedule') {
        const rows = anchorRows(p, dm);
        const limit = Math.max(1, Math.min(500, Number(input.limit) || 200));
        return { total: rows.length, rows: rows.slice(0, limit) };
      }
      if (action === 'export_csv') {
        exportAnchorScheduleCsv();
        return { exported: anchorRows(p, dm).length };
      }
      throw new Error(`Unknown action ${action}.`);
    },

    drawing_layout(input: Json) {
      const action = String(input.action);
      if (action === 'check') {
        // Every sheet is made one at a time (and released), only its problems are kept.
        const set = currentDrawingSet();
        const ids = input.drawing ? [findDrawing(input.drawing).id] : sheetIndex().map((e) => e.id);
        const sheets: (ReturnType<typeof summary> & { issues: string[]; notices: string[] })[] = [];
        for (const d of set.sheets(ids)) {
          const x = { ...summary(d), issues: checkSheetLayout(d).map((i) => i.message), notices: d.notices ?? [] };
          if (input.drawing || x.issues.length || x.notices.length) sheets.push(x);
        }
        return { checked: ids.length, withProblems: sheets.filter((x) => x.issues.length).length, sheets: sheets.slice(0, 60) };
      }
      if (action === 'zones') {
        const p = st().project;
        const ctx = makeCtx(p, derived(p));
        const ds = sheetIndex();
        const view = (v: 'front' | 'plan') => {
          const plan = zonePlanFor(ctx, v);
          if (!plan) return { divided: false };
          return {
            divided: true,
            scale: `1:${plan.den}`,
            legibleScale: plan.legible ? `1:${plan.legible}` : null,
            reason: plan.reason,
            facadePlanes: plan.segments.map((sg) => ({ name: sg.name, view: sg.frame.kind, tiltFromVertical: Math.round(sg.tilt), assemblies: sg.assemblies.length })),
            zones: plan.zones.map((z) => ({
              zone: z.index,
              name: z.name,
              assemblies: z.assemblies.length,
              sheets: ds.filter((d) => d.zone?.index === z.index && d.id.startsWith(v === 'front' ? 'ga-front-z' : 'ga-plan-z')).map((d) => sheetLabel(d)),
              matchLines: z.match.map((m) => ({ side: m.side, zone: m.zone, fold: !!m.fold })),
            })),
          };
        };
        return { settings: zoningSettings(p), gaSheet: p.drawings.settings.gaSheet, front: view('front'), plan: view('plan'), erectionSheets: ds.filter((d) => d.kind === 'sequence' && d.zone).length };
      }
      if (action === 'set_zoning') {
        const patch: Partial<DrawingZoning> = {};
        if (input.enabled !== undefined) patch.enabled = !!input.enabled;
        if (input.scale !== undefined) patch.scale = Math.max(0, n(input.scale, 'scale'));
        if (input.maxZones !== undefined) patch.maxZones = Math.max(1, Math.round(n(input.maxZones, 'maxZones')));
        if (input.overlap !== undefined) patch.overlap = Math.max(0, n(input.overlap, 'overlap'));
        if (input.splitBy !== undefined) patch.splitBy = input.splitBy === 'equal' ? 'equal' : 'grids';
        if (input.viewDirection !== undefined) {
          if (!['auto', 'world', 'normal'].includes(String(input.viewDirection))) throw new Error('viewDirection must be auto, world or normal.');
          patch.viewDirection = input.viewDirection as DrawingZoning['viewDirection'];
        }
        const sheet = input.gaSheet !== undefined ? String(input.gaSheet) : undefined;
        if (sheet && !['A3', 'A2', 'A1', 'A0'].includes(sheet)) throw new Error('gaSheet must be A3, A2, A1 or A0.');
        st().apply('Assistant: drawing zones', (q) => {
          q.drawings.settings.zoning = { ...zoningSettings(q), ...patch };
          if (sheet) q.drawings.settings.gaSheet = sheet as SheetSize;
        });
        const p = st().project;
        return { settings: zoningSettings(p), gaSheet: p.drawings.settings.gaSheet };
      }
      throw new Error(`Unknown action ${action}.`);
    },

    sheet_templates(input: Json) {
      const action = String(input.action);
      const p = st().project;
      const list = p.drawings.templates ?? [];
      const brief = (t: SheetTemplate) => ({
        id: t.id,
        name: t.name,
        width: t.width,
        height: t.height,
        grid: t.grid ?? 1,
        fields: t.fields,
        notes: t.notes,
        logo: !!t.logo,
        ...(t.texts?.length ? { texts: t.texts.map((x, i) => ({ i, source: x.source, ...(x.origin ? { origin: x.origin } : {}) })) } : {}),
        ...(t.graphics?.length ? { graphics: t.graphics.length } : {}),
        ...(t.imported ? { imported: t.imported } : {}),
      });
      const checkSource = (src: string) => {
        if (src && !src.startsWith('text:') && !src.startsWith('fmt:') && !FIELD_SOURCES.some((f) => f.value === src)) throw new Error(`Unknown source "${src}". Sources: ${FIELD_SOURCES.map((f) => f.value).join(', ')}, fmt:<text>.`);
      };
      if (action === 'list')
        return { active: p.drawings.activeTemplate ?? DEFAULT_TEMPLATE_ID, templates: [brief(DEFAULT_TEMPLATE), ...list.map(brief)], sources: FIELD_SOURCES.map((s) => s.value) };
      const apply = (t: SheetTemplate) => {
        if (input.name) t.name = String(input.name);
        if (input.width !== undefined) t.width = n(input.width, 'width');
        if (input.height !== undefined) t.height = n(input.height, 'height');
        if (input.grid !== undefined) t.grid = n(input.grid, 'grid');
        if (Array.isArray(input.fields)) t.fields = input.fields as SheetTemplate['fields'];
        if (Array.isArray(input.notes)) t.notes = input.notes.map(String);
        Object.assign(t, sanitizeTemplate(t));
      };
      if (action === 'import_dxf') {
        if (typeof input.dxf !== 'string' || !input.dxf.trim()) throw new Error('Give the DXF file content as "dxf".');
        const imp = readTitleBlockDxf(input.dxf, input.units !== undefined ? { unitScale: n(input.units, 'units') } : {});
        const map = imp.texts.map((x) => x.suggested);
        for (const m of Array.isArray(input.map) ? (input.map as Json[]) : []) {
          const i = Math.round(n(m.i, 'map.i'));
          if (!(i >= 0 && i < map.length)) throw new Error(`No text ${i}: the DXF has ${map.length} texts.`);
          checkSource(String(m.source ?? ''));
          map[i] = String(m.source ?? '');
        }
        const t = titleBlockTemplate(imp, newId('tpl'), { name: String(input.name ?? 'Imported title block'), map, file: 'assistant.dxf' });
        st().apply('Assistant: import title block', (q) => {
          (q.drawings.templates ??= []).push(t);
          if (input.activate) q.drawings.activeTemplate = t.id;
        });
        return {
          ...brief(t),
          units: imp.units,
          unitSource: imp.unitSource,
          summary: titleBlockSummary(imp),
          notes: imp.notes,
          dxfTexts: imp.texts.map((x, i) => ({ i, kind: x.kind, ...(x.tag ? { tag: x.tag } : {}), text: x.lines.map((l) => l.text).join(' / '), source: map[i] })),
        };
      }
      if (action === 'create') {
        const from = input.from ? list.find((t) => t.id === input.from) : undefined;
        if (input.from && !from && input.from !== DEFAULT_TEMPLATE_ID) throw new Error(`No template "${input.from}".`);
        const t = newTemplate(newId('tpl'), String(input.name ?? 'Company template'), from ?? DEFAULT_TEMPLATE);
        apply(t);
        st().apply('Assistant: new sheet template', (q) => {
          (q.drawings.templates ??= []).push(t);
          if (input.activate) q.drawings.activeTemplate = t.id;
        });
        return brief(t);
      }
      if (action === 'set_active') {
        const id = String(input.id ?? '');
        if (id !== DEFAULT_TEMPLATE_ID && !list.some((t) => t.id === id)) throw new Error(`No template "${id}".`);
        st().apply('Assistant: sheet template', (q) => void (q.drawings.activeTemplate = id === DEFAULT_TEMPLATE_ID ? undefined : id));
        return { active: id };
      }
      const t = list.find((x) => x.id === input.id);
      if (!t) throw new Error(input.id === DEFAULT_TEMPLATE_ID ? 'The default ISO 7200 template cannot be changed; create a copy.' : `No template "${input.id}".`);
      if (action === 'map_texts') {
        const items = Array.isArray(input.map) ? (input.map as Json[]) : [];
        if (!items.length) throw new Error('Give "map": [{ i, source }] (text indices from list).');
        const count = t.texts?.length ?? 0;
        for (const m of items) {
          const i = Math.round(n(m.i, 'map.i'));
          if (!(i >= 0 && i < count)) throw new Error(`No text ${i}: the template has ${count} free texts.`);
          checkSource(String(m.source ?? ''));
        }
        st().apply('Assistant: map title block texts', (q) => {
          const x = (q.drawings.templates ?? []).find((y) => y.id === t.id);
          if (!x?.texts) return;
          const drop = new Set<number>();
          for (const m of items) {
            const i = Math.round(Number(m.i));
            const tx = x.texts[i];
            const src = String(m.source ?? '');
            if (!src) drop.add(i);
            // "text:" alone keeps the text as it reads now (its fixed text or the original DXF text).
            else tx.source = src === 'text:' ? `text:${tx.source.startsWith('text:') ? tx.source.slice(5) : tx.source.startsWith('fmt:') ? tx.source.slice(4) : (tx.origin ?? '')}` : src;
          }
          x.texts = x.texts.filter((_, i) => !drop.has(i));
        });
        return brief(st().project.drawings.templates.find((x) => x.id === t.id)!);
      }
      if (action === 'update') {
        st().apply('Assistant: edit sheet template', (q) => {
          const x = (q.drawings.templates ?? []).find((y) => y.id === t.id);
          if (x) apply(x);
        });
        return brief(st().project.drawings.templates.find((x) => x.id === t.id)!);
      }
      if (action === 'delete') {
        st().apply('Assistant: delete sheet template', (q) => {
          q.drawings.templates = (q.drawings.templates ?? []).filter((x) => x.id !== t.id);
          if (q.drawings.activeTemplate === t.id) q.drawings.activeTemplate = undefined;
        });
        return { deleted: t.id };
      }
      throw new Error(`Unknown action ${action}.`);
    },
  },
};
