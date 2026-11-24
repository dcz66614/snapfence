/**
 * SnapFence (P030) — JSON export. T009.
 *
 * Authority: PROJECT_BOOK.md §8.4 (SearchResult, schemaVersion
 * "snapfence.report/v1"), §4.4 / §4.7 (verbatim diagnostic codes and
 * verdicts), IMPLEMENTATION_PLAN.md §9.1 (frozen `exportJson` signature
 * in src/core/model/contracts.ts: `(result: SearchResult) => string`).
 *
 * `exportJson` serializes a SearchResult as a `snapfence.report/v1`
 * document. The output is deterministic: the same SearchResult always
 * produces byte-identical JSON (fixed field order, snapshot maps with
 * keys sorted lexicographically, diagnostics in the frozen sorted
 * order, 2-space indentation, one trailing newline). No timestamps,
 * no randomness, no environment-dependent values are ever emitted.
 *
 * The exported document is validated against `report-schema.ts`
 * (`validateReport`) in the integration tests; `exportJson` itself
 * does not throw for a well-formed SearchResult.
 *
 * Rules for this file:
 * - TypeScript strict mode; `any` is forbidden.
 * - Pure deterministic functions only; no I/O, no network, no wall-clock.
 * - Reuses the S0-verified `SearchResult` / `Diagnostic` contracts
 *   without changing core semantics in `src/core/`.
 */

import type {
  BlobState,
  DatabaseState,
  Diagnostic,
  SearchResult,
} from "../core/model/types";
import { sortDiagnostics } from "../core/search/search-result";
import { REPORT_SCHEMA_VERSION } from "./report-schema";
import type { ExportJson } from "../core/model/contracts";

/** A JSON-serializable snapshot record, keys in schema order. */
export interface JsonBlobReference {
  objectId: string;
  generation: number;
  digest: string;
}

/**
 * The exported document shape: the twelve §8.4 fields in schema order.
 * `databaseSnapshot` / `blobSnapshot` keys are sorted lexicographically
 * so the output is stable regardless of map insertion order.
 */
export interface ReportDocument {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  scenarioId: string;
  strategy: SearchResult["strategy"];
  verdict: SearchResult["verdict"];
  eventCount: number;
  counterexample: string[];
  counterexampleLength: number;
  diagnostics: Diagnostic[];
  databaseSnapshot: Record<string, JsonBlobReference>;
  blobSnapshot: Record<string, string>;
  assumptions: string[];
  limitations: string[];
}

function sortedDatabaseSnapshot(
  snapshot: DatabaseState,
): Record<string, JsonBlobReference> {
  const out: Record<string, JsonBlobReference> = {};
  for (const fileId of Object.keys(snapshot).sort()) {
    const reference = snapshot[fileId];
    out[fileId] = {
      objectId: reference.objectId,
      generation: reference.generation,
      digest: reference.digest,
    };
  }
  return out;
}

function sortedBlobSnapshot(snapshot: BlobState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, digest] of Object.entries(snapshot).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    out[key] = digest;
  }
  return out;
}

/**
 * Build the plain report document for a SearchResult (no serialization).
 * The document carries the complete strategy, verdict, diagnostic,
 * counterexample, snapshot, assumption and limitation information —
 * nothing from the SearchResult is dropped.
 */
export function exportJsonObject(result: SearchResult): ReportDocument {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    scenarioId: result.scenarioId,
    strategy: result.strategy,
    verdict: result.verdict,
    eventCount: result.eventCount,
    counterexample: [...result.counterexample],
    counterexampleLength: result.counterexampleLength,
    diagnostics: [...sortDiagnostics(result.diagnostics)],
    databaseSnapshot: sortedDatabaseSnapshot(result.databaseSnapshot),
    blobSnapshot: sortedBlobSnapshot(result.blobSnapshot),
    assumptions: [...result.assumptions],
    limitations: [...result.limitations],
  };
}

/**
 * Serialize a SearchResult as a `snapfence.report/v1` JSON string.
 * Deterministic: same input, byte-identical output. `JSON.stringify`
 * escapes `<`, `>`, `&`, quotes and non-ASCII text correctly on
 * round-trip (verified by the escaping integration test, including
 * Chinese text in file/object IDs).
 */
export const exportJson: ExportJson = (result: SearchResult): string => {
  return `${JSON.stringify(exportJsonObject(result), null, 2)}\n`;
};
