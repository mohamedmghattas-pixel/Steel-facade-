import type { Vec2 } from '../model/types';

export type DLayer = 'visible' | 'hidden' | 'center' | 'dim' | 'text' | 'border' | 'thin';

export type DEnt =
  | { t: 'line'; a: Vec2; b: Vec2; layer: DLayer }
  | { t: 'circle'; c: Vec2; r: number; layer: DLayer }
  | { t: 'poly'; pts: Vec2[]; closed: boolean; layer: DLayer }
  | { t: 'text'; p: Vec2; text: string; h: number; anchor?: 'start' | 'middle' | 'end'; rot?: number; layer: DLayer };

/** A drawing sheet. Paper coordinates in mm, origin bottom-left, y up. */
export interface Drawing {
  id: string;
  kind: 'part' | 'assembly' | 'ga';
  mark: string;
  title: string;
  sheet: { w: number; h: number };
  scale: string;
  entities: DEnt[];
}

export const A3 = { w: 420, h: 297 };
