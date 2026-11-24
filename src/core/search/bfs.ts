/**
 * SnapFence (P030) — deterministic BFS bounded interleaving search. T003.
 *
 * Authority: PROJECT_BOOK.md §4.5 (BFS bounded interleaving search), §4.6
 * (shortest counterexample; lexicographic event-ID tie-break), §4.7
 * (verdicts), §3.3 (strategy snapshot constraints), §10.3 (10-event bound
 * incl. snapshots); IMPLEMENTATION_PLAN.md §9.1 (frozen `runSearch`
 * signature in contracts.ts). Inputs (frozen, read-only): T001 model
 * (types.ts, scenario.ts, contracts.ts); T002 event state machine
 * (event-types.ts, apply-event.ts, dependency-graph.ts, validate-events.ts).
 *
 * Rules for this file:
 * - TypeScript strict mode; `any` is forbidden.
 * - Pure deterministic functions only: no randomness, no wall-clock, no
 *   object traversal order. Candidates are always processed in fixed
 *   lexicographic event-ID order; the queue is FIFO, so nodes are popped
 *   in non-decreasing depth and, within a depth, in lexicographic order of
 *   their execution paths. The first inconsistent terminal state popped is
 *   therefore the shortest counterexample, tie-broken lexicographically
 *   (§4.6). The BFS runs to exhaustion (it never stops at the first
 *   counterexample) so the reported snapshot pairs and terminal counts
 *   cover every legal interleaving.
 * - `runSearch` never throws: malformed input yields INVALID_INPUT,
 *   over-limit input yields INCONCLUSIVE_LIMIT (never a downgraded SAFE).
 *
 * Scope (plan §11 / task): this module implements the §4.5–§4.7 search and
 * the minimal snapshot-pair judgement the search needs (common-boundary
 * membership + the §4.4 diagnostics of one captured pair). The full
 * consistency-invariant module and counterexample extraction are T004's
 * job; this module exposes everything T004 needs — the counterexample
 * trace (per-event before/after states), the captured snapshot pair, the
 * enumerated legal operation boundaries, and all distinct snapshot pairs —
 * through `runSearchDetailed`.
 *
 * Known spec tension (see handoff P030-T003.md, L-08) — RESOLVED by
 * ADR-001 (SPEC_VERSION 1.0.1, implemented by FIX-ADR-001): under the
 * §4.5 full-interleaving enumeration, ANY scenario with ≥1 operation
 * under DB_FIRST or FILE_FIRST is UNSAFE, so plan §6.2 G02–G04 / G06–G08
 * ("upload/delete/update complete, then backup, SAFE") could not hold as
 * single-operation scenarios. ADR-001 adds the optional
 * `Scenario.snapshotsAfter` placement constraint: a snapshot event is a
 * candidate only when every listed operation is COMPLETED. G02–G04 /
 * G06–G08 carry the field and are SAFE; U01–U12 omit it and keep the
 * full-interleaving behaviour implemented here. This module implements
 * §4.5 faithfully plus exactly that candidate-eligibility rule.
 */

import type {
  BackupStrategy,
  BlobState,
  DatabaseState,
  Diagnostic,
  OperationBoundary,
  Scenario,
  SearchResult,
  SearchTrace,
} from "../model/types";
import { blobVersionKey } from "../model/types";
import { MAX_EVENTS, totalAtomicEventCount } from "../model/scenario";
import {
  expandScenario,
  isSnapshotEventId,
  type SnapFenceEvent,
} from "../events/event-types";
import {
  applyEvent,
  EventApplicationError,
  initialState,
  inFlightOperationIds,
} from "../events/apply-event";
import {
  buildDependencyGraph,
  prerequisitesOf,
  type DependencyGraph,
} from "../events/dependency-graph";
import {
  validateEventSequence,
  validateScenario,
  type EventSequenceIssue,
} from "../events/validate-events";
import {
  createInitialSearchState,
  extendSearchState,
  inFlightOperationIdsOf,
  isTerminalSearchState,
  type SearchState,
} from "./search-state";
import { snapshotPairKey, stableStringify, visitedKey } from "./visited-key";
import {
  buildInvalidInputResult,
  buildLimitResult,
  buildSearchResult,
  describeRawInvalidInput,
  EMPTY_BLOB_SNAPSHOT,
  EMPTY_DATABASE_SNAPSHOT,
  makeDiagnostic,
  sortDiagnostics,
} from "./search-result";

// ---------------------------------------------------------------------------
// Search statistics and detailed execution result
// ---------------------------------------------------------------------------

/** Deterministic counters for one search execution. */
export interface SearchStatistics {
  /** Distinct deduped states visited (including the initial state). */
  visitedStateCount: number;
  /** Terminal states popped (both snapshots executed). */
  terminalStateCount: number;
  /** Distinct snapshot pairs found across all terminal states. */
  distinctSnapshotPairCount: number;
  /** Terminal states whose snapshot pair has no common legal boundary. */
  inconsistentTerminalCount: number;
  /** Candidate transitions rejected by applyEvent (0 for valid scenarios). */
  rejectedTransitionCount: number;
}

/** One distinct snapshot pair (database snapshot, Blob snapshot). */
export interface SnapshotPair {
  database: DatabaseState;
  blob: BlobState;
}

/**
 * Full search execution: the frozen SearchResult plus everything T004
 * needs — the counterexample (or first-terminal) trace, the enumerated
 * legal operation boundaries, every distinct snapshot pair, and counters.
 * `trace` is null only when no terminal state exists (INVALID_INPUT /
 * INCONCLUSIVE_LIMIT, or a valid scenario with no complete interleaving,
 * which cannot occur for validated input).
 */
export interface SearchExecution {
  result: SearchResult;
  trace: SearchTrace | null;
  boundaries: readonly OperationBoundary[];
  snapshotPairs: readonly SnapshotPair[];
  statistics: SearchStatistics;
}

const ZERO_STATISTICS: SearchStatistics = {
  visitedStateCount: 0,
  terminalStateCount: 0,
  distinctSnapshotPairCount: 0,
  inconsistentTerminalCount: 0,
  rejectedTransitionCount: 0,
};

/** Total atomic event count of a scenario, or 0 when it cannot be counted. */
function safeTotalEventCount(scenario: Scenario): number {
  try {
    return totalAtomicEventCount(scenario);
  } catch {
    return 0;
  }
}

function emptyExecution(result: SearchResult): SearchExecution {
  return {
    result,
    trace: null,
    boundaries: [],
    snapshotPairs: [],
    statistics: { ...ZERO_STATISTICS },
  };
}

// ---------------------------------------------------------------------------
// Legal operation boundaries (§4.2 / §4.3)
// ---------------------------------------------------------------------------

/**
 * Enumerate every legal operation boundary of a scenario, deterministically.
 *
 * A boundary is determined by the set S of completed operations: the
 * database/Blob states of applying exactly the operations in S (each fully,
 * in scenario order) to the initial state. S must be closed under the
 * same-file chain: if an operation on a file is in S, every earlier
 * operation on that file is in S too (otherwise the later operation could
 * never have started). Subsets are ordered by (number of completed
 * operations, lexicographic completed-op-ID list); the empty set is first,
 * so boundaryIndex 0 is the initial state, as frozen in types.ts.
 *
 * Guard: scenarios with more than 12 operations are not enumerated (the
 * subset space would explode); only the initial boundary is returned.
 * Validated scenarios have at most 4 operations (10 events), so the guard
 * never fires on legal input.
 */
export function computeBoundaries(scenario: Scenario): readonly OperationBoundary[] {
  const operations = scenario.operations;
  const initial = initialState(scenario);
  const initialBoundary: OperationBoundary = {
    boundaryIndex: 0,
    databaseState: initial.database,
    blobState: initial.blob,
    completedOperationIds: [],
    notStartedOperationIds: operations.map((op) => op.opId).sort(),
  };
  if (operations.length > 12) {
    return [initialBoundary];
  }
  const expansion = expandScenario(scenario);
  const eventsByOp = new Map<string, readonly SnapFenceEvent[]>();
  for (const operation of operations) {
    eventsByOp.set(
      operation.opId,
      expansion.dataEvents.filter((event) => event.opId === operation.opId),
    );
  }
  // Chain predecessors: earlier operation indices on the same file.
  const chainPredecessors: readonly (readonly number[])[] = operations.map(
    (operation, index) => {
      const preds: number[] = [];
      for (let j = 0; j < index; j++) {
        const earlier = operations[j];
        if (earlier !== undefined && earlier.fileId === operation.fileId) {
          preds.push(j);
        }
      }
      return preds;
    },
  );
  const masks: number[] = [];
  const totalMasks = 1 << operations.length;
  for (let mask = 0; mask < totalMasks; mask++) {
    let closed = true;
    for (let i = 0; i < operations.length; i++) {
      if ((mask & (1 << i)) === 0) {
        continue;
      }
      for (const pred of chainPredecessors[i] ?? []) {
        if ((mask & (1 << pred)) === 0) {
          closed = false;
          break;
        }
      }
      if (!closed) {
        break;
      }
    }
    if (closed) {
      masks.push(mask);
    }
  }
  const maskKey = (mask: number): string => {
    const completed: string[] = [];
    for (let i = 0; i < operations.length; i++) {
      if ((mask & (1 << i)) !== 0) {
        const op = operations[i];
        if (op !== undefined) {
          completed.push(op.opId);
        }
      }
    }
    completed.sort();
    return `${completed.length}:${completed.join(",")}`;
  };
  masks.sort((a, b) => (maskKey(a) < maskKey(b) ? -1 : maskKey(a) > maskKey(b) ? 1 : 0));
  const boundaries: OperationBoundary[] = [];
  for (const mask of masks) {
    const completed: string[] = [];
    const notStarted: string[] = [];
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      if (op === undefined) {
        continue;
      }
      if ((mask & (1 << i)) !== 0) {
        completed.push(op.opId);
      } else {
        notStarted.push(op.opId);
      }
    }
    completed.sort();
    notStarted.sort();
    if (mask === 0) {
      boundaries.push(initialBoundary);
      continue;
    }
    const applied = applyOperationSubset(scenario, eventsByOp, mask);
    if (applied === null) {
      continue;
    }
    boundaries.push({
      boundaryIndex: boundaries.length,
      databaseState: applied.database,
      blobState: applied.blob,
      completedOperationIds: completed,
      notStartedOperationIds: notStarted,
    });
  }
  return boundaries;
}

/**
 * Apply exactly the operations in `mask` (each fully, in scenario order)
 * to the initial state. Returns the resulting system state, or null when
 * an event cannot be applied (defensive: never throws for a closed subset
 * of a validated scenario).
 */
function applyOperationSubset(
  scenario: Scenario,
  eventsByOp: ReadonlyMap<string, readonly SnapFenceEvent[]>,
  mask: number,
): { database: DatabaseState; blob: BlobState } | null {
  let state = initialState(scenario);
  const executed: string[] = [];
  for (let i = 0; i < scenario.operations.length; i++) {
    if ((mask & (1 << i)) === 0) {
      continue;
    }
    const operation = scenario.operations[i];
    if (operation === undefined) {
      continue;
    }
    for (const event of eventsByOp.get(operation.opId) ?? []) {
      try {
        const result = applyEvent(state, event, executed);
        state = result.state;
        executed.push(event.eventId);
      } catch (error) {
        if (error instanceof EventApplicationError) {
          return null;
        }
        throw error;
      }
    }
  }
  return { database: state.database, blob: state.blob };
}

// ---------------------------------------------------------------------------
// Snapshot-pair judgement (§4.3) and diagnostics (§4.4)
// ---------------------------------------------------------------------------

/**
 * True when a snapshot pair corresponds to one common legal operation
 * boundary (§4.3): some enumerated boundary has exactly this database
 * state AND exactly this Blob state.
 */
export function isConsistentSnapshotPair(
  databaseSnapshot: DatabaseState,
  blobSnapshot: BlobState,
  boundaries: readonly OperationBoundary[],
): boolean {
  const key = snapshotPairKey(databaseSnapshot, blobSnapshot);
  for (const boundary of boundaries) {
    if (snapshotPairKey(boundary.databaseState, boundary.blobState) === key) {
      return true;
    }
  }
  return false;
}

/**
 * Diagnostics of one captured snapshot pair (§4.4), derived by direct
 * comparison of the two snapshots plus the capture-time in-flight sets:
 *
 * - DANGLING_REFERENCE (CRITICAL): a database record references an object
 *   version the Blob snapshot does not hold at all.
 * - GENERATION_MISMATCH (CRITICAL): the Blob snapshot holds the referenced
 *   objectId at a different generation (not also reported as dangling).
 * - DIGEST_MISMATCH (CRITICAL): the Blob snapshot holds the referenced
 *   version but with a different digest.
 * - ORPHAN_BLOB (WARNING): a Blob snapshot version no database record
 *   references.
 * - IN_FLIGHT_OPERATION (WARNING): one per operation that was in flight
 *   when either snapshot was captured — but ONLY for value-inconsistent
 *   pairs (see below).
 * - NO_COMMON_BOUNDARY (CRITICAL): the pair matches no legal boundary
 *   (added when `consistent` is false).
 *
 * ADR-002 value-first: the verdict is the value judgement — the pair is
 * consistent iff it value-matches a common boundary. A value-consistent
 * pair produces NO diagnostics at all (there is no "consistent but with
 * diagnostics" state), so this function returns [] when `consistent` is
 * true, regardless of whether a snapshot was captured while an operation
 * was in flight. IN_FLIGHT_OPERATION is an explanatory diagnostic only:
 * it is emitted only for value-inconsistent pairs, to explain why the
 * pair straddles an operation. A value-matching boundary pair is
 * reference-clean by construction, so the early return is exact — no
 * reference diagnostic is dropped. This mirrors
 * checkConsistencyDetailed in invariants/consistency.ts.
 *
 * The diagnostics are sorted deterministically (see search-result.ts).
 * This is the minimal derivation the search needs for its SearchResult;
 * the full invariant module is T004's job.
 */
export function diagnoseSnapshotPair(
  databaseSnapshot: DatabaseState,
  blobSnapshot: BlobState,
  consistent: boolean,
  dbSnapshotInFlightOperationIds: readonly string[],
  blobSnapshotInFlightOperationIds: readonly string[],
  fileIdByOperationId: ReadonlyMap<string, string>,
): readonly Diagnostic[] {
  if (consistent) {
    // ADR-002 value-first: a common boundary exists, so the pair is
    // consistent and produces NO diagnostics — capture-time in-flight
    // information NEVER overturns a value-consistent verdict.
    return [];
  }
  const diagnostics: Diagnostic[] = [];
  const fileIds = Object.keys(databaseSnapshot).sort();
  for (const fileId of fileIds) {
    const ref = databaseSnapshot[fileId];
    if (ref === undefined) {
      continue;
    }
    const key = blobVersionKey(ref.objectId, ref.generation);
    const heldDigest = blobSnapshot[key];
    if (heldDigest === undefined) {
      const otherGenerationHeld = Object.keys(blobSnapshot).some((blobKey) => {
        const at = blobKey.lastIndexOf("@");
        return at > 0 && blobKey.slice(0, at) === ref.objectId;
      });
      if (otherGenerationHeld) {
        diagnostics.push(
          makeDiagnostic(
            "GENERATION_MISMATCH",
            `Database record for file ${fileId} references ${ref.objectId}@${ref.generation}, but the Blob snapshot holds ${ref.objectId} at a different generation.`,
            fileId,
            ref.objectId,
          ),
        );
      } else {
        diagnostics.push(
          makeDiagnostic(
            "DANGLING_REFERENCE",
            `Database record for file ${fileId} references ${ref.objectId}@${ref.generation}, which the Blob snapshot does not contain.`,
            fileId,
            ref.objectId,
          ),
        );
      }
    } else if (heldDigest !== ref.digest) {
      diagnostics.push(
        makeDiagnostic(
          "DIGEST_MISMATCH",
          `Database record for file ${fileId} references ${ref.objectId}@${ref.generation} with digest ${ref.digest}, but the Blob snapshot holds digest ${heldDigest}.`,
          fileId,
          ref.objectId,
        ),
      );
    }
  }
  const blobKeys = Object.keys(blobSnapshot).sort();
  for (const blobKey of blobKeys) {
    const at = blobKey.lastIndexOf("@");
    if (at <= 0) {
      continue;
    }
    const objectId = blobKey.slice(0, at);
    const generation = Number(blobKey.slice(at + 1));
    const referenced = fileIds.some((fileId) => {
      const ref = databaseSnapshot[fileId];
      return ref !== undefined && ref.objectId === objectId && ref.generation === generation;
    });
    if (!referenced) {
      diagnostics.push(
        makeDiagnostic(
          "ORPHAN_BLOB",
          `Blob snapshot holds ${objectId}@${generation}, which no database record references.`,
          undefined,
          objectId,
        ),
      );
    }
  }
  const inFlight = [...new Set([...dbSnapshotInFlightOperationIds, ...blobSnapshotInFlightOperationIds])].sort();
  for (const opId of inFlight) {
    const fileId = fileIdByOperationId.get(opId);
    diagnostics.push(
      makeDiagnostic(
        "IN_FLIGHT_OPERATION",
        `Operation ${opId} was in flight when a snapshot was captured; the captured state is not a complete operation boundary.`,
        fileId,
        undefined,
      ),
    );
  }
  if (!consistent) {
    diagnostics.push(
      makeDiagnostic(
        "NO_COMMON_BOUNDARY",
        "The database snapshot and the Blob snapshot do not correspond to one common legal operation boundary.",
      ),
    );
  }
  return sortDiagnostics(diagnostics);
}

// ---------------------------------------------------------------------------
// BFS candidates (§4.5 + §3.3)
// ---------------------------------------------------------------------------

/**
 * Candidate event IDs from one search state, in fixed lexicographic
 * event-ID order: unexecuted events whose dependency-graph prerequisites
 * have all executed, filtered by the PAUSE_WRITES constraints
 * (MODEL_CONTRACT.md I-04; validate-events.ts semantics):
 * - no data-modifying event may execute between the two snapshots;
 * - no snapshot may execute while any operation is IN_FLIGHT.
 * DB_FIRST / FILE_FIRST snapshot order is enforced by the graph edge
 * itself (a prerequisite), not by this filter.
 * ADR-001 placement constraint (MODEL_CONTRACT.md I-06): when the
 * scenario lists `snapshotsAfter`, a snapshot event is a candidate ONLY
 * when every listed operation is COMPLETED in this state; when the field
 * is absent (or empty) there is no constraint (full interleaving).
 */
export function candidateEventIds(
  state: SearchState,
  graph: DependencyGraph,
  scenario: Scenario,
): readonly string[] {
  const candidates: string[] = [];
  const snapshotsExecuted =
    (state.databaseSnapshot !== null ? 1 : 0) + (state.blobSnapshot !== null ? 1 : 0);
  const anyInFlight = inFlightOperationIdsOf(state).length > 0;
  const snapshotsAfter = scenario.snapshotsAfter ?? [];
  const placementSatisfied =
    snapshotsAfter.length === 0 ||
    snapshotsAfter.every(
      (opId) => state.systemState.operationStatus[opId] === "COMPLETED",
    );
  for (const event of graph.events) {
    const eventId = event.eventId;
    if (state.executedEventIds.includes(eventId)) {
      continue;
    }
    let ready = true;
    for (const prerequisite of prerequisitesOf(graph, eventId)) {
      if (!state.executedEventIds.includes(prerequisite)) {
        ready = false;
        break;
      }
    }
    if (!ready) {
      continue;
    }
    if (isSnapshotEventId(eventId) && !placementSatisfied) {
      continue;
    }
    if (scenario.strategy === "PAUSE_WRITES") {
      if (!isSnapshotEventId(eventId)) {
        if (snapshotsExecuted === 1) {
          continue;
        }
      } else if (anyInFlight) {
        continue;
      }
    }
    candidates.push(eventId);
  }
  return candidates.sort();
}

// ---------------------------------------------------------------------------
// runSearchDetailed / runSearch (§4.5–§4.7, frozen contracts.ts signature)
// ---------------------------------------------------------------------------

/**
 * Run the deterministic bounded BFS interleaving search for one scenario.
 *
 * - Invalid input → INVALID_INPUT (validation issues listed in the
 *   result's limitations). P030-R1-01: the result is NORMALIZED to
 *   schema-valid values inside `buildInvalidInputResult` (empty scenarioId
 *   becomes "UNKNOWN_SCENARIO", an illegal strategy becomes "DB_FIRST"),
 *   with the raw invalid input preserved in a separate `limitations`
 *   entry — so `validateReport(exportJsonObject(runSearch(bad)))` is
 *   valid for every illegal input, including null / undefined /
 *   non-object input. Over-limit input → INCONCLUSIVE_LIMIT, never a
 *   downgraded SAFE. "Over-limit" means every validation issue is
 *   MAX_EVENTS_EXCEEDED and the scenario genuinely exceeds the bound
 *   (total events > 10, maxEvents > 10, or maxEvents below the events the
 *   scenario needs).
 * - Valid input → BFS to exhaustion over deduped states. The first
 *   inconsistent terminal state popped (shortest, lexicographically
 *   smallest, §4.6) is the counterexample; when none exists the verdict
 *   is SAFE_WITHIN_BOUND and the reported snapshots are those of the
 *   first complete interleaving in deterministic BFS order.
 */
export function runSearchDetailed(scenario: Scenario): SearchExecution {
  if (typeof scenario !== "object" || scenario === null) {
    // P030-R1-01: a non-object input has no scenarioId / strategy to
    // normalize from, so the raw whole input is carried in a separate
    // limitations note (describeRawInvalidInput) and the validation
    // issues come from validateScenario, which reports exactly this
    // shape failure (MISSING_REQUIRED_FIELD) instead of crashing.
    const validation = validateScenario(scenario as unknown as Scenario);
    return emptyExecution(
      buildInvalidInputResult(
        "",
        "DB_FIRST",
        0,
        validation.issues,
        describeRawInvalidInput(scenario as unknown),
      ),
    );
  }
  const validation = validateScenario(scenario);
  const totalEvents = safeTotalEventCount(scenario);
  if (!validation.valid) {
    const allLimit =
      validation.issues.length > 0 &&
      validation.issues.every((issue) => issue.code === "MAX_EVENTS_EXCEEDED");
    const maxEvents = scenario.maxEvents;
    const overBound =
      totalEvents > MAX_EVENTS ||
      (typeof maxEvents === "number" && maxEvents > MAX_EVENTS) ||
      (typeof maxEvents === "number" &&
        Number.isInteger(maxEvents) &&
        maxEvents > 0 &&
        maxEvents < totalEvents);
    if (allLimit && overBound) {
      return emptyExecution(
        buildLimitResult(
          scenario.scenarioId,
          scenario.strategy as BackupStrategy,
          totalEvents,
          totalEvents,
        ),
      );
    }
    return emptyExecution(
      buildInvalidInputResult(
        scenario.scenarioId,
        scenario.strategy as BackupStrategy,
        totalEvents,
        validation.issues,
      ),
    );
  }

  const expansion = expandScenario(scenario);
  const graph = buildDependencyGraph(scenario);
  const eventById = new Map<string, SnapFenceEvent>(
    expansion.allEvents.map((event) => [event.eventId, event]),
  );
  const boundaries = computeBoundaries(scenario);
  const boundaryPairKeys = new Set<string>(
    boundaries.map((boundary) => snapshotPairKey(boundary.databaseState, boundary.blobState)),
  );
  const fileIdByOperationId = new Map<string, string>(
    scenario.operations.map((operation) => [operation.opId, operation.fileId]),
  );

  const initial = createInitialSearchState(scenario);
  const visited = new Map<string, SearchState>();
  visited.set(visitedKey(initial), initial);
  const queue: SearchState[] = [initial];
  let head = 0;
  let rejectedTransitionCount = 0;
  let terminalStateCount = 0;
  let inconsistentTerminalCount = 0;
  let firstTerminal: SearchState | null = null;
  let firstInconsistent: SearchState | null = null;
  const terminalPairs = new Map<string, SnapshotPair>();

  while (head < queue.length) {
    const node = queue[head];
    head += 1;
    if (node === undefined) {
      break;
    }
    if (isTerminalSearchState(node)) {
      terminalStateCount += 1;
      const dbSnap = node.databaseSnapshot;
      const blobSnap = node.blobSnapshot;
      if (dbSnap !== null && blobSnap !== null) {
        const pairKey = snapshotPairKey(dbSnap, blobSnap);
        if (!terminalPairs.has(pairKey)) {
          terminalPairs.set(pairKey, { database: dbSnap, blob: blobSnap });
        }
        if (firstTerminal === null) {
          firstTerminal = node;
        }
        if (!boundaryPairKeys.has(pairKey)) {
          inconsistentTerminalCount += 1;
          if (firstInconsistent === null) {
            firstInconsistent = node;
          }
        }
      }
      continue;
    }
    for (const eventId of candidateEventIds(node, graph, scenario)) {
      const event = eventById.get(eventId);
      if (event === undefined) {
        continue;
      }
      try {
        const applied = applyEvent(node.systemState, event, node.executedEventIds);
        const next = extendSearchState(node, event, applied);
        const key = visitedKey(next);
        if (!visited.has(key)) {
          visited.set(key, next);
          queue.push(next);
        }
      } catch (error) {
        if (error instanceof EventApplicationError) {
          rejectedTransitionCount += 1;
          continue;
        }
        throw error;
      }
    }
  }

  const snapshotPairs = [...terminalPairs.values()].sort((a, b) => {
    const ka = snapshotPairKey(a.database, a.blob);
    const kb = snapshotPairKey(b.database, b.blob);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const verdict = firstInconsistent !== null ? "UNSAFE_WITHIN_BOUND" : "SAFE_WITHIN_BOUND";
  const chosen = firstInconsistent ?? firstTerminal;
  const diagnostics =
    firstInconsistent !== null &&
    firstInconsistent.databaseSnapshot !== null &&
    firstInconsistent.blobSnapshot !== null
      ? diagnoseSnapshotPair(
          firstInconsistent.databaseSnapshot,
          firstInconsistent.blobSnapshot,
          false,
          firstInconsistent.dbSnapshotInFlightOperationIds,
          firstInconsistent.blobSnapshotInFlightOperationIds,
          fileIdByOperationId,
        )
      : [];
  const result = buildSearchResult({
    scenarioId: scenario.scenarioId,
    strategy: scenario.strategy,
    verdict,
    eventCount: totalEvents,
    counterexample: firstInconsistent !== null ? [...firstInconsistent.path] : [],
    diagnostics,
    databaseSnapshot:
      chosen !== null && chosen.databaseSnapshot !== null
        ? chosen.databaseSnapshot
        : EMPTY_DATABASE_SNAPSHOT,
    blobSnapshot:
      chosen !== null && chosen.blobSnapshot !== null
        ? chosen.blobSnapshot
        : EMPTY_BLOB_SNAPSHOT,
    extraLimitations:
      verdict === "SAFE_WITHIN_BOUND"
        ? [
            "No inconsistent snapshot pair was found among the enumerated legal interleavings; the reported snapshots are those of the first complete interleaving in deterministic BFS order.",
          ]
        : [],
  });
  const trace: SearchTrace | null =
    chosen !== null
      ? { scenarioId: scenario.scenarioId, strategy: scenario.strategy, steps: [...chosen.steps] }
      : null;
  return {
    result,
    trace,
    boundaries,
    snapshotPairs,
    statistics: {
      visitedStateCount: visited.size,
      terminalStateCount,
      distinctSnapshotPairCount: terminalPairs.size,
      inconsistentTerminalCount,
      rejectedTransitionCount,
    },
  };
}

/**
 * Run the deterministic bounded BFS search (frozen `RunSearch` signature
 * from contracts.ts). Never throws: unexpected failures fail closed to
 * INVALID_INPUT.
 */
export function runSearch(scenario: Scenario): SearchResult {
  try {
    return runSearchDetailed(scenario).result;
  } catch {
    const scenarioId =
      typeof scenario === "object" && scenario !== null && typeof scenario.scenarioId === "string"
        ? scenario.scenarioId
        : "";
    const strategy =
      typeof scenario === "object" && scenario !== null
        ? (scenario.strategy as BackupStrategy)
        : "DB_FIRST";
    return buildInvalidInputResult(scenarioId, strategy, 0, []);
  }
}

// ---------------------------------------------------------------------------
// evaluateSequence — judge one concrete execution order (for §9 checks, T004)
// ---------------------------------------------------------------------------

/** Result of judging one concrete event sequence. */
export interface SequenceEvaluation {
  valid: boolean;
  issues: readonly EventSequenceIssue[];
  databaseSnapshot: DatabaseState | null;
  blobSnapshot: BlobState | null;
  /** Null when either snapshot never executes in the sequence. */
  consistent: boolean | null;
  diagnostics: readonly Diagnostic[];
  appliedEventIds: readonly string[];
}

/**
 * Validate and replay one concrete execution order against a scenario.
 * A valid complete sequence (both snapshots executed) is judged against
 * the enumerated legal boundaries, with the same diagnostics as the BFS
 * counterexample path. Invalid sequences report their issues and judge
 * nothing. Pure and deterministic.
 */
export function evaluateSequence(
  scenario: Scenario,
  eventIds: readonly string[],
): SequenceEvaluation {
  const sequenceValidation = validateEventSequence(scenario, eventIds);
  if (!sequenceValidation.valid) {
    return {
      valid: false,
      issues: sequenceValidation.issues,
      databaseSnapshot: null,
      blobSnapshot: null,
      consistent: null,
      diagnostics: [],
      appliedEventIds: [],
    };
  }
  const expansion = expandScenario(scenario);
  const eventById = new Map<string, SnapFenceEvent>(
    expansion.allEvents.map((event) => [event.eventId, event]),
  );
  let state = initialState(scenario);
  const executed: string[] = [];
  let databaseSnapshot: DatabaseState | null = null;
  let blobSnapshot: BlobState | null = null;
  let dbInFlight: readonly string[] = [];
  let blobInFlight: readonly string[] = [];
  try {
    for (const eventId of eventIds) {
      const event = eventById.get(eventId);
      if (event === undefined) {
        return {
          valid: false,
          issues: [
            {
              code: "UNKNOWN_EVENT",
              message: `Event ${eventId} is not part of scenario ${scenario.scenarioId}.`,
              eventId,
            },
          ],
          databaseSnapshot: null,
          blobSnapshot: null,
          consistent: null,
          diagnostics: [],
          appliedEventIds: [],
        };
      }
      const applied = applyEvent(state, event, executed);
      if (applied.databaseSnapshot !== null) {
        databaseSnapshot = applied.databaseSnapshot;
        dbInFlight = inFlightOperationIds(state);
      }
      if (applied.blobSnapshot !== null) {
        blobSnapshot = applied.blobSnapshot;
        blobInFlight = inFlightOperationIds(state);
      }
      state = applied.state;
      executed.push(eventId);
    }
  } catch (error) {
    if (error instanceof EventApplicationError) {
      return {
        valid: false,
        issues: [
          {
            code: "PREREQUISITE_NOT_MET",
            message: `Event ${error.eventId} cannot be applied to the state reached so far: ${error.message}`,
            eventId: error.eventId,
          },
        ],
        databaseSnapshot: null,
        blobSnapshot: null,
        consistent: null,
        diagnostics: [],
        appliedEventIds: [],
      };
    }
    throw error;
  }
  if (databaseSnapshot === null || blobSnapshot === null) {
    return {
      valid: true,
      issues: [],
      databaseSnapshot,
      blobSnapshot,
      consistent: null,
      diagnostics: [],
      appliedEventIds: executed,
    };
  }
  const boundaries = computeBoundaries(scenario);
  // ADR-002 value-first: the value judgement comes first — `consistent`
  // is decided by common-boundary membership alone, and
  // diagnoseSnapshotPair returns ZERO diagnostics for a value-consistent
  // pair (capture-time in-flight information is explanatory only, for
  // value-inconsistent pairs). The BFS verdicts are unaffected: they use
  // `boundaryPairKeys` directly, never these diagnostics.
  const consistent = isConsistentSnapshotPair(databaseSnapshot, blobSnapshot, boundaries);
  const fileIdByOperationId = new Map<string, string>(
    scenario.operations.map((operation) => [operation.opId, operation.fileId]),
  );
  return {
    valid: true,
    issues: [],
    databaseSnapshot,
    blobSnapshot,
    consistent,
    diagnostics: diagnoseSnapshotPair(
      databaseSnapshot,
      blobSnapshot,
      consistent,
      dbInFlight,
      blobInFlight,
      fileIdByOperationId,
    ),
    appliedEventIds: executed,
  };
}

// ---------------------------------------------------------------------------
// countLegalInterleavings — exact count of complete legal orders
// ---------------------------------------------------------------------------

function popcount(mask: number): number {
  let count = 0;
  let rest = mask;
  while (rest !== 0) {
    count += rest & 1;
    rest >>= 1;
  }
  return count;
}

/**
 * Exact number of complete legal event interleavings of a scenario:
 * linear extensions of the dependency DAG that also satisfy the
 * PAUSE_WRITES constraints (no data event between the snapshots, no
 * snapshot while an operation is in flight) and the ADR-001
 * `snapshotsAfter` placement constraint (no snapshot before every listed
 * operation completes). Computed by memoized DFS
 * over executed-event bitmasks (at most 2^10 states for valid input), so
 * it is exact and cheap; invalid scenarios count 0.
 *
 * For validated scenarios, DAG + PAUSE legality coincides with
 * applyability: every state check in applyEvent is implied by the
 * template / chain prerequisites, so every counted order replays cleanly
 * (cross-checked in tests against brute-force permutation enumeration).
 */
export function countLegalInterleavings(scenario: Scenario): number {
  if (!validateScenario(scenario).valid) {
    return 0;
  }
  const expansion = expandScenario(scenario);
  const graph = buildDependencyGraph(scenario);
  const sortedIds = expansion.allEvents.map((event) => event.eventId).sort();
  const bitOf = new Map<string, number>(
    sortedIds.map((eventId, index) => [eventId, 1 << index]),
  );
  const bitFor = (eventId: string): number => {
    const bit = bitOf.get(eventId);
    if (bit === undefined) {
      throw new Error(`countLegalInterleavings: unknown event ${eventId}`);
    }
    return bit;
  };
  const prereqMask = sortedIds.map((eventId) => {
    let mask = 0;
    for (const prerequisite of prerequisitesOf(graph, eventId)) {
      mask |= bitFor(prerequisite);
    }
    return mask;
  });
  const snapshotBits = sortedIds.map((eventId) => isSnapshotEventId(eventId));
  const opMasks = scenario.operations.map((operation) => {
    let mask = 0;
    for (const event of expansion.dataEvents) {
      if (event.opId === operation.opId) {
        mask |= bitFor(event.eventId);
      }
    }
    return mask;
  });
  // ADR-001 placement constraint: a snapshot event is legal from a mask
  // only when every listed operation's events are all in the mask. The
  // scenario is validated by the caller check above, so every listed opId
  // exists; an opIndex of -1 (unreachable for valid input) fails closed.
  const snapshotsAfter = scenario.snapshotsAfter ?? [];
  const placementSatisfied = (mask: number): boolean => {
    for (const opId of snapshotsAfter) {
      const opIndex = scenario.operations.findIndex((op) => op.opId === opId);
      if (opIndex < 0) {
        return false;
      }
      const opMask = opMasks[opIndex] ?? 0;
      if (opMask === 0 || (mask & opMask) !== opMask) {
        return false;
      }
    }
    return true;
  };
  const allMask = (1 << sortedIds.length) - 1;
  const memo = new Map<number, number>();
  const countFrom = (mask: number): number => {
    if (mask === allMask) {
      return 1;
    }
    const hit = memo.get(mask);
    if (hit !== undefined) {
      return hit;
    }
    let total = 0;
    const snapshotsExecuted = sortedIds.reduce(
      (sum, _eventId, index) =>
        sum + (snapshotBits[index] === true && (mask & (1 << index)) !== 0 ? 1 : 0),
      0,
    );
    const anyInFlight = opMasks.some((opMask) => {
      const done = popcount(mask & opMask);
      return done > 0 && done < popcount(opMask);
    });
    for (let index = 0; index < sortedIds.length; index++) {
      if ((mask & (1 << index)) !== 0) {
        continue;
      }
      const required = prereqMask[index];
      if (required === undefined || (required & ~mask) !== 0) {
        continue;
      }
      if (scenario.strategy === "PAUSE_WRITES") {
        if (snapshotBits[index] !== true) {
          if (snapshotsExecuted === 1) {
            continue;
          }
        } else if (anyInFlight) {
          continue;
        }
      }
      if (snapshotBits[index] === true && !placementSatisfied(mask)) {
        continue;
      }
      total += countFrom(mask | (1 << index));
    }
    memo.set(mask, total);
    return total;
  };
  return countFrom(0);
}

/** Stable rendering of a system-state pair, for evidence logs and tests. */
export function renderPair(database: DatabaseState, blob: BlobState): string {
  return stableStringify({ blob, database });
}
