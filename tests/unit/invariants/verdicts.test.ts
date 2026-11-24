/**
 * SnapFence (P030) — T004 unit tests: the four §4.7 verdict literals.
 * The verdicts themselves are produced by runSearch (T003); this file
 * pins each literal verbatim — SAFE_WITHIN_BOUND, UNSAFE_WITHIN_BOUND,
 * INCONCLUSIVE_LIMIT, INVALID_INPUT — against the scenario that must
 * produce it, so a verdict rename or a silent downgrade (e.g. over-limit
 * input reported as SAFE) fails loudly here.
 */
import { describe, expect, it } from "vitest";
import type { Scenario } from "../../../src/core/model/types";
import { runSearch } from "../../../src/core/search/bfs";
import {
  deleteScenarioC,
  fiveUploadScenario,
  idleScenario,
  uploadScenarioA,
} from "../search/helpers";

describe("verdict literals (§4.7, verbatim)", () => {
  it("SAFE_WITHIN_BOUND: an idle scenario has no inconsistent path", () => {
    const result = runSearch(idleScenario("DB_FIRST"));
    expect(result.verdict).toBe("SAFE_WITHIN_BOUND");
    expect(result.counterexample).toEqual([]);
    expect(result.counterexampleLength).toBe(0);
  });

  it("SAFE_WITHIN_BOUND: PAUSE_WRITES around a complete upload is safe", () => {
    const result = runSearch(uploadScenarioA("PAUSE_WRITES"));
    expect(result.verdict).toBe("SAFE_WITHIN_BOUND");
  });

  it("UNSAFE_WITHIN_BOUND: scenario A (DB_FIRST upload) has a shortest counterexample", () => {
    const result = runSearch(uploadScenarioA());
    expect(result.verdict).toBe("UNSAFE_WITHIN_BOUND");
    expect(result.counterexample).toEqual([
      "DB_SNAPSHOT",
      "upload-A:BLOB_PUT",
      "BLOB_SNAPSHOT",
    ]);
    expect(result.counterexampleLength).toBe(result.counterexample.length);
    expect(result.counterexampleLength).toBe(3);
  });

  it("UNSAFE_WITHIN_BOUND: scenario C (DB_FIRST delete) is unsafe too", () => {
    expect(runSearch(deleteScenarioC()).verdict).toBe("UNSAFE_WITHIN_BOUND");
  });

  it("INCONCLUSIVE_LIMIT: five uploads need 12 events, over the 10-event bound — never SAFE", () => {
    const result = runSearch(fiveUploadScenario());
    expect(result.verdict).toBe("INCONCLUSIVE_LIMIT");
    expect(result.verdict).not.toBe("SAFE_WITHIN_BOUND");
    expect(result.counterexample).toEqual([]);
  });

  it("INVALID_INPUT: an empty scenarioId is rejected, never searched", () => {
    const bad: Scenario = {
      scenarioId: "",
      strategy: "DB_FIRST",
      maxEvents: 10,
      operations: [
        { opId: "upload-A", kind: "UPLOAD", fileId: "A", objectId: "A-v1", digest: "fixture-digest-A" },
      ],
    };
    const result = runSearch(bad);
    expect(result.verdict).toBe("INVALID_INPUT");
    expect(result.counterexample).toEqual([]);
  });

  it("INVALID_INPUT: an unknown snapshotsAfter opId is rejected", () => {
    const bad: Scenario = {
      scenarioId: "BAD_SNAPSHOTS_AFTER",
      strategy: "DB_FIRST",
      maxEvents: 10,
      operations: [
        { opId: "upload-A", kind: "UPLOAD", fileId: "A", objectId: "A-v1", digest: "fixture-digest-A" },
      ],
      snapshotsAfter: ["no-such-op"],
    };
    expect(runSearch(bad).verdict).toBe("INVALID_INPUT");
  });
});
