/**
 * SnapFence (P030) — T004 evidence tests: full formatted counterexamples.
 * These tests assert the key facts AND print them, so the saved test log
 * doubles as the counterexample output sample evidence
 * (00_control/T004_TEST_INVARIANTS.log).
 */
import { describe, expect, it } from "vitest";
import type { SearchTrace } from "../../../src/core/model/types";
import { extractCounterexample } from "../../../src/core/counterexample/extract";
import {
  formatCounterexampleJson,
  formatCounterexampleText,
} from "../../../src/core/counterexample/format";
import { runSearchDetailed } from "../../../src/core/search/bfs";
import {
  deleteScenarioC,
  uploadScenarioA,
  uploadScenarioB,
} from "../search/helpers";

describe("evidence — full formatted counterexample for scenario A", () => {
  it("prints the complete formatted counterexample for scenario A", () => {
    const detailed = runSearchDetailed(uploadScenarioA());
    const counterexample = extractCounterexample(detailed.trace as SearchTrace);
    expect(counterexample.length).toBe(3);
    expect(counterexample.firstFailingOperationId).toBe("upload-A");
    console.log("T004_EVIDENCE scenario=U01_DB_FIRST_UPLOAD_ORPHAN");
    console.log(formatCounterexampleText(counterexample));
    console.log("T004_EVIDENCE json:");
    console.log(formatCounterexampleJson(counterexample));
  });

  it("prints the formatted counterexamples for scenarios B and C", () => {
    for (const [label, scenario] of [
      ["U07_FILE_FIRST_UPLOAD_DANGLING", uploadScenarioB()],
      ["U02_DB_FIRST_DELETE_DANGLING", deleteScenarioC()],
    ] as const) {
      const detailed = runSearchDetailed(scenario);
      const counterexample = extractCounterexample(detailed.trace as SearchTrace);
      expect(counterexample.length).toBe(3);
      console.log(`T004_EVIDENCE scenario=${label}`);
      console.log(formatCounterexampleText(counterexample));
    }
  });
});
