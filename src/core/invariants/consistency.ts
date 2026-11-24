/**
 * SnapFence (P030) — §4.3 snapshot consistency invariant. T004.
 *
 * Authority: PROJECT_BOOK.md §4.2 (complete operation boundary: no
 * operation IN_FLIGHT), §4.3 (snapshot pair consistent iff it equals one
 * common legal operation boundary, with all references intact, generations
 * and digests matching, no unreferenced committed Blob, no operation in
 * flight), §4.4 (diagnostic codes), §4.7 (verdicts — the verdict literals
 * themselves are produced by runSearch, not here); IMPLEMENTATION_PLAN.md
 * §9.1 (frozen `checkConsistency` signature in contracts.ts).
 * Inputs (frozen, read-only): T001 model (types.ts, contracts.ts); T002
 * event state machine (isOperationBoundary — the state-level boundary
 * test, reused where a live state is available); T003 search
 * (computeBoundaries enumerates the boundaries; snapshotPairKey compares
 * pairs; makeDiagnostic / sortDiagnostics build diagnostics).
 *
 * Two judgements are provided. Both apply the SAME verdict rule
 * (ADR-002, value-first); they differ only in the diagnostics they can
 * produce — see "Value judgement vs explanatory diagnostics" below.
 *
 * 1. `checkConsistency` — the FROZEN contracts.ts signature:
 *    checkConsistency(databaseSnapshot, blobSnapshot, boundaries).
 *    Pure value judgement over the two snapshot values: consistent iff
 *    some enumerated boundary has exactly this database state AND exactly
 *    this Blob state, and the pair is reference-clean. This agrees exactly
 *    with T003 `isConsistentSnapshotPair` (cross-checked on every distinct
 *    snapshot pair of the §9 scenarios in the tests). It cannot see
 *    capture-time in-flight status, because that information is not in its
 *    inputs — a snapshot pair is only two state values.
 *
 * 2. `checkConsistencyDetailed` — the §4.3 judgement WITH explanatory
 *    capture-time diagnostics (ADR-002, value-first). The verdict is the
 *    value judgement above, unchanged: a pair is consistent iff it
 *    value-matches a common boundary. When the caller supplies the
 *    operation IDs that were IN_FLIGHT when either snapshot was captured,
 *    that information is used ONLY when the pair is value-inconsistent:
 *    one IN_FLIGHT_OPERATION diagnostic (WARNING) per such operation
 *    explains why the pair straddles an operation. A value-consistent
 *    pair produces NO diagnostics at all — there is no "consistent but
 *    with diagnostics" state. Rationale (ADR-002): §4.3's "no unfinished
 *    operation" is a property of the boundary k (§4.2: on a boundary every
 *    operation is unstarted or fully complete), not a property of capture
 *    time; the "当且仅当" definition is authoritative. The reachable
 *    FILE_FIRST example [BLOB_SNAPSHOT, upload-B:BLOB_PUT, DB_SNAPSHOT]
 *    — both snapshots empty, value-matching the initial boundary, DB
 *    snapshot captured while upload-B was in flight — is therefore
 *    CONSISTENT under this rule (the T004 strict reading that called it
 *    inconsistent was overturned by ADR-002). The two functions are kept
 *    separate so the detailed one can carry the explanatory diagnostics
 *    without touching the frozen signature.
 *
 * Rules for this file:
 * - TypeScript strict mode; `any` is forbidden.
 * - Pure deterministic functions only: no randomness, no wall-clock, no
 *   mutation of inputs.
 * - The frozen `checkConsistency` signature is implemented exactly as
 *   declared in contracts.ts (it is exported here as `checkConsistency`
 *   with the `CheckConsistency` type).
 */

import type {
  ConsistencyResult,
  DatabaseState,
  BlobState,
  Diagnostic,
  OperationBoundary,
} from "../model/types";
import type { CheckConsistency } from "../model/contracts";
import { snapshotPairKey } from "../search/visited-key";
import { makeDiagnostic, sortDiagnostics } from "../search/search-result";
import { checkReferences } from "./reference-check";

// ---------------------------------------------------------------------------
// Boundary matching (§4.3: exists k with D_s = D(k) and B_s = B(k))
// ---------------------------------------------------------------------------

/**
 * The legal operation boundary whose database AND Blob states both equal
 * the given snapshots, or null when no enumerated boundary matches both.
 * Matching is by exact state value (stable key comparison), in boundary
 * order; the first match is returned. A boundary that matches only one
 * component is not a common boundary.
 */
export function findMatchingBoundary(
  databaseSnapshot: DatabaseState,
  blobSnapshot: BlobState,
  boundaries: readonly OperationBoundary[],
): OperationBoundary | null {
  const key = snapshotPairKey(databaseSnapshot, blobSnapshot);
  for (const boundary of boundaries) {
    if (snapshotPairKey(boundary.databaseState, boundary.blobState) === key) {
      return boundary;
    }
  }
  return null;
}

/**
 * True when some enumerated boundary has exactly this database state AND
 * exactly this Blob state (§4.3, value half). Equivalent to
 * `findMatchingBoundary(...) !== null`.
 */
export function hasCommonBoundary(
  databaseSnapshot: DatabaseState,
  blobSnapshot: BlobState,
  boundaries: readonly OperationBoundary[],
): boolean {
  return findMatchingBoundary(databaseSnapshot, blobSnapshot, boundaries) !== null;
}

// ---------------------------------------------------------------------------
// Frozen §4.3 judgement (value-only; contracts.ts CheckConsistency)
// ---------------------------------------------------------------------------

/**
 * Check whether a database snapshot and a Blob snapshot correspond to one
 * common legal operation boundary (§4.3), given the enumerated boundaries.
 *
 * consistent is true exactly when a boundary value-matches both snapshots
 * AND the pair is reference-clean (every reference has its object version,
 * generations match, digests match, no orphan Blob). In this model a
 * value-matching boundary pair is reference-clean by construction
 * (boundaries are built by applying complete operations to a consistent
 * initial state), so the reference test is a defensive second check, not
 * a second source of truth.
 *
 * Diagnostics on inconsistency: the §4.4 reference diagnostics from
 * checkReferences (DANGLING_REFERENCE / GENERATION_MISMATCH /
 * DIGEST_MISMATCH / ORPHAN_BLOB, one per broken reference / orphan) plus
 * NO_COMMON_BOUNDARY (CRITICAL) when no boundary value-matches. On
 * consistency the diagnostic list is empty.
 *
 * This function cannot report IN_FLIGHT_OPERATION: capture-time in-flight
 * status is not among its inputs. Use checkConsistencyDetailed when that
 * information is available (it is, from a BFS trace — see
 * counterexample/extract.ts).
 */
export const checkConsistency: CheckConsistency = (
  databaseSnapshot: DatabaseState,
  blobSnapshot: BlobState,
  boundaries: readonly OperationBoundary[],
): ConsistencyResult => {
  const matched = findMatchingBoundary(databaseSnapshot, blobSnapshot, boundaries);
  const referenceDiagnostics = checkReferences(databaseSnapshot, blobSnapshot);
  const diagnostics: Diagnostic[] = [...referenceDiagnostics];
  if (matched === null) {
    diagnostics.push(
      makeDiagnostic(
        "NO_COMMON_BOUNDARY",
        "The database snapshot and the Blob snapshot do not correspond to one common legal operation boundary.",
      ),
    );
  }
  return {
    consistent: matched !== null && referenceDiagnostics.length === 0,
    matchedBoundaryIndex: matched === null ? null : matched.boundaryIndex,
    diagnostics: sortDiagnostics(diagnostics),
  };
};

// ---------------------------------------------------------------------------
// Complete §4.3 judgement (value verdict + explanatory in-flight diagnostics)
// ---------------------------------------------------------------------------

/**
 * The §4.3 judgement with explanatory capture-time diagnostics
 * (ADR-002, value-first).
 *
 * - `inFlightOperationIds`: operation IDs that were IN_FLIGHT in the live
 *   system when either snapshot was captured (union of both captures, as
 *   recorded by the BFS search state). Empty (the default) means "no
 *   capture-time information supplied", in which case this function
 *   behaves exactly like checkConsistency.
 * - `fileIdByOperationId`: optional opId → fileId map, used only to fill
 *   the diagnostic's fileId field; when absent the IN_FLIGHT_OPERATION
 *   diagnostic carries no fileId (the field is optional in §8.5).
 *
 * Verdict-first: consistent is exactly the value judgement of
 * checkConsistency (a common boundary exists AND the pair is
 * reference-clean). When the pair is value-consistent, the result is
 * returned unchanged: consistent true, zero diagnostics — capture-time
 * in-flight information NEVER overturns a value-consistent verdict.
 * Only when the pair is value-inconsistent is the in-flight information
 * used, as an explanatory diagnostic: one IN_FLIGHT_OPERATION (WARNING,
 * §4.4) per operation in flight at either capture, alongside the
 * reference diagnostics and NO_COMMON_BOUNDARY (CRITICAL) that the value
 * judgement already produced. `matchedBoundaryIndex` is therefore null
 * whenever the pair is inconsistent (no value-matching boundary exists),
 * and reports the matching boundary when the pair is consistent.
 */
export function checkConsistencyDetailed(
  databaseSnapshot: DatabaseState,
  blobSnapshot: BlobState,
  boundaries: readonly OperationBoundary[],
  inFlightOperationIds: readonly string[] = [],
  fileIdByOperationId: ReadonlyMap<string, string> = new Map<string, string>(),
): ConsistencyResult {
  const base = checkConsistency(databaseSnapshot, blobSnapshot, boundaries);
  if (base.consistent) {
    // ADR-002 value-first: a common boundary exists, so the pair is
    // consistent and produces NO diagnostics — regardless of whether a
    // snapshot was captured while an operation was in flight.
    return base;
  }
  const inFlight = [...new Set(inFlightOperationIds)].sort();
  if (inFlight.length === 0) {
    return base;
  }
  // Value-inconsistent only: IN_FLIGHT_OPERATION is an explanatory
  // diagnostic for why the pair straddles an operation. NO_COMMON_BOUNDARY
  // is already in base.diagnostics (no value-matching boundary exists),
  // so none is added here.
  const diagnostics: Diagnostic[] = [...base.diagnostics];
  for (const opId of inFlight) {
    diagnostics.push(
      makeDiagnostic(
        "IN_FLIGHT_OPERATION",
        `Operation ${opId} was in flight when a snapshot was captured; the captured state is not a complete operation boundary.`,
        fileIdByOperationId.get(opId),
      ),
    );
  }
  return {
    consistent: false,
    matchedBoundaryIndex: base.matchedBoundaryIndex,
    diagnostics: sortDiagnostics(diagnostics),
  };
}
