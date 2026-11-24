/**
 * SnapFence (P030) — T003 unit tests: search state representation.
 * Covers: initial state derivation (implied pre-existing records per I-02),
 * extension by one event (path, sorted executed set, snapshot capture with
 * capture-time in-flight operations, per-event before/after trace steps),
 * terminal / boundary detection, and purity (inputs never mutated).
 */
import { describe, expect, it } from "vitest";
import { expandScenario } from "../../../src/core/events/event-types";
import { applyEvent } from "../../../src/core/events/apply-event";
import {
  completedOperationIds,
  createInitialSearchState,
  extendSearchState,
  inFlightOperationIdsOf,
  isBoundarySearchState,
  isTerminalSearchState,
} from "../../../src/core/search/search-state";
import {
  deleteScenarioC,
  uploadScenarioA,
} from "./helpers";

function eventById(scenarioId: string, eventId: string) {
  const scenario = scenarioId === "delete" ? deleteScenarioC() : uploadScenarioA();
  const event = expandScenario(scenario).allEvents.find((e) => e.eventId === eventId);
  if (event === undefined) {
    throw new Error(`no such event ${eventId}`);
  }
  return { scenario, event };
}

describe("createInitialSearchState", () => {
  it("starts empty: no path, no snapshots, no steps", () => {
    const state = createInitialSearchState(uploadScenarioA());
    expect(state.path).toEqual([]);
    expect(state.executedEventIds).toEqual([]);
    expect(state.databaseSnapshot).toBeNull();
    expect(state.blobSnapshot).toBeNull();
    expect(state.steps).toEqual([]);
    expect(state.dbSnapshotInFlightOperationIds).toEqual([]);
    expect(state.blobSnapshotInFlightOperationIds).toEqual([]);
  });

  it("starts all operations NOT_STARTED at a boundary", () => {
    const state = createInitialSearchState(uploadScenarioA());
    expect(state.systemState.operationStatus).toEqual({ "upload-A": "NOT_STARTED" });
    expect(isBoundarySearchState(state)).toBe(true);
    expect(isTerminalSearchState(state)).toBe(false);
  });

  it("derives the implied pre-existing record for a DELETE scenario (I-02)", () => {
    const state = createInitialSearchState(deleteScenarioC());
    expect(state.systemState.database).toEqual({
      C: { objectId: "C-v1", generation: 1, digest: "fixture-digest-C-C-v1" },
    });
    expect(state.systemState.blob).toEqual({ "C-v1@1": "fixture-digest-C-C-v1" });
  });
});

describe("extendSearchState", () => {
  it("extends the path and keeps the executed set sorted", () => {
    const { scenario, event } = eventById("upload", "upload-A:BLOB_PUT");
    const initial = createInitialSearchState(scenario);
    const next = extendSearchState(
      initial,
      event,
      applyEvent(initial.systemState, event, initial.executedEventIds),
    );
    expect(next.path).toEqual(["upload-A:BLOB_PUT"]);
    expect(next.executedEventIds).toEqual(["upload-A:BLOB_PUT"]);
    expect(next.systemState.blob).toEqual({ "A-v1@1": "fixture-digest-A" });
    expect(inFlightOperationIdsOf(next)).toEqual(["upload-A"]);
    expect(isBoundarySearchState(next)).toBe(false);
  });

  it("records a trace step with before/after states and completions", () => {
    const scenario = uploadScenarioA();
    const initial = createInitialSearchState(scenario);
    const expansion = expandScenario(scenario);
    const put = expansion.allEvents.find((e) => e.eventId === "upload-A:BLOB_PUT");
    const link = expansion.allEvents.find((e) => e.eventId === "upload-A:DB_LINK");
    if (put === undefined || link === undefined) {
      throw new Error("missing events");
    }
    const afterPut = extendSearchState(
      initial,
      put,
      applyEvent(initial.systemState, put, initial.executedEventIds),
    );
    const afterLink = extendSearchState(
      afterPut,
      link,
      applyEvent(afterPut.systemState, link, afterPut.executedEventIds),
    );
    expect(afterLink.steps).toHaveLength(2);
    expect(afterLink.steps[0]?.stepIndex).toBe(0);
    expect(afterLink.steps[0]?.eventId).toBe("upload-A:BLOB_PUT");
    expect(afterLink.steps[0]?.databaseStateBefore).toEqual({});
    expect(afterLink.steps[0]?.blobStateBefore).toEqual({});
    expect(afterLink.steps[0]?.blobStateAfter).toEqual({ "A-v1@1": "fixture-digest-A" });
    expect(afterLink.steps[0]?.completedOperationIds).toEqual([]);
    expect(afterLink.steps[1]?.stepIndex).toBe(1);
    expect(afterLink.steps[1]?.databaseStateAfter).toEqual({
      A: { objectId: "A-v1", generation: 1, digest: "fixture-digest-A" },
    });
    expect(afterLink.steps[1]?.completedOperationIds).toEqual(["upload-A"]);
    expect(completedOperationIds(afterLink)).toEqual(["upload-A"]);
    expect(isBoundarySearchState(afterLink)).toBe(true);
  });

  it("captures a snapshot copy and the operations in flight at capture time", () => {
    const scenario = uploadScenarioA();
    const initial = createInitialSearchState(scenario);
    const expansion = expandScenario(scenario);
    const put = expansion.allEvents.find((e) => e.eventId === "upload-A:BLOB_PUT");
    const dbSnap = expansion.allEvents.find((e) => e.eventId === "DB_SNAPSHOT");
    if (put === undefined || dbSnap === undefined) {
      throw new Error("missing events");
    }
    const afterPut = extendSearchState(
      initial,
      put,
      applyEvent(initial.systemState, put, initial.executedEventIds),
    );
    const afterSnap = extendSearchState(
      afterPut,
      dbSnap,
      applyEvent(afterPut.systemState, dbSnap, afterPut.executedEventIds),
    );
    expect(afterSnap.databaseSnapshot).toEqual({});
    expect(afterSnap.dbSnapshotInFlightOperationIds).toEqual(["upload-A"]);
    expect(afterSnap.blobSnapshot).toBeNull();
    expect(isTerminalSearchState(afterSnap)).toBe(false);
  });

  it("captures a boundary snapshot with no in-flight operations", () => {
    const scenario = uploadScenarioA();
    const initial = createInitialSearchState(scenario);
    const expansion = expandScenario(scenario);
    const dbSnap = expansion.allEvents.find((e) => e.eventId === "DB_SNAPSHOT");
    if (dbSnap === undefined) {
      throw new Error("missing event");
    }
    const afterSnap = extendSearchState(
      initial,
      dbSnap,
      applyEvent(initial.systemState, dbSnap, initial.executedEventIds),
    );
    expect(afterSnap.databaseSnapshot).toEqual({});
    expect(afterSnap.dbSnapshotInFlightOperationIds).toEqual([]);
  });

  it("is terminal once both snapshots have executed", () => {
    const scenario = uploadScenarioA();
    const initial = createInitialSearchState(scenario);
    const expansion = expandScenario(scenario);
    let state = initial;
    for (const eventId of ["DB_SNAPSHOT", "BLOB_SNAPSHOT"]) {
      const event = expansion.allEvents.find((e) => e.eventId === eventId);
      if (event === undefined) {
        throw new Error("missing event");
      }
      state = extendSearchState(
        state,
        event,
        applyEvent(state.systemState, event, state.executedEventIds),
      );
    }
    expect(isTerminalSearchState(state)).toBe(true);
    expect(state.databaseSnapshot).toEqual({});
    expect(state.blobSnapshot).toEqual({});
  });

  it("never mutates its input state", () => {
    const scenario = uploadScenarioA();
    const initial = createInitialSearchState(scenario);
    const before = JSON.stringify(initial);
    const expansion = expandScenario(scenario);
    const put = expansion.allEvents.find((e) => e.eventId === "upload-A:BLOB_PUT");
    if (put === undefined) {
      throw new Error("missing event");
    }
    extendSearchState(initial, put, applyEvent(initial.systemState, put, initial.executedEventIds));
    expect(JSON.stringify(initial)).toBe(before);
    expect(initial.path).toEqual([]);
  });
});
