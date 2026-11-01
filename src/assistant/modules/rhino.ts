/**
 * Assistant tools for Rhino (.3dm): summarise (and optionally adjust and apply)
 * the import loaded in the import dialog, and export the model as .3dm
 * (docs/RHINO.md).
 */
import { MEMBER_ROLES, type MemberRole } from '../../core/model/types';
import { getProfile } from '../../core/library/profiles';
import { RHINO_ACTIONS, RHINO_GROUP_LABEL, RHINO_GROUPS, rhinoImportPlan, type RhinoLayerAction, type RhinoLayerSetting } from '../../core/io/rhinoLayers';
import { applyRhinoImport, exportRhinoFile, rhinoOptions, updateRhinoSettings, useRhino } from '../../ui/rhinoActions';
import type { Json, ToolModule } from './types';

const str = { type: 'string' } as const;

function summary() {
  const pending = useRhino.getState().pending;
  if (!pending) throw new Error('No Rhino file is loaded — ask the user to use Import → Import Rhino (.3dm)… (the summary reads the open import dialog).');
  const { read, settings } = pending;
  const plan = rhinoImportPlan(read, rhinoOptions(settings));
  return {
    file: pending.name,
    application: read.application || undefined,
    units: { file: read.units.name, mmPerUnit: read.units.scale, fromFile: read.units.fileScale },
    objects: read.stats.objects,
    blockInstances: read.stats.instances,
    hiddenObjects: read.stats.hidden,
    bounds: read.bounds,
    layers: read.layers
      .filter((l) => Object.keys(l.counts).length)
      .map((l) => {
        const s = settings.layers[l.fullPath];
        return {
          layer: l.fullPath,
          visible: l.visible,
          objects: RHINO_GROUPS.filter((g) => l.counts[g]).map((g) => `${l.counts[g]} ${RHINO_GROUP_LABEL[g]}`).join(', '),
          import: s.on,
          action: s.on ? s.action : 'ignore',
          ...(s.action === 'wireframe' ? { role: s.role, profile: s.profile } : {}),
        };
      }),
    willCreate: {
      wireframe: plan.wireframe,
      reference: plan.reference,
      panels: plan.panels,
      survey: plan.survey,
      keepOriginal: settings.keepOriginal,
    },
    skipped: plan.skipped.slice(0, 30),
    warnings: read.warnings,
  };
}

export const rhinoModule: ToolModule = {
  tools: [
    {
      name: 'rhino_import_summary',
      description:
        'Summary of the Rhino .3dm file loaded in the import dialog: units, layers with object counts and their action (wireframe / reference / panels / survey / ignore, role and profile for wireframe layers), what the import will create (wire lines, reference model, panel outlines, survey points) and what is skipped and why. layers changes actions first; apply: true runs the import (one undo step) and opens the wireframe check.',
      input_schema: {
        type: 'object',
        properties: {
          layers: {
            type: 'array',
            description: 'Per-layer changes (full layer path as in the summary).',
            items: {
              type: 'object',
              properties: { layer: str, action: { type: 'string', enum: [...RHINO_ACTIONS] }, role: { type: 'string', enum: [...MEMBER_ROLES] }, profile: { type: 'string', description: 'Profile name; "" = construction lines' } },
              required: ['layer'],
            },
          },
          includeHidden: { type: 'boolean' },
          keepOriginal: { type: 'boolean', description: 'Keep the original .3dm with the project (export package 00-References).' },
          apply: { type: 'boolean' },
        },
      },
    },
    {
      name: 'rhino_export',
      description:
        'Download the model as a Rhino .3dm file (millimetres): one mesh per part named by mark with user strings (mark, assembly, profile, material, length, weight, phase, zone, batch, role, normal …) on FacadeSteel::Members::<role> / Connections / Plates, bolts, and wire lines on FacadeSteel::Wireframe.',
      input_schema: {
        type: 'object',
        properties: {
          wireframe: { type: 'boolean', description: 'Wire lines (default true)' },
          bolts: { type: 'boolean', description: 'Bolts and anchors (default true)' },
          blocks: { type: 'boolean', description: 'Assemblies as block definitions + instances (default false)' },
          references: { type: 'boolean', description: 'Also write the visible Rhino reference models (default false)' },
        },
      },
    },
  ],
  run: {
    async rhino_import_summary(input: Json) {
      const pending = useRhino.getState().pending;
      if (pending && Array.isArray(input.layers)) {
        const layers = { ...pending.settings.layers };
        const unknown: string[] = [];
        for (const raw of input.layers as Json[]) {
          const name = String(raw.layer ?? '');
          if (!layers[name]) {
            unknown.push(name);
            continue;
          }
          const patch: Partial<RhinoLayerSetting> = {};
          if (typeof raw.action === 'string' && (RHINO_ACTIONS as string[]).includes(raw.action)) Object.assign(patch, { action: raw.action as RhinoLayerAction, on: raw.action !== 'ignore' });
          if (typeof raw.role === 'string' && (MEMBER_ROLES as string[]).includes(raw.role)) patch.role = raw.role as MemberRole;
          if (raw.profile === null || raw.profile === '') patch.profile = null;
          else if (typeof raw.profile === 'string') {
            if (!getProfile(raw.profile)) throw new Error(`Unknown profile "${raw.profile}".`);
            patch.profile = raw.profile;
          }
          layers[name] = { ...layers[name], ...patch };
        }
        if (unknown.length) throw new Error(`No such layer: ${unknown.join(', ')}. Layers: ${Object.keys(layers).join(', ')}`);
        updateRhinoSettings({ layers });
      }
      if (pending && typeof input.includeHidden === 'boolean') updateRhinoSettings({ includeHidden: input.includeHidden });
      if (pending && typeof input.keepOriginal === 'boolean') updateRhinoSettings({ keepOriginal: input.keepOriginal });
      const s = summary();
      if (!input.apply) return s;
      const res = await applyRhinoImport();
      if (!res) throw new Error('The import failed (see the message in the app).');
      return { ...s, imported: { lines: res.lines, referenceId: res.referenceId, surveyPoints: res.survey, panelOutlines: res.panels, next: res.lines ? 'wireframe check opened' : res.panels ? 'panel layout dialog opened' : undefined } };
    },
    async rhino_export(input: Json) {
      const stats = await exportRhinoFile({ wireframe: input.wireframe !== false, bolts: input.bolts !== false, blocks: !!input.blocks, references: !!input.references });
      if (!stats) throw new Error('The Rhino export failed (see the message in the app).');
      return { downloaded: true, units: 'mm', ...stats };
    },
  },
};
