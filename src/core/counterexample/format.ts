/**
 * SnapFence (P030) — counterexample formatting. T004.
 *
 * Authority: PROJECT_BOOK.md §4.6 (counterexample output contents:
 * counterexample event order; each event's input state; each event's
 * output state; database snapshot contents; Blob snapshot contents;
 * diagnostic code(s); first operation that caused the integrity failure;
 * counterexample length), §4.4 (diagnostic codes and severities), §8.4
 * (SearchResult schema — the JSON form mirrors its field names where
 * they apply). Inputs (frozen, read-only): T001 model (types.ts:
 * Counterexample, Diagnostic, SearchTraceStep); T004 extract.ts
 * (the Counterexample being formatted).
 *
 * Two renderings are provided, both deterministic (same counterexample →
 * same output, byte for byte):
 * - `formatCounterexampleText`: human-readable multi-line text, for the
 *   result inspector, logs, and review packs.
 * - `formatCounterexampleJson`: machine-readable JSON (2-space indent,
 *   fixed field order, record keys sorted), for export and tooling.
 * Both carry every §4.6 content item; neither drops a diagnostic, a
 * state, or the first failing operation.
 *
 * Rules for this file:
 * - TypeScript strict mode; `any` is forbidden.
 * - Pure deterministic functions only: no randomness, no wall-clock, no
 *   mutation of inputs. Record keys are always emitted sorted.
 */

import type {
  BlobState,
  Counterexample,
  DatabaseState,
  Diagnostic,
  SearchTraceStep,
} from "../model/types";
import { blobVersionKey, type BlobVersionKey } from "../model/types";

// ---------------------------------------------------------------------------
// Deterministic state rendering
// ---------------------------------------------------------------------------

/** Render one record with sorted keys as compact JSON ({} for empty). */
function renderRecord(record: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(record).sort();
  if (keys.length === 0) {
    return "{}";
  }
  const parts: string[] = [];
  for (const key of keys) {
    parts.push(`${JSON.stringify(key)}: ${JSON.stringify(record[key])}`);
  }
  return `{ ${parts.join(", ")} }`;
}

/** Render a database snapshot: one "fileId -> objectId@generation (digest …)" line per record, sorted by fileId. */
export function formatDatabaseSnapshot(database: DatabaseState): string {
  const fileIds = Object.keys(database).sort();
  if (fileIds.length === 0) {
    return "  (empty — no database records)";
  }
  return fileIds
    .map((fileId) => {
      const ref = database[fileId];
      if (ref === undefined) {
        return `  ${fileId} -> (missing)`;
      }
      return `  ${fileId} -> ${blobVersionKey(ref.objectId, ref.generation)} (digest ${ref.digest})`;
    })
    .join("\n");
}

/** Render a Blob snapshot: one "objectId@generation (digest …)" line per version, sorted by version key. */
export function formatBlobSnapshot(blob: BlobState): string {
  const keys = Object.keys(blob).sort();
  if (keys.length === 0) {
    return "  (empty — no Blob objects)";
  }
  return keys
    .map((key) => `  ${key} (digest ${blob[key as BlobVersionKey] as string})`)
    .join("\n");
}

/** One-line rendering of a diagnostic: "CODE (SEVERITY): message". */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  const where =
    diagnostic.fileId !== undefined
      ? ` [file ${diagnostic.fileId}]`
      : diagnostic.objectId !== undefined
        ? ` [object ${diagnostic.objectId}]`
        : "";
  return `${diagnostic.code} (${diagnostic.severity})${where}: ${diagnostic.message}`;
}

/**
 * One-line rendering of a trace step: its input and output states.
 * "step N EVENT_ID: db <before> -> <after>; blob <before> -> <after>".
 */
export function formatTraceStep(step: SearchTraceStep): string {
  return (
    `step ${step.stepIndex} ${step.eventId}: ` +
    `db ${renderRecord(step.databaseStateBefore)} -> ${renderRecord(step.databaseStateAfter)}; ` +
    `blob ${renderRecord(step.blobStateBefore)} -> ${renderRecord(step.blobStateAfter)}`
  );
}

// ---------------------------------------------------------------------------
// Machine-readable summary (the JSON form's content)
// ---------------------------------------------------------------------------

/** Structured, JSON-ready summary of a counterexample (§4.6 contents). */
export interface CounterexampleSummary {
  schemaVersion: "snapfence.report/v1";
  scenarioId: string;
  strategy: string;
  eventIds: readonly string[];
  length: number;
  diagnosticCodes: readonly string[];
  diagnostics: readonly Diagnostic[];
  firstFailingOperationId: string | null;
  databaseSnapshot: DatabaseState;
  blobSnapshot: BlobState;
  steps: readonly {
    stepIndex: number;
    eventId: string;
    databaseStateBefore: DatabaseState;
    databaseStateAfter: DatabaseState;
    blobStateBefore: BlobState;
    blobStateAfter: BlobState;
    completedOperationIds: readonly string[];
  }[];
}

/** Build the structured summary of a counterexample (sorted record keys). */
export function summarizeCounterexample(
  counterexample: Counterexample,
): CounterexampleSummary {
  const sortedDatabase: DatabaseState = {};
  for (const fileId of Object.keys(counterexample.databaseSnapshot).sort()) {
    const ref = counterexample.databaseSnapshot[fileId];
    if (ref !== undefined) {
      (sortedDatabase as Record<string, typeof ref>)[fileId] = ref;
    }
  }
  const sortedBlob: BlobState = {};
  for (const key of Object.keys(counterexample.blobSnapshot).sort()) {
    const digest = counterexample.blobSnapshot[key as BlobVersionKey];
    if (digest !== undefined) {
      (sortedBlob as Record<string, string>)[key] = digest;
    }
  }
  return {
    schemaVersion: "snapfence.report/v1",
    scenarioId: counterexample.trace.scenarioId,
    strategy: counterexample.trace.strategy,
    eventIds: [...counterexample.eventIds],
    length: counterexample.length,
    diagnosticCodes: counterexample.diagnostics.map((d) => d.code),
    diagnostics: counterexample.diagnostics.map((d) => ({ ...d })),
    firstFailingOperationId: counterexample.firstFailingOperationId,
    databaseSnapshot: sortedDatabase,
    blobSnapshot: sortedBlob,
    steps: counterexample.trace.steps.map((step) => ({
      stepIndex: step.stepIndex,
      eventId: step.eventId,
      databaseStateBefore: step.databaseStateBefore,
      databaseStateAfter: step.databaseStateAfter,
      blobStateBefore: step.blobStateBefore,
      blobStateAfter: step.blobStateAfter,
      completedOperationIds: [...step.completedOperationIds],
    })),
  };
}

/** Machine-readable JSON rendering of a counterexample (2-space indent). */
export function formatCounterexampleJson(counterexample: Counterexample): string {
  return JSON.stringify(summarizeCounterexample(counterexample), null, 2);
}

// ---------------------------------------------------------------------------
// Human-readable text rendering (§4.6, all contents)
// ---------------------------------------------------------------------------

/**
 * Human-readable rendering of a counterexample. Sections, in order:
 * header (scenario, strategy, length); event sequence (numbered, in
 * order); per-event input/output states; database snapshot contents;
 * Blob snapshot contents; diagnostic codes (one line each, with
 * severity); first failing operation; counterexample length.
 * When the pair is clean (no diagnostics) the diagnostics section says
 * so explicitly and the first failing operation is reported as none —
 * the text never claims a failure it does not show.
 */
export function formatCounterexampleText(counterexample: Counterexample): string {
  const lines: string[] = [];
  lines.push(
    `SnapFence counterexample — scenario ${counterexample.trace.scenarioId} (${counterexample.trace.strategy})`,
  );
  lines.push(`Counterexample length: ${counterexample.length} event(s)`);
  lines.push("");
  lines.push("Event sequence:");
  if (counterexample.eventIds.length === 0) {
    lines.push("  (none)");
  } else {
    counterexample.eventIds.forEach((eventId, index) => {
      lines.push(`  ${index + 1}. ${eventId}`);
    });
  }
  lines.push("");
  lines.push("Per-event states (input -> output):");
  if (counterexample.trace.steps.length === 0) {
    lines.push("  (no steps)");
  } else {
    for (const step of counterexample.trace.steps) {
      lines.push(`  ${formatTraceStep(step)}`);
    }
  }
  lines.push("");
  lines.push("Database snapshot contents:");
  lines.push(formatDatabaseSnapshot(counterexample.databaseSnapshot));
  lines.push("");
  lines.push("Blob snapshot contents:");
  lines.push(formatBlobSnapshot(counterexample.blobSnapshot));
  lines.push("");
  lines.push("Diagnostics:");
  if (counterexample.diagnostics.length === 0) {
    lines.push("  (none — the snapshot pair is consistent)");
  } else {
    for (const diagnostic of counterexample.diagnostics) {
      lines.push(`  - ${formatDiagnostic(diagnostic)}`);
    }
  }
  lines.push("");
  lines.push(
    `First failing operation: ${counterexample.firstFailingOperationId ?? "(none)"}`,
  );
  lines.push(`Counterexample length: ${counterexample.length}`);
  return lines.join("\n");
}
