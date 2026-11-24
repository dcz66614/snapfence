/**
 * SnapFence (P030) — SearchResult construction. T003.
 *
 * Authority: PROJECT_BOOK.md §8.4 (SearchResult fields, schemaVersion
 * "snapfence.report/v1"), §4.4 (diagnostic codes and severities), §4.7
 * (verdicts), §6 (honest boundary); types.ts (SearchResult, Diagnostic).
 * Inputs (frozen, read-only): src/core/model/types.ts,
 * src/core/model/scenario.ts (MAX_EVENTS).
 *
 * Rules for this file:
 * - TypeScript strict mode; `any` is forbidden.
 * - Pure deterministic functions only; no randomness, no wall-clock.
 * - Every SearchResult built here carries the fixed schemaVersion, a
 *   counterexampleLength that always equals counterexample.length, and the
 *   frozen assumptions / limitations strings. The verdict is supplied by
 *   the caller (bfs.ts); this module never decides a verdict on its own.
 */

import type {
  BackupStrategy,
  BlobState,
  DatabaseState,
  Diagnostic,
  DiagnosticCode,
  DiagnosticSeverity,
  SearchResult,
  SearchVerdict,
  ValidationIssue,
} from "../model/types";
import { MAX_EVENTS } from "../model/scenario";

/** The fixed report schema version (PROJECT_BOOK.md §8.4, verbatim). */
export const REPORT_SCHEMA_VERSION = "snapfence.report/v1" as const;

/** Empty database snapshot (used when no snapshot pair exists). */
export const EMPTY_DATABASE_SNAPSHOT: DatabaseState = {};

/** Empty Blob snapshot (used when no snapshot pair exists). */
export const EMPTY_BLOB_SNAPSHOT: BlobState = {};

// ---------------------------------------------------------------------------
// Fixed assumptions and limitations (§6 honest boundary, §4.7)
// ---------------------------------------------------------------------------

/** Assumptions carried by every SearchResult built by this module. */
export const SEARCH_ASSUMPTIONS: readonly string[] = [
  "Synthetic model only: no real database, file system, or Blob storage is involved (PROJECT_BOOK.md §6, §11.1).",
  "Snapshot consistency is judged against a common legal operation boundary (PROJECT_BOOK.md §4.3).",
  "Event templates are the frozen §3.2 templates: UPLOAD BLOB_PUT -> DB_LINK; DELETE DB_UNLINK -> BLOB_DELETE; UPDATE BLOB_PUT_NEW -> DB_REPOINT -> BLOB_DELETE_OLD.",
  "The search bound is 10 atomic events including the 2 snapshot events (PROJECT_BOOK.md §10.3).",
] as const;

/** Limitations carried by every SearchResult built by this module. */
export const SEARCH_LIMITATIONS: readonly string[] = [
  "SAFE_WITHIN_BOUND is bounded only: it does not prove the real production system is safe (PROJECT_BOOK.md §4.7, §6).",
  "Behaviour beyond the 10-event bound is not covered; over-limit input returns INCONCLUSIVE_LIMIT, never SAFE (PROJECT_BOOK.md §4.7).",
  "Consistency invariants and counterexample extraction beyond §4.5–§4.7 are the T004 module's responsibility; this result carries the trace and snapshot pair T004 needs.",
] as const;

// ---------------------------------------------------------------------------
// Diagnostic severities (§4.4, verbatim)
// ---------------------------------------------------------------------------

/** Frozen severity for each diagnostic code (PROJECT_BOOK.md §4.4). */
export const DIAGNOSTIC_SEVERITY: Readonly<Record<DiagnosticCode, DiagnosticSeverity>> = {
  DANGLING_REFERENCE: "CRITICAL",
  ORPHAN_BLOB: "WARNING",
  GENERATION_MISMATCH: "CRITICAL",
  DIGEST_MISMATCH: "CRITICAL",
  IN_FLIGHT_OPERATION: "WARNING",
  NO_COMMON_BOUNDARY: "CRITICAL",
} as const;

/** Severity of one diagnostic code. */
export function severityFor(code: DiagnosticCode): DiagnosticSeverity {
  return DIAGNOSTIC_SEVERITY[code];
}

/** Build one diagnostic with its frozen severity. */
export function makeDiagnostic(
  code: DiagnosticCode,
  message: string,
  fileId?: string,
  objectId?: string,
): Diagnostic {
  const diagnostic: Diagnostic = { code, severity: severityFor(code), message };
  if (fileId !== undefined) {
    return objectId !== undefined
      ? { ...diagnostic, fileId, objectId }
      : { ...diagnostic, fileId };
  }
  return objectId !== undefined ? { ...diagnostic, objectId } : diagnostic;
}

/** Deterministic diagnostic order: by code, then fileId, objectId, message. */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
  return [...diagnostics].sort((a, b) => {
    if (a.code !== b.code) {
      return a.code < b.code ? -1 : 1;
    }
    const aFile = a.fileId ?? "";
    const bFile = b.fileId ?? "";
    if (aFile !== bFile) {
      return aFile < bFile ? -1 : 1;
    }
    const aObj = a.objectId ?? "";
    const bObj = b.objectId ?? "";
    if (aObj !== bObj) {
      return aObj < bObj ? -1 : 1;
    }
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// SearchResult construction
// ---------------------------------------------------------------------------

/** Arguments for building a SearchResult. */
export interface BuildSearchResultArgs {
  scenarioId: string;
  strategy: BackupStrategy;
  verdict: SearchVerdict;
  eventCount: number;
  counterexample: readonly string[];
  diagnostics: readonly Diagnostic[];
  databaseSnapshot: DatabaseState;
  blobSnapshot: BlobState;
  /** Extra limitation strings appended after SEARCH_LIMITATIONS. */
  extraLimitations?: readonly string[];
}

/**
 * Build a SearchResult. `counterexampleLength` is always set to
 * `counterexample.length` (0 when there is none). Assumptions and
 * limitations are the frozen strings above, plus any extra limitations
 * the caller supplies (in caller order, after the frozen ones).
 */
export function buildSearchResult(args: BuildSearchResultArgs): SearchResult {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    scenarioId: args.scenarioId,
    strategy: args.strategy,
    verdict: args.verdict,
    eventCount: args.eventCount,
    counterexample: [...args.counterexample],
    counterexampleLength: args.counterexample.length,
    diagnostics: sortDiagnostics(args.diagnostics),
    databaseSnapshot: args.databaseSnapshot,
    blobSnapshot: args.blobSnapshot,
    assumptions: [...SEARCH_ASSUMPTIONS],
    limitations: [
      ...SEARCH_LIMITATIONS,
      ...(args.extraLimitations ?? []),
    ],
  };
}

/**
 * Placeholder scenarioId for an INVALID_INPUT report whose input
 * scenarioId was missing, empty, or whitespace-only (P030-R1-01).
 * A report must satisfy snapfence.report/v1 (`scenarioId` minLength 1),
 * so the normalized report field can never carry the raw empty value.
 * The raw value is preserved separately, in `limitations` (see below) —
 * never in this field.
 */
export const NORMALIZED_UNKNOWN_SCENARIO_ID = "UNKNOWN_SCENARIO";

/**
 * Default strategy for an INVALID_INPUT report whose input strategy was
 * not one of the three legal literals (P030-R1-01). `DB_FIRST` is the
 * first enum value and therefore the deterministic default; it is a
 * placeholder for schema validity, NOT a claim about the input strategy.
 * The raw value is preserved separately, in `limitations` (see below).
 */
export const NORMALIZED_DEFAULT_STRATEGY: BackupStrategy = "DB_FIRST";

/**
 * Normalize a raw scenarioId to a schema-valid report value (P030-R1-01):
 * a string with non-whitespace content is kept verbatim; anything else
 * (empty string, whitespace-only, missing, non-string) becomes
 * `NORMALIZED_UNKNOWN_SCENARIO_ID`.
 */
export function normalizeInvalidInputScenarioId(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : NORMALIZED_UNKNOWN_SCENARIO_ID;
}

/**
 * Normalize a raw strategy to a schema-valid report value (P030-R1-01):
 * one of the three legal literals is kept; anything else (unknown
 * literal such as "DB_LAST", missing, non-string) becomes
 * `NORMALIZED_DEFAULT_STRATEGY`.
 */
export function normalizeInvalidInputStrategy(value: unknown): BackupStrategy {
  return value === "DB_FIRST" || value === "FILE_FIRST" || value === "PAUSE_WRITES"
    ? value
    : NORMALIZED_DEFAULT_STRATEGY;
}

/** Render one raw value for the limitations note: JSON when possible. */
function renderRawValue(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

/**
 * The limitations note carrying the raw (pre-normalization) scenarioId /
 * strategy of an INVALID_INPUT report (P030-R1-01). It lives in
 * `limitations` — a `string[]` field the schema already allows — so the
 * raw illegal values are preserved for diagnosis without ever appearing
 * in a schema-constrained position. The note states explicitly that the
 * normalized report values are placeholders, not the input values.
 */
export function describeRawInvalidInputFields(
  rawScenarioId: unknown,
  rawStrategy: unknown,
): string {
  return (
    `Raw invalid input (the normalized report values are placeholders, ` +
    `not the input values): scenarioId=${renderRawValue(rawScenarioId)} ` +
    `strategy=${renderRawValue(rawStrategy)}.`
  );
}

/**
 * The limitations note for an INVALID_INPUT report whose whole input was
 * not a scenario object at all (null / undefined / non-object, P030-R1-01).
 * Carries the whole raw input, rendered the same way as
 * `describeRawInvalidInputFields`.
 */
export function describeRawInvalidInput(rawInput: unknown): string {
  return (
    `Raw invalid input (the whole input was not a scenario object; the ` +
    `normalized report values are placeholders, not the input values): ` +
    `${renderRawValue(rawInput)}.`
  );
}

/**
 * Build the INVALID_INPUT result for a scenario that failed validation.
 *
 * P030-R1-01 normalized-output contract (GPT final review R1, P1-R1-01):
 * the report fields are NORMALIZED to schema-valid values — the
 * scenarioId via `normalizeInvalidInputScenarioId` (empty / missing /
 * whitespace-only becomes "UNKNOWN_SCENARIO") and the strategy via
 * `normalizeInvalidInputStrategy` (an illegal literal such as "DB_LAST"
 * becomes "DB_FIRST"). The schema is NOT weakened: `scenarioId`
 * minLength 1 and the 3-value strategy enum stand unchanged, and no new
 * top-level field is added (the frozen §8.4 twelve fields and
 * `additionalProperties: false` are preserved). The original raw invalid
 * input is preserved, but only in a separate `limitations` entry — a
 * schema-legal `string[]` position — via `describeRawInvalidInputFields`
 * (emitted exactly when normalization changed something), or via the
 * caller-supplied `rawInputNote` (used when the whole input was not a
 * scenario object, where the fields alone cannot describe the input).
 * A valid scenarioId / strategy is always kept verbatim, and then no raw
 * note is emitted (there is nothing to preserve beyond the fields).
 *
 * The event count is the count the caller could compute (0 when the input
 * was too broken to count). The validation issue codes are listed, sorted
 * and deduped, in an extra limitation string so the failure is explainable
 * from the result alone. Diagnostics stay empty: no diagnostic code in
 * §4.4 names an input-validation failure.
 */
export function buildInvalidInputResult(
  scenarioId: unknown,
  strategy: unknown,
  eventCount: number,
  issues: readonly ValidationIssue[],
  rawInputNote?: string,
): SearchResult {
  const normalizedScenarioId = normalizeInvalidInputScenarioId(scenarioId);
  const normalizedStrategy = normalizeInvalidInputStrategy(strategy);
  const codes = [...new Set(issues.map((issue) => issue.code))].sort();
  const detail =
    codes.length > 0
      ? `Input failed validation with issue code(s): ${codes.join(", ")}.`
      : "Input failed validation.";
  const extraLimitations: string[] = [
    `${detail} Invalid input is reported, never silently ignored or repaired (PROJECT_BOOK.md §8.6).`,
  ];
  if (rawInputNote !== undefined) {
    extraLimitations.push(rawInputNote);
  } else if (
    normalizedScenarioId !== scenarioId ||
    normalizedStrategy !== strategy
  ) {
    extraLimitations.push(
      describeRawInvalidInputFields(scenarioId, strategy),
    );
  }
  return buildSearchResult({
    scenarioId: normalizedScenarioId,
    strategy: normalizedStrategy,
    verdict: "INVALID_INPUT",
    eventCount,
    counterexample: [],
    diagnostics: [],
    databaseSnapshot: EMPTY_DATABASE_SNAPSHOT,
    blobSnapshot: EMPTY_BLOB_SNAPSHOT,
    extraLimitations,
  });
}

/**
 * Build the INCONCLUSIVE_LIMIT result for a scenario that exceeds the
 * supported bounded search size. This verdict is NEVER a downgraded SAFE:
 * no search was attempted and no counterexample is claimed. The event
 * count is the scenario's real total (including the 2 snapshot events).
 */
export function buildLimitResult(
  scenarioId: string,
  strategy: BackupStrategy,
  eventCount: number,
  totalEvents: number,
): SearchResult {
  return buildSearchResult({
    scenarioId,
    strategy,
    verdict: "INCONCLUSIVE_LIMIT",
    eventCount,
    counterexample: [],
    diagnostics: [],
    databaseSnapshot: EMPTY_DATABASE_SNAPSHOT,
    blobSnapshot: EMPTY_BLOB_SNAPSHOT,
    extraLimitations: [
      `Scenario needs ${totalEvents} atomic events (including the 2 snapshot events), exceeding the supported bound of ${MAX_EVENTS}; the search was not attempted.`,
    ],
  });
}
