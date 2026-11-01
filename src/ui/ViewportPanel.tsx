import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { derived, isModifyTool, useStore, type ViewName } from '../state/store';
import { provideReferenceCentre } from '../state/runtime';
import { Viewer } from '../viewer/Viewer';
import { getBlob } from '../state/storage';
import { dxfReferenceObject, loadIfcReference, loadUnderlayImage, placeUnderlay, setGroupOpacity, underlayMesh, type UnderlayImage } from '../viewer/references';
import { rhinoReferenceObject } from '../viewer/rhinoReference';
import { decodeRefMeshes, refMeshBlobId } from '../core/io/refMesh';
import { handleToolPoints } from './actions';
import { Icon } from './icons';
import { Segmented } from './widgets';
import type { Vec3 } from '../core/model/types';
import { WorkPlaneControl } from './dialogs/ModellingDialogs';
import { disposeObject } from '../viewer/meshes';
import { filterSelection } from '../core/management/grouping';
import { ColorByControl, SelectFilterChip } from './dialogs/ManagementDialogs';
import { beginTool, pointOnMember, toolClick, toolHover, toolPress, toolTyped, viewerHooks } from './modifyTools';
import { ModifyToolBar, openModifyMenu } from './ModifyPanels';
import { measureText } from './modifyActions';
import { SelectionModeBar, openPartMenu, setMenuTarget } from './AssemblyPanels';
import { boxToAssemblies, hitRef, isolatedRefs, pickAssembly } from './navigationActions';

let viewerInstance: Viewer | null = null;
export const getViewer = () => viewerInstance;

export function ViewportPanel() {
  const host = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const display = useStore((s) => s.display);
  const workPlane = useStore((s) => s.workPlane);
  const tool = useStore((s) => s.tool);
  const viewRequest = useStore((s) => s.viewRequest);
  const zoomRequest = useStore((s) => s.zoomRequest);
  const typedInput = useStore((s) => s.typedInput);
  const wireOverlay = useStore((s) => s.wireOverlay);
  const isolate = useStore((s) => s.isolate);
  const focusRequest = useStore((s) => s.focusRequest);
  const set = useStore((s) => s.set);

  // Create the viewer once.
  useEffect(() => {
    const v = new Viewer(host.current!, {
      getState: () => {
        const s = useStore.getState();
        return { tool: s.tool, snap: s.snap, workPlane: s.workPlane, gridStep: s.project.settings.gridStep };
      },
      onPick: (hit, additive, alt) => {
        const s = useStore.getState();
        if (!hit) {
          if (!additive) s.clearSelection();
          return;
        }
        const key = hit.kind === 'member' ? 'members' : hit.kind === 'connection' ? 'connections' : hit.kind === 'plate' ? 'plates' : 'nodes';
        const picked = filterSelection(s.project, { members: [], nodes: [], connections: [], [key]: [hit.id] }, s.selectFilter);
        if (!picked.members.length && !picked.connections.length && !picked.nodes.length && !picked.plates?.length) return;
        // Assembly mode, or Alt+click: the whole assembly of the part hit.
        if (hit.kind !== 'node' && (s.selectionMode === 'assembly' || alt) && pickAssembly(hit, additive)) return;
        s.select(picked, additive);
      },
      onBoxSelect: (sel, additive) => {
        const s = useStore.getState();
        const picked = filterSelection(s.project, sel, s.selectFilter);
        s.select(s.selectionMode === 'assembly' ? boxToAssemblies(picked) : picked, additive);
      },
      onPoints: (t, pts) => handleToolPoints(t, pts),
      onCursor: (p) => useStore.setState({ cursor: p }),
      onPrompt: (text) => useStore.setState({ prompt: text }),
      onToolDone: () => {
        const s = useStore.getState();
        if (s.tool === 'move' || s.tool === 'copy' || s.tool === 'calibrate') s.setTool('select');
      },
      isModifyTool: (t) => isModifyTool(t),
      onToolHover: (t, info) => isModifyTool(t) && toolHover(t, info),
      onToolPress: (t, info) => isModifyTool(t) && toolPress(t, info),
      onToolClick: (t, info) => isModifyTool(t) && toolClick(t, info),
      onContextMenu: (hit, x, y, info) => {
        const s = useStore.getState();
        // Navigation / assembly items for the part clicked (AssemblyPanels): in the member / connection menu, or a menu of their own.
        const ref = hit ? (hitRef(derived(s.project), hit) ?? null) : null;
        setMenuTarget(ref);
        if (hit?.kind === 'connection') {
          // Right-click on a connection outside the selection selects it; the menu has the connection commands.
          if (!s.selection.connections.includes(hit.id)) s.select({ members: [], nodes: [], connections: [hit.id] });
          return openModifyMenu({ x, y, member: null, point: null, connection: hit.id });
        }
        if (hit && ref && hit.kind === 'plate') {
          if (!(s.selection.plates ?? []).includes(hit.id)) s.select({ plates: [hit.id] });
          openPartMenu({ x, y, ref });
          return;
        }
        if (hit?.kind !== 'member') return;
        // Right-click on a member outside the selection selects it.
        if (!s.selection.members.includes(hit.id)) s.select({ members: [hit.id] });
        openModifyMenu({ x, y, member: hit.id, point: pointOnMember(hit.id, info) });
      },
    });
    viewerHooks.overlay = (o) => v.setToolPreview(o);
    viewerHooks.anchor = (q) => v.setToolAnchor(q);
    viewerRef.current = v;
    viewerInstance = v;
    provideReferenceCentre(() => v.referenceCentre());
    const s = useStore.getState();
    v.setModel(s.project, derived(s.project));
    v.setWorkPlane(s.workPlane, s.project.settings.gridStep, s.project);
    v.setView('3d');
    return () => {
      v.dispose();
      viewerRef.current = null;
      viewerInstance = null;
      provideReferenceCentre(null);
    };
  }, []);

  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    v.setModel(project, derived(project));
  }, [project]);

  useEffect(() => viewerRef.current?.setSelection(selection), [selection]);
  // Isolation: the assemblies of the isolated parts, in the current model.
  useEffect(() => viewerRef.current?.setIsolation(isolatedRefs(derived(project), isolate)), [isolate, project]);
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || !focusRequest) return;
    const box = v.boxOfRefs(focusRequest.refs);
    if (box) v.focusBox(box.min, box.max);
  }, [focusRequest]);
  useEffect(() => viewerRef.current?.setWireOverlay(wireOverlay), [wireOverlay]);
  useEffect(() => viewerRef.current?.setDisplay(display), [display]);
  useEffect(() => {
    viewerRef.current?.setWorkPlane(workPlane, project.settings.gridStep, project);
  }, [workPlane, project]);
  useEffect(() => {
    viewerRef.current?.resetTool();
    beginTool(isModifyTool(tool) ? tool : null);
    // Measure with members selected: their length, angles and the angle between the first two.
    const s = useStore.getState();
    const sel = s.selection.members.filter((id) => s.project.members[id]);
    if (tool === 'measure' && sel.length) s.notify(measureText(s.project, sel));
  }, [tool]);
  useEffect(() => {
    if (viewRequest.n) viewerRef.current?.setView(viewRequest.name);
  }, [viewRequest]);
  useEffect(() => {
    if (zoomRequest) viewerRef.current?.zoomExtents();
  }, [zoomRequest]);
  useEffect(() => {
    if (!typedInput) return;
    const err = isModifyTool(useStore.getState().tool) ? toolTyped(typedInput.text) : viewerRef.current?.typed(typedInput.text);
    if (err) useStore.getState().notify(err, 'error');
  }, [typedInput]);

  useReferenceRuntime(viewerRef);

  const views: { value: ViewName; label: string; title: string }[] = [
    { value: '3d', label: '3D', title: '3D view (1)' },
    { value: 'front', label: 'Front', title: 'Front elevation, looking north (2)' },
    { value: 'plan', label: 'Plan', title: 'Plan view (3)' },
    { value: 'side', label: 'Side', title: 'Side elevation, looking west (4)' },
  ];

  return (
    <div className="viewport">
      <div className="viewport-canvas" ref={host} data-tool={tool} />
      <div className="viewport-overlay top-left">
        <Segmented value={viewRequest.name} options={views} onChange={(name) => set({ viewRequest: { name, n: Date.now() } })} />
        <button className="chip" title="Zoom to fit (F)" onClick={() => set({ zoomRequest: Date.now() })}>
          <Icon name="zoom" size={15} /> Fit
        </button>
        <SelectionModeBar />
      </div>
      <div className="viewport-overlay bottom-center">
        <ModifyToolBar />
      </div>
      <div className="viewport-overlay top-right">
        <WorkPlaneControl />
        <DisplayToggles />
        <ColorByControl />
        <SelectFilterChip />
      </div>
      <div className="viewport-overlay bottom-left nav-hint">Right-drag orbit · Middle-drag or Shift+right-drag pan · Wheel zoom</div>
    </div>
  );
}

function DisplayToggles() {
  const display = useStore((s) => s.display);
  const set = useStore((s) => s.set);
  const t = (k: Exclude<keyof typeof display, 'colorBy'>, label: string) => (
    <button className={`chip ${display[k] ? 'on' : ''}`} onClick={() => set({ display: { ...display, [k]: !display[k] } })}>
      {label}
    </button>
  );
  return (
    <div className="display-toggles">
      {t('solids', 'Solids')}
      {t('wire', 'Wire')}
      {t('connections', 'Connections')}
      {t('references', 'References')}
      {t('underlays', 'Underlays')}
      {t('labels', 'Marks')}
    </div>
  );
}

/**
 * Keeps reference models and underlays in the viewer in sync with the project:
 * loads blobs from IndexedDB on first sight, then updates visibility/opacity/placement.
 */
function useReferenceRuntime(viewerRef: React.RefObject<Viewer | null>) {
  const references = useStore((s) => s.project.references);
  const underlays = useStore((s) => s.project.underlays);
  const loaded = useRef(new Map<string, THREE.Object3D>());
  const images = useRef(new Map<string, { img: UnderlayImage; page: number }>());
  const loading = useRef(new Set<string>());

  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    const wanted = new Set([...references.map((r) => r.id), ...underlays.map((u) => u.id)]);
    const setStatus = (id: string, text: string) =>
      useStore.setState((s) => ({ refStatus: { ...s.refStatus, [id]: text } }));
    const refreshSnapPoints = () => {
      const pts: Vec3[] = [];
      for (const [id, obj] of loaded.current) {
        const r = useStore.getState().project.references.find((x) => x.id === id);
        const sp = obj.userData.snapPoints as Vec3[] | undefined;
        if (!sp || !r?.visible) continue;
        for (const q of sp) pts.push({ x: q.x + r.offset.x, y: q.y + r.offset.y, z: q.z + r.offset.z });
      }
      v.setReferencePoints(pts);
    };
    for (const [id, obj] of loaded.current) {
      if (!wanted.has(id)) {
        obj.parent?.remove(obj);
        disposeObject(obj);
        loaded.current.delete(id);
        images.current.delete(id);
      }
    }
    refreshSnapPoints();

    for (const r of references) {
      const obj = loaded.current.get(r.id);
      if (obj) {
        obj.visible = r.visible;
        obj.position.set(r.offset.x, r.offset.y, r.offset.z);
        setGroupOpacity(obj, r.opacity);
        refreshSnapPoints();
        continue;
      }
      if (loading.current.has(r.id)) continue;
      loading.current.add(r.id);
      setStatus(r.id, 'Loading…');
      void (async () => {
        try {
          if (r.kind === '3dm') {
            const blob = await getBlob(refMeshBlobId(r.id));
            if (!blob) throw new Error('File not found in browser storage — import it again.');
            const set = decodeRefMeshes(blob);
            const { group, points, triangles } = rhinoReferenceObject(set, r.opacity);
            group.userData = { reference: r.id, snapPoints: points };
            group.position.set(r.offset.x, r.offset.y, r.offset.z);
            group.visible = r.visible;
            v.refGroup.add(group);
            loaded.current.set(r.id, group);
            refreshSnapPoints();
            setStatus(r.id, set.objects.length ? `Rhino · ${set.objects.length} object${set.objects.length === 1 ? '' : 's'} · ${triangles.toLocaleString()} triangles` : 'Rhino · original file only');
            v.requestRender();
            if (set.objects.length) useStore.setState({ zoomRequest: Date.now() });
            return;
          }
          const bytes = await getBlob(r.id);
          if (!bytes) throw new Error('File not found in browser storage — import it again.');
          if (r.kind === 'dxf') {
            const segs = JSON.parse(new TextDecoder().decode(bytes)) as { a: Vec3; b: Vec3 }[];
            const { object, points } = dxfReferenceObject(segs, r.plane, r.scale ?? 1, { x: 0, y: 0 });
            object.userData = { reference: r.id, snapPoints: points };
            object.position.set(r.offset.x, r.offset.y, r.offset.z);
            v.refGroup.add(object);
            loaded.current.set(r.id, object);
            refreshSnapPoints();
            setStatus(r.id, `${segs.length} lines`);
            v.requestRender();
            return;
          }
          const res = await loadIfcReference(bytes, r.opacity);
          res.group.userData = { reference: r.id };
          res.group.position.set(r.offset.x, r.offset.y, r.offset.z);
          v.refGroup.add(res.group);
          loaded.current.set(r.id, res.group);
          setStatus(r.id, `${res.schema} · ${res.meshCount} meshes`);
          v.requestRender();
          useStore.setState({ zoomRequest: Date.now() });
        } catch (e) {
          setStatus(r.id, `Error: ${(e as Error).message}`);
        } finally {
          loading.current.delete(r.id);
        }
      })();
    }

    for (const u of underlays) {
      const obj = loaded.current.get(u.id) as THREE.Mesh | undefined;
      const cached = images.current.get(u.id);
      if (obj && cached && cached.page === u.page) {
        obj.visible = u.visible;
        (obj.material as THREE.MeshBasicMaterial).opacity = u.opacity;
        const fresh = underlayMesh(u, cached.img);
        obj.geometry.dispose();
        obj.geometry = fresh.geometry;
        placeUnderlay(obj, u);
        continue;
      }
      if (loading.current.has(u.id)) continue;
      loading.current.add(u.id);
      setStatus(u.id, 'Loading…');
      void (async () => {
        try {
          const bytes = await getBlob(u.id);
          if (!bytes) throw new Error('File not found in browser storage — import it again.');
          const img = await loadUnderlayImage(u.kind, bytes, u.page);
          if (obj) {
            obj.parent?.remove(obj);
            disposeObject(obj);
          }
          const latest = useStore.getState().project.underlays.find((x) => x.id === u.id) ?? u;
          const mesh = underlayMesh(latest, img);
          mesh.visible = latest.visible;
          v.underlayGroup.add(mesh);
          loaded.current.set(u.id, mesh);
          images.current.set(u.id, { img, page: u.page });
          setStatus(u.id, `${img.width}×${img.height} px`);
          v.requestRender();
        } catch (e) {
          setStatus(u.id, `Error: ${(e as Error).message}`);
        } finally {
          loading.current.delete(u.id);
        }
      })();
    }
    v.requestRender();
  }, [references, underlays, viewerRef]);
}
