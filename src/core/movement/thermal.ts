/**
 * Thermal movement of members: ΔL = α · ΔT · L.
 *
 * α per material (core/library/materials): carbon steel 12e-6 /K (EN 1993-1-1
 * 3.2.6), austenitic stainless 16e-6 /K (EN 1993-1-4 / EN 10088-1), aluminium
 * 23e-6 /K (EN 1999-1-1). ΔT is taken from the installation temperature to the
 * design extremes, separately for expansion and contraction.
 */
import type { MovementSettings } from '../model/types';
import { thermalExpansion } from '../library/materials';

export interface TempRange {
  /** Temperature rise above installation, K (expansion). */
  expansion: number;
  /** Temperature drop below installation, K (contraction). */
  contraction: number;
}

export function tempRange(ms: Pick<MovementSettings, 'tempInstall' | 'tempMin' | 'tempMax'>): TempRange {
  return {
    expansion: Math.max(0, ms.tempMax - ms.tempInstall),
    contraction: Math.max(0, ms.tempInstall - ms.tempMin),
  };
}

export interface ThermalMovement {
  alpha: number;
  length: number;
  dTexp: number;
  dTcon: number;
  /** ΔL lengthening at the hottest steel temperature, mm. */
  expansion: number;
  /** ΔL shortening at the coldest steel temperature, mm. */
  contraction: number;
  /** The larger of the two: what a symmetric slot centred at installation must allow each way. */
  max: number;
}

/** ΔL = α · ΔT · L for expansion and contraction, mm. */
export function thermalMovement(length: number, material: string, ms: Pick<MovementSettings, 'tempInstall' | 'tempMin' | 'tempMax'>): ThermalMovement {
  const alpha = thermalExpansion(material);
  const t = tempRange(ms);
  const L = Math.max(0, length);
  const expansion = alpha * t.expansion * L;
  const contraction = alpha * t.contraction * L;
  return { alpha, length: L, dTexp: t.expansion, dTcon: t.contraction, expansion, contraction, max: Math.max(expansion, contraction) };
}
