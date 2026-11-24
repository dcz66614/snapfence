/**
 * SnapFence (P030) — T002 unit tests: dependency DAG + cycle detection.
 * Covers: template-order edges, same-file chain edges, strategy snapshot
 * order edges, deterministic topological order (lexicographic tie-break),
 * cycle detection on an illegal DAG, and fail-closed topological order.
 */
import { describe, expect, it } from "vitest";
import type { Scenario } from "../../../src/core/model/types";
import { expandScenario } from "../../../src/core/events/event-types";
import {
  buildDependencyGraph,
  buildGraph,
  dependentsOf,
  detectCycle,
  eventById,
  hasCycle,
  prerequisitesOf,
  topologicalOrder,
} from "../../../src/core/events/dependency-graph";

function uploadScenario(strategy: Scenario["strategy"] = "DB_FIRST"): Scenario {
  return {
    scenarioId: "UPLOAD_ONE",
    strategy,
    maxEvents: 10,
    operations: [
      { opId: "up", kind: "UPLOAD", fileId: "A", objectId: "A-v1", digest: "digest-A" },
    ],
  };
}

describe("buildDependencyGraph — template edges", () => {
  it("adds BLOB_PUT -> DB_LINK for UPLOAD", () => {
    const graph = buildDependencyGraph(uploadScenario());
    expect(prerequisitesOf(graph, "up:DB_LINK")).toEqual(["up:BLOB_PUT"]);
    expect(prerequisitesOf(graph, "up:BLOB_PUT")).toEqual([]);
    expect(dependentsOf(graph, "up:BLOB_PUT")).toEqual(["up:DB_LINK"]);
  });

  it("adds the full UPDATE chain", () => {
    const scenario: Scenario = {
      scenarioId: "UPDATE_ONE",
      strategy: "DB_FIRST",
      maxEvents: 10,
      operations: [
        {
          opId: "upd",
          kind: "UPDATE",
          fileId: "A",
          objectId: "A-v2",
          oldObjectId: "A-v1",
          digest: "digest-v2",
        },
      ],
    };
    const graph = buildDependencyGraph(scenario);
    expect(prerequisitesOf(graph, "upd:DB_REPOINT")).toEqual(["upd:BLOB_PUT_NEW"]);
    expect(prerequisitesOf(graph, "upd:BLOB_DELETE_OLD")).toEqual(["upd:DB_REPOINT"]);
    expect(prerequisitesOf(graph, "upd:BLOB_PUT_NEW")).toEqual([]);
  });

  it("adds DB_UNLINK -> BLOB_DELETE for DELETE", () => {
    const scenario: Scenario = {
      scenarioId: "DELETE_ONE",
      strategy: "FILE_FIRST",
      maxEvents: 10,
      operations: [{ opId: "del", kind: "DELETE", fileId: "C", objectId: "C-v1" }],
    };
    const graph = buildDependencyGraph(scenario);
    expect(prerequisitesOf(graph, "del:BLOB_DELETE")).toEqual(["del:DB_UNLINK"]);
  });
});

describe("buildDependencyGraph — strategy snapshot order", () => {
  it("DB_FIRST adds DB_SNAPSHOT -> BLOB_SNAPSHOT", () => {
    const graph = buildDependencyGraph(uploadScenario("DB_FIRST"));
    expect(prerequisitesOf(graph, "BLOB_SNAPSHOT")).toEqual(["DB_SNAPSHOT"]);
    expect(prerequisitesOf(graph, "DB_SNAPSHOT")).toEqual([]);
  });

  it("FILE_FIRST adds BLOB_SNAPSHOT -> DB_SNAPSHOT", () => {
    const graph = buildDependencyGraph(uploadScenario("FILE_FIRST"));
    expect(prerequisitesOf(graph, "DB_SNAPSHOT")).toEqual(["BLOB_SNAPSHOT"]);
    expect(prerequisitesOf(graph, "BLOB_SNAPSHOT")).toEqual([]);
  });

  it("PAUSE_WRITES adds no snapshot-order edge", () => {
    const graph = buildDependencyGraph(uploadScenario("PAUSE_WRITES"));
    expect(prerequisitesOf(graph, "DB_SNAPSHOT")).toEqual([]);
    expect(prerequisitesOf(graph, "BLOB_SNAPSHOT")).toEqual([]);
  });
});

describe("buildDependencyGraph — same-file chains", () => {
  it("chains a later operation on the same file after the earlier one", () => {
    const scenario: Scenario = {
      scenarioId: "UPLOAD_THEN_DELETE",
      strategy: "DB_FIRST",
      maxEvents: 10,
      operations: [
        { opId: "up", kind: "UPLOAD", fileId: "A", objectId: "A-v1", digest: "digest-v1" },
        { opId: "del", kind: "DELETE", fileId: "A", objectId: "A-v1" },
      ],
    };
    const graph = buildDependencyGraph(scenario);
    expect(prerequisitesOf(graph, "del:DB_UNLINK")).toEqual(["up:DB_LINK"]);
    expect(dependentsOf(graph, "up:DB_LINK")).toEqual(["del:DB_UNLINK"]);
  });

  it("does not chain operations on different files", () => {
    const scenario: Scenario = {
      scenarioId: "TWO_UPLOADS",
      strategy: "DB_FIRST",
      maxEvents: 10,
      operations: [
        { opId: "up1", kind: "UPLOAD", fileId: "A", objectId: "A-v1", digest: "digest-A" },
        { opId: "up2", kind: "UPLOAD", fileId: "B", objectId: "B-v1", digest: "digest-B" },
      ],
    };
    const graph = buildDependencyGraph(scenario);
    expect(prerequisitesOf(graph, "up2:BLOB_PUT")).toEqual([]);
  });
});

describe("topologicalOrder — deterministic", () => {
  it("returns a valid order respecting every edge", () => {
    const scenario: Scenario = {
      scenarioId: "MIXED",
      strategy: "DB_FIRST",
      maxEvents: 10,
      operations: [
        { opId: "up1", kind: "UPLOAD", fileId: "A", objectId: "A-v1", digest: "digest-A" },
        { opId: "up2", kind: "UPLOAD", fileId: "B", objectId: "B-v1", digest: "digest-B" },
      ],
    };
    const graph = buildDependencyGraph(scenario);
    const order = topologicalOrder(graph);
    expect(order).not.toBeNull();
    expect(order).toEqual([
      "DB_SNAPSHOT",
      "BLOB_SNAPSHOT",
      "up1:BLOB_PUT",
      "up1:DB_LINK",
      "up2:BLOB_PUT",
      "up2:DB_LINK",
    ]);
    // Every edge's `from` precedes its `to`.
    for (const edge of graph.edges) {
      expect(order?.indexOf(edge.from) ?? -1).toBeLessThan(order?.indexOf(edge.to) ?? -1);
    }
  });

  it("is deterministic across repeated calls", () => {
    const graph = buildDependencyGraph(uploadScenario());
    expect(topologicalOrder(graph)).toEqual(topologicalOrder(graph));
  });

  it("covers every event exactly once", () => {
    const graph = buildDependencyGraph(uploadScenario());
    const order = topologicalOrder(graph);
    expect(order).toHaveLength(graph.events.length);
    expect(new Set(order).size).toBe(graph.events.length);
  });
});

describe("cycle detection — illegal DAG fails closed", () => {
  it("detects a two-node cycle and reports it closed", () => {
    const events = expandScenario(uploadScenario()).allEvents;
    const cyclic = buildGraph(events, [
      { from: "up:BLOB_PUT", to: "up:DB_LINK", reason: "template" },
      { from: "up:DB_LINK", to: "up:BLOB_PUT", reason: "illegal back edge" },
    ]);
    const cycle = detectCycle(cyclic);
    expect(cycle).not.toBeNull();
    expect(cycle).toEqual(["up:BLOB_PUT", "up:DB_LINK", "up:BLOB_PUT"]);
    expect(hasCycle(cyclic)).toBe(true);
    // Fail-closed: no topological order is returned for a cyclic graph.
    expect(topologicalOrder(cyclic)).toBeNull();
  });

  it("detects a three-node cycle through the snapshot events", () => {
    const events = expandScenario(uploadScenario()).allEvents;
    const cyclic = buildGraph(events, [
      { from: "up:BLOB_PUT", to: "DB_SNAPSHOT", reason: "test edge" },
      { from: "DB_SNAPSHOT", to: "BLOB_SNAPSHOT", reason: "strategy" },
      { from: "BLOB_SNAPSHOT", to: "up:BLOB_PUT", reason: "illegal back edge" },
    ]);
    expect(hasCycle(cyclic)).toBe(true);
    expect(detectCycle(cyclic)).toEqual([
      "BLOB_SNAPSHOT",
      "up:BLOB_PUT",
      "DB_SNAPSHOT",
      "BLOB_SNAPSHOT",
    ]);
    expect(topologicalOrder(cyclic)).toBeNull();
  });

  it("reports no cycle for a scenario-built DAG", () => {
    const graph = buildDependencyGraph(uploadScenario());
    expect(detectCycle(graph)).toBeNull();
    expect(hasCycle(graph)).toBe(false);
  });

  it("a self-loop is a cycle", () => {
    const events = expandScenario(uploadScenario()).allEvents;
    const cyclic = buildGraph(events, [
      { from: "up:BLOB_PUT", to: "up:BLOB_PUT", reason: "self-loop" },
    ]);
    expect(detectCycle(cyclic)).toEqual(["up:BLOB_PUT", "up:BLOB_PUT"]);
    expect(topologicalOrder(cyclic)).toBeNull();
  });
});

describe("eventById / buildGraph", () => {
  it("looks events up by ID and deduplicates edges", () => {
    const events = expandScenario(uploadScenario()).allEvents;
    const graph = buildGraph(events, [
      { from: "up:BLOB_PUT", to: "up:DB_LINK", reason: "a" },
      { from: "up:BLOB_PUT", to: "up:DB_LINK", reason: "a again" },
    ]);
    expect(graph.edges).toHaveLength(1);
    expect(eventById(graph, "up:DB_LINK")?.kind).toBe("DB_LINK");
    expect(eventById(graph, "no-such-event")).toBeUndefined();
  });
});
