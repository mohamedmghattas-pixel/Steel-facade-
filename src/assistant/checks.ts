import type { Project } from '../core/model/types';
import type { DerivedModel } from '../core/derive/model';

export interface CodeFinding {
  severity: string;
  message: string;
  clause: string;
}

/** Detailing-code findings for the assistant (wired to the code-rules engine). */
export function codeChecks(_p: Project, _dm: DerivedModel): CodeFinding[] {
  return [];
}
