/**
 * SnapFence (P030) — shortest-counterexample extraction. T004.
 *
 * Authority: PROJECT_BOOK.md §4.5 (BFS produces the shortest inconsistent
 * path; the terminal state is reached as soon as both snapshots have
 * executed — T003 L-10), §4.6 (shortest counterexample: minimal event
 * length; same-length ties broken by fixed lexicographic event-ID order;
 * output contents: event order, per-event input/output state, database
 * snapshot contents, Blob snapshot contents, diagnostic code(s), first
 * failing operation, counterexample length; same input → same
 * counterexample), §4.4 (diagnostic codes), §4.7 (verdicts);
 * IMPLEMENTATION_PLAN.md §9.1 (frozen `extractCounterexample` signature
 * in contracts.ts: (searchTrace: SearchTrace) => Counterexample).
 * Inputs (frozen, read-only): T001 model (types.ts, contracts.ts); T002
 * event templates (event-types.ts: event IDs are "<opId>:<KIND>");
 * T003 search (runSearchDetailed supplies the trace; diagnoseSnapshotPair
 * is the cross-check oracle in tests, not re-implemented here).
 *
 * What "shortest" means here (T003 L-10): the counterexample is the
 * prefix of the BFS trace ending at the SECOND snapshot event. The BFS
 * never extends a terminal state, so the trace it returns already ends
 * there; extraction truncates defensively anyway, so a longer trace (e.g.
 * a full interleaving) still yields the minimal prefix. Minimality is
 * proven by BFS layering (first inconsistent terminal popped is
 * shortest), and the tests prove it independently by exhaustive
 * prefix enumeration over all legal interleavings of the §9 scenarios.
 *
 * Judgement used by extraction: the VALUE-FIRST §4.3 reading of ADR-002
 * (implemented by checkConsistencyDetailed — see
 * invariants/consistency.ts header). The trace carries what the frozen
 * checkConsistency signature cannot: the operations that were IN_FLIGHT
 * when each snapshot was captured. Diagnostics are therefore derived
 * from the trace alone as:
 *   value-consistent pair → NO diagnostics at all;
 *   value-inconsistent pair → checkReferences(pair) +
 *   IN_FLIGHT_OPERATION per operation in flight at either capture +
 *   NO_COMMON_BOUNDARY.
 * The trace carries no boundaries list, so the value gate here is
 * reference-cleanliness: a reachable reference-clean pair always
 * value-matches a common boundary, because any partially executed
 * operation leaves an orphan Blob or a dangling / mismatched reference
 * in the pair (see consistency.ts / reference-check.ts headers, and the
 * exhaustive cross-check over every enumerated snapshot pair in
 * consistency.test.ts). For every BFS counterexample trace this agrees
 * exactly with diagnoseSnapshotPair (tested); the value-first reading
 * differs from the T004 strict reading only on pairs whose values match
 * a boundary but were captured mid-operation (e.g. FILE_FIRST
 * [BLOB_SNAPSHOT, BLOB_PUT, DB_SNAPSHOT] — both snapshots empty, yet the
 * DB snapshot was taken while the upload was in flight). That case is
 * now reported CONSISTENT, with no diagnostics — the T004 strict reading
 * was overturned by ADR-002. Scenario A keeps IN_FLIGHT_OPERATION: its
 * pair is value-inconsistent (ORPHAN_BLOB) AND its Blob snapshot was
 * captured mid-upload, so IN_FLIGHT stays as an explanatory diagnostic
 * alongside ORPHAN_BLOB and NO_COMMON_BOUNDARY.
 *
 * First failing operation (§4.6 "第一个导致完整性失败的操作"): the
 * operation owning the earliest trace step that either (a) belongs to an
 * operation in flight at either snapshot capture, or (b) introduced /
 * removed a Blob version or database reference named by a reference
 * diagnostic. For the §9 scenarios this is the operation whose partial
 * execution straddles the two snapshots (upload-A / upload-B / delete-C).
 * Null when the extracted pair is clean (no diagnostics).
 *
 * Rules for this file:
 * - TypeScript strict mode; `any` is forbidden.
 * - Pure deterministic functions only: no randomness, no wall-clock, no
 *   mutation of inputs. Same trace → same counterexample, byte for byte.
 * - The frozen `extractCounterexample` signature is implemented exactly
 *   as declared in contracts.ts.
 */

import type {
  BlobState,
  Counterexample,
  DatabaseState,
  Diagnostic,
  Scenario,
  SearchTrace,
  SearchTraceStep,
} from "../model/types";
import type { ExtractCounterexample } from "../model/contracts";
import { blobVersionKey, type BlobVersionKey } from "../model/types";
import { isSnapshotEventId } from "../events/event-types";
import { runSearchDetailed } from "../search/bfs";
import { makeDiagnostic, sortDiagnostics } from "../search/search-result";
import { checkReferences } from "../invariants/reference-check";

// ---------------------------------------------------------------------------
// Trace structure helpers
// ---------------------------------------------------------------------------

/** Number of atomic events in the template of each data event kind (§3.2). */
const TEMPLATE_EVENT_COUNT: Readonly<Record<string, number>> = {
  BLOB_PUT: 2,
  DB_LINK: 2,
  DB_UNLINK: 2,
  BLOB_DELETE: 2,
  BLOB_PUT_NEW: 3,
  DB_REPOINT: 3,
  BLOB_DELETE_OLD: 3,
} as const;

/** Owning operation ID of an event ID ("<opId>:<KIND>"), or null for snapshots. */
export function operationIdOfEvent(eventId: string): string | null {
  if (isSnapshotEventId(eventId)) {
    return null;
  }
  const at = eventId.lastIndexOf(":");
  return at > 0 ? eventId.slice(0, at) : null;
}

/** Atomic event kind suffix of an event ID, or null for snapshot events. */
function eventKindOfEventId(eventId: string): string | null {
  if (isSnapshotEventId(eventId)) {
    return null;
  }
  const at = eventId.lastIndexOf(":");
  return at > 0 ? eventId.slice(at + 1) : null;
}

/**
 * The prefix of a trace ending at the second snapshot event (inclusive),
 * per T003 L-10. When the trace contains fewer than two snapshot events
 * the whole trace is returned (the pair is then partial; the snapshots
 * default to empty — see extractCounterexample). Pure: the input trace is
 * never mutated; the returned trace shares the (immutable) step objects.
 */
export function truncateTraceAtSecondSnapshot(trace: SearchTrace): SearchTrace {
  let snapshotsSeen = 0;
  let end = trace.steps.length;
  for (let i = 0; i < trace.steps.length; i++) {
    const step = trace.steps[i];
    if (step !== undefined && isSnapshotEventId(step.eventId)) {
      snapshotsSeen += 1;
      if (snapshotsSeen === 2) {
        end = i + 1;
        break;
      }
    }
  }
  return { ...trace, steps: trace.steps.slice(0, end) };
}

/**
 * Operation IDs IN_FLIGHT in the live system at the moment the given
 * snapshot event executed in the trace: operations with at least one data
 * event before the snapshot step but fewer than their full template
 * (§3.2 sizes: UPLOAD / DELETE 2 events, UPDATE 3). Sorted. Empty when
 * the snapshot never executes in the trace, or when it captured a
 * boundary state. Derived from the trace alone — no scenario needed,
 * because the template size follows from the event kind.
 */
export function inFlightOperationsAtSnapshot(
  trace: SearchTrace,
  snapshotEventId: string,
): readonly string[] {
  const snapshotIndex = trace.steps.findIndex((step) => step.eventId === snapshotEventId);
  if (snapshotIndex < 0) {
    return [];
  }
  const executedCount = new Map<string, number>();
  const templateTotal = new Map<string, number>();
  for (let i = 0; i < snapshotIndex; i++) {
    const step = trace.steps[i];
    if (step === undefined) {
      continue;
    }
    const opId = operationIdOfEvent(step.eventId);
    const kind = eventKindOfEventId(step.eventId);
    if (opId === null || kind === null) {
      continue;
    }
    executedCount.set(opId, (executedCount.get(opId) ?? 0) + 1);
    const total = TEMPLATE_EVENT_COUNT[kind];
    if (total !== undefined) {
      templateTotal.set(opId, total);
    }
  }
  const inFlight: string[] = [];
  for (const [opId, count] of executedCount) {
    const total = templateTotal.get(opId);
    if (total !== undefined && count > 0 && count < total) {
      inFlight.push(opId);
    }
  }
  return inFlight.sort();
}

/** Union of the in-flight sets at both snapshot captures, sorted. */
export function inFlightOperationsAtCaptures(trace: SearchTrace): readonly string[] {
  return [
    ...new Set([
      ...inFlightOperationsAtSnapshot(trace, "DB_SNAPSHOT"),
      ...inFlightOperationsAtSnapshot(trace, "BLOB_SNAPSHOT"),
    ]),
  ].sort();
}

// ---------------------------------------------------------------------------
// First failing operation (§4.6)
// ---------------------------------------------------------------------------

/**
 * Blob version keys named by the reference diagnostics: for a
 * DANGLING_REFERENCE / GENERATION_MISMATCH / DIGEST_MISMATCH the key is
 * the referenced version (objectId@generation from the database
 * snapshot); for an ORPHAN_BLOB every Blob snapshot key with that
 * objectId. File IDs named by the diagnostics, for the database-side
 * scan. Returned as { versionKeys, fileIds }.
 */
function diagnosticTargets(
  diagnostics: readonly Diagnostic[],
  databaseSnapshot: DatabaseState,
  blobSnapshot: BlobState,
): { versionKeys: ReadonlySet<string>; fileIds: ReadonlySet<string> } {
  const versionKeys = new Set<string>();
  const fileIds = new Set<string>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.fileId !== undefined) {
      fileIds.add(diagnostic.fileId);
      const ref = databaseSnapshot[diagnostic.fileId];
      if (ref !== undefined) {
        versionKeys.add(blobVersionKey(ref.objectId, ref.generation));
      }
    }
    if (diagnostic.objectId !== undefined) {
      for (const blobKey of Object.keys(blobSnapshot)) {
        const at = blobKey.lastIndexOf("@");
        if (at > 0 && blobKey.slice(0, at) === diagnostic.objectId) {
          versionKeys.add(blobKey);
        }
      }
    }
  }
  return { versionKeys, fileIds };
}

/**
 * The first operation that caused the integrity failure: the owner of
 * the earliest prefix step that either belongs to an operation in flight
 * at either snapshot capture, or introduced / removed a Blob version or
 * database reference named by a reference diagnostic. Null when the
 * diagnostics are empty (no failure) or when no step can be attributed
 * (defensive; unreachable for traces replayed from a real search).
 */
export function firstFailingOperation(
  prefix: SearchTrace,
  diagnostics: readonly Diagnostic[],
  inFlightOperationIds: readonly string[],
): string | null {
  if (diagnostics.length === 0) {
    return null;
  }
  const databaseSnapshot = snapshotDatabase(prefix);
  const blobSnapshot = snapshotBlob(prefix);
  const { versionKeys, fileIds } = diagnosticTargets(
    diagnostics,
    databaseSnapshot,
    blobSnapshot,
  );
  const inFlight = new Set(inFlightOperationIds);
  for (const step of prefix.steps) {
    const opId = operationIdOfEvent(step.eventId);
    if (opId === null) {
      continue;
    }
    if (inFlight.has(opId)) {
      return opId;
    }
    let touchesTarget = false;
    for (const fileId of fileIds) {
      const before = step.databaseStateBefore[fileId];
      const after = step.databaseStateAfter[fileId];
      if (
        (before === undefined && after !== undefined) ||
        (before !== undefined && after === undefined) ||
        (before !== undefined &&
          after !== undefined &&
          (before.objectId !== after.objectId ||
            before.generation !== after.generation ||
            before.digest !== after.digest))
      ) {
        touchesTarget = true;
        break;
      }
    }
    if (!touchesTarget) {
      for (const key of versionKeys) {
        const versionKey = key as BlobVersionKey;
        if (step.blobStateBefore[versionKey] !== step.blobStateAfter[versionKey]) {
          touchesTarget = true;
          break;
        }
      }
    }
    if (touchesTarget) {
      return opId;
    }
  }
  // Defensive fallback: the first data event of the prefix, if any.
  for (const step of prefix.steps) {
    const opId = operationIdOfEvent(step.eventId);
    if (opId !== null) {
      return opId;
    }
  }
  return null;
}

/** Database state captured by the DB_SNAPSHOT step, or {} when absent. */
export function snapshotDatabase(trace: SearchTrace): DatabaseState {
  const step = trace.steps.find((s) => s.eventId === "DB_SNAPSHOT");
  return step === undefined ? {} : step.databaseStateAfter;
}

/** Blob state captured by the BLOB_SNAPSHOT step, or {} when absent. */
export function snapshotBlob(trace: SearchTrace): BlobState {
  const step = trace.steps.find((s) => s.eventId === "BLOB_SNAPSHOT");
  return step === undefined ? {} : step.blobStateAfter;
}

// ---------------------------------------------------------------------------
// Frozen extraction (contracts.ts ExtractCounterexample)
// ---------------------------------------------------------------------------

/**
 * Extract the shortest counterexample from a search trace (§4.6).
 *
 * - The event sequence is the prefix ending at the second snapshot event
 *   (T003 L-10); `length` equals `eventIds.length`.
 * - `databaseSnapshot` / `blobSnapshot` are the states captured by the
 *   two snapshot steps ({} when a snapshot never executes in the trace).
 * - `diagnostics` are the value-first §4.3 diagnostics of the pair (see
 *   the module header): empty when the pair is value-consistent
 *   (reference-clean); otherwise the reference diagnostics +
 *   IN_FLIGHT_OPERATION per operation in flight at either capture +
 *   NO_COMMON_BOUNDARY. Empty when the pair is clean.
 * - `firstFailingOperationId` is the first operation that caused the
 *   failure (null when the pair is clean).
 * - `trace` is the truncated prefix trace, carrying the per-event
 *   input/output states (§4.6).
 *
 * The input trace is expected to come from runSearchDetailed (already
 * the shortest inconsistent trace when the verdict is UNSAFE); extraction
 * itself does not search — it truncates, judges, and attributes.
 */
export const extractCounterexample: ExtractCounterexample = (
  searchTrace: SearchTrace,
): Counterexample => {
  const prefix = truncateTraceAtSecondSnapshot(searchTrace);
  const eventIds = prefix.steps.map((step) => step.eventId);
  const databaseSnapshot = snapshotDatabase(prefix);
  const blobSnapshot = snapshotBlob(prefix);
  const inFlight = inFlightOperationsAtCaptures(prefix);
  const referenceDiagnostics = checkReferences(databaseSnapshot, blobSnapshot);
  // ADR-002 value-first: the trace carries no boundaries list, so the
  // value gate is reference-cleanliness (a reachable reference-clean pair
  // always value-matches a common boundary — see the module header).
  // Value-consistent → zero diagnostics, even when a snapshot was
  // captured mid-operation. Only a value-inconsistent pair may carry
  // IN_FLIGHT_OPERATION (explanatory) and NO_COMMON_BOUNDARY.
  const diagnostics: Diagnostic[] = [...referenceDiagnostics];
  if (referenceDiagnostics.length > 0) {
    for (const opId of inFlight) {
      diagnostics.push(
        makeDiagnostic(
          "IN_FLIGHT_OPERATION",
          `Operation ${opId} was in flight when a snapshot was captured; the captured state is not a complete operation boundary.`,
        ),
      );
    }
    diagnostics.push(
      makeDiagnostic(
        "NO_COMMON_BOUNDARY",
        "The database snapshot and the Blob snapshot do not correspond to one common legal operation boundary.",
      ),
    );
  }
  const sorted = sortDiagnostics(diagnostics);
  return {
    eventIds,
    length: eventIds.length,
    diagnostics: sorted,
    databaseSnapshot,
    blobSnapshot,
    firstFailingOperationId: firstFailingOperation(prefix, sorted, inFlight),
    trace: prefix,
  };
};

// ---------------------------------------------------------------------------
// §4.6 ordering: shorter first, ties by fixed lexicographic event-ID order
// ---------------------------------------------------------------------------

/**
 * Compare two counterexamples by the §4.6 order: shorter length first;
 * same length → lexicographic comparison of the event-ID sequences,
 * element by element (plain string order; the sequences have equal length
 * in the tie case). Negative when `a` precedes `b`, 0 when identical.
 */
export function compareCounterexamples(a: Counterexample, b: Counterexample): number {
  if (a.length !== b.length) {
    return a.length - b.length;
  }
  for (let i = 0; i < a.eventIds.length; i++) {
    const aId = a.eventIds[i] as string;
    const bId = b.eventIds[i] as string;
    if (aId !== bId) {
      return aId < bId ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Pick the shortest counterexample among candidate traces, by the §4.6
 * order (minimal length, then lexicographic event-ID order). Only traces
 * whose extracted pair is inconsistent (non-empty diagnostics) are
 * candidates; returns null when no candidate exists (empty input, or
 * every trace clean). Pure and deterministic.
 */
export function pickShortestCounterexample(
  traces: readonly SearchTrace[],
): Counterexample | null {
  let best: Counterexample | null = null;
  for (const trace of traces) {
    const candidate = extractCounterexample(trace);
    if (candidate.diagnostics.length === 0) {
      continue;
    }
    if (best === null || compareCounterexamples(candidate, best) < 0) {
      best = candidate;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Scenario convenience: run the BFS, extract its counterexample
// ---------------------------------------------------------------------------

/**
 * Run the deterministic BFS for one scenario and extract the shortest
 * counterexample from its trace. Returns null when the search finds no
 * inconsistency (SAFE_WITHIN_BOUND), when the input is invalid, or when
 * the search is over the bound (INCONCLUSIVE_LIMIT) — in all three cases
 * there is no counterexample to report. Never throws for a malformed
 * scenario (runSearchDetailed fails closed to INVALID_INPUT).
 */
export function extractShortestCounterexample(
  scenario: Scenario,
): Counterexample | null {
  const detailed = runSearchDetailed(scenario);
  if (detailed.result.verdict !== "UNSAFE_WITHIN_BOUND" || detailed.trace === null) {
    return null;
  }
  return extractCounterexample(detailed.trace);
}

/** Re-exported for callers that need the step type next to the extractor. */
export type { SearchTraceStep };
