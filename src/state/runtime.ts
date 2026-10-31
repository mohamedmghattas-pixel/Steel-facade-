/**
 * Late-bound runtime services, so commands and assistant tools can use them
 * without importing browser-only modules (the web-ifc WASM loader lives in
 * viewer/references.ts and registers itself here; tests can register a Node one).
 */
import type { IfcAPI } from 'web-ifc';

let ifcProvider: (() => Promise<IfcAPI>) | null = null;

export function provideIfcApi(fn: () => Promise<IfcAPI>) {
  ifcProvider = fn;
}

/** The shared, initialised web-ifc instance. */
export async function getIfcApi(): Promise<IfcAPI> {
  if (!ifcProvider) throw new Error('The IFC engine is not available here.');
  return ifcProvider();
}
