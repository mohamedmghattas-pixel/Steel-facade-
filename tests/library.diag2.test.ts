import { it } from 'vitest';
import { PROFILES } from '../src/core/library/profiles';
import { sectionProps } from '../src/core/library/shapes';
it('timing', () => {
  const t0 = performance.now();
  for (const p of PROFILES) sectionProps(p.shape);
  console.log('sectionProps all ms', (performance.now() - t0).toFixed(0));
});
