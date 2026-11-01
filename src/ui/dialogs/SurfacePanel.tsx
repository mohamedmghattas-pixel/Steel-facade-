/**
 * Surface orientation UI shared by the wireframe check and the "Orient
 * profiles to surface" dialog: patches / folds / members left as is, the
 * exterior side with flip controls (whole model and per patch), fold choices,
 * and the 3D preview (normal arrows at member midpoints, patch tints).
 */
import { useState } from 'react';
import type { FoldNormal, Id, Vec3 } from '../../core/model/types';
import { depthFromNormal } from '../../core/model/geometry';
import { EXTERIOR_RULE_TEXT, ORIENT_TOLERANCE, type OrientChoices, type OrientationSummary } from '../../core/wireframe';
import { useStore, type WireOverlay } from '../../state/store';
import { getViewer } from '../ViewportPanel';

/** Patch tints of the preview (repeating). */
export const PATCH_COLORS = [0x22d3ee, 0xf472b6, 0xa3e635, 0xfb923c, 0xa78bfa, 0xfacc15, 0x34d399, 0xf87171, 0x60a5fa, 0xe879f9];
export const FOLD_COLOR = 0xffffff;
const BRACKET_COLOR = 0xd98b3a;
const FREE_COLOR = 0x5b6573;
/** At most this many normal arrows in the preview (every k-th member on big models). */
const MAX_ARROWS = 1500;

export const patchColor = (id: number) => PATCH_COLORS[id % PATCH_COLORS.length];
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const fmt = (n: number) => (Math.abs(n) >= 10 ? Math.round(n).toLocaleString() : n.toFixed(n >= 1 ? 1 : 2));

interface LineLike {
  a: Vec3;
  b: Vec3;
  pieces: Id[];
  inScope: boolean;
  len: number;
}

/** Select the members and aim the 3D view at them. */
export function zoomToMembers(ids: Id[], fallback?: Vec3) {
  const s = useStore.getState();
  const p = s.project;
  const live = ids.filter((id) => p.members[id]);
  s.select({ members: live });
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const id of live) {
    const m = p.members[id];
    for (const n of [m.start, m.end]) {
      const q = p.nodes[n]?.p;
      if (!q) continue;
      min.x = Math.min(min.x, q.x);
      min.y = Math.min(min.y, q.y);
      min.z = Math.min(min.z, q.z);
      max.x = Math.max(max.x, q.x);
      max.y = Math.max(max.y, q.y);
      max.z = Math.max(max.z, q.z);
    }
  }
  const v = getViewer();
  if (!v) return;
  if (fallback && (!live.length || Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z) > 6000)) v.focusPoint(fallback, 2500);
  else if (live.length) v.focusBox(min, max);
  else if (fallback) v.focusPoint(fallback, 2500);
}

/**
 * Preview overlay of the surfaces: normal arrows at member midpoints (patch colours; folds
 * white, brackets orange), optionally the lines tinted by patch. Appends to `o`.
 */
export function surfaceOverlay(o: WireOverlay, lines: LineLike[], sum: OrientationSummary, nodes: Record<Id, { p: Vec3 }>, members: Record<Id, { start: Id; end: Id }>, tint: boolean) {
  const S = sum.surfaces;
  if (tint) {
    o.segments.length = 0;
    o.colors.length = 0;
    lines.forEach((L, li) => {
      if (!L.inScope) return;
      const ln = S.normals[li];
      o.segments.push(L.a.x, L.a.y, L.a.z, L.b.x, L.b.y, L.b.z);
      o.colors.push(!ln ? FREE_COLOR : ln.bracket ? BRACKET_COLOR : ln.fold ? FOLD_COLOR : patchColor(ln.patch));
    });
  }
  const targets = sum.lines.flatMap((lo) => lo.members.map((t) => ({ t, ln: lo.normal })));
  if (!targets.length) return;
  const lens = targets
    .map(({ t }) => {
      const m = members[t.id];
      const a = m && nodes[m.start]?.p;
      const b = m && nodes[m.end]?.p;
      return a && b ? Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) : 0;
    })
    .filter((x) => x > 0)
    .sort((x, y) => x - y);
  const L = Math.min(800, Math.max(120, 0.3 * (lens[Math.floor(lens.length / 2)] ?? 1000)));
  const stride = Math.max(1, Math.ceil(targets.length / MAX_ARROWS));
  for (let k = 0; k < targets.length; k += stride) {
    const { t, ln } = targets[k];
    const m = members[t.id];
    const a = m && nodes[m.start]?.p;
    const b = m && nodes[m.end]?.p;
    if (!a || !b) continue;
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
    const dl = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) || 1;
    const d = { x: (b.x - a.x) / dl, y: (b.y - a.y) / dl, z: (b.z - a.z) / dl };
    // The section depth: the normal projected perpendicular to the member.
    const n = depthFromNormal(d, t.normal);
    if (!n) continue;
    const tip = { x: c.x + n.x * L, y: c.y + n.y * L, z: c.z + n.z * L };
    const col = ln.bracket ? BRACKET_COLOR : ln.fold ? FOLD_COLOR : patchColor(ln.patch);
    o.segments.push(c.x, c.y, c.z, tip.x, tip.y, tip.z);
    o.colors.push(col);
    for (const s of [1, -1]) {
      const h = { x: tip.x - n.x * 0.28 * L + d.x * s * 0.14 * L, y: tip.y - n.y * 0.28 * L + d.y * s * 0.14 * L, z: tip.z - n.z * 0.28 * L + d.z * s * 0.14 * L };
      o.segments.push(tip.x, tip.y, tip.z, h.x, h.y, h.z);
      o.colors.push(col);
    }
  }
}

/** Summary, exterior side, patches and folds of a surface orientation, with flip and fold controls. */
export function SurfacePanel({
  sum,
  lines,
  choices,
  onChoices,
  tint,
  onTint,
}: {
  sum: OrientationSummary;
  lines: LineLike[];
  choices: OrientChoices;
  onChoices: (c: OrientChoices) => void;
  tint: boolean;
  onTint: (on: boolean) => void;
}) {
  const [open, setOpen] = useState<'patches' | 'folds' | null>(null);
  const S = sum.surfaces;
  const patches = [...S.patches].filter((P) => P.lines.length).sort((x, y) => y.length - x.length);
  const rules = [...new Set(S.exterior)];
  const flipped = new Set(choices.flipPatches ?? []);
  const scopeFolds = S.folds.filter((f) => lines[f.line]?.inScope);
  const togglePatch = (key: string) => {
    const next = new Set(flipped);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChoices({ ...choices, flipPatches: [...next] });
  };
  const setFold = (key: string, mode: FoldNormal) => onChoices({ ...choices, folds: { ...(choices.folds ?? {}), [key]: mode } });
  const membersOf = (lis: number[]) => lis.flatMap((li) => lines[li]?.pieces ?? []);
  return (
    <div className="wf-surfaces" data-testid="wf-surfaces">
      <p className="wf-surf-stats">
        <strong>{patches.length}</strong> surface patch{patches.length === 1 ? '' : 'es'} · <strong>{sum.folds}</strong> fold member{sum.folds === 1 ? '' : 's'} ·{' '}
        <strong>{sum.turn}</strong> line{sum.turn === 1 ? '' : 's'} to turn ({sum.turnMembers} members{sum.turn ? `, up to ${fmt(sum.maxDeviation)}° off now` : ''}) · <strong>{sum.free.length}</strong> member
        {sum.free.length === 1 ? '' : 's'} left as {sum.free.length === 1 ? 'it is' : 'they are'} (no junction)
        {sum.brackets ? (
          <>
            {' '}
            · <strong>{sum.brackets}</strong> bracket{sum.brackets === 1 ? '' : 's'} (depth along the mullion)
          </>
        ) : null}
      </p>
      <div className="wf-surf-row">
        <span className="muted">
          Exterior side: {rules.map((r) => EXTERIOR_RULE_TEXT[r]).join('; ')}
          {choices.flip ? ' — flipped' : ''}
        </span>
        <button className={`secondary-btn small ${choices.flip ? 'on' : ''}`} data-testid="wf-flip" title="Turn every section to the other side of the facade" onClick={() => onChoices({ ...choices, flip: !choices.flip })}>
          ⇅ Flip exterior side
        </button>
      </div>
      <div className="wf-surf-row">
        <label className="check" title="Colour the lines by surface patch in the 3D preview (folds white, brackets orange, no surface grey)">
          <input type="checkbox" checked={tint} onChange={(e) => onTint(e.target.checked)} /> Colour the preview by surface patch
        </label>
        {sum.free.length > 0 && (
          <button className="link-btn small" title="Select the members that keep their orientation (no junction defines a surface for them)" onClick={() => zoomToMembers(sum.free)}>
            Show members left as is
          </button>
        )}
      </div>
      <section className="wf-group">
        <header>
          <span className="wf-dot" />
          <button className="wf-toggle" onClick={() => setOpen(open === 'patches' ? null : 'patches')} aria-expanded={open === 'patches'}>
            <span className="wf-caret">{open === 'patches' ? '▾' : '▸'}</span> Surface patches
          </button>
          <span className="wf-count">{patches.length}</span>
        </header>
        {open === 'patches' && (
          <ul>
            {patches.map((P) => (
              <li key={P.key} className="info">
                <span className="wf-swatch" style={{ background: hex(patchColor(P.id)) }} />
                <span className="wf-text">
                  Patch {P.id + 1}: {P.lines.length} lines, {fmt(P.length / 1000)} m, normal ({P.normal.x.toFixed(2)}, {P.normal.y.toFixed(2)}, {P.normal.z.toFixed(2)})
                  {P.spread > 2 ? `, curved (normals up to ${fmt(P.spread)}° apart)` : ''}
                  {flipped.has(P.key) ? ' — flipped' : ''}
                </span>
                <button className="link-btn small" title="Turn this patch to the other side" onClick={() => togglePatch(P.key)}>
                  Flip
                </button>
                <button className="icon-btn wf-zoom" title="Select and zoom to" aria-label="Zoom to" onClick={() => zoomToMembers(membersOf(P.lines), P.at)}>
                  ⌖
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {scopeFolds.length > 0 && (
        <section className="wf-group">
          <header>
            <span className="wf-dot" />
            <button className="wf-toggle" onClick={() => setOpen(open === 'folds' ? null : 'folds')} aria-expanded={open === 'folds'}>
              <span className="wf-caret">{open === 'folds' ? '▾' : '▸'}</span> Fold members (shared by two patches)
            </button>
            <span className="wf-count">{scopeFolds.length}</span>
          </header>
          {open === 'folds' && (
            <ul>
              {scopeFolds.slice(0, 200).map((f) => (
                <li key={f.key} className="info">
                  <span className="wf-dot" />
                  <span className="wf-text">
                    {fmt(lines[f.line].len)} mm between patches {f.patches.map((x) => x + 1).join(' and ')} ({fmt(f.angle)}° apart)
                  </span>
                  <select
                    value={f.mode}
                    aria-label="Fold member normal"
                    onChange={(e) => setFold(f.key, e.target.value as FoldNormal)}
                    onKeyDown={(e) => e.stopPropagation()}
                    title="Section depth of the fold member"
                  >
                    <option value="bisector">Bisector</option>
                    <option value="a">Follow patch {f.patches[0] + 1}</option>
                    <option value="b">Follow patch {f.patches[1] + 1}</option>
                  </select>
                  <button className="icon-btn wf-zoom" title="Select and zoom to" aria-label="Zoom to" onClick={() => zoomToMembers(lines[f.line].pieces)}>
                    ⌖
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <p className="muted wf-legend">
        Section depth (local z) along the surface normal, width in the surface; members within {ORIENT_TOLERANCE}° are left as they are. Arrows: the exterior side
        {patches.slice(0, 6).map((P) => (
          <span key={P.key} style={{ color: hex(patchColor(P.id)) }}>
            {' '}
            ● {P.id + 1}
          </span>
        ))}
        {sum.folds ? <span style={{ color: hex(FOLD_COLOR) }}> ● fold</span> : null}
        {sum.brackets ? <span style={{ color: hex(BRACKET_COLOR) }}> ● bracket</span> : null}
      </p>
    </div>
  );
}
