/**
 * SnapFence (P030) — T008 counterexample step-replay tests.
 *
 * Replays the shortest counterexample through the frozen event state
 * machine (initialState + applyEvent) and asserts the per-event
 * before/after states are exactly the model's states. Fixtures are the
 * frozen T005 Golden inputs; results come from the S0-verified `runSearch`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Scenario, SearchResult } from "../../../src/core/model/types";
import { runSearch } from "../../../src/core/search/bfs";
import { initialState } from "../../../src/core/events/apply-event";
import {
  buildReplaySteps,
  clampReplayStep,
  stateAfterSteps,
} from "../../../src/components/timeline/replay";

const GOLDEN_DIR = fileURLToPath(new URL("../../../fixtures/golden/", import.meta.url));

interface GoldenFixtureFile {
  fixtureId: string;
  scenario: Scenario;
  expectedCounterexample: readonly string[];
}

function loadFixture(fixtureId: string): GoldenFixtureFile {
  const raw = readFileSync(`${GOLDEN_DIR}${fixtureId}.json`, "utf-8");
  return JSON.parse(raw) as GoldenFixtureFile;
}

function runFixture(fixtureId: string): { fixture: GoldenFixtureFile; result: SearchResult } {
  const fixture = loadFixture(fixtureId);
  return { fixture, result: runSearch(fixture.scenario) };
}

describe("buildReplaySteps", () => {
  it("U01: 3 steps; BLOB_PUT writes A-v1 and leaves upload-A in flight", () => {
    const { fixture, result } = runFixture("U01");
    const steps = buildReplaySteps(fixture.scenario, result.counterexample);
    expect(steps).toHaveLength(3);
    expect(steps.map((step) => step.eventId)).toEqual(fixture.expectedCounterexample);
    // Step 0 DB_SNAPSHOT changes nothing.
    expect(steps[0]?.stateBefore).toEqual(steps[0]?.stateAfter);
    expect(Object.keys(steps[0]?.stateAfter.database ?? {})).toHaveLength(0);
    // Step 1 BLOB_PUT: Blob gains A-v1@1, database still empty, op in flight.
    expect(steps[1]?.stateAfter.blob["A-v1@1"]).toBe("fixture-digest-A");
    expect(Object.keys(steps[1]?.stateAfter.database ?? {})).toHaveLength(0);
    expect(steps[1]?.inFlightAfter).toEqual(["upload-A"]);
    // Step 2 BLOB_SNAPSHOT changes nothing; final state still in flight.
    expect(steps[2]?.stateAfter).toEqual(steps[1]?.stateAfter);
    expect(steps[2]?.inFlightAfter).toEqual(["upload-A"]);
  });

  it("U02 (delete cross-snapshot): DB_UNLINK removes C and leaves delete-C in flight", () => {
    const { fixture, result } = runFixture("U02");
    const steps = buildReplaySteps(fixture.scenario, result.counterexample);
    expect(steps).toHaveLength(3);
    // Initial state carries the implied pre-existing record C (I-02).
    expect(initialState(fixture.scenario).database["C"]?.objectId).toBe("C-v1");
    // Step 0 DB_UNLINK: database loses C, Blob still holds C-v1.
    expect(steps[0]?.stateAfter.database["C"]).toBeUndefined();
    expect(steps[0]?.stateAfter.blob["C-v1@1"]).toBeDefined();
    expect(steps[0]?.inFlightAfter).toEqual(["delete-C"]);
  });

  it("U07: BLOB_PUT first, then the Blob snapshot captures B-v1", () => {
    const { fixture, result } = runFixture("U07");
    const steps = buildReplaySteps(fixture.scenario, result.counterexample);
    expect(steps.map((step) => step.eventId)).toEqual([
      "upload-B:BLOB_PUT",
      "BLOB_SNAPSHOT",
      "DB_SNAPSHOT",
    ]);
    expect(steps[1]?.stateBefore.blob["B-v1@1"]).toBe("fixture-digest-B");
    expect(steps[1]?.stateAfter).toEqual(steps[1]?.stateBefore);
  });

  it("G12 canonical sequence replays all 10 events to the completed state", () => {
    const { fixture, result } = runFixture("G12");
    expect(result.counterexample).toHaveLength(0);
    const canonical = [
      "upload-A:BLOB_PUT",
      "upload-A:DB_LINK",
      "upload-B:BLOB_PUT",
      "upload-B:DB_LINK",
      "upload-C:BLOB_PUT",
      "upload-C:DB_LINK",
      "upload-D:BLOB_PUT",
      "upload-D:DB_LINK",
      "DB_SNAPSHOT",
      "BLOB_SNAPSHOT",
    ];
    const steps = buildReplaySteps(fixture.scenario, canonical);
    expect(steps).toHaveLength(10);
    const finalState = steps[9]?.stateAfter;
    expect(Object.keys(finalState?.database ?? {})).toHaveLength(4);
    expect(Object.keys(finalState?.blob ?? {})).toHaveLength(4);
    expect(finalState?.operationStatus).toEqual({
      "upload-A": "COMPLETED",
      "upload-B": "COMPLETED",
      "upload-C": "COMPLETED",
      "upload-D": "COMPLETED",
    });
  });

  it("an unknown event ID fails closed instead of replaying silently", () => {
    const { fixture } = runFixture("U01");
    expect(() => buildReplaySteps(fixture.scenario, ["no-such-event"])).toThrow(
      /unknown event ID/i,
    );
  });
});

describe("clampReplayStep", () => {
  it("clamps below 0, above total, and NaN", () => {
    expect(clampReplayStep(-1, 3)).toBe(0);
    expect(clampReplayStep(99, 3)).toBe(3);
    expect(clampReplayStep(Number.NaN, 3)).toBe(0);
    expect(clampReplayStep(2, 3)).toBe(2);
  });
});

describe("stateAfterSteps", () => {
  it("step 0 is the initial state; step N is the final replayed state", () => {
    const { fixture, result } = runFixture("U01");
    const initial = stateAfterSteps(fixture.scenario, result.counterexample, 0);
    expect(initial).toEqual(initialState(fixture.scenario));
    const final = stateAfterSteps(fixture.scenario, result.counterexample, 3);
    expect(final.blob["A-v1@1"]).toBe("fixture-digest-A");
    expect(Object.keys(final.database)).toHaveLength(0);
  });
});
