/**
 * SnapFence (P030) — T004 unit tests: counterexample formatting.
 * Covers PROJECT_BOOK.md §4.6 output contents — event sequence,
 * per-event input/output state, database + Blob snapshot contents,
 * diagnostic code, first failing operation, counterexample length — in
 * both renderings (human-readable text and machine-readable JSON), and
 * determinism (same counterexample → same output).
 */
import { describe, expect, it } from "vitest";
import type { SearchTrace } from "../../../src/core/model/types";
import { extractCounterexample } from "../../../src/core/counterexample/extract";
import {
  formatBlobSnapshot,
  formatCounterexampleJson,
  formatCounterexampleText,
  formatDatabaseSnapshot,
  formatDiagnostic,
  formatTraceStep,
  summarizeCounterexample,
} from "../../../src/core/counterexample/format";
import { runSearchDetailed } from "../../../src/core/search/bfs";
import { deleteScenarioC, idleScenario, uploadScenarioA } from "../search/helpers";

describe("formatCounterexampleText — scenario A (§4.6 contents)", () => {
  it("contains the event sequence, states, snapshots, diagnostics, first failing operation and length", () => {
    const detailed = runSearchDetailed(uploadScenarioA());
    const counterexample = extractCounterexample(detailed.trace as SearchTrace);
    const text = formatCounterexampleText(counterexample);
    // Event sequence, in order.
    expect(text).toContain("1. DB_SNAPSHOT");
    expect(text).toContain("2. upload-A:BLOB_PUT");
    expect(text).toContain("3. BLOB_SNAPSHOT");
    // Per-event input/output states.
    expect(text).toContain("step 0 DB_SNAPSHOT");
    expect(text).toContain("step 1 upload-A:BLOB_PUT");
    expect(text).toContain("db {} -> {}");
    expect(text).toContain("blob {} -> { \"A-v1@1\": \"fixture-digest-A\" }");
    // Database + Blob snapshot contents.
    expect(text).toContain("Database snapshot contents:");
    expect(text).toContain("(empty — no database records)");
    expect(text).toContain("Blob snapshot contents:");
    expect(text).toContain("A-v1@1 (digest fixture-digest-A)");
    // Diagnostic code(s).
    expect(text).toContain("ORPHAN_BLOB");
    expect(text).toContain("IN_FLIGHT_OPERATION");
    expect(text).toContain("NO_COMMON_BOUNDARY");
    // First failing operation and length.
    expect(text).toContain("First failing operation: upload-A");
    expect(text).toContain("Counterexample length: 3");
    // Scenario identity.
    expect(text).toContain("U01_DB_FIRST_UPLOAD_ORPHAN");
  });

  it("a clean counterexample says so explicitly instead of claiming a failure", () => {
    const detailed = runSearchDetailed(idleScenario("DB_FIRST"));
    const counterexample = extractCounterexample(detailed.trace as SearchTrace);
    const text = formatCounterexampleText(counterexample);
    expect(text).toContain("(none — the snapshot pair is consistent)");
    expect(text).toContain("First failing operation: (none)");
    expect(text).toContain("Counterexample length: 2");
  });

  it("formatting is deterministic: same counterexample, same text", () => {
    const detailed = runSearchDetailed(deleteScenarioC());
    const first = formatCounterexampleText(
      extractCounterexample(detailed.trace as SearchTrace),
    );
    const second = formatCounterexampleText(
      extractCounterexample(detailed.trace as SearchTrace),
    );
    expect(first).toBe(second);
  });
});

describe("formatCounterexampleJson — machine-readable form", () => {
  it("parses to a summary carrying every §4.6 content item", () => {
    const detailed = runSearchDetailed(uploadScenarioA());
    const counterexample = extractCounterexample(detailed.trace as SearchTrace);
    const parsed = JSON.parse(
      formatCounterexampleJson(counterexample),
    ) as ReturnType<typeof summarizeCounterexample>;
    expect(parsed.schemaVersion).toBe("snapfence.report/v1");
    expect(parsed.scenarioId).toBe("U01_DB_FIRST_UPLOAD_ORPHAN");
    expect(parsed.eventIds).toEqual(["DB_SNAPSHOT", "upload-A:BLOB_PUT", "BLOB_SNAPSHOT"]);
    expect(parsed.length).toBe(3);
    expect(parsed.diagnosticCodes).toEqual([
      "IN_FLIGHT_OPERATION",
      "NO_COMMON_BOUNDARY",
      "ORPHAN_BLOB",
    ]);
    expect(parsed.firstFailingOperationId).toBe("upload-A");
    expect(parsed.databaseSnapshot).toEqual({});
    expect(parsed.blobSnapshot).toEqual({ "A-v1@1": "fixture-digest-A" });
    expect(parsed.steps).toHaveLength(3);
    expect(parsed.steps[1]?.databaseStateBefore).toEqual({});
    expect(parsed.steps[1]?.blobStateAfter).toEqual({ "A-v1@1": "fixture-digest-A" });
    expect(parsed.steps[1]?.completedOperationIds).toEqual([]);
  });

  it("formatting is deterministic: same counterexample, same JSON", () => {
    const detailed = runSearchDetailed(uploadScenarioA());
    const counterexample = extractCounterexample(detailed.trace as SearchTrace);
    expect(formatCounterexampleJson(counterexample)).toBe(
      formatCounterexampleJson(counterexample),
    );
  });
});

describe("small formatters", () => {
  it("formatDiagnostic renders code, severity and message in one line", () => {
    expect(
      formatDiagnostic({
        code: "DANGLING_REFERENCE",
        severity: "CRITICAL",
        fileId: "B",
        objectId: "B-v1",
        message: "Database record for file B references B-v1@1, which the Blob snapshot does not contain.",
      }),
    ).toBe(
      "DANGLING_REFERENCE (CRITICAL) [file B]: Database record for file B references B-v1@1, which the Blob snapshot does not contain.",
    );
  });

  it("formatDatabaseSnapshot / formatBlobSnapshot render empty states explicitly", () => {
    expect(formatDatabaseSnapshot({})).toContain("(empty");
    expect(formatBlobSnapshot({})).toContain("(empty");
    expect(formatDatabaseSnapshot({ A: { objectId: "A-v1", generation: 1, digest: "fixture-digest-A" } })).toBe(
      "  A -> A-v1@1 (digest fixture-digest-A)",
    );
  });

  it("formatTraceStep renders input and output states", () => {
    expect(
      formatTraceStep({
        stepIndex: 1,
        eventId: "upload-A:BLOB_PUT",
        databaseStateBefore: {},
        blobStateBefore: {},
        databaseStateAfter: {},
        blobStateAfter: { "A-v1@1": "fixture-digest-A" },
        completedOperationIds: [],
      }),
    ).toBe(
      'step 1 upload-A:BLOB_PUT: db {} -> {}; blob {} -> { "A-v1@1": "fixture-digest-A" }',
    );
  });
});
