/**
 * Lazy access to rhino3dm (McNeel's openNURBS for JavaScript / WebAssembly, MIT).
 *
 * The library (≈ 130 kB of JavaScript and a 2.7 MB WebAssembly file) is only
 * loaded when a .3dm file is imported or exported: everything here is a
 * dynamic import, so it never lands in the main bundle. The browser registers
 * a loader that tells the module where its bundled .wasm is
 * (viewer/rhinoReference.ts, like the web-ifc wasm URL); without one, the
 * package's own loader is used, which finds rhino3dm.wasm next to its script
 * (Node, tests).
 */
import type { RhinoModule } from 'rhino3dm';

export type { RhinoModule } from 'rhino3dm';

type Loader = () => Promise<RhinoModule>;

let loader: Loader | null = null;
let ready: Promise<RhinoModule> | null = null;

/** Register how the module is loaded (the browser passes the bundled wasm URL). */
export function provideRhino(fn: Loader | null) {
  loader = fn;
  ready = null;
}

async function packageLoader(): Promise<RhinoModule> {
  const mod = await import('rhino3dm');
  const factory = (mod as unknown as { default?: typeof mod.default }).default ?? (mod as unknown as typeof mod.default);
  return factory();
}

/** The initialised rhino3dm module (loaded once, on first use). */
export function loadRhino(): Promise<RhinoModule> {
  if (!ready) {
    ready = (loader ?? packageLoader)().catch((e: unknown) => {
      ready = null;
      throw new Error(`Could not load the Rhino 3dm engine (rhino3dm): ${(e as Error)?.message ?? e}`);
    });
  }
  return ready;
}

/** Free a rhino3dm (embind) object; ignores values without delete(). */
export function free(...objs: unknown[]) {
  for (const o of objs) {
    try {
      (o as { delete?: () => void } | null | undefined)?.delete?.();
    } catch {
      // already deleted
    }
  }
}
