/**
 * Assistant tools for the export package: read the template and the items with
 * their files, set the package fields / template / item choice, and produce
 * the package as one ZIP download (docs/EXPORT_PACKAGE.md).
 */
import { useStore } from '../../state/store';
import { outputMeta } from '../../core/export/catalog';
import { exportTemplates, isBuiltinTemplate, packageSettings, parseTemplateJson, templateIssues, walkFolders } from '../../core/export/template';
import { formatBytes, packageTree, planPaths } from '../../core/export/package';
import { OUTPUT_IDS } from '../../core/export/types';
import { planCurrentPackage, runExportPackage, saveExportTemplate } from '../../ui/exportPackageActions';
import type { Json, ToolModule } from './types';

const st = () => useStore.getState();
const str = { type: 'string' } as const;
const strList = { type: 'array', items: str } as const;

function findTemplate(ref: string) {
  const all = exportTemplates(st().project);
  const r = ref.trim().toLowerCase();
  return all.find((t) => t.id === ref) ?? all.find((t) => t.name.toLowerCase() === r) ?? null;
}

/** Item ids matching ids or output names ("drawing-pdf" matches every drawing PDF item). */
function matchItems(refs: string[]): { ids: string[]; unknown: string[] } {
  const plan = planCurrentPackage({ skip: [] });
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const ref of refs) {
    const hit = plan.items.filter((i) => i.item.id === ref || i.item.output === ref);
    if (!hit.length) unknown.push(ref);
    ids.push(...hit.map((i) => i.item.id));
  }
  return { ids: [...new Set(ids)], unknown };
}

function info(input: Json) {
  const p = st().project;
  const plan = planCurrentPackage();
  const s = packageSettings(p);
  const limit = Math.max(1, Math.min(2000, Number(input.limit) || 80));
  const folders = walkFolders(plan.template).map((e) => ({
    folder: e.depth ? e.path.join('/') : '(package folder)',
    pattern: e.folder.name,
    items: e.folder.items.map((it) => {
      const ip = plan.items.find((x) => x.item.id === it.id)!;
      const m = outputMeta(it.output);
      return {
        id: it.id,
        output: it.output,
        label: `${m.label} (${m.format})`,
        pattern: it.pattern,
        ...(it.drawings?.length ? { drawings: it.drawings } : {}),
        ...(ip.off ? { leftOut: true } : ip.skip ? { skipped: ip.skip } : { files: ip.files.length, size: `${ip.exact ? '' : '~'}${formatBytes(ip.size)}`, first: ip.files[0]?.path }),
      };
    }),
  }));
  return {
    package: plan.root,
    fields: { code: s.code, seq: plan.tokens.seq, rev: plan.rev, revSource: s.rev ? 'set' : 'from drawing revisions', autoRev: plan.ctx.autoRev },
    template: { id: plan.template.id, name: plan.template.name, builtIn: isBuiltinTemplate(plan.template.id) },
    templates: exportTemplates(p).map((t) => ({ id: t.id, name: t.name })),
    folders,
    totals: { files: plan.files.length + 1, estimatedSize: formatBytes(plan.size) },
    issues: templateIssues(plan.template).map((i) => `${i.level}: ${i.text}`),
    warnings: plan.warnings,
    ...(input.tree ? { tree: packageTree(plan.root, planPaths(plan), plan.folders).split('\n').slice(0, limit).join('\n') } : {}),
    ...(input.paths ? { paths: planPaths(plan).slice(0, limit), morePaths: Math.max(0, plan.files.length + 1 - limit) } : {}),
  };
}

export const exportPackageModule: ToolModule = {
  tools: [
    {
      name: 'export_package_info',
      description:
        'Show the export package: package folder name, fields (code, sequence, revision), the active template (folders with their items, file-name patterns, file counts, sizes, why items are skipped) and other templates. paths: true lists the resulting file paths, tree: true the folder tree as Windows "tree /F" prints it.',
      input_schema: {
        type: 'object',
        properties: { paths: { type: 'boolean' }, tree: { type: 'boolean' }, limit: { type: 'number', description: 'Max paths / tree lines (default 80)' } },
      },
    },
    {
      name: 'set_export_package',
      description:
        'Set the export package fields kept with the project: code (e.g. FWR), seq (package sequence, written as 3 digits), rev (e.g. R01; empty string = from the drawing revisions), template (id or name of the template to use), exclude / include (item ids or output names to leave out / put back), templateJson (import a template in the facadesteel.exportTemplate JSON format and make it active).',
      input_schema: {
        type: 'object',
        properties: {
          code: str,
          seq: { type: 'number' },
          rev: str,
          template: str,
          exclude: strList,
          include: strList,
          templateJson: str,
        },
      },
    },
    {
      name: 'export_package',
      description:
        'Produce the export package with the active template and download it as one ZIP: the package folder (default: 00-References … 10-Quality Check List) with drawings PDF / DXF per sheet and combined, IFC, STEP, OBJ, NC1, plate DXF and nests, flat patterns, lists, cutting plan, sheet nesting, QAF / VCF forms, run report and a README.txt manifest. Items with nothing to export are skipped and listed in README.txt. Each export records the package revision for the VCF. Returns the files written, skipped items and errors.',
      input_schema: { type: 'object', properties: {} },
    },
  ],
  run: {
    export_package_info: (input: Json) => info(input),

    set_export_package: (input: Json) => {
      const notes: string[] = [];
      let importedId: string | null = null;
      if (typeof input.templateJson === 'string' && input.templateJson.trim()) {
        const { template, warnings } = parseTemplateJson(input.templateJson);
        saveExportTemplate(template);
        importedId = template.id;
        notes.push(`Imported template "${template.name}".`, ...warnings);
      }
      const tpl = typeof input.template === 'string' && input.template.trim() ? findTemplate(input.template) : null;
      if (typeof input.template === 'string' && input.template.trim() && !tpl) throw new Error(`No export template "${input.template}". Templates: ${exportTemplates(st().project).map((t) => t.name).join(', ')}.`);
      const exclude = Array.isArray(input.exclude) ? matchItems(input.exclude.map(String)) : { ids: [], unknown: [] };
      const include = Array.isArray(input.include) ? matchItems(input.include.map(String)) : { ids: [], unknown: [] };
      const unknown = [...exclude.unknown, ...include.unknown];
      if (unknown.length) notes.push(`Not in the template: ${unknown.join(', ')} (outputs: ${OUTPUT_IDS.join(', ')}).`);
      st().apply('Export package settings', (p) => {
        const s = { ...packageSettings(p) };
        if (typeof input.code === 'string') s.code = input.code.trim();
        if (typeof input.seq === 'number' && Number.isFinite(input.seq)) s.seq = Math.max(0, Math.floor(input.seq));
        if (typeof input.rev === 'string') {
          if (input.rev.trim()) s.rev = input.rev.trim();
          else delete s.rev;
        }
        const skip = new Set(s.skip ?? []);
        for (const id of exclude.ids) skip.add(id);
        for (const id of include.ids) skip.delete(id);
        s.skip = [...skip];
        if (!s.skip.length) delete s.skip;
        p.exportPackage = s;
        if (tpl) {
          if (isBuiltinTemplate(tpl.id)) delete p.activeExportTemplate;
          else p.activeExportTemplate = tpl.id;
        } else if (importedId) p.activeExportTemplate = importedId;
      });
      const r = info({});
      return { ...r, ...(notes.length ? { notes } : {}) };
    },

    export_package: async () => {
      const { plan, result, aborted } = await runExportPackage('zip', {}, { confirm: false });
      if (!result) throw new Error(aborted ?? 'The package was not made.');
      return {
        downloaded: `${plan.root}.zip`,
        files: result.entries.length + 1,
        size: formatBytes(result.bytes),
        skipped: result.skipped.map((s) => `${outputMeta(s.item.output).label} (${outputMeta(s.item.output).format}): ${s.reason}`),
        leftOut: plan.items.filter((i) => i.off).map((i) => i.item.id),
        errors: result.errors.map((e) => `${e.path}: ${e.message}`),
        cancelled: result.cancelled,
        note: 'README.txt in the package folder lists every file with its source and revision.',
      };
    },
  },
};
