import { it } from 'vitest';
it('diag', async () => {
  const t0 = performance.now();
  const { PROFILES, getProfile } = await import('../src/core/library/profiles');
  console.log('import ms', (performance.now() - t0).toFixed(0), 'count', PROFILES.length);
  const fams = new Map<string, number[]>();
  const bad: string[] = [];
  for (const p of PROFILES) {
    if (p.massSource !== 'catalogue') continue;
    const dev = ((p.area * 7850) / 1e6 - p.mass) / p.mass;
    const arr = fams.get(p.standard + ' ' + p.family) ?? [];
    arr.push(dev);
    fams.set(p.standard + ' ' + p.family, arr);
    if (Math.abs(dev) > 0.02) bad.push(`${p.name} ${(dev * 100).toFixed(2)}%`);
  }
  for (const [f, a] of fams) console.log(f, a.length, 'min', (Math.min(...a) * 100).toFixed(2), 'max', (Math.max(...a) * 100).toFixed(2));
  console.log('BAD >2%:', bad.join(' | '));
  const L = 1.48816394;
  const spots: [string, number][] = [
    ['L 50x50x5', 3.77], ['L 100x100x10', 15.0], ['L 150x150x15', 33.8], ['L 200x200x20', 59.9], ['L 80x80x8', 9.63], ['L 60x60x6', 5.42],
    ['L 150x90x10', 18.2], ['L 120x80x10', 15.0], ['L 100x50x6', 6.85], ['L 200x100x10', 23.0], ['L 20x20x3', 0.882], ['L 40x40x4', 2.42],
    ['SHS 100x100x5', 14.4], ['SHS 100x100x5 HF', 14.7], ['RHS 200x100x6', 26.4], ['SHS 50x50x3', 4.25], ['RHS 100x50x4', 8.59], ['SHS 200x200x10 HF', 58.8], ['RHS 200x100x6.3 HF', 28.1],
    ['CHS 168.3x6.3', 25.2], ['CHS 88.9x4', 8.38], ['FL 100x10', 7.85], ['RD 20', 2.47], ['SQ 20', 3.14],
    ['HSS6x6x1/4', 19.02 * L], ['HSS4x4x1/4', 12.21 * L], ['HSS6x4x1/4', 15.62 * L], ['HSS8x8x1/2', 48.85 * L], ['HSS6.625x0.280', 18.97 * L],
    ['Pipe2STD', 3.66 * L], ['Pipe4STD', 10.79 * L], ['Pipe6XS', 28.57 * L], ['Pipe8STD', 28.55 * L],
    ['L4x4x1/4', 6.6 * L], ['L6x6x3/8', 14.9 * L], ['L3x3x1/4', 4.9 * L], ['L8x8x1/2', 26.4 * L], ['L2x2x1/4', 3.19 * L], ['L6x4x3/8', 12.3 * L], ['L4x3x1/4', 5.8 * L],
    ['C 150x65x20x2', 0], ['CU 100x50x3', 0], ['CL 40x40x3', 0],
  ];
  for (const [n, m] of spots) {
    const p = getProfile(n);
    if (!p) { console.log('MISSING', n); continue; }
    console.log(n.padEnd(20), p.mass.toFixed(3).padStart(8), m ? m.toFixed(3).padStart(8) : '', m ? (((p.mass - m) / m) * 100).toFixed(2) + '%' : '');
  }
  const p = getProfile('L 100x100x10')!;
  console.log('L100x100x10 Iy cm4', (p.Iy / 1e4).toFixed(1), 'Iu', (p.Iu! / 1e4).toFixed(1), 'Iv', (p.Iv! / 1e4).toFixed(1), 'alpha', p.alpha, 'cy', p.cy, 'cz', p.cz);
  const i = getProfile('IPE 300')!;
  console.log('IPE300 Iy', (i.Iy / 1e4).toFixed(0), 'Wy', (i.Wy / 1e3).toFixed(0), 'Wply', (i.Wply! / 1e3).toFixed(0), 'Wplz', (i.Wplz! / 1e3).toFixed(1), 'Iz', (i.Iz / 1e4).toFixed(0));
  const u = getProfile('UPN 200')!;
  console.log('UPN200 Iy', (u.Iy / 1e4).toFixed(0), 'Iz', (u.Iz / 1e4).toFixed(0), 'Wply', (u.Wply! / 1e3).toFixed(0), 'Wplz', (u.Wplz! / 1e3).toFixed(1), 'cy', u.cy);
  const s = getProfile('SHS 100x100x5')!;
  console.log('SHS100x5 I', (s.Iy / 1e4).toFixed(0), 'Wel', (s.Wy / 1e3).toFixed(1), 'Wpl', (s.Wply! / 1e3).toFixed(1));
});
