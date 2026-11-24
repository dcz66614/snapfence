/**
 * SnapFence (P030) — scenario / event-list validation. T002.
 *
 * Authority: PROJECT_BOOK.md §8.6 (explicit IDs, legal DAG, no cycles, no
 * reference to a nonexistent object version, no duplicate event ID, within
 * the bounded event count, no silently ignored invalid input), §10.3
 * (10-event bound incl. snapshots), §3.3 (strategy snapshot order).
 * Implements the frozen `ValidateScenario` type from
 * src/core/model/contracts.ts: `validateScenario(scenario): ValidationResult`.
 * Inputs (frozen, read-only): src/core/model/types.ts (ValidationResult,
 * ValidationIssue, ValidationIssueCode), scenario.ts (MAX_EVENTS,
 * totalAtomicEventCount); event-types.ts and dependency-graph.ts (this task).
 *
 * Rules for this file:
 * - TypeScript strict mode; `any` is forbidden.
 * - Fail-closed: any illegal input yields `valid: false` with at least one
 *   issue; invalid input is reported, never silently ignored or repaired.
 * - All functions are pure and deterministic.
 * - `validateScenario` never throws: structurally unusable input is reported
 *   as issues instead of crashing the caller.
 */

import type {
  LogicalOperation,
  Scenario,
  ValidationIssue,
  ValidationIssueCode,
  ValidationResult,
} from "../model/types";
import {
  MAX_EVENTS,
  totalAtomicEventCount,
} from "../model/scenario";
import {
  deriveImpliedDigest,
  expandOperation,
  expandScenario,
  type LiveFileRecord,
  type SnapFenceEvent,
} from "./event-types";
import {
  buildDependencyGraph,
  detectCycle,
  type DependencyEdge,
  type DependencyGraph,
} from "./dependency-graph";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function issue(
  code: ValidationIssueCode,
  message: string,
  subjectId?: string,
): ValidationIssue {
  return subjectId === undefined ? { code, message } : { code, message, subjectId };
}

function invalid(issues: readonly ValidationIssue[]): ValidationResult {
  return { valid: false, issues };
}

const STRATEGIES: readonly string[] = ["DB_FIRST", "FILE_FIRST", "PAUSE_WRITES"];
const OPERATION_KINDS: readonly string[] = ["UPLOAD", "DELETE", "UPDATE"];

// ---------------------------------------------------------------------------
// validateScenario — the frozen §9.1 interface (contracts.ts ValidateScenario)
// ---------------------------------------------------------------------------

/**
 * Validate a scenario against the §8.6 constraints. Returns `valid: true`
 * exactly when no issue was found. Checks, in order:
 * 1. scenarioId non-empty; strategy one of the three literals.
 * 2. Every operation structurally usable (object, known kind, all required
 *    fields present and non-empty). Unusable operations are reported and
 *    validation stops here — expansion cannot run safely on them.
 * 3. Duplicate operation IDs.
 * 4. Duplicate event IDs (from scenario expansion).
 * 5. Event count: total atomic events (incl. the 2 snapshot events) within
 *    MAX_EVENTS = 10, and the scenario's own `maxEvents` consistent with it.
 * 6. Unknown / conflicting object-version references, walking operations in
 *    scenario order with per-file live-record tracking.
 * 7. Dependency DAG legality: no cycle, no edge to an unknown event.
 */
export function validateScenario(scenario: Scenario): ValidationResult {
  if (typeof scenario !== "object" || scenario === null) {
    return invalid([
      issue("MISSING_REQUIRED_FIELD", "Scenario must be an object with scenarioId, strategy, operations, and maxEvents."),
    ]);
  }

  const issues: ValidationIssue[] = [];

  if (!isNonEmptyString(scenario.scenarioId)) {
    issues.push(issue("EMPTY_SCENARIO_ID", "scenarioId must be a non-empty string."));
  }
  if (!STRATEGIES.includes(scenario.strategy as string)) {
    issues.push(
      issue(
        "INVALID_STRATEGY",
        `strategy must be one of DB_FIRST, FILE_FIRST, PAUSE_WRITES; got ${JSON.stringify(scenario.strategy)}.`,
      ),
    );
    // The strategy drives the dependency graph's snapshot-order edge; with
    // an unknown strategy no further check can run safely. Fail closed here.
    return invalid(issues);
  }

  if (!Array.isArray(scenario.operations)) {
    issues.push(issue("MISSING_REQUIRED_FIELD", "operations must be an array of logical operations."));
    return invalid(issues);
  }

  // Structural pass — expansion below requires usable operations.
  const structuralIssues: ValidationIssue[] = [];
  for (let i = 0; i < scenario.operations.length; i++) {
    const operation = scenario.operations[i] as unknown;
    const subject = `operations[${i}]`;
    if (typeof operation !== "object" || operation === null) {
      structuralIssues.push(issue("MISSING_REQUIRED_FIELD", `Operation at ${subject} must be an object.`, subject));
      continue;
    }
    const op = operation as Record<string, unknown>;
    if (!isNonEmptyString(op["opId"])) {
      structuralIssues.push(issue("MISSING_REQUIRED_FIELD", `Operation at ${subject} is missing a non-empty opId.`, subject));
    }
    if (typeof op["kind"] !== "string" || !OPERATION_KINDS.includes(op["kind"])) {
      structuralIssues.push(
        issue(
          "INVALID_OPERATION_KIND",
          `Operation at ${subject} has unknown kind ${JSON.stringify(op["kind"])}; expected UPLOAD, DELETE, or UPDATE.`,
          typeof op["opId"] === "string" ? op["opId"] : subject,
        ),
      );
    }
    if (!isNonEmptyString(op["fileId"])) {
      structuralIssues.push(issue("MISSING_REQUIRED_FIELD", `Operation at ${subject} is missing a non-empty fileId.`, subject));
    }
    if (!isNonEmptyString(op["objectId"])) {
      structuralIssues.push(issue("MISSING_REQUIRED_FIELD", `Operation at ${subject} is missing a non-empty objectId.`, subject));
    }
    if (op["kind"] === "UPLOAD" || op["kind"] === "UPDATE") {
      if (!isNonEmptyString(op["digest"])) {
        structuralIssues.push(issue("MISSING_REQUIRED_FIELD", `Operation at ${subject} (${String(op["kind"])}) is missing a non-empty digest.`, subject));
      }
    }
    if (op["kind"] === "UPDATE" && !isNonEmptyString(op["oldObjectId"])) {
      structuralIssues.push(issue("MISSING_REQUIRED_FIELD", `Operation at ${subject} (UPDATE) is missing a non-empty oldObjectId.`, subject));
    }
    if (op["kind"] === "DELETE" && op["digest"] !== undefined && !isNonEmptyString(op["digest"])) {
      structuralIssues.push(issue("MISSING_REQUIRED_FIELD", `Operation at ${subject} (DELETE) has an empty digest.`, subject));
    }
    if (op["kind"] === "UPDATE" && op["oldDigest"] !== undefined && !isNonEmptyString(op["oldDigest"])) {
      structuralIssues.push(issue("MISSING_REQUIRED_FIELD", `Operation at ${subject} (UPDATE) has an empty oldDigest.`, subject));
    }
  }
  if (structuralIssues.length > 0) {
    return invalid([...issues, ...structuralIssues]);
  }

  const operations = scenario.operations as readonly LogicalOperation[];

  // Duplicate operation IDs.
  const seenOpIds = new Set<string>();
  for (const operation of operations) {
    if (seenOpIds.has(operation.opId)) {
      issues.push(
        issue("DUPLICATE_OPERATION_ID", `Operation id ${operation.opId} is used more than once.`, operation.opId),
      );
    } else {
      seenOpIds.add(operation.opId);
    }
  }

  // ADR-001 (SPEC_VERSION 1.0.1): every snapshotsAfter entry must name an
  // operation present in this scenario. Reuses UNKNOWN_OBJECT_VERSION —
  // the existing code for references to things that do not exist (§8.6) —
  // so runSearch maps the failure to INVALID_INPUT.
  issues.push(...checkSnapshotsAfter(scenario.snapshotsAfter, seenOpIds));

  // Duplicate event IDs (from expansion).
  const expansion = expandScenario(scenario);
  const seenEventIds = new Set<string>();
  for (const event of expansion.allEvents) {
    if (seenEventIds.has(event.eventId)) {
      issues.push(
        issue("DUPLICATE_EVENT_ID", `Event id ${event.eventId} is used more than once.`, event.eventId),
      );
    } else {
      seenEventIds.add(event.eventId);
    }
  }

  // Event-count bound (§10.3: bound includes the two snapshot events).
  const totalEvents = totalAtomicEventCount(scenario);
  if (totalEvents > MAX_EVENTS) {
    issues.push(
      issue(
        "MAX_EVENTS_EXCEEDED",
        `Scenario has ${totalEvents} atomic events (including the 2 snapshot events), exceeding the bound of ${MAX_EVENTS}.`,
        scenario.scenarioId,
      ),
    );
  }
  if (typeof scenario.maxEvents !== "number" || !Number.isInteger(scenario.maxEvents) || scenario.maxEvents <= 0) {
    issues.push(
      issue("MAX_EVENTS_EXCEEDED", `maxEvents must be a positive integer; got ${JSON.stringify(scenario.maxEvents)}.`, scenario.scenarioId),
    );
  } else {
    if (scenario.maxEvents > MAX_EVENTS) {
      issues.push(
        issue(
          "MAX_EVENTS_EXCEEDED",
          `maxEvents ${scenario.maxEvents} exceeds the supported bound of ${MAX_EVENTS}.`,
          scenario.scenarioId,
        ),
      );
    }
    if (scenario.maxEvents < totalEvents) {
      issues.push(
        issue(
          "MAX_EVENTS_EXCEEDED",
          `maxEvents ${scenario.maxEvents} is smaller than the ${totalEvents} atomic events the scenario needs (including the 2 snapshot events).`,
          scenario.scenarioId,
        ),
      );
    }
  }

  // Unknown / conflicting object-version references, in scenario order.
  issues.push(...checkObjectReferences(operations));

  // Dependency DAG legality.
  issues.push(...validateEventGraph(buildDependencyGraph(scenario)));

  return { valid: issues.length === 0, issues };
}

/**
 * ADR-001 (SPEC_VERSION 1.0.1): validate the optional `snapshotsAfter`
 * placement list. Absent or empty means no constraint. A non-array value
 * (only reachable from untyped callers) is a structural error; every entry
 * must be a non-empty string naming an operation in the scenario. Unknown
 * entries are reported once each, with the existing unknown-reference code
 * UNKNOWN_OBJECT_VERSION. Duplicate entries of a known opId are harmless
 * (the constraint is a set) and are not reported.
 */
function checkSnapshotsAfter(
  snapshotsAfter: unknown,
  knownOperationIds: ReadonlySet<string>,
): readonly ValidationIssue[] {
  if (snapshotsAfter === undefined) {
    return [];
  }
  if (!Array.isArray(snapshotsAfter)) {
    return [
      issue(
        "MISSING_REQUIRED_FIELD",
        "snapshotsAfter must be an array of operation ids when present.",
      ),
    ];
  }
  const issues: ValidationIssue[] = [];
  const reported = new Set<string>();
  for (const entry of snapshotsAfter as readonly unknown[]) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      const label = JSON.stringify(entry);
      if (!reported.has(label)) {
        reported.add(label);
        issues.push(
          issue(
            "UNKNOWN_OBJECT_VERSION",
            `snapshotsAfter lists ${label}, which is not a valid operation id; listed opIds must exist in operations (ADR-001).`,
          ),
        );
      }
      continue;
    }
    if (!knownOperationIds.has(entry)) {
      if (!reported.has(entry)) {
        reported.add(entry);
        issues.push(
          issue(
            "UNKNOWN_OBJECT_VERSION",
            `snapshotsAfter lists unknown operation id "${entry}", which is not present in operations; listed opIds must exist (ADR-001).`,
            entry,
          ),
        );
      }
    }
  }
  return issues;
}

/**
 * Walk operations in scenario order tracking each file's live record, and
 * report references to object versions that cannot exist:
 * - DELETE / UPDATE on a file already deleted by an earlier operation, with
 *   no intervening UPLOAD (the old version is gone);
 * - DELETE / UPDATE whose old objectId disagrees with the live record's
 *   objectId (the operation targets a version the file does not hold);
 * - UPLOAD of a file that already holds a live record (the file already
 *   exists; the upload's DB_LINK could never apply).
 * A first DELETE / UPDATE on a never-seen file is legal: it implies the
 * pre-existing record (I-02).
 */
function checkObjectReferences(
  operations: readonly LogicalOperation[],
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const liveRecords = new Map<string, LiveFileRecord>();
  const deletedFiles = new Set<string>();

  for (const operation of operations) {
    const liveBefore: LiveFileRecord | null = liveRecords.get(operation.fileId) ?? null;
    if (operation.kind === "UPLOAD") {
      if (liveBefore !== null) {
        issues.push(
          issue(
            "UNKNOWN_OBJECT_VERSION",
            `UPLOAD ${operation.opId} targets file ${operation.fileId}, which already holds ` +
              `live version ${liveBefore.objectId}@${liveBefore.generation}; an upload cannot ` +
              `create a second live record for the same file.`,
            operation.opId,
          ),
        );
      }
      const { liveAfter } = expandOperation(operation, liveBefore);
      if (liveAfter !== null) {
        liveRecords.set(operation.fileId, liveAfter);
      }
      deletedFiles.delete(operation.fileId);
      continue;
    }
    if (operation.kind === "DELETE") {
      if (liveBefore === null && deletedFiles.has(operation.fileId)) {
        issues.push(
          issue(
            "UNKNOWN_OBJECT_VERSION",
            `DELETE ${operation.opId} targets file ${operation.fileId}, which was already ` +
              `deleted by an earlier operation in this scenario; the referenced version no longer exists.`,
            operation.opId,
          ),
        );
      } else if (liveBefore !== null && liveBefore.objectId !== operation.objectId) {
        issues.push(
          issue(
            "UNKNOWN_OBJECT_VERSION",
            `DELETE ${operation.opId} targets ${operation.objectId} but file ${operation.fileId} ` +
              `holds live version ${liveBefore.objectId}@${liveBefore.generation}.`,
            operation.opId,
          ),
        );
      }
      liveRecords.delete(operation.fileId);
      deletedFiles.add(operation.fileId);
      continue;
    }
    // UPDATE
    if (liveBefore === null && deletedFiles.has(operation.fileId)) {
      issues.push(
        issue(
          "UNKNOWN_OBJECT_VERSION",
          `UPDATE ${operation.opId} targets file ${operation.fileId}, which was already ` +
            `deleted by an earlier operation in this scenario; the old version no longer exists.`,
          operation.opId,
        ),
      );
    } else if (liveBefore !== null && liveBefore.objectId !== operation.oldObjectId) {
      issues.push(
        issue(
          "UNKNOWN_OBJECT_VERSION",
          `UPDATE ${operation.opId} targets old version ${operation.oldObjectId} but file ` +
            `${operation.fileId} holds live version ${liveBefore.objectId}@${liveBefore.generation}.`,
          operation.opId,
        ),
      );
    }
    const { liveAfter } = expandOperation(operation, liveBefore);
    if (liveAfter !== null) {
      liveRecords.set(operation.fileId, liveAfter);
    }
    deletedFiles.delete(operation.fileId);
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Dependency-graph validation (frozen ValidationIssue codes)
// ---------------------------------------------------------------------------

/**
 * Validate a dependency graph: report cycles (fail-closed) and edges that
 * reference event IDs absent from the graph. Returns the issues found
 * (empty when the graph is legal).
 */
export function validateEventGraph(graph: DependencyGraph): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const knownIds = new Set<string>(graph.events.map((event) => event.eventId));
  for (const edge of graph.edges) {
    if (!knownIds.has(edge.from)) {
      issues.push(
        issue(
          "UNKNOWN_OBJECT_VERSION",
          `Dependency edge ${edge.from} -> ${edge.to} references unknown event ${edge.from}.`,
          edge.from,
        ),
      );
    }
    if (!knownIds.has(edge.to)) {
      issues.push(
        issue(
          "UNKNOWN_OBJECT_VERSION",
          `Dependency edge ${edge.from} -> ${edge.to} references unknown event ${edge.to}.`,
          edge.to,
        ),
      );
    }
  }
  const cycle = detectCycle(graph);
  if (cycle !== null) {
    issues.push(
      issue(
        "CYCLE_IN_DAG",
        `Event dependency graph contains a cycle: ${cycle.join(" -> ")}. Illegal DAGs fail closed; no execution order exists.`,
        cycle[0],
      ),
    );
  }
  return issues;
}

/**
 * Validate an explicit event list (plus optional edges) as a graph: duplicate
 * event IDs, dangling edges, and cycles are all reported. This is the
 * fail-closed entry point for event lists that do not come from a scenario.
 */
export function validateEvents(
  events: readonly SnapFenceEvent[],
  edges: readonly DependencyEdge[] = [],
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.eventId)) {
      issues.push(
        issue("DUPLICATE_EVENT_ID", `Event id ${event.eventId} is used more than once.`, event.eventId),
      );
    } else {
      seen.add(event.eventId);
    }
  }
  issues.push(...validateEventGraph({ events, edges }));
  return { valid: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Event-sequence validation — a concrete execution order against a scenario
// ---------------------------------------------------------------------------

/** Why a concrete event sequence is illegal. */
export type EventSequenceIssueCode =
  | "UNKNOWN_EVENT"
  | "DUPLICATE_EVENT"
  | "PREREQUISITE_NOT_MET"
  | "STRATEGY_ORDER_VIOLATED"
  | "PAUSE_WRITES_VIOLATED"
  | "SNAPSHOT_PLACEMENT_VIOLATED";

/** One issue found in a concrete event sequence. */
export interface EventSequenceIssue {
  code: EventSequenceIssueCode;
  message: string;
  eventId?: string;
}

/** Result of `validateEventSequence`. */
export interface EventSequenceValidation {
  valid: boolean;
  issues: readonly EventSequenceIssue[];
}

/**
 * Validate a concrete execution order (a list of event IDs) against a
 * scenario: every ID must be a known event, no event may repeat, every
 * event's dependency-graph prerequisites must have executed earlier, the
 * strategy snapshot order must hold, for PAUSE_WRITES no data-modifying
 * event may occur between the two snapshots and no operation may be
 * in-flight when the first snapshot executes, and for snapshotsAfter
 * (ADR-001) no snapshot may execute before every listed operation
 * completes. Partial prefixes are legal:
 * checks only fire for events actually present in the sequence.
 */
export function validateEventSequence(
  scenario: Scenario,
  eventIds: readonly string[],
): EventSequenceValidation {
  const issues: EventSequenceIssue[] = [];
  const expansion = expandScenario(scenario);
  const graph = buildDependencyGraph(scenario);
  const knownEvents = new Map(expansion.allEvents.map((event) => [event.eventId, event]));
  const executed = new Set<string>();
  const appliedPerOp = new Map<string, number>();
  const totalPerOp = new Map<string, number>();
  for (const operation of scenario.operations) {
    totalPerOp.set(operation.opId, expandOperation(operation, null).events.length);
  }
  let firstSnapshotIndex = -1;
  let secondSnapshotIndex = -1;
  const snapshotOrder: string[] = [];

  for (let i = 0; i < eventIds.length; i++) {
    const eventId = eventIds[i];
    if (eventId === undefined) {
      continue;
    }
    const event = knownEvents.get(eventId);
    if (event === undefined) {
      issues.push({
        code: "UNKNOWN_EVENT",
        message: `Event ${eventId} is not part of scenario ${scenario.scenarioId}.`,
        eventId,
      });
      continue;
    }
    if (executed.has(eventId)) {
      issues.push({
        code: "DUPLICATE_EVENT",
        message: `Event ${eventId} is executed more than once in the sequence.`,
        eventId,
      });
      continue;
    }
    for (const prerequisite of graph.edges
      .filter((edge) => edge.to === eventId)
      .map((edge) => edge.from)) {
      if (!executed.has(prerequisite)) {
        issues.push({
          code: "PREREQUISITE_NOT_MET",
          message: `Event ${eventId} executes before its prerequisite ${prerequisite}.`,
          eventId,
        });
      }
    }
    if (event.kind === "DB_SNAPSHOT" || event.kind === "BLOB_SNAPSHOT") {
      // ADR-001 (SPEC_VERSION 1.0.1): snapshotsAfter requires every listed
      // operation to be complete (all of its data events applied) before
      // any snapshot executes. An opId absent from the scenario cannot be
      // proven complete, so it fails closed too. This mirrors the BFS
      // candidate rule (candidateEventIds in bfs.ts) so a concrete sequence
      // and the search enumeration never disagree about placement.
      for (const opId of scenario.snapshotsAfter ?? []) {
        const total = totalPerOp.get(opId);
        const applied = appliedPerOp.get(opId) ?? 0;
        if (total === undefined || applied < total) {
          issues.push({
            code: "SNAPSHOT_PLACEMENT_VIOLATED",
            message:
              `snapshotsAfter requires operation ${opId} to complete before any snapshot; ` +
              `${eventId} executes with ${applied} of ${total ?? 0} events of ${opId} applied.`,
            eventId,
          });
          break;
        }
      }
      if (firstSnapshotIndex === -1) {
        firstSnapshotIndex = i;
        // PAUSE_WRITES: no operation may be in-flight at the first snapshot.
        if (scenario.strategy === "PAUSE_WRITES") {
          for (const [opId, applied] of appliedPerOp) {
            const total = totalPerOp.get(opId) ?? 0;
            if (applied > 0 && applied < total) {
              issues.push({
                code: "PAUSE_WRITES_VIOLATED",
                message:
                  `PAUSE_WRITES requires all started operations to finish before the first ` +
                  `snapshot; operation ${opId} has ${applied} of ${total} events applied ` +
                  `when ${eventId} executes.`,
                eventId,
              });
            }
          }
        }
      } else if (secondSnapshotIndex === -1) {
        secondSnapshotIndex = i;
      }
      snapshotOrder.push(eventId);
    } else {
      // Data-modifying event between the two snapshots breaks PAUSE_WRITES.
      if (scenario.strategy === "PAUSE_WRITES" && firstSnapshotIndex !== -1 && secondSnapshotIndex === -1) {
        issues.push({
          code: "PAUSE_WRITES_VIOLATED",
          message:
            `PAUSE_WRITES forbids data-modifying events between the two snapshots; ` +
            `${eventId} executes after the first snapshot.`,
          eventId,
        });
      }
      if (event.opId !== null) {
        appliedPerOp.set(event.opId, (appliedPerOp.get(event.opId) ?? 0) + 1);
      }
    }
    executed.add(eventId);
  }

  if (snapshotOrder.length === 2) {
    const first = snapshotOrder[0];
    const second = snapshotOrder[1];
    if (scenario.strategy === "DB_FIRST" && !(first === "DB_SNAPSHOT" && second === "BLOB_SNAPSHOT")) {
      issues.push({
        code: "STRATEGY_ORDER_VIOLATED",
        message: `DB_FIRST requires DB_SNAPSHOT before BLOB_SNAPSHOT; got ${first} before ${second}.`,
        eventId: second,
      });
    }
    if (scenario.strategy === "FILE_FIRST" && !(first === "BLOB_SNAPSHOT" && second === "DB_SNAPSHOT")) {
      issues.push({
        code: "STRATEGY_ORDER_VIOLATED",
        message: `FILE_FIRST requires BLOB_SNAPSHOT before DB_SNAPSHOT; got ${first} before ${second}.`,
        eventId: second,
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

// Re-exported for callers that only need the derivation rule (I-02).
export { deriveImpliedDigest };
