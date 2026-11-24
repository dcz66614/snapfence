/**
 * SnapFence (P030) — scenario helpers and frozen operation templates. T001.
 *
 * Authority: PROJECT_BOOK.md §3.2 (operation templates), §3.3 (strategy
 * snapshot constraints), §10.3 (10-event bound, 2 snapshot events),
 * §9.1/§9.3 (scenario samples). SPEC_VERSION 1.0.0.
 *
 * This file contains ONLY frozen constants and pure structural helpers.
 * It does not implement validateScenario / runSearch (see contracts.ts);
 * those implementations land in later tasks (T002/T003).
 */

import type {
  LogicalOperation,
  LogicalOperationKind,
  Scenario,
} from "./types";

// ---------------------------------------------------------------------------
// Frozen bounds — PROJECT_BOOK.md §10.2/§10.3
// ---------------------------------------------------------------------------

/** Maximum supported event count for a search, including snapshot events. */
export const MAX_EVENTS = 10;

/** Number of snapshot events in every search (DB_SNAPSHOT + BLOB_SNAPSHOT). */
export const SNAPSHOT_EVENT_COUNT = 2;

/** Maximum number of atomic data-modifying events (MAX_EVENTS minus snapshots). */
export const MAX_DATA_EVENTS = MAX_EVENTS - SNAPSHOT_EVENT_COUNT;

// ---------------------------------------------------------------------------
// Atomic event kinds — PROJECT_BOOK.md §3.2 + §9 samples
// ---------------------------------------------------------------------------

/** Atomic data-modifying event kinds, exactly as named in §3.2. */
export type AtomicEventKind =
  | "BLOB_PUT"
  | "DB_LINK"
  | "DB_UNLINK"
  | "BLOB_DELETE"
  | "BLOB_PUT_NEW"
  | "DB_REPOINT"
  | "BLOB_DELETE_OLD";

/** Snapshot event kinds. */
export type SnapshotEventKind = "DB_SNAPSHOT" | "BLOB_SNAPSHOT";

/** Every event kind the model can produce. */
export type EventKind = AtomicEventKind | SnapshotEventKind;

/** The two snapshot events, in no implied order. */
export const SNAPSHOT_EVENTS: readonly SnapshotEventKind[] = ["DB_SNAPSHOT", "BLOB_SNAPSHOT"] as const;

// ---------------------------------------------------------------------------
// Operation templates — PROJECT_BOOK.md §3.2, frozen verbatim
// ---------------------------------------------------------------------------

/**
 * Frozen operation templates. Each logical operation expands to exactly this
 * ordered list of atomic events; no step may be skipped or reordered (§1.2
 * of IMPLEMENTATION_PLAN.md: templates are immutable).
 * - UPLOAD: BLOB_PUT -> DB_LINK
 * - DELETE: DB_UNLINK -> BLOB_DELETE
 * - UPDATE: BLOB_PUT_NEW -> DB_REPOINT -> BLOB_DELETE_OLD
 */
export const OPERATION_TEMPLATES: Readonly<Record<LogicalOperationKind, readonly AtomicEventKind[]>> = {
  UPLOAD: ["BLOB_PUT", "DB_LINK"],
  DELETE: ["DB_UNLINK", "BLOB_DELETE"],
  UPDATE: ["BLOB_PUT_NEW", "DB_REPOINT", "BLOB_DELETE_OLD"],
} as const;

/** Return the frozen atomic-event template for one operation kind. */
export function templateFor(kind: LogicalOperationKind): readonly AtomicEventKind[] {
  return OPERATION_TEMPLATES[kind];
}

/** Return the frozen atomic-event template for one logical operation. */
export function atomicEventKindsFor(operation: LogicalOperation): readonly AtomicEventKind[] {
  return OPERATION_TEMPLATES[operation.kind];
}

/** Number of atomic events one logical operation expands to. */
export function atomicEventCountFor(operation: LogicalOperation): number {
  return OPERATION_TEMPLATES[operation.kind].length;
}

// ---------------------------------------------------------------------------
// Strategy snapshot-order constraints — PROJECT_BOOK.md §3.3
// ---------------------------------------------------------------------------

/**
 * Fixed snapshot order imposed by a strategy, or null when the strategy
 * imposes no fixed order between the two snapshots.
 * - DB_FIRST: DB_SNAPSHOT before BLOB_SNAPSHOT.
 * - FILE_FIRST: BLOB_SNAPSHOT before DB_SNAPSHOT.
 * - PAUSE_WRITES: no fixed order; the constraint is instead that all started
 *   operations finish first and no data-modifying event occurs between the
 *   two snapshots (§3.3). Represented as null — callers must enforce the
 *   pause constraint separately, never assume an order.
 */
export const STRATEGY_SNAPSHOT_ORDER: Readonly<
  Record<
    Scenario["strategy"],
    readonly [SnapshotEventKind, SnapshotEventKind] | null
  >
> = {
  DB_FIRST: ["DB_SNAPSHOT", "BLOB_SNAPSHOT"],
  FILE_FIRST: ["BLOB_SNAPSHOT", "DB_SNAPSHOT"],
  PAUSE_WRITES: null,
} as const;

// ---------------------------------------------------------------------------
// Structural helpers for scenario validation (pure, no verdicts)
// ---------------------------------------------------------------------------

/**
 * Total atomic event count of a scenario: all operation events plus the two
 * snapshot events. PROJECT_BOOK.md §10.3 counts snapshot events in the bound
 * (G12: 8 modifying + 2 snapshot = 10).
 */
export function totalAtomicEventCount(scenario: Scenario): number {
  let count = SNAPSHOT_EVENT_COUNT;
  for (const operation of scenario.operations) {
    count += atomicEventCountFor(operation);
  }
  return count;
}

/** True when the scenario's total event count exceeds the frozen bound. */
export function exceedsEventBound(scenario: Scenario): boolean {
  return totalAtomicEventCount(scenario) > MAX_EVENTS;
}

/** True when the scenario id is a non-empty string after trimming. */
export function isNonEmptyScenarioId(scenarioId: string): boolean {
  return scenarioId.trim().length > 0;
}

/** Operation ids that occur more than once in the scenario, in first-seen order. */
export function findDuplicateOperationIds(operations: readonly LogicalOperation[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const operation of operations) {
    if (seen.has(operation.opId)) {
      if (!duplicates.includes(operation.opId)) {
        duplicates.push(operation.opId);
      }
    } else {
      seen.add(operation.opId);
    }
  }
  return duplicates;
}

/** True when any operation id is used more than once. */
export function hasDuplicateOperationIds(operations: readonly LogicalOperation[]): boolean {
  return findDuplicateOperationIds(operations).length > 0;
}

/**
 * File ids referenced by more than one operation, in first-seen order.
 * Sharing a fileId across operations is legal in the model (e.g. an upload
 * followed by an update of the same file); this helper exists so validators
 * and the event state machine can find such chains deterministically.
 */
export function findSharedFileIds(operations: readonly LogicalOperation[]): readonly string[] {
  const seen = new Set<string>();
  const shared: string[] = [];
  for (const operation of operations) {
    if (seen.has(operation.fileId)) {
      if (!shared.includes(operation.fileId)) {
        shared.push(operation.fileId);
      }
    } else {
      seen.add(operation.fileId);
    }
  }
  return shared;
}
