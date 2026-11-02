/**
 * Export package dialog: opening it shows the outline (items, folders, tokens
 * and model counts) without generating the drawing set or any output; the
 * full plan is made on request ("Calculate sizes") or by the export itself.
 */
import { describe, expect, it } from 'vitest';
import { useStore, derived } from '../src/state/store';
import { sampleProject } from '../src/core/sample';
import { allDrawings, issueDrawings } from '../src/core/drawings';
import { deriveModel } from '../src/core/derive/model';
import { templateItems, DEFAULT_EXPORT_TEMPLATE } from '../src/core/export/template';
import { outlineCurrentPackage, planCurrentPackage } from '../src/ui/exportPackageActions';
import { cachedDrawingsOf } from '../src/ui/actions';

describe('export package outline (lazy plan)', () => {
  it('lists every item with its folder, the package folder and the counts, without making the drawing set', () => {
    const p = sampleProject();
    issueDrawings(p, allDrawings(p, deriveModel(p)), { description: 'For construction', status: 'Released', date: '2026-10-31', drawn: 'MG', checked: 'QA', approved: 'PM' });
    useStore.getState().replaceProject(p);
    const dm = derived(useStore.getState().project);
    expect(cachedDrawingsOf(dm)).toBeUndefined();
    const o = outlineCurrentPackage({ template: DEFAULT_EXPORT_TEMPLATE });
    expect(cachedDrawingsOf(dm), 'the outline makes no drawings').toBeUndefined();
    expect(o.items.map((i) => i.item.id)).toEqual(templateItems(DEFAULT_EXPORT_TEMPLATE).map((x) => x.item.id));
    expect(o.counts).toMatchObject({ parts: dm.parts.length, assemblies: dm.assemblies.length, drawings: null });
    // The full plan agrees on the package folder, the folders, the tokens and the revision.
    const plan = planCurrentPackage({ template: DEFAULT_EXPORT_TEMPLATE });
    expect(o.root).toBe(plan.root);
    expect(o.autoRev).toBe(plan.ctx.autoRev);
    expect(o.tokens).toEqual(plan.tokens);
    expect(o.items.map((i) => i.folder)).toEqual(plan.items.map((i) => i.folder));
    // Planned once, the drawing set is cached and the outline counts its sheets.
    expect(outlineCurrentPackage({ template: DEFAULT_EXPORT_TEMPLATE }).counts.drawings).toBe(plan.ctx.drawings.length);
  });

  it('stays cheap: no drawing generation on every keystroke of the package fields', () => {
    useStore.getState().replaceProject(sampleProject());
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) outlineCurrentPackage({ settings: { code: `X${i}` } });
    expect((performance.now() - t0) / 20).toBeLessThan(50);
  });
});
