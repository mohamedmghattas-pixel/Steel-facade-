/**
 * Assistant tools for fabrication and supply chain: plate CNC files, labels,
 * packing lists, galvanizing and paint lists, MIS export, stock on hand.
 */
import type { FabricationSettings, LabelLayout, PaintCoat, StockItem } from '../../core/model/types';
import { derived, useStore } from '../../state/store';
import { fabSettings } from '../../core/fabrication/settings';
import { LABEL_LAYOUTS, labelItems } from '../../core/fabrication/labels';
import { packingLists } from '../../core/fabrication/packing';
import { galvanizingReport } from '../../core/fabrication/galvanizing';
import { paintAreas } from '../../core/fabrication/paint';
import { misExport } from '../../core/fabrication/mis';
import { fmtDims } from '../../core/fabrication/geometry';
import { planBars } from '../../core/optimize/barNesting';
import { nestPlates } from '../../core/optimize/plateNesting';
import {
  exportGalvanizing,
  exportLabels,
  exportMis,
  exportNestedDxf,
  exportPackingLists,
  exportPaint,
  exportPlateDxf,
  exportPlateNc,
  exportPurchaseList,
  exportStockCsv,
  importStockText,
  setFabSettings,
  setStock,
} from '../../ui/fabricationActions';
import type { Json, ToolModule } from './types';

const st = () => useStore.getState();
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const LAYOUT_IDS = Object.keys(LABEL_LAYOUTS) as LabelLayout[];
const EXPORTS = ['plate_dxf', 'nested_dxf', 'plate_nc', 'labels_pdf', 'packing_xlsx', 'packing_pdf', 'galvanizing_xlsx', 'paint_xlsx', 'mis_zip', 'purchase_xlsx', 'stock_csv'] as const;

const num = { type: 'number' } as const;
const str = { type: 'string' } as const;

export const fabricationModule: ToolModule = {
  tools: [
    {
      name: 'fabrication_export',
      description:
        'Download fabrication outputs: plate_dxf (CNC DXF per unique plate, layers OUTLINE/HOLES/MARKING), nested_dxf (one DXF per nested sheet), plate_nc (DSTV NC1 for plates), labels_pdf (part labels with QR + Code 128), packing_xlsx / packing_pdf (per delivery batch), galvanizing_xlsx (dip size checks), paint_xlsx (paint areas, litres), mis_zip (MIS/ERP JSON + CSV + IFC), purchase_xlsx (bars to buy after stock on hand), stock_csv.',
      input_schema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...EXPORTS] },
          layout: { type: 'string', enum: LAYOUT_IDS, description: 'Label sheet layout (labels_pdf)' },
          per: { type: 'string', enum: ['piece', 'mark'], description: 'One label per physical piece or per unique mark (labels_pdf)' },
        },
        required: ['kind'],
      },
    },
    {
      name: 'fabrication_report',
      description:
        'Read fabrication data without downloading: packing (per delivery batch: assemblies, loose parts, bolts, weights), galvanizing (dip class per HDG assembly vs the bath, vent/drain reminders), paint (areas, coats, litres), stock (bars from stock on hand, purchase list, remaining stock), plates (nested sheets), labels (count, layout).',
      input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['packing', 'galvanizing', 'paint', 'stock', 'plates', 'labels', 'mis'] } }, required: ['kind'] },
    },
    {
      name: 'set_stock',
      description:
        'Set the stock on hand used first by bar nesting. Give CSV text (profile, length, qty, material; header optional, qty -1 = unlimited, lengths in mm or with "m") or items. action: replace (default), append or clear.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['replace', 'append', 'clear'] },
          csv: str,
          items: {
            type: 'array',
            items: { type: 'object', properties: { profile: str, length: num, qty: num, material: str }, required: ['profile', 'length', 'qty'] },
          },
        },
      },
    },
    {
      name: 'set_fabrication_settings',
      description:
        'Change fabrication settings: DXF part-mark text (dxfMarking, markHeight mm), plate cutting kerf for nesting (plateKerf mm), label layout and per piece/mark, galvanizing bath inside size (galvBath mm) and clearance, paint coats (name, dft µm, solids %) and application loss %, DSTV through holes of hollow sections on one face or both faces (dstvHollowThrough).',
      input_schema: {
        type: 'object',
        properties: {
          dxfMarking: { type: 'boolean' },
          markHeight: num,
          plateKerf: num,
          labelLayout: { type: 'string', enum: LAYOUT_IDS },
          labelPer: { type: 'string', enum: ['piece', 'mark'] },
          galvBath: { type: 'object', properties: { length: num, width: num, depth: num } },
          galvClearance: num,
          paintCoats: { type: 'array', items: { type: 'object', properties: { name: str, dft: num, solids: num }, required: ['dft', 'solids'] } },
          paintLoss: num,
          dstvHollowThrough: { type: 'string', enum: ['one', 'both'] },
        },
      },
    },
  ],
  run: {
    fabrication_export: async (input: Json) => {
      const kind = String(input.kind);
      const per = input.per === 'mark' || input.per === 'piece' ? input.per : undefined;
      const layout = LAYOUT_IDS.includes(input.layout as LabelLayout) ? (input.layout as LabelLayout) : undefined;
      switch (kind) {
        case 'plate_dxf':
          return { downloaded: kind, files: exportPlateDxf() };
        case 'nested_dxf':
          return { downloaded: kind, sheets: exportNestedDxf() };
        case 'plate_nc':
          return { downloaded: kind, files: exportPlateNc() };
        case 'labels_pdf':
          return { downloaded: kind, labels: await exportLabels({ layout, per }) };
        case 'packing_xlsx':
          return { downloaded: kind, batches: await exportPackingLists('xlsx') };
        case 'packing_pdf':
          return { downloaded: kind, batches: await exportPackingLists('pdf') };
        case 'galvanizing_xlsx':
          exportGalvanizing();
          return { downloaded: kind };
        case 'paint_xlsx':
          exportPaint();
          return { downloaded: kind };
        case 'mis_zip':
          exportMis();
          return { downloaded: kind };
        case 'purchase_xlsx':
          exportPurchaseList();
          return { downloaded: kind };
        case 'stock_csv':
          exportStockCsv();
          return { downloaded: kind };
      }
      throw new Error(`Unknown export kind ${kind}; use one of ${EXPORTS.join(', ')}`);
    },

    fabrication_report: (input: Json) => {
      const p = st().project;
      const dm = derived(p);
      switch (input.kind) {
        case 'packing':
          return packingLists(p, dm).map((l) => ({
            batch: l.batch,
            date: l.date,
            totals: { pieces: l.totals.pieces, steelKg: r1(l.totals.weight), bolts: l.totals.bolts, fastenerKgEstimate: r1(l.totals.boltWeight) },
            assemblies: l.assemblies.map((i) => ({ mark: i.mark, qty: i.qty, kgEach: r2(i.unitWeight), dims: fmtDims(i.dims), finish: i.finish })),
            loose: l.loose.map((i) => ({ mark: i.mark, qty: i.qty, kgEach: r2(i.unitWeight) })),
            bolts: l.bolts.map((b) => ({ item: b.description, qty: b.qty })),
          }));
        case 'galvanizing': {
          const g = galvanizingReport(p, dm);
          return {
            bath: g.bath,
            clearance: g.clearance,
            rule: 'Typical rule: single dip if it fits with clearance; double dip if one dimension exceeds the bath length or depth by up to ~2x. Confirm with the galvanizer.',
            totals: { ...g.totals, weight: r1(g.totals.weight) },
            batches: g.batches.map((b) => ({
              batch: b.batch,
              pieces: b.totals.pieces,
              kg: r1(b.totals.weight),
              items: b.items.map((i) => ({ mark: i.mark, qty: i.qty, dims: fmtDims(i.dims), dip: i.dip.cls, ventDrain: !!i.vent })),
            })),
          };
        }
        case 'paint': {
          const r = paintAreas(p, dm);
          return {
            areaM2: r2(r.totals.area),
            paintM2: r2(r.totals.paint),
            duplexM2: r2(r.totals.duplex),
            lossPct: r.loss,
            coats: r.coats.map((c) => ({ name: c.name, dft: c.dft, solids: c.solids, tsrM2PerL: r2(c.tsr), litres: r1(c.litres) })),
            byAssembly: r.rows.map((x) => ({ mark: x.mark, qty: x.qty, m2Each: r2(x.each) })),
          };
        }
        case 'stock': {
          const plan = planBars(p, dm);
          return {
            stockItems: p.settings.stock.length,
            fromStock: plan.used,
            purchase: plan.purchase,
            remaining: plan.remaining,
            unplaced: plan.groups.flatMap((g) => g.unplaced.map((u) => `${g.profile} ${u.mark} ${Math.round(u.length)}`)),
          };
        }
        case 'plates':
          return nestPlates(p, dm).map((g) => ({
            plate: `PL${g.thickness} ${g.material}`,
            sheets: g.sheets.map((s) => ({ size: `${s.sheet.w}x${s.sheet.h}`, parts: s.placements.length, utilisationPct: r1(s.utilisation * 100) })),
            unplaced: g.unplaced.length,
          }));
        case 'labels': {
          const s = fabSettings(p);
          const n = labelItems(p, dm, s.labelPer).length;
          const L = LABEL_LAYOUTS[s.labelLayout];
          return { labels: n, per: s.labelPer, layout: L.name, sheets: Math.ceil(n / (L.cols * L.rows)) };
        }
        case 'mis': {
          const m = misExport(p, dm);
          return { schema: m.schema, version: m.version, totals: m.totals, partMarks: m.parts.length, assemblyMarks: m.assemblies.length, operations: m.operations.length, welds: m.welds.length };
        }
      }
      throw new Error('kind must be packing, galvanizing, paint, stock, plates, labels or mis');
    },

    set_stock: (input: Json) => {
      const action = (input.action as string) ?? 'replace';
      if (action === 'clear') {
        setStock([], 'Clear stock');
        return { stockItems: 0 };
      }
      const mode = action === 'append' ? 'append' : 'replace';
      if (typeof input.csv === 'string' && input.csv.trim()) {
        const res = importStockText(input.csv, mode);
        if (!res.items.length) throw new Error(`No stock rows recognised. ${res.errors.slice(0, 3).join(' ')}`);
        return { imported: res.items.length, stockItems: st().project.settings.stock.length, errors: res.errors.slice(0, 10), warnings: res.warnings };
      }
      const raw = Array.isArray(input.items) ? (input.items as Json[]) : [];
      const items: StockItem[] = raw
        .map((x) => ({ profile: String(x.profile ?? '').trim(), length: Number(x.length), qty: Math.round(Number(x.qty)), ...(x.material ? { material: String(x.material) } : {}) }))
        .filter((x) => x.profile && x.length > 0 && Number.isFinite(x.qty));
      if (!items.length) throw new Error('Give csv text or items with profile, length (mm) and qty (-1 = unlimited).');
      setStock(mode === 'append' ? [...st().project.settings.stock, ...items] : items, 'Set stock');
      return { stockItems: st().project.settings.stock.length };
    },

    set_fabrication_settings: (input: Json) => {
      const patch: Partial<FabricationSettings> = {};
      if (typeof input.dxfMarking === 'boolean') patch.dxfMarking = input.dxfMarking;
      if (Number(input.markHeight) > 0) patch.markHeight = Number(input.markHeight);
      if (Number.isFinite(Number(input.plateKerf)) && input.plateKerf !== undefined) patch.plateKerf = Math.max(0, Number(input.plateKerf));
      if (LAYOUT_IDS.includes(input.labelLayout as LabelLayout)) patch.labelLayout = input.labelLayout as LabelLayout;
      if (input.labelPer === 'piece' || input.labelPer === 'mark') patch.labelPer = input.labelPer;
      if (input.galvClearance !== undefined && Number.isFinite(Number(input.galvClearance))) patch.galvClearance = Math.max(0, Number(input.galvClearance));
      if (Array.isArray(input.paintCoats)) {
        patch.paintCoats = (input.paintCoats as Json[])
          .map((c, i): PaintCoat => ({ name: String(c.name ?? `Coat ${i + 1}`), dft: Number(c.dft), solids: Number(c.solids) }))
          .filter((c) => c.dft > 0 && c.solids > 0 && c.solids <= 100);
      }
      if (input.paintLoss !== undefined && Number.isFinite(Number(input.paintLoss))) patch.paintLoss = Math.min(90, Math.max(0, Number(input.paintLoss)));
      if (input.dstvHollowThrough === 'one' || input.dstvHollowThrough === 'both') patch.dstvHollowThrough = input.dstvHollowThrough;
      if (Object.keys(patch).length) setFabSettings(patch);
      const bath = input.galvBath as Json | undefined;
      if (bath && typeof bath === 'object') {
        st().apply('Galvanizing bath', (p) => {
          for (const k of ['length', 'width', 'depth'] as const) if (Number(bath[k]) > 0) p.settings.galvBath[k] = Number(bath[k]);
        });
      }
      const p = st().project;
      return { fabrication: fabSettings(p), galvBath: p.settings.galvBath };
    },
  },
};
