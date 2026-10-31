/**
 * Assistant tools for movement, tolerances and survey-driven brackets.
 * Edits go through the store's `apply` (undoable).
 */
import type { MovementSettings, ToleranceItem } from '../../core/model/types';
import { newId } from '../../core/model/ops';
import { FACADE_DIRS, movementReport, movementSettings, toleranceStack } from '../../core/movement';
import { applySurvey, clearSurveyAdjustments, parseSurveyCsv, settingOutCsv, settingOutRows, surveyBrackets, surveyResiduals } from '../../core/survey';
import { derived, useStore } from '../../state/store';
import { exportSettingOut } from '../../ui/movementActions';
import type { Json, ToolModule } from './types';

const st = () => useStore.getState();
const r1 = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : 'unlimited');
const num = { type: 'number' } as const;
const dir = { type: 'string', enum: ['along', 'vertical', 'out'] } as const;
const tolItem = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    value: { type: 'number', description: '± mm' },
    direction: dir,
    scope: { type: 'string', enum: ['structure', 'steel'], description: 'structure = slab/anchors (absorbed at slab brackets, replaced by the survey); steel = fabrication/erection' },
    source: { type: 'string' },
  },
} as const;

const SCALAR_KEYS = ['tempInstall', 'tempMin', 'tempMax', 'slabDeflection', 'storeyDrift', 'slotIncrement', 'slotMargin', 'minGap', 'surveyAccuracy'] as const;

function settingsOut(): Json {
  const ms = movementSettings(st().project);
  return {
    ...ms,
    stacks: Object.fromEntries(FACADE_DIRS.map((d) => [d, r1(toleranceStack(ms, d).value)])),
    note: 'Temperatures °C, lengths mm. Slot = d0 + 2·(T + M) rounded up to slotIncrement. Stacks are ± mm per facade direction.',
  };
}

function setSettings(input: Json): Json {
  const findTol = (list: ToleranceItem[], key: unknown) => list.findIndex((t) => t.id === key || t.name.toLowerCase() === String(key).toLowerCase());
  const problems: string[] = [];
  st().apply('Assistant: movement settings', (p) => {
    const m: MovementSettings = { ...movementSettings(p) };
    for (const k of SCALAR_KEYS) if (typeof input[k] === 'number') (m as unknown as Record<string, number>)[k] = input[k] as number;
    if (input.combine === 'linear' || input.combine === 'rss') m.combine = input.combine;
    if (Array.isArray(input.tolerances)) {
      m.tolerances = (input.tolerances as Partial<ToleranceItem>[])
        .filter((t) => t && typeof t.value === 'number' && t.direction)
        .map((t) => ({ id: t.id || newId('tol'), name: t.name || 'Tolerance', value: Math.abs(t.value!), direction: t.direction!, ...(t.scope ? { scope: t.scope } : {}), ...(t.source ? { source: t.source } : {}) }));
    }
    for (const t of (Array.isArray(input.upsertTolerances) ? input.upsertTolerances : []) as Partial<ToleranceItem>[]) {
      const i = findTol(m.tolerances, t.id ?? t.name);
      if (i >= 0) m.tolerances[i] = { ...m.tolerances[i], ...t, id: m.tolerances[i].id } as ToleranceItem;
      else if (typeof t.value === 'number' && t.direction) m.tolerances.push({ id: newId('tol'), name: t.name || 'Tolerance', value: Math.abs(t.value), direction: t.direction, ...(t.scope ? { scope: t.scope } : {}), ...(t.source ? { source: t.source } : {}) });
      else problems.push(`New tolerance ${t.name ?? '?'} needs value and direction`);
    }
    for (const key of (Array.isArray(input.removeTolerances) ? input.removeTolerances : []) as string[]) {
      const i = findTol(m.tolerances, key);
      if (i >= 0) m.tolerances.splice(i, 1);
      else problems.push(`No tolerance ${key}`);
    }
    p.settings.movement = m;
  });
  return { ...settingsOut(), problems };
}

function report(input: Json): Json {
  const p = st().project;
  const dm = derived(p);
  const rep = movementReport(p, dm, { survey: surveyResiduals(surveyBrackets(p, dm)) });
  const ids = Array.isArray(input.connectionIds) ? new Set(input.connectionIds as string[]) : null;
  const rows = rep.rows.filter((r) => (!input.onlyProblems || !r.provision.ok) && (!ids || (r.connectionId && ids.has(r.connectionId))));
  const limit = typeof input.limit === 'number' ? input.limit : 60;
  const big = [...rep.members].sort((a, b) => b.expansion - a.expansion).slice(0, 5);
  return {
    dT: rep.dT,
    combine: rep.combine,
    stacks: Object.fromEntries(FACADE_DIRS.map((d) => [d, r1(rep.stacks[d].value)])),
    summary: rep.summary,
    rows: rows.slice(0, limit).map((r) => ({
      connectionId: r.connectionId,
      mark: r.mark,
      location: r.location,
      joint: r.joint,
      provision: r.provision.label,
      dir: r.provision.dir,
      tolerance: r1(r.provision.tol),
      movement: r1(r.provision.move),
      survey: r.provision.survey === undefined ? undefined : r1(r.provision.survey),
      required: r1(r.provision.required),
      provided: r1(r.provision.provided),
      auto: r.provision.auto,
      ok: r.provision.ok,
      limitedBy: r.provision.cap?.reason,
    })),
    truncated: rows.length > limit ? rows.length - limit : 0,
    largestThermal: big.map((m) => ({ mark: m.mark, profile: m.profile, length: Math.round(m.length), expansion: r1(m.expansion), contraction: r1(m.contraction) })),
  };
}

function surveyStatus(limit = 60): Json {
  const p = st().project;
  const rows = surveyBrackets(p, derived(p));
  return {
    points: p.survey.points.length,
    matchRadius: p.survey.matchRadius,
    applyAlong: !!p.survey.applyAlong,
    brackets: rows.length,
    matched: rows.filter((r) => r.point).length,
    exceeding: rows.filter((r) => r.status === 'exceeds').length,
    madeToMeasure: rows.filter((r) => r.status === 'adjusted').length,
    rows: rows
      .filter((r) => r.point || r.status !== 'unmatched')
      .slice(0, limit)
      .map((r) => ({
        connectionId: r.connectionId,
        mark: r.mark,
        location: r.location,
        point: r.point?.name,
        deviation: r.deviation && { out: r1(r.deviation.out), vertical: r1(r.deviation.vertical), along: r1(r.deviation.along) },
        applied: r.applied,
        status: r.status,
        why: r.messages.length ? r.messages : undefined,
      })),
    directions: 'out = towards the slab, vertical = up, along = mullion local +y (mm)',
  };
}

function survey(input: Json): Json {
  const action = String(input.action);
  const notes: string[] = [];
  if (typeof input.matchRadius === 'number' || typeof input.applyAlong === 'boolean') {
    st().apply('Assistant: survey settings', (p) => {
      if (typeof input.matchRadius === 'number' && input.matchRadius > 0) p.survey.matchRadius = input.matchRadius;
      if (typeof input.applyAlong === 'boolean') p.survey.applyAlong = input.applyAlong;
    });
  }
  switch (action) {
    case 'import': {
      if (typeof input.csv !== 'string' || !input.csv.trim()) throw new Error('Pass the survey points as csv text: "name, x, y, z[, design x, y, z]" per line.');
      const scale = input.units === 'm' ? 1000 : input.units === 'ft' ? 304.8 : 1;
      const r = parseSurveyCsv(input.csv, { scale });
      if (!r.points.length) throw new Error(`No points found. Skipped: ${r.skipped.slice(0, 5).join('; ')}`);
      st().apply('Assistant: import survey points', (p) => {
        p.survey = { ...p.survey, points: input.append ? [...p.survey.points, ...r.points] : r.points, source: 'assistant (pasted CSV)', importedAt: new Date().toISOString() };
      });
      notes.push(`Imported ${r.points.length} points${r.skipped.length ? `, skipped ${r.skipped.length} lines` : ''}.`);
      break;
    }
    case 'apply': {
      const mode = input.mode === 'all' ? 'all' : 'exceeding';
      const dm = derived(st().project);
      let n = 0;
      st().apply(`Assistant: survey adjustments (${mode})`, (p) => {
        n = applySurvey(p, dm, mode);
      });
      notes.push(`Adjusted ${n} brackets (${mode}).`);
      break;
    }
    case 'clear': {
      let n = 0;
      st().apply('Assistant: clear survey adjustments', (p) => {
        n = clearSurveyAdjustments(p);
      });
      notes.push(`Cleared ${n} brackets.`);
      break;
    }
    case 'remove_points':
      st().apply('Assistant: remove survey points', (p) => void (p.survey = { ...p.survey, points: [], source: undefined, importedAt: undefined }));
      notes.push('Removed all survey points (adjustments stay until cleared).');
      break;
    case 'status':
      break;
    default:
      throw new Error(`Unknown survey action ${action}`);
  }
  return { notes, ...surveyStatus(typeof input.limit === 'number' ? input.limit : 60) };
}

function settingOut(input: Json): unknown {
  const p = st().project;
  const dm = derived(p);
  if (input.download === 'csv' || input.download === 'xlsx') {
    exportSettingOut(input.download);
    return { downloaded: input.download };
  }
  if (input.format === 'csv') return { csv: settingOutCsv(p, dm) };
  const limit = typeof input.limit === 'number' ? input.limit : 80;
  const rows = settingOutRows(p, dm);
  return {
    count: rows.length,
    rows: rows.slice(0, limit).map((r) => ({
      mark: r.mark,
      location: r.location,
      design: { x: r1(r.design.x), y: r1(r.design.y), z: r1(r.design.z) },
      point: r.pointName,
      deviation: r.deviation && { out: r1(r.deviation.out), vertical: r1(r.deviation.vertical), along: r1(r.deviation.along) },
      applied: r.applied,
      site: r.site,
      status: r.statusText,
    })),
    truncated: rows.length > limit ? rows.length - limit : 0,
  };
}

export const movementModule: ToolModule = {
  tools: [
    {
      name: 'movement_settings',
      description:
        'Read or change the movement & tolerance settings that drive the auto slots/gaps of slab brackets, fin plates and angle cleats: steel temperatures (install/min/max °C), slab-edge deflection and storey drift (mm), tolerance combination (linear or rss), slot increment/margin, minimum stack gap, survey accuracy, and the ± tolerance list (direction along/vertical/out of the facade). action "get" returns them with the combined stacks.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'set'] },
          tempInstall: num,
          tempMin: num,
          tempMax: num,
          slabDeflection: num,
          storeyDrift: num,
          combine: { type: 'string', enum: ['linear', 'rss'] },
          slotIncrement: num,
          slotMargin: num,
          minGap: num,
          surveyAccuracy: num,
          tolerances: { type: 'array', items: tolItem, description: 'Replace the whole list' },
          upsertTolerances: { type: 'array', items: tolItem, description: 'Change items matched by id or name, or add new ones' },
          removeTolerances: { type: 'array', items: { type: 'string' }, description: 'Ids or names' },
        },
        required: ['action'],
      },
    },
    {
      name: 'movement_report',
      description:
        'Movement report: for every slab bracket, fin plate and angle cleat the provisions (fin/anchor/thermal slots, packing, stack-joint gap, drift rotation) with the ± tolerance, ± movement (thermal ΔL = α·ΔT·L, slab deflection), survey residual, required vs provided mm and whether it is OK, plus the largest thermal ΔL per member.',
      input_schema: {
        type: 'object',
        properties: {
          onlyProblems: { type: 'boolean' },
          connectionIds: { type: 'array', items: { type: 'string' } },
          limit: { type: 'integer', description: 'Default 60 rows' },
        },
      },
    },
    {
      name: 'survey',
      description:
        'Survey-driven slab brackets. import: points from CSV text the user pasted ("name, x, y, z[, design x, y, z]" per line, comma/semicolon/tab). status: matching of brackets to points with deviation (out/vertical/along) and status. apply: make brackets to measure (mode "exceeding" = only where the slots/packing cannot absorb the deviation, "all" = every matched bracket). clear: remove adjustments. remove_points. matchRadius / applyAlong change the matching.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['import', 'status', 'apply', 'clear', 'remove_points'] },
          csv: { type: 'string' },
          units: { type: 'string', enum: ['mm', 'm', 'ft'], description: 'Units of the CSV coordinates (default mm)' },
          append: { type: 'boolean', description: 'Keep existing points' },
          mode: { type: 'string', enum: ['exceeding', 'all'] },
          matchRadius: num,
          applyAlong: { type: 'boolean' },
          limit: { type: 'integer' },
        },
        required: ['action'],
      },
    },
    {
      name: 'setting_out_table',
      description:
        'Setting-out table of the slab brackets: mark, grid/level, design anchor point, surveyed point, deviation, applied adjustment, site setting (slot positions, packing) and status. format "csv" returns CSV text; download "csv" or "xlsx" saves the file for the user.',
      input_schema: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['rows', 'csv'] },
          download: { type: 'string', enum: ['csv', 'xlsx'] },
          limit: { type: 'integer' },
        },
      },
    },
  ],
  run: {
    movement_settings: (input) => (input.action === 'set' ? setSettings(input) : settingsOut()),
    movement_report: report,
    survey,
    setting_out_table: settingOut,
  },
};
