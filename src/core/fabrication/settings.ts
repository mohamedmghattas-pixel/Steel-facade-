/**
 * Fabrication output settings with defaults. Projects store only what the user
 * changed (`settings.fabrication` is partial), so older files keep working.
 */
import type { FabricationSettings, Project } from '../model/types';

export function defaultFabricationSettings(): FabricationSettings {
  return {
    dxfMarking: true,
    markHeight: 10,
    plateKerf: 0,
    labelLayout: 'a4-3x8',
    labelPer: 'piece',
    galvClearance: 100,
    // A typical two-coat system — replace with the project coating specification.
    paintCoats: [
      { name: 'Primer', dft: 80, solids: 60 },
      { name: 'Topcoat', dft: 60, solids: 55 },
    ],
    paintLoss: 0,
  };
}

export function fabSettings(p: Project): FabricationSettings {
  const d = defaultFabricationSettings();
  const s = p.settings.fabrication ?? {};
  return { ...d, ...s, paintCoats: s.paintCoats ?? d.paintCoats };
}
