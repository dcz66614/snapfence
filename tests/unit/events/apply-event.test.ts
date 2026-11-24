/**
 * SnapFence (P030) — T002 unit tests: pure event state machine (applyEvent).
 * Covers: correct upload / delete / update order; prerequisite skipping
 * rejected; repeating the same atomic event rejected; partially completed
 * operations report IN_FLIGHT (never complete); snapshot events capture
 * state correctly; transitions are pure (inputs never mutated).
 */
import { describe, expect, it } from "vitest";
import type { Scenario, SystemState } from "../../../src/core/model/types";
import { expandScenario } from "../../../src/core/events/event-types";
import {
  EventApplicationError,
  applyEvent,
  applyEvents,
  initialState,
  inFlightOperationIds,
  isOperationBoundary,
} from "../../../src/core/events/apply-event";

function uploadScenario(): Scenario {
  return {
    scenarioId: "U01_DB_FIRST_UPLOAD_ORPHAN",
    strategy: "DB_FIRST",
    maxEvents: 10,
    operations: [
      { opId: "upload-A", kind: "UPLOAD", fileId: "A", objectId: "A-v1", digest: "fixture-digest-A" },
    ],
  };
}

function deleteScenario(): Scenario {
  return {
    scenarioId: "U02_DB_FIRST_DELETE_DANGLING",
    strategy: "DB_FIRST",
    maxEvents: 10,
    operations: [{ opId: "delete-C", kind: "DELETE", fileId: "C", objectId: "C-v1" }],
  };
}

function updateScenario(): Scenario {
  return {
    scenarioId: "UPDATE_SAMPLE",
    strategy: "FILE_FIRST",
    maxEvents: 10,
    operations: [
      {
        opId: "update-A",
        kind: "UPDATE",
        fileId: "A",
        objectId: "A-v2",
        oldObjectId: "A-v1",
        digest: "fixture-digest-A-v2",
      },
    ],
  };
}

/** Assert that applying `events` in order throws an EventApplicationError. */
function expectRejection(
  state: SystemState,
  events: ReturnType<typeof expandScenario>["dataEvents"],
  code: string,
): void {
  let caught: unknown;
  try {
    applyEvents(state, events);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(EventApplicationError);
  expect((caught as EventApplicationError).code).toBe(code);
}

describe("initialState (I-01 / I-02)", () => {
  it("starts empty for an upload-only scenario", () => {
    const state = initialState(uploadScenario());
    expect(state.database).toEqual({});
    expect(state.blob).toEqual({});
    expect(state.operationStatus).toEqual({ "upload-A": "NOT_STARTED" });
    expect(isOperationBoundary(state)).toBe(true);
  });

  it("seeds the implied pre-existing record for DELETE / UPDATE", () => {
    const state = initialState(deleteScenario());
    expect(state.database).toEqual({
      C: { objectId: "C-v1", generation: 1, digest: "fixture-digest-C-C-v1" },
    });
    expect(state.blob).toEqual({ "C-v1@1": "fixture-digest-C-C-v1" });
    expect(state.operationStatus).toEqual({ "delete-C": "NOT_STARTED" });
  });
});

describe("UPLOAD: BLOB_PUT -> DB_LINK", () => {
  it("applies in template order and completes the operation", () => {
    const scenario = uploadScenario();
    const state0 = initialState(scenario);
    const [put, link] = expandScenario(scenario).dataEvents;
    expect(put).toBeDefined();
    expect(link).toBeDefined();
    if (put === undefined || link === undefined) {
      throw new Error("test setup: missing upload events");
    }
    const afterPut = applyEvent(state0, put, []);
    expect(afterPut.state.blob).toEqual({ "A-v1@1": "fixture-digest-A" });
    expect(afterPut.state.database).toEqual({});
    expect(afterPut.state.operationStatus["upload-A"]).toBe("IN_FLIGHT");
    expect(isOperationBoundary(afterPut.state)).toBe(false);
    expect(inFlightOperationIds(afterPut.state)).toEqual(["upload-A"]);

    const afterLink = applyEvent(afterPut.state, link, ["upload-A:BLOB_PUT"]);
    expect(afterLink.state.database).toEqual({
      A: { objectId: "A-v1", generation: 1, digest: "fixture-digest-A" },
    });
    expect(afterLink.state.blob).toEqual({ "A-v1@1": "fixture-digest-A" });
    expect(afterLink.state.operationStatus["upload-A"]).toBe("COMPLETED");
    expect(isOperationBoundary(afterLink.state)).toBe(true);
  });

  it("rejects DB_LINK when BLOB_PUT was skipped (prerequisite)", () => {
    const scenario = uploadScenario();
    const [, link] = expandScenario(scenario).dataEvents;
    if (link === undefined) {
      throw new Error("test setup: missing DB_LINK event");
    }
    // No executed set at all: template prerequisite fires.
    expect(() => applyEvent(initialState(scenario), link, [])).toThrow(EventApplicationError);
    let caught: unknown;
    try {
      applyEvent(initialState(scenario), link, []);
    } catch (error) {
      caught = error;
    }
    expect((caught as EventApplicationError).code).toBe("PREREQUISITE_NOT_MET");
    // Even claiming BLOB_PUT executed, the missing Blob version is caught by
    // the state check.
    let caught2: unknown;
    try {
      applyEvent(initialState(scenario), link, ["upload-A:BLOB_PUT"]);
    } catch (error) {
      caught2 = error;
    }
    expect((caught2 as EventApplicationError).code).toBe("PREREQUISITE_NOT_MET");
  });

  it("rejects repeating BLOB_PUT", () => {
    const scenario = uploadScenario();
    const [put] = expandScenario(scenario).dataEvents;
    if (put === undefined) {
      throw new Error("test setup: missing BLOB_PUT event");
    }
    const afterPut = applyEvent(initialState(scenario), put, []);
    expect(() => applyEvent(afterPut.state, put, ["upload-A:BLOB_PUT"])).toThrow(
      EventApplicationError,
    );
    let caught: unknown;
    try {
      applyEvent(afterPut.state, put, ["upload-A:BLOB_PUT"]);
    } catch (error) {
      caught = error;
    }
    expect((caught as EventApplicationError).code).toBe("EVENT_ALREADY_EXECUTED");
  });
});

describe("DELETE: DB_UNLINK -> BLOB_DELETE", () => {
  it("applies in template order and completes the operation", () => {
    const scenario = deleteScenario();
    const result = applyEvents(initialState(scenario), expandScenario(scenario).dataEvents);
    expect(result.state.database).toEqual({});
    expect(result.state.blob).toEqual({});
    expect(result.state.operationStatus["delete-C"]).toBe("COMPLETED");
    expect(isOperationBoundary(result.state)).toBe(true);
  });

  it("reports IN_FLIGHT after DB_UNLINK only (partial operation)", () => {
    const scenario = deleteScenario();
    const [unlink] = expandScenario(scenario).dataEvents;
    if (unlink === undefined) {
      throw new Error("test setup: missing DB_UNLINK event");
    }
    const afterUnlink = applyEvent(initialState(scenario), unlink, []);
    expect(afterUnlink.state.operationStatus["delete-C"]).toBe("IN_FLIGHT");
    expect(afterUnlink.state.database).toEqual({});
    // Blob still present: the delete has not finished.
    expect(afterUnlink.state.blob).toEqual({ "C-v1@1": "fixture-digest-C-C-v1" });
    expect(isOperationBoundary(afterUnlink.state)).toBe(false);
  });

  it("rejects BLOB_DELETE when DB_UNLINK was skipped", () => {
    const scenario = deleteScenario();
    const [, blobDelete] = expandScenario(scenario).dataEvents;
    if (blobDelete === undefined) {
      throw new Error("test setup: missing BLOB_DELETE event");
    }
    expectRejection(initialState(scenario), [blobDelete], "PREREQUISITE_NOT_MET");
  });

  it("rejects repeating DB_UNLINK", () => {
    const scenario = deleteScenario();
    const [unlink] = expandScenario(scenario).dataEvents;
    if (unlink === undefined) {
      throw new Error("test setup: missing DB_UNLINK event");
    }
    const afterUnlink = applyEvent(initialState(scenario), unlink, []);
    let caught: unknown;
    try {
      applyEvent(afterUnlink.state, unlink, ["delete-C:DB_UNLINK"]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EventApplicationError);
    expect((caught as EventApplicationError).code).toBe("EVENT_ALREADY_EXECUTED");
  });
});

describe("UPDATE: BLOB_PUT_NEW -> DB_REPOINT -> BLOB_DELETE_OLD", () => {
  it("applies in template order and completes the operation", () => {
    const scenario = updateScenario();
    const state0 = initialState(scenario);
    const [putNew, repoint, deleteOld] = expandScenario(scenario).dataEvents;
    if (putNew === undefined || repoint === undefined || deleteOld === undefined) {
      throw new Error("test setup: missing update events");
    }
    const afterPut = applyEvent(state0, putNew, []);
    expect(afterPut.state.blob).toEqual({
      "A-v1@1": "fixture-digest-A-A-v1",
      "A-v2@2": "fixture-digest-A-v2",
    });
    expect(afterPut.state.database["A"]).toEqual({
      objectId: "A-v1",
      generation: 1,
      digest: "fixture-digest-A-A-v1",
    });
    expect(afterPut.state.operationStatus["update-A"]).toBe("IN_FLIGHT");

    const afterRepoint = applyEvent(afterPut.state, repoint, ["update-A:BLOB_PUT_NEW"]);
    expect(afterRepoint.state.database["A"]).toEqual({
      objectId: "A-v2",
      generation: 2,
      digest: "fixture-digest-A-v2",
    });
    expect(afterRepoint.state.operationStatus["update-A"]).toBe("IN_FLIGHT");
    expect(isOperationBoundary(afterRepoint.state)).toBe(false);

    const afterDelete = applyEvent(afterRepoint.state, deleteOld, [
      "update-A:BLOB_PUT_NEW",
      "update-A:DB_REPOINT",
    ]);
    expect(afterDelete.state.blob).toEqual({ "A-v2@2": "fixture-digest-A-v2" });
    expect(afterDelete.state.operationStatus["update-A"]).toBe("COMPLETED");
    expect(isOperationBoundary(afterDelete.state)).toBe(true);
  });

  it("rejects DB_REPOINT when BLOB_PUT_NEW was skipped", () => {
    const scenario = updateScenario();
    const [, repoint] = expandScenario(scenario).dataEvents;
    if (repoint === undefined) {
      throw new Error("test setup: missing DB_REPOINT event");
    }
    expectRejection(initialState(scenario), [repoint], "PREREQUISITE_NOT_MET");
  });

  it("rejects BLOB_DELETE_OLD when DB_REPOINT was skipped", () => {
    const scenario = updateScenario();
    const [putNew, , deleteOld] = expandScenario(scenario).dataEvents;
    if (putNew === undefined || deleteOld === undefined) {
      throw new Error("test setup: missing update events");
    }
    // Put the new version, then try to delete the old one while the DB still
    // points at it: the state check rejects the skipped repoint.
    const afterPut = applyEvent(initialState(scenario), putNew, []);
    let caught: unknown;
    try {
      applyEvent(afterPut.state, deleteOld, ["update-A:BLOB_PUT_NEW"]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EventApplicationError);
    expect((caught as EventApplicationError).code).toBe("PREREQUISITE_NOT_MET");
  });

  it("rejects repeating BLOB_PUT_NEW", () => {
    const scenario = updateScenario();
    const [putNew] = expandScenario(scenario).dataEvents;
    if (putNew === undefined) {
      throw new Error("test setup: missing BLOB_PUT_NEW event");
    }
    const afterPut = applyEvent(initialState(scenario), putNew, []);
    let caught: unknown;
    try {
      applyEvent(afterPut.state, putNew, ["update-A:BLOB_PUT_NEW"]);
    } catch (error) {
      caught = error;
    }
    expect((caught as EventApplicationError).code).toBe("EVENT_ALREADY_EXECUTED");
  });

  it("rejects BLOB_DELETE_OLD for a version that was never written", () => {
    const scenario = updateScenario();
    const [, , deleteOld] = expandScenario(scenario).dataEvents;
    if (deleteOld === undefined) {
      throw new Error("test setup: missing BLOB_DELETE_OLD event");
    }
    // Executed set claims the prerequisites ran, but the state has no new
    // version and the DB still points at the old one: prerequisite fires.
    expectRejection(initialState(scenario), [deleteOld], "PREREQUISITE_NOT_MET");
  });
});

describe("snapshot events", () => {
  it("DB_SNAPSHOT captures the database state and changes nothing", () => {
    const scenario = uploadScenario();
    const [put, ,] = expandScenario(scenario).dataEvents;
    const [dbSnapshot] = expandScenario(scenario).snapshotEvents;
    if (put === undefined || dbSnapshot === undefined) {
      throw new Error("test setup: missing events");
    }
    const state0 = initialState(scenario);
    const afterPut = applyEvent(state0, put, []);
    const captured = applyEvent(afterPut.state, dbSnapshot, ["upload-A:BLOB_PUT"]);
    expect(captured.databaseSnapshot).toEqual({});
    expect(captured.blobSnapshot).toBeNull();
    // Snapshot events do not change the state object contents.
    expect(captured.state).toEqual(afterPut.state);
    expect(captured.state.operationStatus["upload-A"]).toBe("IN_FLIGHT");
  });

  it("BLOB_SNAPSHOT captures the Blob state mid-upload (orphan shape, §9.1 A)", () => {
    const scenario = uploadScenario();
    const [put] = expandScenario(scenario).dataEvents;
    const [, blobSnapshot] = expandScenario(scenario).snapshotEvents;
    if (put === undefined || blobSnapshot === undefined) {
      throw new Error("test setup: missing events");
    }
    const afterPut = applyEvent(initialState(scenario), put, []);
    const captured = applyEvent(afterPut.state, blobSnapshot, ["upload-A:BLOB_PUT"]);
    expect(captured.blobSnapshot).toEqual({ "A-v1@1": "fixture-digest-A" });
    expect(captured.databaseSnapshot).toBeNull();
  });

  it("applyEvents returns both snapshots of a completed upload", () => {
    const scenario = uploadScenario();
    const expansion = expandScenario(scenario);
    const result = applyEvents(initialState(scenario), expansion.allEvents);
    expect(result.databaseSnapshot).toEqual({
      A: { objectId: "A-v1", generation: 1, digest: "fixture-digest-A" },
    });
    expect(result.blobSnapshot).toEqual({ "A-v1@1": "fixture-digest-A" });
    expect(result.appliedEventIds).toEqual([
      "upload-A:BLOB_PUT",
      "upload-A:DB_LINK",
      "DB_SNAPSHOT",
      "BLOB_SNAPSHOT",
    ]);
  });

  it("rejects repeating the same snapshot event", () => {
    const scenario = uploadScenario();
    const [dbSnapshot] = expandScenario(scenario).snapshotEvents;
    if (dbSnapshot === undefined) {
      throw new Error("test setup: missing DB_SNAPSHOT event");
    }
    const first = applyEvent(initialState(scenario), dbSnapshot, []);
    expect(first.databaseSnapshot).toEqual({});
    let caught: unknown;
    try {
      applyEvent(first.state, dbSnapshot, ["DB_SNAPSHOT"]);
    } catch (error) {
      caught = error;
    }
    expect((caught as EventApplicationError).code).toBe("EVENT_ALREADY_EXECUTED");
  });

  it("snapshot captures are copies: later events do not mutate them", () => {
    const scenario = uploadScenario();
    const expansion = expandScenario(scenario);
    const [put, link] = expansion.dataEvents;
    const [dbSnapshot] = expansion.snapshotEvents;
    if (put === undefined || link === undefined || dbSnapshot === undefined) {
      throw new Error("test setup: missing events");
    }
    const afterPut = applyEvent(initialState(scenario), put, []);
    const captured = applyEvent(afterPut.state, dbSnapshot, ["upload-A:BLOB_PUT"]);
    const afterLink = applyEvent(afterPut.state, link, ["upload-A:BLOB_PUT"]);
    expect(captured.databaseSnapshot).toEqual({});
    expect(afterLink.state.database).toEqual({
      A: { objectId: "A-v1", generation: 1, digest: "fixture-digest-A" },
    });
  });
});

describe("purity — inputs are never mutated", () => {
  it("applyEvent leaves the input state object untouched", () => {
    const scenario = updateScenario();
    const state0 = initialState(scenario);
    const before = JSON.stringify(state0);
    const [putNew] = expandScenario(scenario).dataEvents;
    if (putNew === undefined) {
      throw new Error("test setup: missing BLOB_PUT_NEW event");
    }
    applyEvent(state0, putNew, []);
    expect(JSON.stringify(state0)).toBe(before);
    expect(state0.operationStatus["update-A"]).toBe("NOT_STARTED");
  });

  it("applyEvents leaves the input state and the event list untouched", () => {
    const scenario = deleteScenario();
    const state0 = initialState(scenario);
    const before = JSON.stringify(state0);
    const events = expandScenario(scenario).dataEvents;
    applyEvents(state0, events);
    expect(JSON.stringify(state0)).toBe(before);
  });
});

describe("state-migration samples (evidence)", () => {
  it("logs the three operations' state migrations as JSON", () => {
    const samples: Record<string, unknown> = {};
    for (const scenario of [uploadScenario(), deleteScenario(), updateScenario()]) {
      const state0 = initialState(scenario);
      const result = applyEvents(state0, expandScenario(scenario).dataEvents);
      samples[scenario.scenarioId] = {
        initial: state0,
        final: result.state,
        boundary: isOperationBoundary(result.state),
      };
    }
    // Printed into the test log as the state-migration evidence sample.
    console.log("T002_STATE_MIGRATION_SAMPLES " + JSON.stringify(samples));
    expect(samples["U01_DB_FIRST_UPLOAD_ORPHAN"]).toBeDefined();
    expect(samples["U02_DB_FIRST_DELETE_DANGLING"]).toBeDefined();
    expect(samples["UPDATE_SAMPLE"]).toBeDefined();
  });
});
