/**
 * SnapFence (P030) — FIX-ADR-001 unit tests: `snapshotsAfter` snapshot
 * placement constraint (ADR-001, SPEC_VERSION 1.0.1).
 *
 * Covers PROJECT_BOOK.md §4.5 (placement tightens the candidate set) and
 * §8.1 (`snapshotsAfter` semantics):
 * - single-upload DB_FIRST WITH snapshotsAfter=["upload-A"] is
 *   SAFE_WITHIN_BOUND (the G02 shape: backup after the upload completes);
 * - the identical scenario WITHOUT the field is UNSAFE_WITHIN_BOUND
 *   (existing full-interleaving behaviour, unchanged);
 * - an unknown snapshotsAfter opId is INVALID_INPUT;
 * - an empty snapshotsAfter array behaves as absent;
 * - PAUSE_WRITES + snapshotsAfter stays SAFE;
 * - FILE_FIRST + snapshotsAfter is SAFE (the G06 shape);
 * - the placement rule also tightens countLegalInterleavings (1 complete
 *   legal order for the constrained single upload, vs 6 unconstrained);
 * - determinism: the same input twice yields the identical result.
 *
 * Hand-derived expectation for the constrained single upload (DB_FIRST):
 * snapshots may execute only after BLOB_PUT and DB_LINK have both run,
 * and DB_SNAPSHOT must precede BLOB_SNAPSHOT, so the only complete legal
 * order is [BLOB_PUT, DB_LINK, DB_SNAPSHOT, BLOB_SNAPSHOT] — 1 legal
 * interleaving, 1 terminal state, and the captured pair is the boundary
 * after upload-A, hence SAFE.
 */
import { describe, expect, it } from "vitest";
import type { Scenario } from "../../../src/core/model/types";
import {
  countLegalInterleavings,
  runSearch,
  runSearchDetailed,
} from "../../../src/core/search/bfs";
import { uploadScenarioA } from "./helpers";

/** Single upload, DB_FIRST, snapshots placed after the upload (G02 shape). */
function constrainedUploadScenario(): Scenario {
  return {
    ...uploadScenarioA(),
    scenarioId: "G02_DB_FIRST_UPLOAD_AFTER",
    snapshotsAfter: ["upload-A"],
  };
}

describe("snapshotsAfter (ADR-001) — verdict flips with the field", () => {
  it("single-upload DB_FIRST WITH snapshotsAfter=[upload-A] is SAFE", () => {
    const result = runSearch(constrainedUploadScenario());
    expect(result.verdict).toBe("SAFE_WITHIN_BOUND");
    expect(result.counterexample).toEqual([]);
    expect(result.counterexampleLength).toBe(0);
    expect(result.eventCount).toBe(4);
  });

  it("the identical scenario WITHOUT the field is UNSAFE (behaviour preserved)", () => {
    const result = runSearch(uploadScenarioA());
    expect(result.verdict).toBe("UNSAFE_WITHIN_BOUND");
    expect(result.counterexample).toEqual([
      "DB_SNAPSHOT",
      "upload-A:BLOB_PUT",
      "BLOB_SNAPSHOT",
    ]);
    expect(result.counterexampleLength).toBe(3);
  });

  it("an unknown snapshotsAfter opId is INVALID_INPUT", () => {
    const scenario: Scenario = {
      ...uploadScenarioA(),
      scenarioId: "UNKNOWN_SNAPSHOTS_AFTER",
      snapshotsAfter: ["no-such-op"],
    };
    const result = runSearch(scenario);
    expect(result.verdict).toBe("INVALID_INPUT");
    expect(result.counterexample).toEqual([]);
  });

  it("an empty snapshotsAfter array behaves as absent (UNSAFE)", () => {
    const scenario: Scenario = {
      ...uploadScenarioA(),
      scenarioId: "EMPTY_SNAPSHOTS_AFTER",
      snapshotsAfter: [],
    };
    expect(runSearch(scenario).verdict).toBe("UNSAFE_WITHIN_BOUND");
  });

  it("PAUSE_WRITES + snapshotsAfter remains SAFE", () => {
    const scenario: Scenario = {
      ...uploadScenarioA("PAUSE_WRITES"),
      scenarioId: "G09_PAUSE_WRITES_UPLOAD_AFTER",
      snapshotsAfter: ["upload-A"],
    };
    expect(runSearch(scenario).verdict).toBe("SAFE_WITHIN_BOUND");
  });

  it("single-upload FILE_FIRST WITH snapshotsAfter is SAFE (G06 shape)", () => {
    const scenario: Scenario = {
      scenarioId: "G06_FILE_FIRST_UPLOAD_AFTER",
      strategy: "FILE_FIRST",
      maxEvents: 10,
      operations: [
        { opId: "upload-A", kind: "UPLOAD", fileId: "A", objectId: "A-v1", digest: "fixture-digest-A" },
      ],
      snapshotsAfter: ["upload-A"],
    };
    expect(runSearch(scenario).verdict).toBe("SAFE_WITHIN_BOUND");
  });
});

describe("snapshotsAfter (ADR-001) — enumeration and determinism", () => {
  it("constrains the legal interleaving count to 1 (vs 6 unconstrained)", () => {
    expect(countLegalInterleavings(constrainedUploadScenario())).toBe(1);
    expect(countLegalInterleavings(uploadScenarioA())).toBe(6);
  });

  it("yields exactly one terminal state for the constrained single upload", () => {
    const execution = runSearchDetailed(constrainedUploadScenario());
    expect(execution.result.verdict).toBe("SAFE_WITHIN_BOUND");
    expect(execution.statistics.terminalStateCount).toBe(1);
    expect(execution.statistics.inconsistentTerminalCount).toBe(0);
    expect(execution.statistics.distinctSnapshotPairCount).toBe(1);
  });

  it("is deterministic: the same input twice yields the identical result", () => {
    const first = runSearch(constrainedUploadScenario());
    const second = runSearch(constrainedUploadScenario());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    const firstDetailed = runSearchDetailed(constrainedUploadScenario());
    const secondDetailed = runSearchDetailed(constrainedUploadScenario());
    expect(JSON.stringify(secondDetailed.result)).toBe(
      JSON.stringify(firstDetailed.result),
    );
    expect(secondDetailed.statistics).toEqual(firstDetailed.statistics);
  });
});
