/**
 * Late-bound runtime services, so commands and assistant tools can use them
 * without importing browser-only modules (the web-ifc WASM loader lives in
 * viewer/references.ts and registers itself here; tests can register a Node one).
 */
import type { IfcAPI } from 'web-ifc';
import type { Vec3 } from '../core/model/types';

let ifcProvider: (() => Promise<IfcAPI>) | null = null;

export function provideIfcApi(fn: () => Promise<IfcAPI>) {
  ifcProvider = fn;
}

/** The shared, initialised web-ifc instance. */
export async function getIfcApi(): Promise<IfcAPI> {
  if (!ifcProvider) throw new Error('The IFC engine is not available here.');
  return ifcProvider();
}

let referenceCentreProvider: (() => Vec3 | null) | null = null;

/** The 3D view registers how to find the centre of the visible reference models. */
export function provideReferenceCentre(fn: (() => Vec3 | null) | null) {
  referenceCentreProvider = fn;
}

/** Centre of the visible reference models, or null (no view, nothing loaded). */
export function referenceCentre(): Vec3 | null {
  try {
    return referenceCentreProvider?.() ?? null;
  } catch {
    return null;
  }
}
