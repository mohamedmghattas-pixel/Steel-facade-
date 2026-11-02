/**
 * Project settings → End fitting (settings.autoCut): the auto-cut of member
 * ends that meet another member without a connection, its gap, and whether
 * connection cut-backs follow the main member's face on joints that are not
 * square. Shows how many ends each currently cuts (docs/CONNECTION_GEOMETRY.md §3.4a).
 */
import { derived, useStore } from '../state/store';
import { Field, NumberInput } from './widgets';
import { autoCutSettings } from '../core/model/ops';
import { endFitCounts } from '../core/derive/autoCut';
import type { AutoCutSettings } from '../core/model/types';

export function EndFittingSection() {
  const project = useStore((s) => s.project);
  const apply = useStore((s) => s.apply);
  const a = autoCutSettings(project);
  const set = (label: string, patch: Partial<AutoCutSettings>) => apply(label, (p) => void (p.settings.autoCut = { ...autoCutSettings(p), ...patch }));
  const n = endFitCounts(derived(project));
  return (
    <>
      <h4>End fitting</h4>
      <label className="check-row" title="A transom, rail or brace end on a mullion or post, or a mullion end on a member passing through, with no connection there and no end preparation or extension of its own, is cut to that member's face less the gap">
        <input type="checkbox" checked={a.enabled} onChange={(e) => set(e.target.checked ? 'Auto-cut on' : 'Auto-cut off', { enabled: e.target.checked })} />
        Auto-cut ends to the members they meet
      </label>
      <Field label="Auto-cut gap" hint="clearance to the face">
        <NumberInput value={a.gap} unit="mm" min={0} onChange={(v) => set('Auto-cut gap', { gap: Math.max(0, v) })} />
      </Field>
      <label className="check-row" title="On skewed, raking, sloped and folded joints the connection's cut-back follows the main member's face plus the joint's gap (square joints are unchanged). A Fit, Mitre or Bevel on the end wins.">
        <input type="checkbox" checked={a.connections} onChange={(e) => set('Connection cut-backs', { connections: e.target.checked })} />
        Connection cut-backs follow the main face
      </label>
      <p className="muted">
        {a.enabled ? `${n.auto} end${n.auto === 1 ? '' : 's'} auto-cut${n.autoAngled ? ` (${n.autoAngled} at an angle)` : ''}` : 'Auto-cut is off'}
        {' · '}
        {n.connection} connection end{n.connection === 1 ? '' : 's'} cut to the face at an angle. Connections, Fit / Mitre / Bevel and extensions win.
      </p>
    </>
  );
}
