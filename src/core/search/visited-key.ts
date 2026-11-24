/**
 * SnapFence (P030) — deterministic visited-state dedup key. T003.
 *
 * Authority: PROJECT_BOOK.md §4.5 (BFS state dedup key), §4.6 (deterministic
 * tie-break), §10.3 (10-event bound); MODEL_CONTRACT.md §6 (no randomness,
 * no wall-clock, no object traversal order may influence results).
 * Inputs (frozen, read-only): src/core/model/types.ts;
 * src/core/events/apply-event.ts (in-flight helpers, via search-state.ts).
 *
 * Rules for this file:
 * - TypeScript strict mode; `any` is forbidden.
 * - Pure deterministic functions only: the key is a pure function of the
 *   search state, built from sorted keys and sorted ID lists only. Two
 *   states with the same key are interchangeable for the rest of the search;
 *   two states that differ in ANY key component MUST produce different keys.
 *
 * Key components (§4.5, verbatim):
 *   1. executed event set
 *   2. current database state
 *   3. current Blob state
 *   4. both snapshot-captured states
 *   5. per-operation completion status
 *
 * Conservative extension (documented, does not weaken §4.5): the key also
 * carries, for each snapshot, the operation IDs that were IN_FLIGHT when
 * that snapshot was captured. The five §4.5 components alone do not
 * determine the IN_FLIGHT_OPERATION diagnostic of a captured pair: the same
 * executed set, current states, captured states and completion status can
 * be reached with a snapshot taken mid-operation or taken at a boundary
 * (e.g. DB_SNAPSHOT after BLOB_PUT vs before it, same captured D). Merging
 * those two states would make the counterexample's diagnostics depend on
 * visit order. The capture-time in-flight sets are therefore part of the
 * key, so states differing in them are never merged. No §4.5 component is
 * dropped or weakened by this extension.
 */

import type { BlobState, DatabaseState, OperationStatus } from "../model/types";
import type { SearchState } from "./search-state";

// ---------------------------------------------------------------------------
// Stable (key-sorted) JSON serialisation
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serialisation: object keys are always emitted in
 * sorted order, arrays keep their order, primitives use JSON.stringify.
 * Two values that are equal as data serialise to the same string regardless
 * of the insertion order of their keys. `undefined` never occurs in the
 * state records this module serialises; it is rendered as `null` so the
 * function stays total.
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      parts.push(stableStringify(item));
    }
    return `[${parts.join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      parts.push(`${JSON.stringify(key)}:${stableStringify(record[key])}`);
    }
    return `{${parts.join(",")}}`;
  }
  // No other value kinds occur in search states (no functions, symbols,
  // bigint, or undefined fields). Fail closed rather than emit a
  // non-deterministic rendering.
  throw new Error(`stableStringify: unsupported value of type ${typeof value}`);
}

/** Stable key of a database state (fileId-sorted, field-sorted). */
export function databaseStateKey(database: DatabaseState): string {
  return stableStringify(database);
}

/** Stable key of a Blob state (version-key-sorted). */
export function blobStateKey(blob: BlobState): string {
  return stableStringify(blob);
}

/** Stable key of the per-operation completion status (opId-sorted). */
export function operationStatusKey(
  status: Readonly<Record<string, OperationStatus>>,
): string {
  return stableStringify(status);
}

/** Stable key of a snapshot pair (database snapshot, Blob snapshot). */
export function snapshotPairKey(
  databaseSnapshot: DatabaseState | null,
  blobSnapshot: BlobState | null,
): string {
  return `db=${databaseSnapshot === null ? "null" : databaseStateKey(databaseSnapshot)};blob=${blobSnapshot === null ? "null" : blobStateKey(blobSnapshot)}`;
}

/** Sorted copy of an ID list (deduped, lexicographic order). */
export function sortedIdList(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)].sort();
}

// ---------------------------------------------------------------------------
// Visited key
// ---------------------------------------------------------------------------

/**
 * Deterministic visited-state dedup key for one search state.
 *
 * Format (field order fixed; every component is key-sorted):
 *   executed=[<sorted event IDs>]
 *   ;db=<database state>
 *   ;blob=<Blob state>
 *   ;dbSnap=<captured database state or null>
 *   ;blobSnap=<captured Blob state or null>
 *   ;status=<per-operation completion status>
 *   ;dbSnapInFlight=[<sorted op IDs in-flight at DB snapshot capture>]
 *   ;blobSnapInFlight=[<sorted op IDs in-flight at Blob snapshot capture>]
 *
 * States that differ in any component produce different keys; states that
 * agree on every component produce the same key regardless of the order in
 * which their events executed or their records were inserted.
 */
export function visitedKey(state: SearchState): string {
  const executed = sortedIdList(state.executedEventIds).join(",");
  const db = databaseStateKey(state.systemState.database);
  const blob = blobStateKey(state.systemState.blob);
  const dbSnap =
    state.databaseSnapshot === null
      ? "null"
      : databaseStateKey(state.databaseSnapshot);
  const blobSnap =
    state.blobSnapshot === null ? "null" : blobStateKey(state.blobSnapshot);
  const status = operationStatusKey(state.systemState.operationStatus);
  const dbInFlight = sortedIdList(state.dbSnapshotInFlightOperationIds).join(",");
  const blobInFlight = sortedIdList(state.blobSnapshotInFlightOperationIds).join(",");
  return (
    `executed=[${executed}]` +
    `;db=${db}` +
    `;blob=${blob}` +
    `;dbSnap=${dbSnap}` +
    `;blobSnap=${blobSnap}` +
    `;status=${status}` +
    `;dbSnapInFlight=[${dbInFlight}]` +
    `;blobSnapInFlight=[${blobInFlight}]`
  );
}
