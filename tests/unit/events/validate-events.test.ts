/**
 * SnapFence (P030) — T002 unit tests: scenario / event-list validation.
 * Covers: valid scenarios pass; duplicate operation / event IDs rejected;
 * unknown object-version references rejected; max-events bound enforced;
 * illegal DAG (cycle) fails closed; concrete event-sequence validation
 * (prerequisites, strategy order, PAUSE_WRITES).
 */
import { describe, expect, it } from "vitest";
import type { Scenario } from "../../../src/core/model/types";
import { expandScenario } from "../../../src/core/events/event-types";
import { buildGraph } from "../../../src/core/events/dependency-graph";
import {
  validateEventSequence,
  validateEvents,
  validateScenario,
} from "../../../src/core/events/validate-events";

function uploadScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    scenarioId: "U01_DB_FIRST_UPLOAD_ORPHAN",
    strategy: "DB_FIRST",
    maxEvents: 10,
    operations: [
      { opId: "upload-A", kind: "UPLOAD", fileId: "A", objectId: "A-v1", digest: "fixture-digest-A" },
    ],
    ...overrides,
  };
}

function codes(result: { issues: readonly { code: string }[] }): string[] {
  return result.issues.map((i) => i.code);
}

describe("validateScenario — valid input", () => {
  it("accepts a valid single-upload scenario", () => {
    const result = validateScenario(uploadScenario());
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("accepts the G12 maximum scale: four uploads, ten events", () => {
    const scenario: Scenario = {
      scenarioId: "G12_PAUSE_WRITES_FOUR_UPLOADS",
      strategy: "PAUSE_WRITES",
      maxEvents: 10,
      operations: ["A", "B", "C", "D"].map((fileId) => ({
        opId: `upload-${fileId}`,
        kind: "UPLOAD" as const,
        fileId,
        objectId: `${fileId}-v1`,
        digest: `fixture-digest-${fileId}`,
      })),
    };
    const result = validateScenario(scenario);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("accepts an idle scenario with no operations", () => {
    const result = validateScenario({
      scenarioId: "G01_IDLE",
      strategy: "DB_FIRST",
      maxEvents: 10,
      operations: [],
    });
    expect(result.valid).toBe(true);
  });

  it("accepts DELETE and UPDATE scenarios with implied records", () => {
    const scenario: Scenario = {
      scenarioId: "DELETE_UPDATE",
      strategy: "FILE_FIRST",
      maxEvents: 10,
      operations: [
        { opId: "del-C", kind: "DELETE", fileId: "C", objectId: "C-v1" },
        {
          opId: "upd-D",
          kind: "UPDATE",
          fileId: "D",
          objectId: "D-v2",
          oldObjectId: "D-v1",
          digest: "digest-D-v2",
        },
      ],
    };
    expect(validateScenario(scenario).valid).toBe(true);
  });

  it("accepts an upload followed by a delete of the same file", () => {
    const scenario: Scenario = {
      scenarioId: "UPLOAD_THEN_DELETE",
      strategy: "DB_FIRST",
      maxEvents: 10,
      operations: [
        { opId: "up", kind: "UPLOAD", fileId: "A", objectId: "A-v1", digest: "digest-v1" },
        { opId: "del", kind: "DELETE", fileId: "A", objectId: "A-v1" },
      ],
    };
    expect(validateScenario(scenario).valid).toBe(true);
  });
});

describe("validateScenario — structural problems", () => {
  it("rejects an empty scenarioId", () => {
    const result = validateScenario(uploadScenario({ scenarioId: "   " }));
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("EMPTY_SCENARIO_ID");
  });

  it("rejects an unknown strategy", () => {
    const bad = uploadScenario({ strategy: "DB_LAST" as Scenario["strategy"] });
    const result = validateScenario(bad);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("INVALID_STRATEGY");
  });

  it("rejects an unknown operation kind", () => {
    const bad = uploadScenario({
      operations: [
        {
          opId: "x",
          kind: "MOVE" as Scenario["operations"][number]["kind"],
          fileId: "A",
          objectId: "A-v1",
        } as Scenario["operations"][number],
      ],
    });
    const result = validateScenario(bad);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("INVALID_OPERATION_KIND");
  });

  it("rejects an operation missing its digest", () => {
    const bad = uploadScenario({
      operations: [
        {
          opId: "up",
          kind: "UPLOAD",
          fileId: "A",
          objectId: "A-v1",
        } as Scenario["operations"][number],
      ],
    });
    const result = validateScenario(bad);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("MISSING_REQUIRED_FIELD");
  });

  it("never throws on a null scenario", () => {
    const result = validateScenario(null as unknown as Scenario);
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

describe("validateScenario — duplicate IDs", () => {
  it("rejects duplicate operation IDs", () => {
    const scenario = uploadScenario({
      operations: [
        { opId: "dup", kind: "UPLOAD", fileId: "A", objectId: "A-v1", digest: "d-A" },
        { opId: "dup", kind: "UPLOAD", fileId: "B", objectId: "B-v1", digest: "d-B" },
      ],
    });
    const result = validateScenario(scenario);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("DUPLICATE_OPERATION_ID");
    // The same opId also produces duplicate event IDs.
    expect(codes(result)).toContain("DUPLICATE_EVENT_ID");
  });
});

describe("validateScenario — event-count bound", () => {
  it("rejects five uploads: 12 events exceed the bound of 10", () => {
    const scenario: Scenario = {
      scenarioId: "TOO_MANY",
      strategy: "DB_FIRST",
      maxEvents: 10,
      operations: ["A", "B", "C", "D", "E"].map((fileId) => ({
        opId: `upload-${fileId}`,
        kind: "UPLOAD" as const,
        fileId,
        objectId: `${fileId}-v1`,
        digest: `digest-${fileId}`,
      })),
    };
    const result = validateScenario(scenario);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("MAX_EVENTS_EXCEEDED");
  });

  it("rejects a maxEvents smaller than the events the scenario needs", () => {
    const result = validateScenario(uploadScenario({ maxEvents: 3 }));
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("MAX_EVENTS_EXCEEDED");
  });

  it("rejects a maxEvents above the supported bound", () => {
    const result = validateScenario(uploadScenario({ maxEvents: 11 }));
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("MAX_EVENTS_EXCEEDED");
  });
});

describe("validateScenario — unknown object-version references", () => {
  it("rejects a DELETE whose objectId disagrees with the live version", () => {
    const scenario: Scenario = {
      scenarioId: "DELETE_WRONG_VERSION",
      strategy: "DB_FIRST",
      maxEvents: 10,
      operations: [
        { opId: "up", kind: "UPLOAD", fileId: "A", objectId: "A-v1", digest: "digest-v1" },
        { opId: "del", kind: "DELETE", fileId: "A", objectId: "A-vX" },
      ],
    };
    const result = validateScenario(scenario);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("UNKNOWN_OBJECT_VERSION");
  });

  it("rejects a second DELETE of an already-deleted file", () => {
    const scenario: Scenario = {
      scenarioId: "DOUBLE_DELETE",
      strategy: "DB_FIRST",
      maxEvents: 10,
      operations: [
        { opId: "del1", kind: "DELETE", fileId: "C", objectId: "C-v1" },
        { opId: "del2", kind: "DELETE", fileId: "C", objectId: "C-v1" },
      ],
    };
    const result = validateScenario(scenario);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("UNKNOWN_OBJECT_VERSION");
  });

  it("rejects an UPDATE whose oldObjectId disagrees with the live version", () => {
    const scenario: Scenario = {
      scenarioId: "UPDATE_WRONG_OLD",
      strategy: "DB_FIRST",
      maxEvents: 10,
      operations: [
        { opId: "up", kind: "UPLOAD", fileId: "A", objectId: "A-v1", digest: "digest-v1" },
        {
          opId: "upd",
          kind: "UPDATE",
          fileId: "A",
          objectId: "A-v2",
          oldObjectId: "A-v9",
          digest: "digest-v2",
        },
      ],
    };
    const result = validateScenario(scenario);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("UNKNOWN_OBJECT_VERSION");
  });

  it("rejects an UPLOAD of a file that already holds a live record", () => {
    const scenario: Scenario = {
      scenarioId: "DOUBLE_UPLOAD",
      strategy: "DB_FIRST",
      maxEvents: 10,
      operations: [
        { opId: "up1", kind: "UPLOAD", fileId: "A", objectId: "A-v1", digest: "digest-v1" },
        { opId: "up2", kind: "UPLOAD", fileId: "A", objectId: "A-v2", digest: "digest-v2" },
      ],
    };
    const result = validateScenario(scenario);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("UNKNOWN_OBJECT_VERSION");
  });
});

describe("validateEvents — illegal DAG fails closed", () => {
  it("rejects a cyclic event graph with CYCLE_IN_DAG", () => {
    const events = expandScenario(uploadScenario()).allEvents;
    const result = validateEvents(events, [
      { from: "upload-A:BLOB_PUT", to: "upload-A:DB_LINK", reason: "template" },
      { from: "upload-A:DB_LINK", to: "upload-A:BLOB_PUT", reason: "illegal back edge" },
    ]);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("CYCLE_IN_DAG");
  });

  it("rejects duplicate event IDs in a raw event list", () => {
    const events = expandScenario(uploadScenario()).allEvents;
    const result = validateEvents([...events, events[0] as (typeof events)[number]]);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("DUPLICATE_EVENT_ID");
  });

  it("rejects edges referencing unknown events", () => {
    const events = expandScenario(uploadScenario()).allEvents;
    const result = validateEvents(events, [
      { from: "upload-A:BLOB_PUT", to: "no-such-event", reason: "dangling" },
    ]);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("UNKNOWN_OBJECT_VERSION");
  });

  it("accepts an acyclic raw event list", () => {
    const events = expandScenario(uploadScenario()).allEvents;
    const result = validateEvents(events, [
      { from: "upload-A:BLOB_PUT", to: "upload-A:DB_LINK", reason: "template" },
    ]);
    expect(result.valid).toBe(true);
  });

  it("buildGraph with a cycle also fails validateEvents via the scenario path", () => {
    // A scenario-built graph is acyclic by construction; the fail-closed path
    // is the raw-list one above. This guards the wiring: validateEvents on a
    // cyclic graph built with buildGraph reports the cycle.
    const events = expandScenario(uploadScenario()).allEvents;
    const graph = buildGraph(events, [
      { from: "DB_SNAPSHOT", to: "BLOB_SNAPSHOT", reason: "strategy" },
      { from: "BLOB_SNAPSHOT", to: "DB_SNAPSHOT", reason: "illegal back edge" },
    ]);
    const result = validateEvents(graph.events, graph.edges);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("CYCLE_IN_DAG");
  });
});

describe("validateEventSequence", () => {
  it("accepts a legal full order for DB_FIRST", () => {
    const scenario = uploadScenario();
    const result = validateEventSequence(scenario, [
      "upload-A:BLOB_PUT",
      "upload-A:DB_LINK",
      "DB_SNAPSHOT",
      "BLOB_SNAPSHOT",
    ]);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("accepts the §9.1 scenario-A order (snapshots straddling the upload)", () => {
    const scenario = uploadScenario();
    const result = validateEventSequence(scenario, [
      "DB_SNAPSHOT",
      "upload-A:BLOB_PUT",
      "upload-A:DB_LINK",
      "BLOB_SNAPSHOT",
    ]);
    expect(result.valid).toBe(true);
  });

  it("rejects a sequence that skips a prerequisite", () => {
    const scenario = uploadScenario();
    const result = validateEventSequence(scenario, ["upload-A:DB_LINK", "upload-A:BLOB_PUT"]);
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("PREREQUISITE_NOT_MET");
  });

  it("rejects a repeated event in the sequence", () => {
    const scenario = uploadScenario();
    const result = validateEventSequence(scenario, [
      "upload-A:BLOB_PUT",
      "upload-A:BLOB_PUT",
      "upload-A:DB_LINK",
    ]);
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("DUPLICATE_EVENT");
  });

  it("rejects an unknown event ID in the sequence", () => {
    const scenario = uploadScenario();
    const result = validateEventSequence(scenario, ["upload-A:BLOB_PUT", "no-such-event"]);
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("UNKNOWN_EVENT");
  });

  it("rejects the wrong snapshot order for DB_FIRST", () => {
    const scenario = uploadScenario();
    const result = validateEventSequence(scenario, [
      "upload-A:BLOB_PUT",
      "upload-A:DB_LINK",
      "BLOB_SNAPSHOT",
      "DB_SNAPSHOT",
    ]);
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("STRATEGY_ORDER_VIOLATED");
  });

  it("rejects the wrong snapshot order for FILE_FIRST", () => {
    const scenario = uploadScenario({ strategy: "FILE_FIRST" });
    const result = validateEventSequence(scenario, [
      "upload-A:BLOB_PUT",
      "upload-A:DB_LINK",
      "DB_SNAPSHOT",
      "BLOB_SNAPSHOT",
    ]);
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("STRATEGY_ORDER_VIOLATED");
  });

  it("rejects a data event between the snapshots under PAUSE_WRITES", () => {
    const scenario = uploadScenario({ strategy: "PAUSE_WRITES" });
    const result = validateEventSequence(scenario, [
      "DB_SNAPSHOT",
      "upload-A:BLOB_PUT",
      "upload-A:DB_LINK",
      "BLOB_SNAPSHOT",
    ]);
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("PAUSE_WRITES_VIOLATED");
  });

  it("rejects an in-flight operation at the first snapshot under PAUSE_WRITES", () => {
    const scenario = uploadScenario({ strategy: "PAUSE_WRITES" });
    const result = validateEventSequence(scenario, [
      "upload-A:BLOB_PUT",
      "DB_SNAPSHOT",
      "upload-A:DB_LINK",
      "BLOB_SNAPSHOT",
    ]);
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("PAUSE_WRITES_VIOLATED");
  });

  it("accepts a completed upload before both snapshots under PAUSE_WRITES", () => {
    const scenario = uploadScenario({ strategy: "PAUSE_WRITES" });
    const result = validateEventSequence(scenario, [
      "upload-A:BLOB_PUT",
      "upload-A:DB_LINK",
      "DB_SNAPSHOT",
      "BLOB_SNAPSHOT",
    ]);
    expect(result.valid).toBe(true);
  });
});

describe("validateScenario — snapshotsAfter (ADR-001)", () => {
  it("rejects a snapshotsAfter opId that is not in operations", () => {
    const result = validateScenario(
      uploadScenario({ snapshotsAfter: ["upload-A", "no-such-op"] }),
    );
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("UNKNOWN_OBJECT_VERSION");
    expect(result.issues.some((i) => i.message.includes("no-such-op"))).toBe(true);
    expect(result.issues.some((i) => i.subjectId === "no-such-op")).toBe(true);
  });

  it("accepts a snapshotsAfter opId that is present in operations", () => {
    const result = validateScenario(uploadScenario({ snapshotsAfter: ["upload-A"] }));
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("treats an empty snapshotsAfter array as absent", () => {
    const result = validateScenario(uploadScenario({ snapshotsAfter: [] }));
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("rejects a non-array snapshotsAfter value", () => {
    const result = validateScenario(
      uploadScenario({ snapshotsAfter: "upload-A" as unknown as string[] }),
    );
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("MISSING_REQUIRED_FIELD");
  });
});

describe("validateEventSequence — snapshotsAfter placement (ADR-001)", () => {
  it("rejects a snapshot before the listed operation completes", () => {
    const scenario = uploadScenario({ snapshotsAfter: ["upload-A"] });
    const result = validateEventSequence(scenario, [
      "DB_SNAPSHOT",
      "upload-A:BLOB_PUT",
      "upload-A:DB_LINK",
      "BLOB_SNAPSHOT",
    ]);
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("SNAPSHOT_PLACEMENT_VIOLATED");
  });

  it("accepts snapshots after the listed operation completes", () => {
    const scenario = uploadScenario({ snapshotsAfter: ["upload-A"] });
    const result = validateEventSequence(scenario, [
      "upload-A:BLOB_PUT",
      "upload-A:DB_LINK",
      "DB_SNAPSHOT",
      "BLOB_SNAPSHOT",
    ]);
    expect(result.valid).toBe(true);
  });
});
