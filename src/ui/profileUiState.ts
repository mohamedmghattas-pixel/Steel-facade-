import { create } from 'zustand';
import type { Sketch } from '../core/library/sketch';
import type { ProfileDef } from '../core/library/profiles';

/** What the sketcher page opens with. */
export interface SketcherOpen {
  /** Name of the custom profile being edited (null = a new profile). */
  editing: string | null;
  sketch: Sketch;
  name: string;
  family: string;
  material: string;
}

export interface ReviewItem {
  def: ProfileDef;
  include: boolean;
  error?: string;
  warnings: string[];
  /** DXF: where the name / insertion point came from. */
  nameFrom?: 'text' | 'file';
  insertionFrom?: 'point' | 'marker' | 'origin' | 'none';
}

/** Profiles found in an uploaded file, waiting for the user to review them. */
export interface ImportReview {
  fileName: string;
  kind: 'dxf' | 'json' | 'csv';
  text: string;
  items: ReviewItem[];
  notes: string[];
  /** DXF: millimetres per drawing unit, and where it came from. */
  unitScale?: number;
  unitSource?: string;
}

export const useProfileUi = create<{ sketcher: SketcherOpen | null; review: ImportReview | null }>(() => ({ sketcher: null, review: null }));
