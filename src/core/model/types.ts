/**
 * SnapFence (P030) — core model types. FROZEN by T001.
 *
 * Authority: PROJECT_BOOK.md §3 (state components, operations, strategies),
 * §4 (boundaries, invariants, diagnostic codes, verdicts), §8 (data structures
 * and interface contract), §9.1 (scenario samples). SPEC_VERSION 1.0.1
 * (ADR-001: Scenario.snapshotsAfter added; see MODEL_CONTRACT.md I-06).
 *
 * Rules for this file:
 * - Every field has an explicit type; `any` is forbidden (checked by grep).
 * - Field names and literal values match PROJECT_BOOK.md §8 exactly.
 * - Types that §9.1 of IMPLEMENTATION_PLAN.md references but PROJECT_BOOK.md
 *   §8 does not spell out (ValidationResult, ConsistencyResult, SearchTrace,
 *   Counterexample, OperationBoundary) are defined here as T001 additions and
 *   are marked as such; their shapes are frozen by this file, not by the book.
 * - All data is synthetic; there are no I/O, network, or date/time fields.
 */

// ---------------------------------------------------------------------------
// §3.1 / §4.1 — the two state components
// ---------------------------------------------------------------------------

/**
 * One database record's reference to a Blob object version.
 * PROJECT_BOOK.md §3.1 component A: fileId -> BlobReference.
 */
export interface BlobReference {
  /** Identifier of the Blob object version this record points at. */
  objectId: string;
  /** Generation (version number) of the referenced object. */
  generation: number;
  /** Content digest of the referenced object version, as recorded in the DB. */
  digest: string;
}

/**
 * Database state: fileId -> BlobReference.
 * PROJECT_BOOK.md §3.1: "fileId -> BlobReference, 其中 BlobReference 包含
 * objectId、generation、digest". Independently expressible from BlobState.
 */
export type DatabaseState = Readonly<Record<string, BlobReference>>;

/**
 * Composite key of one Blob object version: "<objectId>@<generation>".
 * The "@" separator is part of the frozen key format; objectIds in synthetic
 * fixtures must not contain "@". Use {@link blobVersionKey} to build keys so
 * the format stays in exactly one place.
 */
export type BlobVersionKey = `${string}@${number}`;

/** Build the frozen composite key for one (objectId, generation) pair. */
export function blobVersionKey(objectId: string, generation: number): BlobVersionKey {
  return `${objectId}@${generation}`;
}

/**
 * Blob state: (objectId, generation) -> digest.
 * PROJECT_BOOK.md §3.1 component B: "objectId + generation -> digest".
 * Independently expressible from DatabaseState. MVP assumes each file record
 * references an independent object version: no shared Blobs, no cross-file
 * deduplication, no object reference counting (§3.1).
 */
export type BlobState = Readonly<Record<BlobVersionKey, string>>;

// ---------------------------------------------------------------------------
// §3.2 / §8.3 — logical operations
// ---------------------------------------------------------------------------

/** Kind of a logical operation. Exactly the three kinds in §3.2. */
export type LogicalOperationKind = "UPLOAD" | "DELETE" | "UPDATE";

/**
 * UPLOAD — §3.2 template: BLOB_PUT -> DB_LINK.
 * Sample (§9.1): { opId, kind: "UPLOAD", fileId, objectId, digest }.
 * The new object version is created at generation 1 (see MODEL_CONTRACT.md,
 * frozen derivation rule R-GEN-1).
 */
export interface UploadOperation {
  opId: string;
  kind: "UPLOAD";
  fileId: string;
  /** Identifier of the newly written object version. */
  objectId: string;
  /** Content digest of the newly written object version. */
  digest: string;
}

/**
 * DELETE — §3.2 template: DB_UNLINK -> BLOB_DELETE.
 * Sample (§9.3): { opId, kind: "DELETE", fileId, objectId } (no digest).
 * The deleted record is an implied pre-existing record: before the operation
 * the file exists in both the database and Blob state at generation 1
 * (see MODEL_CONTRACT.md, frozen interpretation I-02). `digest`, when given,
 * pins that pre-existing record's digest; when omitted it is derived
 * deterministically by the event state machine (T002).
 */
export interface DeleteOperation {
  opId: string;
  kind: "DELETE";
  fileId: string;
  /** Identifier of the object version to delete. */
  objectId: string;
  /** Digest of the pre-existing record; optional, see I-02. */
  digest?: string;
}

/**
 * UPDATE — §3.2 template: BLOB_PUT_NEW -> DB_REPOINT -> BLOB_DELETE_OLD.
 * The old record is an implied pre-existing record at generation 1
 * (see MODEL_CONTRACT.md, I-02); the new version is created at
 * old generation + 1 (R-GEN-2). `oldDigest`, when given, pins the
 * pre-existing old record's digest; when omitted it is derived
 * deterministically by the event state machine (T002).
 */
export interface UpdateOperation {
  opId: string;
  kind: "UPDATE";
  fileId: string;
  /** Identifier of the newly written object version. */
  objectId: string;
  /** Identifier of the old object version to delete after the repoint. */
  oldObjectId: string;
  /** Content digest of the newly written object version. */
  digest: string;
  /** Digest of the pre-existing old record; optional, see I-02. */
  oldDigest?: string;
}

/** A logical operation: exactly one of the three §3.2 templates. */
export type LogicalOperation = UploadOperation | DeleteOperation | UpdateOperation;

// ---------------------------------------------------------------------------
// §3.3 / §8.2 — backup strategies
// ---------------------------------------------------------------------------

/**
 * Backup strategy. PROJECT_BOOK.md §8.2, verbatim:
 * - "DB_FIRST": DB_SNAPSHOT < BLOB_SNAPSHOT; writes may continue between them.
 * - "FILE_FIRST": BLOB_SNAPSHOT < DB_SNAPSHOT; writes may continue between them.
 * - "PAUSE_WRITES": all started operations must finish first; no data-modifying
 *   event may occur between the two snapshots; writes resume only after both
 *   snapshots. If these conditions cannot be proven, the strategy must not be
 *   judged safe (§3.3).
 */
export type BackupStrategy = "DB_FIRST" | "FILE_FIRST" | "PAUSE_WRITES";

// ---------------------------------------------------------------------------
// §8.1 — scenario
// ---------------------------------------------------------------------------

/**
 * Scenario. PROJECT_BOOK.md §8.1, verbatim fields, plus the ADR-001
 * optional field `snapshotsAfter` (SPEC_VERSION 1.0.1).
 * `maxEvents` counts atomic events including the two snapshot events
 * (PROJECT_BOOK.md §10.3; G12: 8 modifying events + 2 snapshot events = 10).
 * The scenario carries no initial-state field: pre-existing records implied
 * by DELETE/UPDATE operations are derived per MODEL_CONTRACT.md I-02.
 */
export interface Scenario {
  scenarioId: string;
  strategy: BackupStrategy;
  operations: readonly LogicalOperation[];
  maxEvents: number;
  /**
   * ADR-001 (SPEC_VERSION 1.0.1): opIds that must all be COMPLETED before
   * either snapshot event (DB_SNAPSHOT / BLOB_SNAPSHOT) may execute —
   * "backup runs after the listed operations finish". Absent (or empty)
   * means no placement constraint: snapshots may appear at any legal
   * position (full interleaving, §4.5). Every listed opId must exist in
   * `operations`; otherwise the scenario is INVALID_INPUT (see
   * MODEL_CONTRACT.md I-06). Used by G02–G04 / G06–G08; U01–U12 omit it.
   */
  snapshotsAfter?: string[];
}

// ---------------------------------------------------------------------------
// §4.4 / §8.5 — diagnostics
// ---------------------------------------------------------------------------

/**
 * Diagnostic code. PROJECT_BOOK.md §4.4, verbatim — all six, no others.
 * - DANGLING_REFERENCE: a DB reference points at a missing object (CRITICAL).
 * - ORPHAN_BLOB: the Blob snapshot holds an object no DB record references
 *   (WARNING — an orphan is not necessarily lost user data, §4.4).
 * - GENERATION_MISMATCH: DB-referenced generation differs from Blob (CRITICAL).
 * - DIGEST_MISMATCH: object digest differs from the DB record (CRITICAL).
 * - IN_FLIGHT_OPERATION (ADR-002): explanatory diagnostic for
 *   value-inconsistent pairs only — an operation was in flight when a
 *   snapshot was captured, explaining why the pair straddles that
 *   operation. A value-consistent pair carries no IN_FLIGHT_OPERATION
 *   (WARNING).
 * - NO_COMMON_BOUNDARY: no legal operation boundary matches both snapshots
 *   (CRITICAL).
 */
export type DiagnosticCode =
  | "DANGLING_REFERENCE"
  | "ORPHAN_BLOB"
  | "GENERATION_MISMATCH"
  | "DIGEST_MISMATCH"
  | "IN_FLIGHT_OPERATION"
  | "NO_COMMON_BOUNDARY";

/** Diagnostic severity. PROJECT_BOOK.md §8.5: "CRITICAL" | "WARNING". */
export type DiagnosticSeverity = "CRITICAL" | "WARNING";

/**
 * Diagnostic. PROJECT_BOOK.md §8.5, verbatim fields.
 * `fileId` / `objectId` identify the affected record/object when applicable.
 */
export interface Diagnostic {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  fileId?: string;
  objectId?: string;
  message: string;
}

// ---------------------------------------------------------------------------
// §4.7 / §8.4 — search verdict and result
// ---------------------------------------------------------------------------

/**
 * Search verdict. PROJECT_BOOK.md §4.7, verbatim — all four, no others.
 * - SAFE_WITHIN_BOUND: every legal path satisfies snapshot consistency.
 *   Bounded only: it does NOT mean the real production system is safe (§4.7).
 * - UNSAFE_WITHIN_BOUND: at least one inconsistent path exists; a
 *   counterexample is produced.
 * - INCONCLUSIVE_LIMIT: the input exceeds the supported bounded search size.
 * - INVALID_INPUT: the event DAG, operation dependencies, or strategy input
 *   is illegal.
 */
export type SearchVerdict =
  | "SAFE_WITHIN_BOUND"
  | "UNSAFE_WITHIN_BOUND"
  | "INCONCLUSIVE_LIMIT"
  | "INVALID_INPUT";

/**
 * Search result. PROJECT_BOOK.md §8.4, verbatim fields.
 * `schemaVersion` is the fixed literal "snapfence.report/v1".
 * `counterexample` is the shortest counterexample as an ordered list of
 * event IDs (§4.6); empty when the verdict is SAFE_WITHIN_BOUND.
 * `counterexampleLength` equals `counterexample.length` (0 when none).
 */
export interface SearchResult {
  schemaVersion: "snapfence.report/v1";
  scenarioId: string;
  strategy: BackupStrategy;
  verdict: SearchVerdict;
  eventCount: number;
  counterexample: readonly string[];
  counterexampleLength: number;
  diagnostics: readonly Diagnostic[];
  databaseSnapshot: DatabaseState;
  blobSnapshot: BlobState;
  assumptions: readonly string[];
  limitations: readonly string[];
}

// ---------------------------------------------------------------------------
// §4.1 / §4.2 — system state and operation boundaries
// ---------------------------------------------------------------------------

/** Completion status of one logical operation inside a system state. */
export type OperationStatus = "NOT_STARTED" | "IN_FLIGHT" | "COMPLETED";

/**
 * System state S = (D, B, Q). PROJECT_BOOK.md §4.1:
 * D = database reference map, B = Blob object map,
 * Q = completion status of each logical operation.
 */
export interface SystemState {
  database: DatabaseState;
  blob: BlobState;
  operationStatus: Readonly<Record<string, OperationStatus>>;
}

/**
 * One legal operation boundary (T001 addition — frozen shape).
 * PROJECT_BOOK.md §4.2: a state is a legal boundary only when every logical
 * operation is either not started or fully completed; any partially completed
 * operation makes the state in-flight, never a boundary.
 * `boundaryIndex` is the ordinal of the boundary in execution order, starting
 * at 0 for the initial state.
 */
export interface OperationBoundary {
  boundaryIndex: number;
  databaseState: DatabaseState;
  blobState: BlobState;
  completedOperationIds: readonly string[];
  notStartedOperationIds: readonly string[];
}

// ---------------------------------------------------------------------------
// §9.1 (IMPLEMENTATION_PLAN.md) — supporting result types
// These types are referenced by the frozen §9.1 interface signatures but are
// not spelled out in PROJECT_BOOK.md §8; their shapes are frozen here by T001.
// ---------------------------------------------------------------------------

/**
 * Validation issue code (T001 addition). Derived from the §8.6 constraints:
 * explicit IDs, legal DAG, no cycles, no reference to a nonexistent object
 * version, no duplicate event ID, no exceeding the bounded event count, and
 * no silently ignored invalid input.
 */
export type ValidationIssueCode =
  | "DUPLICATE_EVENT_ID"
  | "DUPLICATE_OPERATION_ID"
  | "CYCLE_IN_DAG"
  | "UNKNOWN_OBJECT_VERSION"
  | "MAX_EVENTS_EXCEEDED"
  | "INVALID_STRATEGY"
  | "INVALID_OPERATION_KIND"
  | "MISSING_REQUIRED_FIELD"
  | "EMPTY_SCENARIO_ID";

/** One validation issue found by validateScenario. */
export interface ValidationIssue {
  code: ValidationIssueCode;
  message: string;
  /** Operation / event / field the issue refers to, when applicable. */
  subjectId?: string;
}

/**
 * Result of validateScenario (T001 addition — frozen shape).
 * `valid` is true exactly when `issues` is empty.
 */
export interface ValidationResult {
  valid: boolean;
  issues: readonly ValidationIssue[];
}

/**
 * Result of checkConsistency (T001 addition — frozen shape).
 * `consistent` is true exactly when the two snapshots correspond to one
 * common legal operation boundary (§4.3). `matchedBoundaryIndex` is the
 * boundaryIndex of that boundary, or null when none matches.
 */
export interface ConsistencyResult {
  consistent: boolean;
  matchedBoundaryIndex: number | null;
  diagnostics: readonly Diagnostic[];
}

/** One step of a search trace: the state before and after one event. */
export interface SearchTraceStep {
  stepIndex: number;
  eventId: string;
  databaseStateBefore: DatabaseState;
  blobStateBefore: BlobState;
  databaseStateAfter: DatabaseState;
  blobStateAfter: BlobState;
  completedOperationIds: readonly string[];
}

/**
 * A full search trace (T001 addition — frozen shape): the ordered event
 * sequence of one explored path, with the state before/after every event.
 * BFS must produce deterministic traces: same input, same trace (§4.5/§4.6).
 */
export interface SearchTrace {
  scenarioId: string;
  strategy: BackupStrategy;
  steps: readonly SearchTraceStep[];
}

/**
 * Shortest counterexample (T001 addition — frozen shape).
 * PROJECT_BOOK.md §4.6 output contents: counterexample event order; each
 * event's input state; each event's output state; database snapshot content;
 * Blob snapshot content; diagnostic type(s); first operation that caused the
 * integrity failure; counterexample length. `length` equals
 * `eventIds.length`; the trace carries the per-event before/after states.
 */
export interface Counterexample {
  eventIds: readonly string[];
  length: number;
  diagnostics: readonly Diagnostic[];
  databaseSnapshot: DatabaseState;
  blobSnapshot: BlobState;
  firstFailingOperationId: string | null;
  trace: SearchTrace;
}
