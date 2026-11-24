/**
 * SnapFence (P030) — event type definitions. T002.
 *
 * Authority: PROJECT_BOOK.md §3.2 (operation templates), §3.3 (snapshot
 * events), §4.1 (system state), §10.3 (10-event bound incl. snapshots).
 * Inputs (frozen, read-only): src/core/model/types.ts, scenario.ts,
 * contracts.ts; docs/MODEL_CONTRACT.md frozen interpretations I-01/I-02,
 * R-GEN-1/R-GEN-2, I-03.
 *
 * Rules for this file:
 * - TypeScript strict mode; `any` is forbidden.
 * - All functions are pure and deterministic: no randomness, no wall-clock.
 * - Every event carries its full payload (fileId, objectId, generation,
 *   digest) so `applyEvent` (apply-event.ts) needs no scenario context.
 * - Event IDs are deterministic: "<opId>:<KIND>" for operation events,
 *   "DB_SNAPSHOT" / "BLOB_SNAPSHOT" for the two snapshot events.
 */

import type {
  LogicalOperation,
  Scenario,
} from "../model/types";
import {
  atomicEventKindsFor,
  type AtomicEventKind,
  type EventKind,
  type SnapshotEventKind,
} from "../model/scenario";
import { blobVersionKey } from "../model/types";

export type { AtomicEventKind, EventKind, SnapshotEventKind };

// ---------------------------------------------------------------------------
// Event IDs — deterministic, unique per scenario
// ---------------------------------------------------------------------------

/** Event ID of the two snapshot events (fixed, strategy-independent). */
export const DB_SNAPSHOT_EVENT_ID = "DB_SNAPSHOT";
export const BLOB_SNAPSHOT_EVENT_ID = "BLOB_SNAPSHOT";

/** Deterministic event ID for one atomic event of one logical operation. */
export function eventIdFor(opId: string, kind: AtomicEventKind): string {
  return `${opId}:${kind}`;
}

/** True when the event ID is one of the two snapshot event IDs. */
export function isSnapshotEventId(eventId: string): boolean {
  return eventId === DB_SNAPSHOT_EVENT_ID || eventId === BLOB_SNAPSHOT_EVENT_ID;
}

// ---------------------------------------------------------------------------
// Event payloads — one discriminated variant per atomic event kind
// ---------------------------------------------------------------------------

interface BaseEvent {
  eventId: string;
  /** Owning logical operation, or null for the two snapshot events. */
  opId: string | null;
}

/** BLOB_PUT — UPLOAD step 1: write the new object version. */
export interface BlobPutEvent extends BaseEvent {
  kind: "BLOB_PUT";
  fileId: string;
  objectId: string;
  generation: number;
  digest: string;
}

/** DB_LINK — UPLOAD step 2: create the DB record + reference. */
export interface DbLinkEvent extends BaseEvent {
  kind: "DB_LINK";
  fileId: string;
  objectId: string;
  generation: number;
  digest: string;
}

/** DB_UNLINK — DELETE step 1: remove the DB reference. */
export interface DbUnlinkEvent extends BaseEvent {
  kind: "DB_UNLINK";
  fileId: string;
  objectId: string;
  generation: number;
}

/** BLOB_DELETE — DELETE step 2: delete the Blob object version. */
export interface BlobDeleteEvent extends BaseEvent {
  kind: "BLOB_DELETE";
  fileId: string;
  objectId: string;
  generation: number;
}

/** BLOB_PUT_NEW — UPDATE step 1: write the new object version. */
export interface BlobPutNewEvent extends BaseEvent {
  kind: "BLOB_PUT_NEW";
  fileId: string;
  objectId: string;
  generation: number;
  digest: string;
  oldObjectId: string;
  oldGeneration: number;
}

/** DB_REPOINT — UPDATE step 2: switch the DB reference to the new version. */
export interface DbRepointEvent extends BaseEvent {
  kind: "DB_REPOINT";
  fileId: string;
  objectId: string;
  generation: number;
  digest: string;
  oldObjectId: string;
  oldGeneration: number;
}

/** BLOB_DELETE_OLD — UPDATE step 3: delete the old object version. */
export interface BlobDeleteOldEvent extends BaseEvent {
  kind: "BLOB_DELETE_OLD";
  fileId: string;
  oldObjectId: string;
  oldGeneration: number;
}

/** DB_SNAPSHOT — atomic capture of the current database state. */
export interface DbSnapshotEvent extends BaseEvent {
  kind: "DB_SNAPSHOT";
  opId: null;
}

/** BLOB_SNAPSHOT — atomic capture of the current Blob state. */
export interface BlobSnapshotEvent extends BaseEvent {
  kind: "BLOB_SNAPSHOT";
  opId: null;
}

/**
 * One atomic event in the model. The discriminated `kind` carries exactly
 * the payload its state transition needs; snapshot events carry no payload.
 */
export type SnapFenceEvent =
  | BlobPutEvent
  | DbLinkEvent
  | DbUnlinkEvent
  | BlobDeleteEvent
  | BlobPutNewEvent
  | DbRepointEvent
  | BlobDeleteOldEvent
  | DbSnapshotEvent
  | BlobSnapshotEvent;

/** True when the event is one of the two snapshot events. */
export function isSnapshotEvent(event: SnapFenceEvent): boolean {
  return event.kind === "DB_SNAPSHOT" || event.kind === "BLOB_SNAPSHOT";
}

/** True when the event modifies database or Blob state (i.e. not a snapshot). */
export function isDataEvent(event: SnapFenceEvent): boolean {
  return !isSnapshotEvent(event);
}

// ---------------------------------------------------------------------------
// Deterministic derivation rules (MODEL_CONTRACT.md I-02, R-GEN-1, R-GEN-2)
// ---------------------------------------------------------------------------

/**
 * Deterministically derive the digest of an implied pre-existing record
 * (I-02) when the operation does not pin one (`DeleteOperation.digest` /
 * `UpdateOperation.oldDigest` omitted). The value is identical in the
 * database and Blob components by construction, so the implied pre-state is
 * consistent. Format: "fixture-digest-<fileId>-<objectId>"; distinct per
 * object version, never colliding with an explicitly given digest unless the
 * fixture itself uses this exact string (fixtures must not).
 */
export function deriveImpliedDigest(fileId: string, objectId: string): string {
  return `fixture-digest-${fileId}-${objectId}`;
}

/**
 * Generation of the object version an UPLOAD creates (R-GEN-1): always 1.
 */
export const UPLOAD_GENERATION = 1;

/**
 * Generation of the pre-existing record implied by a DELETE / UPDATE (I-02):
 * always 1 by convention.
 */
export const IMPLIED_PREEXISTING_GENERATION = 1;

// ---------------------------------------------------------------------------
// Scenario expansion — operations -> ordered atomic events + implied state
// ---------------------------------------------------------------------------

/**
 * Per-file live-record tracking while expanding a scenario in scenario order.
 * `record` is the version currently live for the file (implied pre-existing
 * record, or a version created by an earlier UPLOAD / UPDATE in the same
 * scenario), or null when the file is known-absent (e.g. deleted by an
 * earlier DELETE in the same scenario).
 */
export interface LiveFileRecord {
  objectId: string;
  generation: number;
  digest: string;
}

/**
 * Result of expanding one scenario: the atomic events of every operation in
 * scenario order (each operation's events in template order), the two
 * snapshot events (appended last, in no implied execution order — the
 * strategy / BFS decides their positions), and the per-file live records
 * after all operations, for validators and the initial-state builder.
 *
 * Expansion is total: it never throws. Unknown or conflicting references are
 * resolved with the deterministic fallbacks documented below and reported by
 * `validateScenario` (validate-events.ts); expansion itself must stay usable
 * by the dependency graph and the BFS even for invalid input, so that
 * validation — not expansion — is the fail-closed gate.
 */
export interface ScenarioExpansion {
  /** Atomic data events, in scenario order, template order within each op. */
  dataEvents: readonly SnapFenceEvent[];
  /** The two snapshot events. */
  snapshotEvents: readonly [DbSnapshotEvent, BlobSnapshotEvent];
  /** All events: data events followed by the two snapshot events. */
  allEvents: readonly SnapFenceEvent[];
  /** Live record per fileId after processing all operations, in order. */
  liveRecords: Readonly<Record<string, LiveFileRecord>>;
  /**
   * Implied pre-existing records (I-02): one entry per fileId whose first
   * DELETE / UPDATE in scenario order found no live record. These seed the
   * initial system state; the digest is the operation's pinned digest when
   * given, else `deriveImpliedDigest`.
   */
  impliedRecords: Readonly<Record<string, LiveFileRecord>>;
}

/**
 * Expand one logical operation into its atomic events, given the live record
 * the operation starts from (`liveBefore`: null when the file has no live
 * record — the operation then falls back to the I-02 implied record at
 * generation 1 with a derived digest).
 *
 * Returns the events plus the live record after the operation (`liveAfter`:
 * null when the operation deletes the file).
 */
export function expandOperation(
  operation: LogicalOperation,
  liveBefore: LiveFileRecord | null,
): { events: readonly SnapFenceEvent[]; liveAfter: LiveFileRecord | null } {
  const opId = operation.opId;
  if (operation.kind === "UPLOAD") {
    const generation = UPLOAD_GENERATION;
    const events: readonly SnapFenceEvent[] = [
      {
        eventId: eventIdFor(opId, "BLOB_PUT"),
        kind: "BLOB_PUT",
        opId,
        fileId: operation.fileId,
        objectId: operation.objectId,
        generation,
        digest: operation.digest,
      },
      {
        eventId: eventIdFor(opId, "DB_LINK"),
        kind: "DB_LINK",
        opId,
        fileId: operation.fileId,
        objectId: operation.objectId,
        generation,
        digest: operation.digest,
      },
    ];
    return {
      events,
      liveAfter: {
        objectId: operation.objectId,
        generation,
        digest: operation.digest,
      },
    };
  }
  if (operation.kind === "DELETE") {
    const oldRecord: LiveFileRecord = liveBefore ?? {
      objectId: operation.objectId,
      generation: IMPLIED_PREEXISTING_GENERATION,
      digest: operation.digest ?? deriveImpliedDigest(operation.fileId, operation.objectId),
    };
    const events: readonly SnapFenceEvent[] = [
      {
        eventId: eventIdFor(opId, "DB_UNLINK"),
        kind: "DB_UNLINK",
        opId,
        fileId: operation.fileId,
        objectId: oldRecord.objectId,
        generation: oldRecord.generation,
      },
      {
        eventId: eventIdFor(opId, "BLOB_DELETE"),
        kind: "BLOB_DELETE",
        opId,
        fileId: operation.fileId,
        objectId: oldRecord.objectId,
        generation: oldRecord.generation,
      },
    ];
    return { events, liveAfter: null };
  }
  // UPDATE
  // R-GEN-2: new generation = old generation + 1. When the operation's
  // oldObjectId disagrees with the live record, the old generation falls back
  // to the implied generation 1 (validation reports the mismatch). When
  // there is no live record, the implied pre-existing record (I-02) is at
  // generation 1, so the new version is at generation 2 either way.
  const oldGeneration =
    liveBefore !== null && liveBefore.objectId === operation.oldObjectId
      ? liveBefore.generation
      : IMPLIED_PREEXISTING_GENERATION;
  const newGeneration = oldGeneration + 1;
  const events: readonly SnapFenceEvent[] = [
    {
      eventId: eventIdFor(opId, "BLOB_PUT_NEW"),
      kind: "BLOB_PUT_NEW",
      opId,
      fileId: operation.fileId,
      objectId: operation.objectId,
      generation: newGeneration,
      digest: operation.digest,
      oldObjectId: operation.oldObjectId,
      oldGeneration,
    },
    {
      eventId: eventIdFor(opId, "DB_REPOINT"),
      kind: "DB_REPOINT",
      opId,
      fileId: operation.fileId,
      objectId: operation.objectId,
      generation: newGeneration,
      digest: operation.digest,
      oldObjectId: operation.oldObjectId,
      oldGeneration,
    },
    {
      eventId: eventIdFor(opId, "BLOB_DELETE_OLD"),
      kind: "BLOB_DELETE_OLD",
      opId,
      fileId: operation.fileId,
      oldObjectId: operation.oldObjectId,
      oldGeneration,
    },
  ];
  return {
    events,
    liveAfter: {
      objectId: operation.objectId,
      generation: newGeneration,
      digest: operation.digest,
    },
  };
}

/** Expand every operation of a scenario, tracking live records in order. */
export function expandScenario(scenario: Scenario): ScenarioExpansion {
  const dataEvents: SnapFenceEvent[] = [];
  const liveRecords: Record<string, LiveFileRecord> = {};
  const impliedRecords: Record<string, LiveFileRecord> = {};
  for (const operation of scenario.operations) {
    const liveBefore: LiveFileRecord | null = liveRecords[operation.fileId] ?? null;
    if (
      (operation.kind === "DELETE" || operation.kind === "UPDATE") &&
      liveBefore === null &&
      impliedRecords[operation.fileId] === undefined
    ) {
      const objectId = operation.kind === "DELETE" ? operation.objectId : operation.oldObjectId;
      const pinnedDigest =
        operation.kind === "DELETE" ? operation.digest : operation.oldDigest;
      impliedRecords[operation.fileId] = {
        objectId,
        generation: IMPLIED_PREEXISTING_GENERATION,
        digest: pinnedDigest ?? deriveImpliedDigest(operation.fileId, objectId),
      };
    }
    const { events, liveAfter } = expandOperation(operation, liveBefore);
    dataEvents.push(...events);
    if (liveAfter === null) {
      delete liveRecords[operation.fileId];
    } else {
      liveRecords[operation.fileId] = liveAfter;
    }
  }
  const snapshotEvents: readonly [DbSnapshotEvent, BlobSnapshotEvent] = [
    { eventId: DB_SNAPSHOT_EVENT_ID, kind: "DB_SNAPSHOT", opId: null },
    { eventId: BLOB_SNAPSHOT_EVENT_ID, kind: "BLOB_SNAPSHOT", opId: null },
  ];
  return {
    dataEvents,
    snapshotEvents,
    allEvents: [...dataEvents, ...snapshotEvents],
    liveRecords,
    impliedRecords,
  };
}

/** All atomic event kinds of one operation, in template order (re-export). */
export function templateKindsFor(operation: LogicalOperation): readonly AtomicEventKind[] {
  return atomicEventKindsFor(operation);
}

/**
 * The prerequisite event IDs of one event within its own operation template:
 * every earlier template event of the same operation, in template order.
 * Snapshot events have no prerequisites. Cross-operation prerequisites (same
 * fileId chains) live in the dependency graph, not here.
 */
export function templatePrerequisites(event: SnapFenceEvent): readonly string[] {
  if (event.opId === null) {
    return [];
  }
  const kinds = OPERATION_TEMPLATE_KINDS[event.kind];
  const prerequisites: string[] = [];
  for (const kind of kinds) {
    if (kind === event.kind) {
      break;
    }
    prerequisites.push(eventIdFor(event.opId, kind));
  }
  return prerequisites;
}

/** Template prefix (earlier kinds) for each atomic event kind. */
const OPERATION_TEMPLATE_KINDS: Readonly<Record<AtomicEventKind, readonly AtomicEventKind[]>> = {
  BLOB_PUT: ["BLOB_PUT", "DB_LINK"],
  DB_LINK: ["BLOB_PUT", "DB_LINK"],
  DB_UNLINK: ["DB_UNLINK", "BLOB_DELETE"],
  BLOB_DELETE: ["DB_UNLINK", "BLOB_DELETE"],
  BLOB_PUT_NEW: ["BLOB_PUT_NEW", "DB_REPOINT", "BLOB_DELETE_OLD"],
  DB_REPOINT: ["BLOB_PUT_NEW", "DB_REPOINT", "BLOB_DELETE_OLD"],
  BLOB_DELETE_OLD: ["BLOB_PUT_NEW", "DB_REPOINT", "BLOB_DELETE_OLD"],
} as const;

/**
 * Blob version key of the object version an event writes / references.
 * Snapshot events return null (they reference no single version).
 */
export function eventBlobVersionKey(event: SnapFenceEvent): string | null {
  switch (event.kind) {
    case "BLOB_PUT":
    case "DB_LINK":
    case "BLOB_DELETE":
      return blobVersionKey(event.objectId, event.generation);
    case "BLOB_PUT_NEW":
    case "DB_REPOINT":
      return blobVersionKey(event.objectId, event.generation);
    case "BLOB_DELETE_OLD":
      return blobVersionKey(event.oldObjectId, event.oldGeneration);
    case "DB_UNLINK":
      return blobVersionKey(event.objectId, event.generation);
    case "DB_SNAPSHOT":
    case "BLOB_SNAPSHOT":
      return null;
  }
}
