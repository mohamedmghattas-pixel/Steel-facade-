/**
 * Assistant tools for the connection library: browse the catalogue (use,
 * members, standards notes, key parameters) and dry-run a connection type with
 * parameters on a typical joint or the user's selection to see its parts and
 * detailing-check findings before applying it.
 */
import type { ToolModule, Json } from './types';
import { useStore } from '../../state/store';
import { CONNECTIONS } from '../../core/connections/registry';
import { CATALOG, CATEGORIES, searchCatalog, type CategoryId } from '../../core/connections/catalog';
import { previewFindings, previewFromMembers, previewJoint } from '../../core/connections/preview';
import { deriveModel } from '../../core/derive/model';
import { codeForProject } from '../../core/codes';
import type { ConnectionType, ParamValue } from '../../core/model/types';

const TYPES = Object.keys(CONNECTIONS) as ConnectionType[];
const round = (n: number) => Math.round(n * 10) / 10;

export const connectionsModule: ToolModule = {
  tools: [
    {
      name: 'connection_library',
      description:
        'Browse the connection library: every connection type with its category (steel to concrete, steel to steel, splices & movement joints, bracing & gussets, hangers & ties, custom), typical facade use, required members, standards notes and key parameters with their options. Filter by category or a search query (e.g. "rainscreen", "slot", "no drilling").',
      input_schema: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: CATEGORIES.map((c) => c.id) },
          query: { type: 'string', description: 'Words that must all appear in the name, summary, use or tags' },
        },
      },
    },
    {
      name: 'preview_connection',
      description:
        'Dry-run a connection type with parameters without changing the model: builds it on a typical joint (or on the first suitable end of the selected members when onSelection is true), derives the parts and returns plates, profiles, bolts/anchors, holes and the detailing-check errors and warnings. Use it to pick parameters before apply_connection.',
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: TYPES },
          params: { type: 'object', description: 'Parameter values, e.g. {"variant": "sliding point", "angle": "L 150x100x10"}' },
          onSelection: { type: 'boolean', description: 'Preview on the user\'s selected members instead of a typical joint' },
          secondaryProfile: { type: 'string', description: 'Profile of the supported member in the typical joint (e.g. "CHS 48.3x3.2" for a tube brace)' },
        },
        required: ['type'],
      },
    },
  ],
  run: {
    connection_library: (input: Json) => {
      const labels = Object.fromEntries(TYPES.map((t) => [t, CONNECTIONS[t].label]));
      const cat = input.category as CategoryId | undefined;
      const list = (input.query ? searchCatalog(String(input.query), labels) : Object.values(CATALOG)).filter((e) => !cat || e.category === cat);
      const p = useStore.getState().project;
      return {
        categories: CATEGORIES.map((c) => ({ id: c.id, label: c.label })),
        types: list.map((e) => {
          const def = CONNECTIONS[e.type];
          const key = new Set(e.keyParams);
          return {
            type: e.type,
            label: def.label,
            category: e.category,
            summary: e.summary,
            use: e.use,
            members: e.members,
            needsMain: def.needsMain,
            standards: e.standards,
            keyParams: def.params.filter((x) => key.has(x.key)).map((x) => ({ key: x.key, label: x.label, default: x.default, unit: x.unit, options: x.options })),
          };
        }),
        templates: !cat || cat === 'custom' ? p.library.templates.map((t) => ({ id: t.id, name: t.name, needsMain: t.needsMain })) : [],
        presets: !cat || cat === 'custom' ? p.library.presets.map((x) => ({ id: x.id, name: x.name, type: x.type })) : [],
        note: 'Detailing only — capacity by the engineer of record.',
      };
    },
    preview_connection: (input: Json) => {
      const type = input.type as ConnectionType;
      if (!CONNECTIONS[type]) throw new Error(`Unknown connection type ${String(input.type)}`);
      const params = (input.params as Record<string, ParamValue>) ?? {};
      const s = useStore.getState();
      const p = s.project;
      const pj =
        (input.onSelection && s.selection.members.length ? previewFromMembers(p, s.selection.members, type, params) : null) ??
        previewJoint(type, params, { base: p, secondaryProfile: input.secondaryProfile ? String(input.secondaryProfile) : undefined });
      const dm = deriveModel(pj.project);
      const parts = dm.parts.filter((x) => x.connectionId === pj.connectionId);
      const findings = previewFindings(pj, dm, codeForProject(p));
      return {
        joint: pj.kind,
        parts: parts.map((x) => ({ name: x.name, profile: x.profile, size: x.kind === 'plate' ? `${round(x.length)} × ${round(x.width)}` : `L ${round(x.length)}`, holes: (x.plateHoles?.length ?? 0) + x.holes.length, kg: round(x.mass) })),
        bolts: dm.bolts.filter((b) => b.connectionId === pj.connectionId).map((b) => ({ size: b.size, grade: b.grade, kind: b.kind, qty: b.positions.length, length: b.length })),
        memberHoles: dm.parts.filter((x) => x.kind === 'member').reduce((n, x) => n + x.holes.length, 0),
        errors: findings.filter((f) => f.severity === 'error').map((f) => f.text),
        warnings: findings.filter((f) => f.severity === 'warning').map((f) => f.text),
      };
    },
  },
};
