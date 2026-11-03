import { create } from 'zustand';
import type { Sketch } from '../core/library/sketch';
import type { ProfileDef } from '../core/library/profiles';
import type { AsmDxfImport, DetailChoice } from '../core/library/profileAssemblyDxf';

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
  insertionFrom?: 'point' | 'marker' | 'origin' | 'none' | 'detail';
  /** DXF: the assembly detail the outline belongs to (its base point is the shared insertion point). */
  detail?: { index: number; name: string };
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
  /** DXF: outlines of one detail share its base point as insertion point (default true). */
  sharedBase?: boolean;
}

/** A reviewed detail of an assembly-detail upload: what to do with it and the choices made. */
export interface AsmDetailReview {
  /** 'save': its own assembly; 'merge': another orientation of `into`; 'skip'. */
  action: 'save' | 'merge' | 'skip';
  into?: number;
  choice: DetailChoice;
}

/** An uploaded assembly-detail DXF waiting for review (profileAssemblyActions). */
export interface AssemblyReview {
  fileName: string;
  text: string;
  imp: AsmDxfImport;
  /** Blocks used as base-point markers (null: detected). */
  markers: string[] | null;
  unitScale?: number;
  details: AsmDetailReview[];
  /** Detail shown. */
  current: number;
}

export const useProfileUi = create<{ sketcher: SketcherOpen | null; review: ImportReview | null; assemblyReview: AssemblyReview | null }>(() => ({ sketcher: null, review: null, assemblyReview: null }));
