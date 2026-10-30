import type { Project } from '../core/model/types';
import type { DerivedModel } from '../core/derive/model';
import { codeForProject, runCodeChecks } from '../core/codes';

export interface CodeFinding {
  severity: string;
  message: string;
  clause: string;
  connectionId?: string;
  memberId?: string;
}

/** Detailing-code findings for the assistant (AISC 360 / EN 1993-1-8 / EN 1090-2 / coatings). */
export function codeChecks(p: Project, dm: DerivedModel): CodeFinding[] {
  const code = codeForProject(p);
  return runCodeChecks(p, dm, code).map((r) => ({
    severity: r.severity,
    message: r.message,
    clause: r.clause,
    connectionId: r.connectionId,
    memberId: r.memberId,
  }));
}
