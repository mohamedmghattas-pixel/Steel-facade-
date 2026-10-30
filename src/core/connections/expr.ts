/**
 * Safe arithmetic formulas for custom connection parameters, e.g.
 * "b_sec + 2*(edge + 20)" or "max(80, h_sec - 10)". No eval: a small
 * recursive-descent parser over numbers, names, + − × ÷, parentheses and a few
 * functions.
 */
const FUNCS: Record<string, (...a: number[]) => number> = {
  max: Math.max,
  min: Math.min,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  /** Round up to a multiple: ceilto(x, 5). */
  ceilto: (x, m = 5) => Math.ceil(x / (m || 1)) * (m || 1),
  sqrt: Math.sqrt,
};

export class ExprError extends Error {}

export function evalExpr(src: string | number, vars: Record<string, number>): number {
  if (typeof src === 'number') return src;
  const s = String(src ?? '').trim();
  if (!s) return 0;
  let i = 0;
  const peek = () => s[i];
  const ws = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  const expr = (): number => {
    let v = term();
    for (;;) {
      ws();
      if (peek() === '+') (i++, (v += term()));
      else if (peek() === '-') (i++, (v -= term()));
      else return v;
    }
  };
  const term = (): number => {
    let v = factor();
    for (;;) {
      ws();
      if (peek() === '*') (i++, (v *= factor()));
      else if (peek() === '/') {
        i++;
        const d = factor();
        v = d === 0 ? 0 : v / d;
      } else return v;
    }
  };
  const factor = (): number => {
    ws();
    const c = peek();
    if (c === '-') return i++, -factor();
    if (c === '+') return i++, factor();
    if (c === '(') {
      i++;
      const v = expr();
      ws();
      if (peek() !== ')') throw new ExprError(`Missing ")" in "${s}"`);
      i++;
      return v;
    }
    const num = s.slice(i).match(/^\d+(\.\d+)?/);
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    const id = s.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (id) {
      i += id[0].length;
      ws();
      if (peek() === '(') {
        const fn = FUNCS[id[0].toLowerCase()];
        if (!fn) throw new ExprError(`Unknown function ${id[0]}`);
        i++;
        const args: number[] = [];
        ws();
        if (peek() !== ')') {
          for (;;) {
            args.push(expr());
            ws();
            if (peek() === ',') i++;
            else break;
          }
        }
        if (peek() !== ')') throw new ExprError(`Missing ")" after ${id[0]}(`);
        i++;
        return fn(...args);
      }
      if (!(id[0] in vars)) throw new ExprError(`Unknown name "${id[0]}"`);
      return vars[id[0]];
    }
    throw new ExprError(`Cannot read "${s.slice(i)}"`);
  };
  const v = expr();
  ws();
  if (i < s.length) throw new ExprError(`Unexpected "${s.slice(i)}" in "${s}"`);
  if (!Number.isFinite(v)) throw new ExprError(`"${s}" is not a finite number`);
  return v;
}
