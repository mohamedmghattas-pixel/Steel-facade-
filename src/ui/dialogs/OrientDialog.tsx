/**
 * "Orient profiles to surface": finds the facade surfaces from the wireframe
 * junctions and turns every member's section so its depth (local z) is along
 * the surface normal. Whole model or the selection; flip the exterior side
 * (all or per patch), fold members, 3D preview with normal arrows; one undo step.
 */
import { useEffect, useMemo, useState } from 'react';
import type { FoldNormal, Id } from '../../core/model/types';
import { reorientPlan, type OrientChoices } from '../../core/wireframe';
import { useStore } from '../../state/store';
import { ROLE_COLORS } from '../../viewer/meshes';
import { Field, Modal, Segmented, Select } from '../widgets';
import { applyOrientationPlan, referenceInsidePoint, resolveOrientScope, runOrientation, type OrientScope } from '../surfaceActions';
import { SurfacePanel, surfaceOverlay } from './SurfacePanel';
import './wireframe.css';

const fmt = (n: number) => (Math.abs(n) >= 10 ? Math.round(n).toLocaleString() : n.toFixed(n >= 1 ? 1 : 2));

export function OrientSurfaceDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project);
  const selCount = useStore((s) => s.selection.members.length);
  const initialScope = useStore((s) => s.orientScope);
  const notify = useStore((s) => s.notify);
  const [scope, setScope] = useState<OrientScope>(initialScope);
  const [scopeIds, setScopeIds] = useState<Id[] | null>(() => resolveOrientScope(initialScope));
  const [keepRotation, setKeepRotation] = useState(project.wireframe.settings.keepRotation);
  const [foldNormal, setFoldNormal] = useState<FoldNormal>(project.wireframe.settings.foldNormal);
  const [choices, setChoices] = useState<OrientChoices>({});
  const [tint, setTint] = useState(true);
  const pickScope = (s: OrientScope) => {
    setScope(s);
    setScopeIds(resolveOrientScope(s));
  };
  const { base, error } = useMemo(() => {
    void project;
    try {
      return { base: runOrientation(scope === 'all' ? null : (scopeIds ?? []), { keepRotation, foldNormal }), error: '' };
    } catch (e) {
      return { base: null, error: (e as Error).message };
    }
  }, [project, scope, scopeIds, keepRotation, foldNormal]);
  useEffect(() => setChoices({}), [base]);
  const plan = useMemo(() => {
    if (!base || (!choices.flip && !choices.flipPatches?.length && !Object.keys(choices.folds ?? {}).length)) return base;
    return reorientPlan(project, base, { insidePoint: referenceInsidePoint(), ...choices });
  }, [base, choices, project]);
  const sum = plan?.orientation ?? null;

  useEffect(() => {
    if (!plan || !sum) {
      useStore.getState().set({ wireOverlay: null });
      return;
    }
    const o = { segments: [] as number[], colors: [] as number[], points: [] as number[], pointColors: [] as number[] };
    plan.lines.forEach((L) => {
      if (!L.inScope || L.duplicate) return;
      o.segments.push(L.a.x, L.a.y, L.a.z, L.b.x, L.b.y, L.b.z);
      o.colors.push(ROLE_COLORS[L.proposed]);
    });
    surfaceOverlay(o, plan.lines, sum, project.nodes, project.members, tint);
    useStore.getState().set({ wireOverlay: o });
  }, [plan, sum, tint, project]);
  useEffect(() => () => useStore.getState().set({ wireOverlay: null }), []);

  const doApply = () => {
    if (!plan) return;
    try {
      const res = applyOrientationPlan(plan);
      notify(
        res.oriented
          ? `${res.oriented} members on ${res.lines} lines turned perpendicular to the surface${keepRotation ? ' (rotation kept)' : ''}. Undo with Ctrl+Z.`
          : 'Every member is already perpendicular to its surface.',
      );
      if (scope === 'selection') setScopeIds(resolveOrientScope('selection'));
    } catch (e) {
      notify((e as Error).message, 'error');
    }
  };
  const turn = sum?.turnMembers ?? 0;

  return (
    <Modal
      title="Orient profiles to surface"
      docked
      onClose={onClose}
      footer={
        <div className="btn-row wf-buttons">
          <button className="secondary-btn" onClick={onClose}>
            Close
          </button>
          <button className="primary-btn" data-testid="orient-apply" disabled={!plan || !turn} onClick={doApply}>
            Orient {turn ? `${turn.toLocaleString()} member${turn === 1 ? '' : 's'}` : ''}
          </button>
        </div>
      }
    >
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
        Profiles are always perpendicular to the facade: the section depth (local z) follows the surface normal and the width lies in the surface. The surfaces come
        from where mullions and transoms meet (20°–160°); members with no junction keep their orientation.
      </p>
      <Field label="Orient">
        <Segmented<OrientScope>
          value={scope}
          options={[
            { value: 'all', label: 'Whole model' },
            { value: 'selection', label: `Selection (${selCount})`, title: 'The members selected now; the rest of the model still defines the surfaces' },
          ]}
          onChange={pickScope}
        />
      </Field>
      <div className="row2">
        <Field label="Fold members" hint="Shared by two surface patches (e.g. the valley of a V)">
          <Select<FoldNormal>
            value={foldNormal}
            options={[
              { value: 'bisector', label: 'Bisector of the two patches' },
              { value: 'a', label: 'Follow the larger patch' },
              { value: 'b', label: 'Follow the smaller patch' },
            ]}
            onChange={setFoldNormal}
          />
        </Field>
        <label className="check wf-reclassify" title="Off: the rotation of oriented members is reset to 0">
          <input type="checkbox" checked={keepRotation} onChange={(e) => setKeepRotation(e.target.checked)} /> Keep each member's rotation on top
        </label>
      </div>
      {error && <p className="warning">{error}</p>}
      {sum && plan && (
        <>
          <SurfacePanel sum={sum} lines={plan.lines} choices={choices} onChoices={setChoices} tint={tint} onTint={setTint} />
          {sum.turn === 0 ? (
            <p className="ok">Every member with a surface is perpendicular to it (within 2°).</p>
          ) : (
            <p className="muted" style={{ fontSize: 12 }}>
              {sum.turnMembers.toLocaleString()} members on {sum.turn.toLocaleString()} lines are up to {fmt(sum.maxDeviation)}° off their surface normal. Applying sets their surface
              normal{keepRotation ? '' : ' and resets their rotation to 0'}; one undo step.
            </p>
          )}
          <p className="muted wf-stats">Found in {plan.stats.ms} ms.</p>
        </>
      )}
    </Modal>
  );
}
