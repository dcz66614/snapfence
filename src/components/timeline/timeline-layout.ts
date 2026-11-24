/**
 * SnapFence (P030) — dual-track timeline layout model. T008.
 *
 * Authority: PROJECT_BOOK.md §5 (dual-track timeline UI, visual spec §5.3,
 * interaction §5.4), §4.4 (diagnostic codes), §4.7 (verdicts), §9 (scenarios
 * A/B/C); IMPLEMENTATION_PLAN.md T008. Inputs (frozen, read-only):
 * src/core/model/types.ts, src/core/model/scenario.ts,
 * src/core/events/event-types.ts, src/core/events/apply-event.ts,
 * src/core/search/bfs.ts (`runSearch` — the S0-verified contract; this
 * module never re-implements search or consistency semantics).
 *
 * This module is pure and deterministic: given a Scenario and its
 * S0-verified SearchResult it derives everything the timeline renders —
 * which lane each event belongs to, the x position of every event and both
 * snapshot markers, which events belong to the shortest counterexample,
 * and how the orphan-Blob / dangling-reference diagnostics map to visual
 * markers and snapshot-diff rows. No React, no DOM, no wall-clock here,
 * so the whole layout is unit-testable in the node vitest environment.
 */

import type {
  BackupStrategy,
  BlobState,
  DatabaseState,
  Diagnostic,
  DiagnosticCode,
  DiagnosticSeverity,
  Scenario,
  SearchResult,
} from "../../core/model/types";
import { blobVersionKey } from "../../core/model/types";
import { totalAtomicEventCount } from "../../core/model/scenario";
import type { EventKind, SnapFenceEvent } from "../../core/events/event-types";
import {
  DB_SNAPSHOT_EVENT_ID,
  BLOB_SNAPSHOT_EVENT_ID,
  expandScenario,
  isSnapshotEventId,
} from "../../core/events/event-types";
import { applyEvents, initialState } from "../../core/events/apply-event";

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

/** The two timeline lanes: database (upper) and Blob storage (lower). */
export type LaneId = "database" | "blob";

/** Chinese lane titles (PROJECT_BOOK.md §5.2). */
export const LANE_TITLES: Readonly<Record<LaneId, string>> = {
  database: "数据库",
  blob: "Blob 存储",
} as const;

/**
 * Which lane an event kind belongs to (PROJECT_BOOK.md §5.2):
 * database lane shows record insert / reference delete / repoint /
 * DB snapshot; Blob lane shows object write / delete / update / Blob snapshot.
 */
export function laneForEventKind(kind: EventKind): LaneId {
  switch (kind) {
    case "DB_LINK":
    case "DB_UNLINK":
    case "DB_REPOINT":
    case "DB_SNAPSHOT":
      return "database";
    case "BLOB_PUT":
    case "BLOB_DELETE":
    case "BLOB_PUT_NEW":
    case "BLOB_DELETE_OLD":
    case "BLOB_SNAPSHOT":
      return "blob";
  }
}

/** Chinese label for one atomic event kind (PROJECT_BOOK.md §3.2/§5.2). */
export const EVENT_KIND_LABELS: Readonly<Record<EventKind, string>> = {
  BLOB_PUT: "写入对象",
  DB_LINK: "建立记录",
  DB_UNLINK: "删除引用",
  BLOB_DELETE: "删除对象",
  BLOB_PUT_NEW: "写入新版本",
  DB_REPOINT: "切换引用",
  BLOB_DELETE_OLD: "删除旧版本",
  DB_SNAPSHOT: "数据库快照",
  BLOB_SNAPSHOT: "Blob 快照",
} as const;

/** Chinese label for one backup strategy (PROJECT_BOOK.md §3.3). */
export const STRATEGY_LABELS: Readonly<Record<BackupStrategy, string>> = {
  DB_FIRST: "数据库优先",
  FILE_FIRST: "文件优先",
  PAUSE_WRITES: "暂停写入",
} as const;

// ---------------------------------------------------------------------------
// Display sequence — what the timeline shows
// ---------------------------------------------------------------------------

/**
 * The event sequence the timeline displays.
 *
 * - UNSAFE_WITHIN_BOUND (or any result with a non-empty counterexample):
 *   the shortest counterexample itself (§4.6). Its events are the ones the
 *   user replays; snapshot markers sit at the snapshot events' positions
 *   inside this sequence.
 * - Otherwise (SAFE / INCONCLUSIVE_LIMIT / INVALID_INPUT with an empty
 *   counterexample): the canonical full sequence — all data events in
 *   scenario order, then the two snapshot events in strategy order
 *   (DB_FIRST / PAUSE_WRITES: DB_SNAPSHOT then BLOB_SNAPSHOT; FILE_FIRST:
 *   BLOB_SNAPSHOT then DB_SNAPSHOT). The canonical sequence is verified
 *   legal by actually applying it with the frozen `applyEvents`; if it
 *   ever failed to apply, the timeline falls back to the two snapshot
 *   events alone rather than rendering a sequence the model rejects.
 */
export interface DisplaySequence {
  /** Ordered event IDs, as displayed left to right. */
  eventIds: readonly string[];
  /** The event objects, in the same order. */
  events: readonly SnapFenceEvent[];
  /** True when the displayed sequence is the shortest counterexample. */
  isCounterexample: boolean;
}

function snapshotOrderFor(strategy: BackupStrategy): readonly string[] {
  return strategy === "FILE_FIRST"
    ? [BLOB_SNAPSHOT_EVENT_ID, DB_SNAPSHOT_EVENT_ID]
    : [DB_SNAPSHOT_EVENT_ID, BLOB_SNAPSHOT_EVENT_ID];
}

export function buildDisplaySequence(
  scenario: Scenario,
  result: SearchResult,
): DisplaySequence {
  const expansion = expandScenario(scenario);
  const byId = new Map<string, SnapFenceEvent>();
  for (const event of expansion.allEvents) {
    byId.set(event.eventId, event);
  }
  if (result.counterexample.length > 0) {
    const events: SnapFenceEvent[] = [];
    for (const eventId of result.counterexample) {
      const event = byId.get(eventId);
      if (event !== undefined) {
        events.push(event);
      }
    }
    return {
      eventIds: events.map((event) => event.eventId),
      events,
      isCounterexample: true,
    };
  }
  const orderedIds = [
    ...expansion.dataEvents.map((event) => event.eventId),
    ...snapshotOrderFor(scenario.strategy),
  ];
  const events: SnapFenceEvent[] = [];
  for (const eventId of orderedIds) {
    const event = byId.get(eventId);
    if (event !== undefined) {
      events.push(event);
    }
  }
  try {
    applyEvents(initialState(scenario), events);
  } catch {
    const fallback = expansion.snapshotEvents;
    return {
      eventIds: fallback.map((event) => event.eventId),
      events: [...fallback],
      isCounterexample: false,
    };
  }
  return {
    eventIds: events.map((event) => event.eventId),
    events,
    isCounterexample: false,
  };
}

// ---------------------------------------------------------------------------
// Timeline model — positioned items, snapshot markers, replay state
// ---------------------------------------------------------------------------

/** Replay state of one displayed event, given the current replay step. */
export type ReplayState = "done" | "current" | "future";

/** One positioned event chip on a lane. */
export interface TimelineEventItem {
  index: number;
  eventId: string;
  kind: EventKind;
  lane: LaneId;
  /** Horizontal centre of the chip, as a percentage of the lane width. */
  xPercent: number;
  isSnapshot: boolean;
  isCounterexample: boolean;
  replayState: ReplayState;
  labelZh: string;
  detail: string;
  fileId: string | null;
  objectId: string | null;
}

/** One snapshot marker (vertical line) on the timeline. */
export interface SnapshotMarkerModel {
  eventId: string;
  kind: "DB_SNAPSHOT" | "BLOB_SNAPSHOT";
  lane: LaneId;
  xPercent: number;
  labelZh: string;
}

export interface TimelineModel {
  sequence: DisplaySequence;
  items: readonly TimelineEventItem[];
  databaseItems: readonly TimelineEventItem[];
  blobItems: readonly TimelineEventItem[];
  snapshotMarkers: readonly SnapshotMarkerModel[];
  /** Total atomic events in the scenario (incl. the 2 snapshot events). */
  totalEvents: number;
}

function eventDetail(event: SnapFenceEvent): string {
  switch (event.kind) {
    case "BLOB_PUT":
      return `对象 ${event.objectId}（第 ${event.generation} 代）`;
    case "DB_LINK":
      return `文件 ${event.fileId} → ${event.objectId}`;
    case "DB_UNLINK":
      return `文件 ${event.fileId} 取消引用 ${event.objectId}`;
    case "BLOB_DELETE":
      return `对象 ${event.objectId}（第 ${event.generation} 代）`;
    case "BLOB_PUT_NEW":
      return `对象 ${event.objectId}（第 ${event.generation} 代）`;
    case "DB_REPOINT":
      return `文件 ${event.fileId}：${event.oldObjectId} → ${event.objectId}`;
    case "BLOB_DELETE_OLD":
      return `旧对象 ${event.oldObjectId}（第 ${event.oldGeneration} 代）`;
    case "DB_SNAPSHOT":
      return "捕获当前数据库状态";
    case "BLOB_SNAPSHOT":
      return "捕获当前 Blob 状态";
  }
}

function eventFileId(event: SnapFenceEvent): string | null {
  switch (event.kind) {
    case "DB_SNAPSHOT":
    case "BLOB_SNAPSHOT":
      return null;
    default:
      return event.fileId;
  }
}

function eventObjectId(event: SnapFenceEvent): string | null {
  switch (event.kind) {
    case "BLOB_PUT":
    case "DB_LINK":
    case "DB_UNLINK":
    case "BLOB_DELETE":
    case "BLOB_PUT_NEW":
    case "DB_REPOINT":
      return event.objectId;
    case "BLOB_DELETE_OLD":
      return event.oldObjectId;
    case "DB_SNAPSHOT":
    case "BLOB_SNAPSHOT":
      return null;
  }
}

/**
 * Build the positioned timeline model for one scenario + search result.
 * `replayStep` is the number of displayed events already applied (0..N);
 * events before it are "done", the event at that index is "current",
 * later events are "future". Positions are evenly spaced by display index
 * inside an inset band, so the first/last chips never clip at the lane
 * edges: x = 8 + (index + 0.5) / N * 84, i.e. centres run from
 * 8 + 42/N % to 92 - 42/N %.
 */
export function buildTimelineModel(
  scenario: Scenario,
  result: SearchResult,
  replayStep: number,
): TimelineModel {
  const sequence = buildDisplaySequence(scenario, result);
  const total = sequence.events.length;
  const clampedStep = Math.max(0, Math.min(replayStep, total));
  const items: TimelineEventItem[] = sequence.events.map((event, index) => {
    const replayState: ReplayState =
      index < clampedStep ? "done" : index === clampedStep ? "current" : "future";
    return {
      index,
      eventId: event.eventId,
      kind: event.kind,
      lane: laneForEventKind(event.kind),
      xPercent: total === 0 ? 50 : 8 + ((index + 0.5) / total) * 84,
      isSnapshot: isSnapshotEventId(event.eventId),
      isCounterexample: sequence.isCounterexample,
      replayState,
      labelZh: EVENT_KIND_LABELS[event.kind],
      detail: eventDetail(event),
      fileId: eventFileId(event),
      objectId: eventObjectId(event),
    };
  });
  const snapshotMarkers: SnapshotMarkerModel[] = items
    .filter((item) => item.isSnapshot)
    .map((item) => ({
      eventId: item.eventId,
      kind: item.eventId === DB_SNAPSHOT_EVENT_ID ? "DB_SNAPSHOT" : "BLOB_SNAPSHOT",
      lane: item.lane,
      xPercent: item.xPercent,
      labelZh: EVENT_KIND_LABELS[item.kind],
    }));
  return {
    sequence,
    items,
    databaseItems: items.filter((item) => item.lane === "database"),
    blobItems: items.filter((item) => item.lane === "blob"),
    snapshotMarkers,
    totalEvents: totalAtomicEventCount(scenario),
  };
}

// ---------------------------------------------------------------------------
// Diagnostics — visual markers (PROJECT_BOOK.md §5.3: dangling red,
// orphan yellow) and Chinese explanations (§4.4)
// ---------------------------------------------------------------------------

/** Visual class of a diagnostic: how the timeline must distinguish it. */
export type InconsistencyKind = "orphan" | "dangling" | "mismatch" | "other";

/** One diagnostic rendered as a visual marker + Chinese explanation. */
export interface DiagnosticMarker {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  fileId?: string;
  objectId?: string;
  message: string;
  explanationZh: string;
  kind: InconsistencyKind;
  /** Marker colour (hex). Red for dangling, amber for orphan (§5.3). */
  color: string;
  /** Short Chinese label shown next to the marker. */
  labelZh: string;
}

export const DIAGNOSTIC_EXPLANATIONS: Readonly<Record<DiagnosticCode, string>> = {
  DANGLING_REFERENCE:
    "悬空引用：数据库记录指向的对象版本在 Blob 快照中不存在，可能导致应用出现损坏记录或无法访问的文件。",
  ORPHAN_BLOB:
    "孤立对象：Blob 快照中存在数据库未引用的对象版本，可能是可重新导入或清理的残留数据，不等于必然丢失用户数据。",
  GENERATION_MISMATCH:
    "版本不一致：数据库引用的对象版本与 Blob 快照中的版本不一致。",
  DIGEST_MISMATCH:
    "摘要不一致：Blob 快照中对象的内容摘要与数据库记录不一致。",
  IN_FLIGHT_OPERATION:
    "在途操作：快照捕获时有逻辑操作尚未完成，该状态不是完整操作边界。",
  NO_COMMON_BOUNDARY:
    "无共同边界：两份快照无法同时对应某一个完整操作边界。",
} as const;

export const DIAGNOSTIC_LABELS: Readonly<Record<DiagnosticCode, string>> = {
  DANGLING_REFERENCE: "悬空引用",
  ORPHAN_BLOB: "孤立对象",
  GENERATION_MISMATCH: "版本不一致",
  DIGEST_MISMATCH: "摘要不一致",
  IN_FLIGHT_OPERATION: "在途操作",
  NO_COMMON_BOUNDARY: "无共同边界",
} as const;

/** Marker colour per diagnostic code (PROJECT_BOOK.md §5.3). */
export const DIAGNOSTIC_COLORS: Readonly<Record<DiagnosticCode, string>> = {
  DANGLING_REFERENCE: "#dc2626",
  ORPHAN_BLOB: "#d97706",
  GENERATION_MISMATCH: "#dc2626",
  DIGEST_MISMATCH: "#dc2626",
  IN_FLIGHT_OPERATION: "#475569",
  NO_COMMON_BOUNDARY: "#dc2626",
} as const;

function inconsistencyKindFor(code: DiagnosticCode): InconsistencyKind {
  switch (code) {
    case "ORPHAN_BLOB":
      return "orphan";
    case "DANGLING_REFERENCE":
      return "dangling";
    case "GENERATION_MISMATCH":
    case "DIGEST_MISMATCH":
      return "mismatch";
    default:
      return "other";
  }
}

/** Convert a SearchResult's diagnostics into visual markers. */
export function diagnosticMarkers(result: SearchResult): readonly DiagnosticMarker[] {
  return result.diagnostics.map((diagnostic: Diagnostic): DiagnosticMarker => {
    const marker: DiagnosticMarker = {
      code: diagnostic.code,
      severity: diagnostic.severity,
      message: diagnostic.message,
      explanationZh: DIAGNOSTIC_EXPLANATIONS[diagnostic.code],
      kind: inconsistencyKindFor(diagnostic.code),
      color: DIAGNOSTIC_COLORS[diagnostic.code],
      labelZh: DIAGNOSTIC_LABELS[diagnostic.code],
    };
    if (diagnostic.fileId !== undefined) {
      marker.fileId = diagnostic.fileId;
    }
    if (diagnostic.objectId !== undefined) {
      marker.objectId = diagnostic.objectId;
    }
    return marker;
  });
}

// ---------------------------------------------------------------------------
// Snapshot diff — database snapshot vs Blob snapshot, row by row
// ---------------------------------------------------------------------------

export type SnapshotDiffStatus = "一致" | "悬空引用" | "孤立对象" | "摘要不一致";
export type SnapshotDiffKind = "ok" | "dangling" | "orphan" | "mismatch";

export interface SnapshotDiffRow {
  key: string;
  fileId: string | null;
  objectId: string | null;
  inDatabase: boolean;
  inBlob: boolean;
  digestMatches: boolean | null;
  status: SnapshotDiffStatus;
  kind: SnapshotDiffKind;
  /** Diagnostic codes attached to this row (verbatim, §4.4). */
  codes: readonly DiagnosticCode[];
}

/**
 * Compare the two captured snapshots row by row. A database reference
 * whose object version the Blob snapshot does not hold is a dangling
 * reference (red); a Blob version no database record references is an
 * orphan Blob (amber); a held version with a different digest is a digest
 * mismatch. Diagnostics from the result are attached to their rows by
 * fileId / objectId so the inspector can show code + row together.
 */
export function snapshotDiff(result: SearchResult): readonly SnapshotDiffRow[] {
  const database: DatabaseState = result.databaseSnapshot;
  const blob: BlobState = result.blobSnapshot;
  const referencedKeys = new Set<string>();
  for (const ref of Object.values(database)) {
    referencedKeys.add(blobVersionKey(ref.objectId, ref.generation));
  }
  const codesFor = (fileId: string | null, objectId: string | null): DiagnosticCode[] => {
    const codes: DiagnosticCode[] = [];
    for (const diagnostic of result.diagnostics) {
      if (
        (fileId !== null && diagnostic.fileId === fileId) ||
        (objectId !== null && diagnostic.objectId === objectId)
      ) {
        codes.push(diagnostic.code);
      }
    }
    return codes;
  };
  const rows: SnapshotDiffRow[] = [];
  for (const [fileId, ref] of Object.entries(database)) {
    const key = blobVersionKey(ref.objectId, ref.generation);
    const heldDigest = blob[key];
    if (heldDigest === undefined) {
      rows.push({
        key: `${fileId} → ${key}`,
        fileId,
        objectId: ref.objectId,
        inDatabase: true,
        inBlob: false,
        digestMatches: null,
        status: "悬空引用",
        kind: "dangling",
        codes: codesFor(fileId, ref.objectId),
      });
    } else if (heldDigest !== ref.digest) {
      rows.push({
        key: `${fileId} → ${key}`,
        fileId,
        objectId: ref.objectId,
        inDatabase: true,
        inBlob: true,
        digestMatches: false,
        status: "摘要不一致",
        kind: "mismatch",
        codes: codesFor(fileId, ref.objectId),
      });
    } else {
      rows.push({
        key: `${fileId} → ${key}`,
        fileId,
        objectId: ref.objectId,
        inDatabase: true,
        inBlob: true,
        digestMatches: true,
        status: "一致",
        kind: "ok",
        codes: codesFor(fileId, ref.objectId),
      });
    }
  }
  for (const key of Object.keys(blob)) {
    if (referencedKeys.has(key)) {
      continue;
    }
    const at = key.lastIndexOf("@");
    const objectId = at >= 0 ? key.slice(0, at) : key;
    rows.push({
      key,
      fileId: null,
      objectId,
      inDatabase: false,
      inBlob: true,
      digestMatches: null,
      status: "孤立对象",
      kind: "orphan",
      codes: codesFor(null, objectId),
    });
  }
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return rows;
}
