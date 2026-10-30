import { AUTO_DEFAULTS, type AutoConnectOptions } from '../../core/connections/registry';

export { AUTO_DEFAULTS };

/** Normalise dialog state into options for autoConnect. */
export function runAutoConnectOptions(o: AutoConnectOptions): AutoConnectOptions {
  return { ...o, standoff: Math.max(0, o.standoff), slabSide: o.slabSide >= 0 ? 1 : -1 };
}
