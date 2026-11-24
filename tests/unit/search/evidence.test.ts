/**
 * SnapFence (P030) — T003 evidence tests: human-readable search traces and
 * the three-strategy comparison. These tests assert the key facts AND print
 * them, so the saved test log doubles as the trace / strategy-comparison
 * evidence (00_control/T003_TRACES.log).
 */
import { describe, expect, it } from "vitest";
import { runSearch, runSearchDetailed } from "../../../src/core/search/bfs";
import { renderPair } from "../../../src/core/search/bfs";
import {
  deleteScenarioC,
  uploadScenarioA,
  uploadScenarioB,
} from "./helpers";

describe("evidence — full trace for a §9-style scenario (scenario A)", () => {
  it("prints the complete counterexample trace for scenario A", () => {
    const detailed = runSearchDetailed(uploadScenarioA());
    expect(detailed.result.verdict).toBe("UNSAFE_WITHIN_BOUND");
    expect(detailed.trace).not.toBeNull();
    console.log("T003_TRACE scenario=U01_DB_FIRST_UPLOAD_ORPHAN");
    console.log(`T003_TRACE verdict=${detailed.result.verdict}`);
    console.log(`T003_TRACE counterexample=${detailed.result.counterexample.join(" -> ")}`);
    console.log(`T003_TRACE counterexampleLength=${detailed.result.counterexampleLength}`);
    console.log(
      `T003_TRACE diagnostics=${detailed.result.diagnostics.map((d) => d.code).join(",")}`,
    );
    console.log(
      `T003_TRACE databaseSnapshot=${renderPair(detailed.result.databaseSnapshot, {})}`,
    );
    console.log(
      `T003_TRACE blobSnapshot=${renderPair({}, detailed.result.blobSnapshot)}`,
    );
    console.log(
      `T003_TRACE stats visited=${detailed.statistics.visitedStateCount} ` +
        `terminals=${detailed.statistics.terminalStateCount} ` +
        `pairs=${detailed.statistics.distinctSnapshotPairCount} ` +
        `inconsistent=${detailed.statistics.inconsistentTerminalCount} ` +
        `rejected=${detailed.statistics.rejectedTransitionCount}`,
    );
    for (const step of detailed.trace?.steps ?? []) {
      console.log(
        `T003_TRACE step ${step.stepIndex} ${step.eventId} ` +
          `dbBefore=${renderPair(step.databaseStateBefore, {})} ` +
          `dbAfter=${renderPair(step.databaseStateAfter, {})} ` +
          `blobBefore=${renderPair({}, step.blobStateBefore)} ` +
          `blobAfter=${renderPair({}, step.blobStateAfter)} ` +
          `completed=[${step.completedOperationIds.join(",")}]`,
      );
    }
    console.log("T003_TRACE snapshot pairs (all distinct pairs found):");
    for (const pair of detailed.snapshotPairs) {
      console.log(`T003_TRACE pair ${renderPair(pair.database, pair.blob)}`);
    }
    console.log("T003_TRACE boundaries (legal operation boundaries):");
    for (const boundary of detailed.boundaries) {
      console.log(
        `T003_TRACE boundary ${boundary.boundaryIndex} ` +
          `completed=[${boundary.completedOperationIds.join(",")}] ` +
          `${renderPair(boundary.databaseState, boundary.blobState)}`,
      );
    }
  });
});

describe("evidence — three-strategy comparison", () => {
  it("prints verdict + counterexample per strategy for the same upload operation", () => {
    console.log("T003_STRATEGY comparison: one UPLOAD of file A, all three strategies");
    for (const strategy of ["DB_FIRST", "FILE_FIRST", "PAUSE_WRITES"] as const) {
      const result = runSearch(uploadScenarioA(strategy));
      console.log(
        `T003_STRATEGY ${strategy} verdict=${result.verdict} ` +
          `eventCount=${result.eventCount} ` +
          `counterexample=[${result.counterexample.join(", ")}] ` +
          `diagnostics=[${result.diagnostics.map((d) => d.code).join(", ")}]`,
      );
    }
    const dbFirst = runSearch(uploadScenarioA("DB_FIRST"));
    const fileFirst = runSearch(uploadScenarioA("FILE_FIRST"));
    const paused = runSearch(uploadScenarioA("PAUSE_WRITES"));
    expect(dbFirst.verdict).toBe("UNSAFE_WITHIN_BOUND");
    expect(fileFirst.verdict).toBe("UNSAFE_WITHIN_BOUND");
    expect(paused.verdict).toBe("SAFE_WITHIN_BOUND");
  });

  it("prints verdict + counterexample per strategy for the same delete operation", () => {
    console.log("T003_STRATEGY comparison: one DELETE of file C, all three strategies");
    for (const strategy of ["DB_FIRST", "FILE_FIRST", "PAUSE_WRITES"] as const) {
      const result = runSearch(deleteScenarioC(strategy));
      console.log(
        `T003_STRATEGY ${strategy} verdict=${result.verdict} ` +
          `counterexample=[${result.counterexample.join(", ")}] ` +
          `diagnostics=[${result.diagnostics.map((d) => d.code).join(", ")}]`,
      );
    }
    expect(runSearch(deleteScenarioC("PAUSE_WRITES")).verdict).toBe("SAFE_WITHIN_BOUND");
  });

  it("prints the scenario B trace (FILE_FIRST orphan Blob)", () => {
    const detailed = runSearchDetailed(uploadScenarioB());
    console.log("T003_TRACE scenario=U07_FILE_FIRST_UPLOAD_DANGLING");
    console.log(`T003_TRACE counterexample=${detailed.result.counterexample.join(" -> ")}`);
    console.log(
      `T003_TRACE diagnostics=${detailed.result.diagnostics.map((d) => d.code).join(",")}`,
    );
    for (const step of detailed.trace?.steps ?? []) {
      console.log(
        `T003_TRACE step ${step.stepIndex} ${step.eventId} ` +
          `dbAfter=${renderPair(step.databaseStateAfter, {})} ` +
          `blobAfter=${renderPair({}, step.blobStateAfter)}`,
      );
    }
    expect(detailed.result.verdict).toBe("UNSAFE_WITHIN_BOUND");
  });
});
