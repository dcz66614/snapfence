/**
 * SnapFence (P030) — BFS search state representation. T003.
 *
 * Authority: PROJECT_BOOK.md §4.1 (S = (D, B, Q)), §4.2 (operation
 * boundaries), §4.5 (BFS search state), §4.6 (counterexample trace: each
 * event's input/output state); types.ts (SystemState, SearchTraceStep,
 * SearchTrace). Inputs (frozen, read-only): src/core/model/types.ts,
 * src/core/events/event-types.ts, src/core/events/apply-event.ts.
 *
 * Rules for this file:
 * - TypeScript strict mode; `any` is forbidden.
 * - Pure deterministic functions only; no mutation of inputs. Every
 *   extension returns a new SearchState; the input state is never modified.
 * - A SearchState is everything the BFS needs to continue a path AND
 *   everything T004 needs to judge the path: the execution order, the
 *   current system state, both captured snapshots (with the operations that
 *   were in flight when each was captured), and the full per-event
 *   before/after trace.
 */

import type {
  BlobState,
  DatabaseState,
  OperationStatus,
  Scenario,
  SearchTraceStep,
  SystemState,
} from "../model/types";
import {
  initialState,
  inFlightOperationIds,
  type EventApplicationResult,
} from "../events/apply-event";
import type { SnapFenceEvent } from "../events/event-types";

// ---------------------------------------------------------------------------
// SearchState
// ---------------------------------------------------------------------------

/**
 * One BFS node: one partial execution path and everything derived from it.
 *
 * - `path`: event IDs in execution order (the path itself; length equals
 *   the BFS depth of this node).
 * - `executedEventIds`: the same IDs in sorted order (the executed SET;
 *   membership and prerequisite checks use this, never traversal order).
 * - `systemState`: the current S = (D, B, Q) after applying `path`.
 * - `databaseSnapshot` / `blobSnapshot`: the states captured by the
 *   snapshot events on this path, or null when the snapshot has not
 *   executed yet. A snapshot captures a copy; later events never change it.
 * - `dbSnapshotInFlightOperationIds` / `blobSnapshotInFlightOperationIds`:
 *   the operation IDs that were IN_FLIGHT in the state each snapshot
 *   captured (empty when the snapshot has not executed, or when it captured
 *   a boundary state). Needed for the IN_FLIGHT_OPERATION diagnostic and
 *   for the visited key (see visited-key.ts).
 * - `steps`: the per-event before/after trace of this path, in execution
 *   order (SearchTraceStep per event; the counterexample trace of §4.6).
 */
export interface SearchState {
  readonly path: readonly string[];
  readonly executedEventIds: readonly string[];
  readonly systemState: SystemState;
  readonly databaseSnapshot: DatabaseState | null;
  readonly blobSnapshot: BlobState | null;
  readonly dbSnapshotInFlightOperationIds: readonly string[];
  readonly blobSnapshotInFlightOperationIds: readonly string[];
  readonly steps: readonly SearchTraceStep[];
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * The initial search state of a scenario: no events executed, the derived
 * initial system state (implied pre-existing records per I-02), no snapshots
 * captured, no trace steps.
 */
export function createInitialSearchState(scenario: Scenario): SearchState {
  return {
    path: [],
    executedEventIds: [],
    systemState: initialState(scenario),
    databaseSnapshot: null,
    blobSnapshot: null,
    dbSnapshotInFlightOperationIds: [],
    blobSnapshotInFlightOperationIds: [],
    steps: [],
  };
}

/**
 * Operation IDs with the given status in a search state, in sorted order.
 * (Sorted, not insertion order, so results never depend on record order.)
 */
export function operationIdsWithStatus(
  state: SearchState,
  status: OperationStatus,
): readonly string[] {
  const ids: string[] = [];
  for (const [opId, opStatus] of Object.entries(state.systemState.operationStatus)) {
    if (opStatus === status) {
      ids.push(opId);
    }
  }
  return ids.sort();
}

/** Operation IDs COMPLETED in this search state, sorted. */
export function completedOperationIds(state: SearchState): readonly string[] {
  return operationIdsWithStatus(state, "COMPLETED");
}

/** Operation IDs IN_FLIGHT in this search state, sorted. */
export function inFlightOperationIdsOf(state: SearchState): readonly string[] {
  return inFlightOperationIds(state.systemState);
}

/** True when the state is a legal operation boundary (§4.2): no op in flight. */
export function isBoundarySearchState(state: SearchState): boolean {
  return inFlightOperationIdsOf(state).length === 0;
}

/**
 * True when both snapshots have executed on this path. A terminal search
 * state fixes the snapshot pair: later data events cannot change the
 * captured snapshots, so BFS never extends a terminal state.
 */
export function isTerminalSearchState(state: SearchState): boolean {
  return state.databaseSnapshot !== null && state.blobSnapshot !== null;
}

/** True when the event ID has already executed on this path. */
export function hasExecuted(state: SearchState, eventId: string): boolean {
  return state.executedEventIds.includes(eventId);
}

// ---------------------------------------------------------------------------
// Extension — apply one event and return the next search state
// ---------------------------------------------------------------------------

/**
 * Extend a search state by one event, given the `applyEvent` result for
 * that event on this state's system state.
 *
 * - `path` gains the event ID; `executedEventIds` stays sorted.
 * - `systemState` becomes the result state.
 * - A snapshot event stores its captured copy and records the operations
 *   that were in flight in the state it captured (the pre-event state,
 *   which a snapshot event does not change).
 * - A trace step records the database/Blob states before and after the
 *   event and the operations completed after it.
 *
 * Pure: the input state is never mutated; a new state object is returned.
 */
export function extendSearchState(
  state: SearchState,
  event: SnapFenceEvent,
  result: EventApplicationResult,
): SearchState {
  const stepIndex = state.path.length;
  const step: SearchTraceStep = {
    stepIndex,
    eventId: event.eventId,
    databaseStateBefore: state.systemState.database,
    blobStateBefore: state.systemState.blob,
    databaseStateAfter: result.state.database,
    blobStateAfter: result.state.blob,
    completedOperationIds: operationIdsWithStatus(
      { ...state, systemState: result.state },
      "COMPLETED",
    ),
  };
  const executedEventIds = [...state.executedEventIds, event.eventId].sort();
  return {
    path: [...state.path, event.eventId],
    executedEventIds,
    systemState: result.state,
    databaseSnapshot:
      result.databaseSnapshot !== null ? result.databaseSnapshot : state.databaseSnapshot,
    blobSnapshot:
      result.blobSnapshot !== null ? result.blobSnapshot : state.blobSnapshot,
    dbSnapshotInFlightOperationIds:
      result.databaseSnapshot !== null
        ? inFlightOperationIds(state.systemState)
        : state.dbSnapshotInFlightOperationIds,
    blobSnapshotInFlightOperationIds:
      result.blobSnapshot !== null
        ? inFlightOperationIds(state.systemState)
        : state.blobSnapshotInFlightOperationIds,
    steps: [...state.steps, step],
  };
}
