/** Shared types of the code-rules engine. */

/** Design / detailing code family used for the checks and defaults. */
export type DesignCode = 'AISC360' | 'EC3';

/** Hole classes common to AISC 360 Table J3.3 and EN 1090-2 Table 11. */
export type HoleType = 'standard' | 'oversize' | 'shortSlot' | 'longSlot';

export type Severity = 'error' | 'warning' | 'info';

export interface CheckResult {
  id: string;
  /** Id of the rule in `RULES`. */
  rule: string;
  severity: Severity;
  message: string;
  clause: string;
  /** Measured value and code limit, mm (or µm for coatings). */
  value?: number;
  limit?: number;
  connectionId?: string;
  memberId?: string;
  partRef?: string;
  /** Number of identical findings merged into this one (identical parts). */
  count?: number;
}

/** How a rule's numbers were checked when it was encoded (see docs/CODE_RULES.md). */
export type Verification =
  /** Matches at least one independent reproduction of the code table/text found online. */
  | 'cross-checked'
  /** Encoded from the code text as known to the author; the primary text could not be opened to re-check. */
  | 'unconfirmed'
  /** Industry guidance or geometry, not a code requirement. */
  | 'guidance';

export interface CodeRule {
  id: string;
  title: string;
  /** Which design code the rule belongs to ('both' = fabrication / coating rules used with either). */
  code: DesignCode | 'both';
  clause: string;
  edition: string;
  description: string;
  /** The numbers, in words. */
  values: string;
  verification: Verification;
  sources: string[];
}
