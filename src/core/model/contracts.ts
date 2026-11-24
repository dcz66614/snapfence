/**
 * SnapFence (P030) — frozen core interface signatures. T001.
 *
 * Authority: IMPLEMENTATION_PLAN.md §9.1 — "核心接口：核心模块统一导出"
 * (validateScenario, runSearch, checkConsistency, extractCounterexample,
 * exportJson, exportHtml). "以上接口由 T001 冻结，不允许各模块私自修改字段名。"
 *
 * This file declares the signatures ONLY, as function types and as one
 * `SnapFenceCore` interface. There are deliberately NO implementations and
 * NO runtime stubs here: implementations land in later tasks
 * (validateScenario → T002, runSearch → T003, checkConsistency /
 * extractCounterexample → T004, exportJson / exportHtml → T009) and each
 * implementation module must satisfy the corresponding type below.
 * A module that cannot satisfy a signature must report the conflict instead
 * of silently changing it (IMPLEMENTATION_PLAN.md §14.2 — core changes need
 * an ADR and a SPEC_VERSION bump).
 */

import type {
  ConsistencyResult,
  Counterexample,
  DatabaseState,
  BlobState,
  OperationBoundary,
  Scenario,
  SearchResult,
  SearchTrace,
  ValidationResult,
} from "./types";

// ---------------------------------------------------------------------------
// Individual frozen function types (§9.1, verbatim signatures)
// ---------------------------------------------------------------------------

/**
 * Validate a scenario against the §8.6 constraints (explicit IDs, legal DAG,
 * no cycles, no reference to a nonexistent object version, no duplicate event
 * ID, within the bounded event count). Invalid input is reported, never
 * silently ignored (§8.6).
 */
export type ValidateScenario = (scenario: Scenario) => ValidationResult;

/**
 * Run the deterministic bounded BFS interleaving search (§4.5) for one
 * scenario and return the §8.4 SearchResult. Must be deterministic: the same
 * input always yields the same result (§4.5/§4.6). Over-limit input returns
 * INCONCLUSIVE_LIMIT, never a downgraded SAFE (§4.7, plan §1.4).
 */
export type RunSearch = (scenario: Scenario) => SearchResult;

/**
 * Check whether a database snapshot and a Blob snapshot correspond to one
 * common legal operation boundary (§4.3), given the enumerated boundaries.
 */
export type CheckConsistency = (
  databaseSnapshot: DatabaseState,
  blobSnapshot: BlobState,
  boundaries: readonly OperationBoundary[],
) => ConsistencyResult;

/**
 * Extract the shortest counterexample from a search trace (§4.6). The
 * returned counterexample has minimal event length; ties are broken by fixed
 * lexicographic order of event IDs.
 */
export type ExtractCounterexample = (searchTrace: SearchTrace) => Counterexample;

/** Serialize a SearchResult as a JSON string (schema snapfence.report/v1). */
export type ExportJson = (result: SearchResult) => string;

/** Render a SearchResult as a self-contained standalone HTML string (§11.2). */
export type ExportHtml = (result: SearchResult) => string;

// ---------------------------------------------------------------------------
// The frozen core API surface, as one interface
// ---------------------------------------------------------------------------

/**
 * The complete frozen core API. Every implementation module must conform to
 * this interface; no module may rename a method, change a parameter, or add
 * a required parameter. Optional behaviour (e.g. extra diagnostic detail) is
 * expressed through the result types in types.ts, never by widening these
 * signatures.
 */
export interface SnapFenceCore {
  validateScenario: ValidateScenario;
  runSearch: RunSearch;
  checkConsistency: CheckConsistency;
  extractCounterexample: ExtractCounterexample;
  exportJson: ExportJson;
  exportHtml: ExportHtml;
}
