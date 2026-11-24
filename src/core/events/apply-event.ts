/**
 * SnapFence (P030) — pure event state machine. T002.
 *
 * Authority: PROJECT_BOOK.md §3.2 (operation templates), §4.1 (S = (D, B, Q)),
 * §4.2 (operation boundaries: partial = IN_FLIGHT, never a boundary).
 * Inputs (frozen, read-only): src/core/model/types.ts, scenario.ts;
 * event-types.ts (this task).
 *
 * Rules for this file:
 * - TypeScript strict mode; `any` is forbidden.
 * - Every transition is a pure function: no randomness, no wall-clock, no
 *   mutation of inputs — a new SystemState is returned every time.
 * - Illegal events are rejected by throwing `EventApplicationError`
 *   (fail-closed): the caller must not apply them and must not silently
 *   skip them. The error code names the reason.
 * - Snapshot events (DB_SNAPSHOT / BLOB_SNAPSHOT) are atomic: they capture
 *   a copy of the current component state and change nothing else.
 */

import type {
  BlobState,
  DatabaseState,
  OperationStatus,
  Scenario,
  SystemState,
} from "../model/types";
import { blobVersionKey } from "../model/types";
import {
  expandScenario,
  templatePrerequisites,
  type SnapFenceEvent,
} from "./event-types";

// ---------------------------------------------------------------------------
// Errors — fail-closed rejection of illegal events
// ---------------------------------------------------------------------------

/** Why an event application was rejected. */
export type EventApplicationErrorCode =
  | "PREREQUISITE_NOT_MET"
  | "EVENT_ALREADY_EXECUTED"
  | "UNKNOWN_OBJECT_VERSION"
  | "INVALID_EVENT_STATE";

/**
 * Thrown by `applyEvent` / `applyEvents` when an event cannot legally be
 * applied to the given state. The state is left untouched (the throw happens
 * before any new state is returned).
 */
export class EventApplicationError extends Error {
  readonly code: EventApplicationErrorCode;
  readonly eventId: string;

  constructor(code: EventApplicationErrorCode, eventId: string, message: string) {
    super(message);
    this.name = "EventApplicationError";
    this.code = code;
    this.eventId = eventId;
  }
}

// ---------------------------------------------------------------------------
// Result of applying one event
// ---------------------------------------------------------------------------

/**
 * Result of applying one event. `databaseSnapshot` / `blobSnapshot` are
 * non-null only for the matching snapshot event (a copy of the state at
 * capture time); for every other event both are null. The state itself is
 * unchanged by snapshot events.
 */
export interface EventApplicationResult {
  state: SystemState;
  databaseSnapshot: DatabaseState | null;
  blobSnapshot: BlobState | null;
}

// ---------------------------------------------------------------------------
// Initial state — MODEL_CONTRACT.md I-01 / I-02
// ---------------------------------------------------------------------------

/**
 * Initial system state for a scenario (I-01: no `initialState` field, so the
 * initial state is derived from the operations). Every file whose first
 * DELETE / UPDATE in scenario order found no live record contributes its
 * implied pre-existing record (I-02): the database holds
 * `fileId -> { objectId, generation 1, digest }` and the Blob holds
 * `(objectId, 1) -> digest`, with the same digest in both components.
 * All operations start NOT_STARTED.
 */
export function initialState(scenario: Scenario): SystemState {
  const expansion = expandScenario(scenario);
  const database: Record<string, { objectId: string; generation: number; digest: string }> = {};
  const blob: Record<string, string> = {};
  const operationStatus: Record<string, OperationStatus> = {};
  for (const operation of scenario.operations) {
    operationStatus[operation.opId] = "NOT_STARTED";
  }
  for (const fileId of Object.keys(expansion.impliedRecords)) {
    const record = expansion.impliedRecords[fileId];
    if (record === undefined) {
      continue;
    }
    database[fileId] = {
      objectId: record.objectId,
      generation: record.generation,
      digest: record.digest,
    };
    blob[blobVersionKey(record.objectId, record.generation)] = record.digest;
  }
  return { database, blob, operationStatus };
}

// ---------------------------------------------------------------------------
// Pure helpers — copy-on-write state updates
// ---------------------------------------------------------------------------

function withOperationStatus(
  state: SystemState,
  opId: string,
  status: OperationStatus,
): SystemState {
  return {
    database: state.database,
    blob: state.blob,
    operationStatus: { ...state.operationStatus, [opId]: status },
  };
}

function withDatabase(
  state: SystemState,
  database: DatabaseState,
): SystemState {
  return { database, blob: state.blob, operationStatus: state.operationStatus };
}

function withBlob(state: SystemState, blob: BlobState): SystemState {
  return { database: state.database, blob, operationStatus: state.operationStatus };
}

/** Copy a readonly record without one key (copy-on-write delete). */
function omitKey<K extends string, V>(
  record: Readonly<Record<K, V>>,
  key: K,
): Record<K, V> {
  const copy: Record<K, V> = { ...record };
  delete copy[key];
  return copy;
}

function reject(
  code: EventApplicationErrorCode,
  event: SnapFenceEvent,
  message: string,
): never {
  throw new EventApplicationError(code, event.eventId, message);
}

// ---------------------------------------------------------------------------
// applyEvent — one pure state transition
// ---------------------------------------------------------------------------

/**
 * Apply one atomic event to a system state and return the new state.
 *
 * `executedEventIds` is the set of event IDs already applied on this path
 * (empty when omitted). It is used to reject repeats of the same atomic
 * event and to reject events whose same-operation prerequisites have not
 * executed yet. State-based checks additionally reject events whose
 * preconditions the current (D, B) do not satisfy — e.g. DB_LINK before its
 * BLOB_PUT, or BLOB_DELETE before its DB_UNLINK — so skipping a prerequisite
 * is rejected even when the caller passes no executed set.
 *
 * The input state is never mutated; a new state object is returned.
 */
export function applyEvent(
  state: SystemState,
  event: SnapFenceEvent,
  executedEventIds: readonly string[] = [],
): EventApplicationResult {
  const executed = new Set(executedEventIds);
  if (executed.has(event.eventId)) {
    reject(
      "EVENT_ALREADY_EXECUTED",
      event,
      `Event ${event.eventId} has already been executed on this path; ` +
        `an atomic event must not be executed twice.`,
    );
  }
  for (const prerequisite of templatePrerequisites(event)) {
    if (!executed.has(prerequisite)) {
      reject(
        "PREREQUISITE_NOT_MET",
        event,
        `Event ${event.eventId} requires prerequisite ${prerequisite} to ` +
          `have executed first (operation template order).`,
      );
    }
  }

  switch (event.kind) {
    case "BLOB_PUT": {
      if (event.opId === null) {
        reject("INVALID_EVENT_STATE", event, `BLOB_PUT ${event.eventId} has no owning operation.`);
      }
      const key = blobVersionKey(event.objectId, event.generation);
      if (state.blob[key] !== undefined) {
        reject(
          "EVENT_ALREADY_EXECUTED",
          event,
          `Blob version ${key} already exists; BLOB_PUT ${event.eventId} would repeat it.`,
        );
      }
      const next = withBlob(state, { ...state.blob, [key]: event.digest });
      return {
        state: withOperationStatus(next, event.opId, "IN_FLIGHT"),
        databaseSnapshot: null,
        blobSnapshot: null,
      };
    }
    case "DB_LINK": {
      if (event.opId === null) {
        reject("INVALID_EVENT_STATE", event, `DB_LINK ${event.eventId} has no owning operation.`);
      }
      const key = blobVersionKey(event.objectId, event.generation);
      if (state.blob[key] === undefined) {
        reject(
          "PREREQUISITE_NOT_MET",
          event,
          `DB_LINK ${event.eventId} requires Blob version ${key} to exist ` +
            `(BLOB_PUT must have executed first).`,
        );
      }
      if (state.database[event.fileId] !== undefined) {
        reject(
          "EVENT_ALREADY_EXECUTED",
          event,
          `Database already holds a record for file ${event.fileId}; ` +
            `DB_LINK ${event.eventId} would repeat it.`,
        );
      }
      const database: DatabaseState = {
        ...state.database,
        [event.fileId]: {
          objectId: event.objectId,
          generation: event.generation,
          digest: event.digest,
        },
      };
      const next = withDatabase(state, database);
      return {
        state: withOperationStatus(next, event.opId, "COMPLETED"),
        databaseSnapshot: null,
        blobSnapshot: null,
      };
    }
    case "DB_UNLINK": {
      if (event.opId === null) {
        reject("INVALID_EVENT_STATE", event, `DB_UNLINK ${event.eventId} has no owning operation.`);
      }
      const record = state.database[event.fileId];
      if (record === undefined) {
        reject(
          "PREREQUISITE_NOT_MET",
          event,
          `DB_UNLINK ${event.eventId} requires a database record for file ` +
            `${event.fileId} (no such record exists).`,
        );
      }
      if (record.objectId !== event.objectId || record.generation !== event.generation) {
        reject(
          "UNKNOWN_OBJECT_VERSION",
          event,
          `DB_UNLINK ${event.eventId} targets ${event.objectId}@${event.generation} ` +
            `but the database record for ${event.fileId} points at ` +
            `${record.objectId}@${record.generation}.`,
        );
      }
      const database: DatabaseState = omitKey(state.database, event.fileId);
      const next = withDatabase(state, database);
      return {
        state: withOperationStatus(next, event.opId, "IN_FLIGHT"),
        databaseSnapshot: null,
        blobSnapshot: null,
      };
    }
    case "BLOB_DELETE": {
      if (event.opId === null) {
        reject("INVALID_EVENT_STATE", event, `BLOB_DELETE ${event.eventId} has no owning operation.`);
      }
      if (state.database[event.fileId] !== undefined) {
        reject(
          "PREREQUISITE_NOT_MET",
          event,
          `BLOB_DELETE ${event.eventId} requires the database record for file ` +
            `${event.fileId} to be removed first (DB_UNLINK must have executed).`,
        );
      }
      const key = blobVersionKey(event.objectId, event.generation);
      if (state.blob[key] === undefined) {
        reject(
          "EVENT_ALREADY_EXECUTED",
          event,
          `Blob version ${key} does not exist; BLOB_DELETE ${event.eventId} ` +
            `would repeat a deletion (or delete a never-written version).`,
        );
      }
      const blob: BlobState = omitKey(state.blob, key);
      const next = withBlob(state, blob);
      return {
        state: withOperationStatus(next, event.opId, "COMPLETED"),
        databaseSnapshot: null,
        blobSnapshot: null,
      };
    }
    case "BLOB_PUT_NEW": {
      if (event.opId === null) {
        reject("INVALID_EVENT_STATE", event, `BLOB_PUT_NEW ${event.eventId} has no owning operation.`);
      }
      const oldRecord = state.database[event.fileId];
      if (oldRecord === undefined) {
        reject(
          "PREREQUISITE_NOT_MET",
          event,
          `BLOB_PUT_NEW ${event.eventId} requires a database record for file ` +
            `${event.fileId} (the old version to replace does not exist).`,
        );
      }
      if (oldRecord.objectId !== event.oldObjectId || oldRecord.generation !== event.oldGeneration) {
        reject(
          "UNKNOWN_OBJECT_VERSION",
          event,
          `BLOB_PUT_NEW ${event.eventId} expects the old version ` +
            `${event.oldObjectId}@${event.oldGeneration} but the database record ` +
            `for ${event.fileId} points at ${oldRecord.objectId}@${oldRecord.generation}.`,
        );
      }
      const key = blobVersionKey(event.objectId, event.generation);
      if (state.blob[key] !== undefined) {
        reject(
          "EVENT_ALREADY_EXECUTED",
          event,
          `Blob version ${key} already exists; BLOB_PUT_NEW ${event.eventId} would repeat it.`,
        );
      }
      const next = withBlob(state, { ...state.blob, [key]: event.digest });
      return {
        state: withOperationStatus(next, event.opId, "IN_FLIGHT"),
        databaseSnapshot: null,
        blobSnapshot: null,
      };
    }
    case "DB_REPOINT": {
      if (event.opId === null) {
        reject("INVALID_EVENT_STATE", event, `DB_REPOINT ${event.eventId} has no owning operation.`);
      }
      const key = blobVersionKey(event.objectId, event.generation);
      if (state.blob[key] === undefined) {
        reject(
          "PREREQUISITE_NOT_MET",
          event,
          `DB_REPOINT ${event.eventId} requires Blob version ${key} to exist ` +
            `(BLOB_PUT_NEW must have executed first).`,
        );
      }
      const oldRecord = state.database[event.fileId];
      if (oldRecord === undefined) {
        reject(
          "PREREQUISITE_NOT_MET",
          event,
          `DB_REPOINT ${event.eventId} requires a database record for file ` +
            `${event.fileId} to repoint.`,
        );
      }
      if (oldRecord.objectId !== event.oldObjectId || oldRecord.generation !== event.oldGeneration) {
        reject(
          "UNKNOWN_OBJECT_VERSION",
          event,
          `DB_REPOINT ${event.eventId} expects the old version ` +
            `${event.oldObjectId}@${event.oldGeneration} but the database record ` +
            `for ${event.fileId} points at ${oldRecord.objectId}@${oldRecord.generation}.`,
        );
      }
      const database: DatabaseState = {
        ...state.database,
        [event.fileId]: {
          objectId: event.objectId,
          generation: event.generation,
          digest: event.digest,
        },
      };
      const next = withDatabase(state, database);
      return {
        state: withOperationStatus(next, event.opId, "IN_FLIGHT"),
        databaseSnapshot: null,
        blobSnapshot: null,
      };
    }
    case "BLOB_DELETE_OLD": {
      if (event.opId === null) {
        reject("INVALID_EVENT_STATE", event, `BLOB_DELETE_OLD ${event.eventId} has no owning operation.`);
      }
      const current = state.database[event.fileId];
      if (
        current !== undefined &&
        current.objectId === event.oldObjectId &&
        current.generation === event.oldGeneration
      ) {
        reject(
          "PREREQUISITE_NOT_MET",
          event,
          `BLOB_DELETE_OLD ${event.eventId} requires the database reference for ` +
            `file ${event.fileId} to be repointed away from ` +
            `${event.oldObjectId}@${event.oldGeneration} first (DB_REPOINT must have executed).`,
        );
      }
      const key = blobVersionKey(event.oldObjectId, event.oldGeneration);
      if (state.blob[key] === undefined) {
        reject(
          "EVENT_ALREADY_EXECUTED",
          event,
          `Blob version ${key} does not exist; BLOB_DELETE_OLD ${event.eventId} ` +
            `would repeat a deletion (or delete a never-written version).`,
        );
      }
      const blob: BlobState = omitKey(state.blob, key);
      const next = withBlob(state, blob);
      return {
        state: withOperationStatus(next, event.opId, "COMPLETED"),
        databaseSnapshot: null,
        blobSnapshot: null,
      };
    }
    case "DB_SNAPSHOT": {
      return {
        state,
        databaseSnapshot: { ...state.database },
        blobSnapshot: null,
      };
    }
    case "BLOB_SNAPSHOT": {
      return {
        state,
        databaseSnapshot: null,
        blobSnapshot: { ...state.blob },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// applyEvents — fold a whole ordered event list over a state
// ---------------------------------------------------------------------------

/**
 * Result of applying an ordered event list: the final state plus the
 * snapshots captured along the way (null when the matching snapshot event
 * never executed).
 */
export interface EventSequenceResult {
  state: SystemState;
  databaseSnapshot: DatabaseState | null;
  blobSnapshot: BlobState | null;
  /** Event IDs applied, in order (equals the input order when it succeeds). */
  appliedEventIds: readonly string[];
}

/**
 * Apply an ordered list of events to a state, in order, tracking the
 * executed set so repeats and skipped prerequisites are rejected. Pure: the
 * input state is never mutated. Throws `EventApplicationError` on the first
 * illegal event (fail-closed); no partial result is returned.
 */
export function applyEvents(
  state: SystemState,
  events: readonly SnapFenceEvent[],
): EventSequenceResult {
  let current = state;
  const executed: string[] = [];
  let databaseSnapshot: DatabaseState | null = null;
  let blobSnapshot: BlobState | null = null;
  for (const event of events) {
    const result = applyEvent(current, event, executed);
    current = result.state;
    if (result.databaseSnapshot !== null) {
      databaseSnapshot = result.databaseSnapshot;
    }
    if (result.blobSnapshot !== null) {
      blobSnapshot = result.blobSnapshot;
    }
    executed.push(event.eventId);
  }
  return { state: current, databaseSnapshot, blobSnapshot, appliedEventIds: executed };
}

/**
 * True when the state is a legal operation boundary (§4.2): every logical
 * operation is NOT_STARTED or COMPLETED — no operation is IN_FLIGHT.
 */
export function isOperationBoundary(state: SystemState): boolean {
  for (const status of Object.values(state.operationStatus)) {
    if (status === "IN_FLIGHT") {
      return false;
    }
  }
  return true;
}

/** Operation IDs currently IN_FLIGHT in the state, in first-seen order. */
export function inFlightOperationIds(state: SystemState): readonly string[] {
  const ids: string[] = [];
  for (const [opId, status] of Object.entries(state.operationStatus)) {
    if (status === "IN_FLIGHT") {
      ids.push(opId);
    }
  }
  return ids;
}
