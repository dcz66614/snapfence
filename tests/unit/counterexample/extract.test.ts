/**
 * SnapFence (P030) — T004 unit tests: shortest-counterexample extraction.
 * Covers PROJECT_BOOK.md §4.6 (minimal event length, prefix ending at the
 * second snapshot per T003 L-10, lexicographic tie-break, output
 * contents: event order, per-event input/output state, snapshot contents,
 * diagnostic code(s), first failing operation, length) and the frozen
 * extractCounterexample signature (contracts.ts).
 *
 * Hand-derived expectations (BFS shortest prefixes — the §9 narrative
 * orderings are longer paths to the same inconsistency, not the shortest):
 * - Scenario A: [DB_SNAPSHOT, upload-A:BLOB_PUT, BLOB_SNAPSHOT] (length
 *   3; ORPHAN_BLOB — the Blob snapshot holds A-v1 while the DB snapshot
 *   does not reference it; upload-A in flight at the Blob capture).
 * - Scenario B: [upload-B:BLOB_PUT, BLOB_SNAPSHOT, DB_SNAPSHOT] (length
 *   3; ORPHAN_BLOB; upload-B in flight at the Blob capture).
 * - Scenario C: [delete-C:DB_UNLINK, DB_SNAPSHOT, BLOB_SNAPSHOT] (length
 *   3; ORPHAN_BLOB — the Blob snapshot still holds C-v1 while the DB
 *   snapshot no longer references it; delete-C in flight at the DB
 *   capture). The §9.3 four-event ordering
 *   [DB_SNAPSHOT, DB_UNLINK, BLOB_DELETE, BLOB_SNAPSHOT] is the
 *   DANGLING_REFERENCE path, asserted separately via evaluateSequence.
 */
import { describe, expect, it } from "vitest";
import type { BlobState, SearchTrace } from "../../../src/core/model/types";
import {
  compareCounterexamples,
  extractCounterexample,
  extractShortestCounterexample,
  inFlightOperationsAtCaptures,
  inFlightOperationsAtSnapshot,
  pickShortestCounterexample,
  truncateTraceAtSecondSnapshot,
} from "../../../src/core/counterexample/extract";
import {
  evaluateSequence,
  runSearch,
  runSearchDetailed,
} from "../../../src/core/search/bfs";
import {
  deleteScenarioC,
  fiveUploadScenario,
  idleScenario,
  twoUploadScenario,
  updateScenario,
  uploadScenarioA,
  uploadScenarioB,
} from "../search/helpers";

describe("extractCounterexample — §9 scenario A (3-event prefix)", () => {
  it("extracts the shortest prefix with snapshots, diagnostics and first failing operation", () => {
    const detailed = runSearchDetailed(uploadScenarioA());
    expect(detailed.trace).not.toBeNull();
    const counterexample = extractCounterexample(detailed.trace as SearchTrace);
    expect(counterexample.eventIds).toEqual([
      "DB_SNAPSHOT",
      "upload-A:BLOB_PUT",
      "BLOB_SNAPSHOT",
    ]);
    expect(counterexample.length).toBe(3);
    expect(counterexample.length).toBe(counterexample.eventIds.length);
    expect(counterexample.databaseSnapshot).toEqual({});
    expect(counterexample.blobSnapshot).toEqual({ "A-v1@1": "fixture-digest-A" });
    expect(counterexample.diagnostics.map((d) => d.code)).toEqual([
      "IN_FLIGHT_OPERATION",
      "NO_COMMON_BOUNDARY",
      "ORPHAN_BLOB",
    ]);
    expect(counterexample.firstFailingOperationId).toBe("upload-A");
    // Per-event input/output states (§4.6): one step per event, states evolve.
    expect(counterexample.trace.steps).toHaveLength(3);
    expect(counterexample.trace.steps[0]?.eventId).toBe("DB_SNAPSHOT");
    expect(counterexample.trace.steps[1]?.databaseStateBefore).toEqual({});
    expect(counterexample.trace.steps[1]?.blobStateAfter).toEqual({
      "A-v1@1": "fixture-digest-A",
    });
    expect(counterexample.trace.steps[2]?.blobStateBefore).toEqual({
      "A-v1@1": "fixture-digest-A",
    });
    // The extracted diagnostics agree exactly with the search result's
    // on codes and messages. (The search result's IN_FLIGHT_OPERATION
    // also carries fileId "A" from the scenario's op→file map; the
    // trace-only extractor cannot derive a fileId — see the module
    // header — so deep equality on the fileId field is not asserted
    // here. checkConsistencyDetailed, which takes the map, is deep-equal
    // to diagnoseSnapshotPair; see consistency.test.ts.)
    expect(counterexample.diagnostics.map((d) => d.code)).toEqual(
      detailed.result.diagnostics.map((d) => d.code),
    );
    expect(counterexample.diagnostics.map((d) => d.message)).toEqual(
      detailed.result.diagnostics.map((d) => d.message),
    );
  });

  it("extractShortestCounterexample agrees with runSearch for scenario A", () => {
    const counterexample = extractShortestCounterexample(uploadScenarioA());
    expect(counterexample).not.toBeNull();
    expect(counterexample?.eventIds).toEqual(runSearch(uploadScenarioA()).counterexample);
    expect(counterexample?.length).toBe(3);
  });
});

describe("extractCounterexample — §9 scenarios B and C (3-event prefixes)", () => {
  it("scenario B: [BLOB_PUT, BLOB_SNAPSHOT, DB_SNAPSHOT], first failing operation upload-B", () => {
    const detailed = runSearchDetailed(uploadScenarioB());
    const counterexample = extractCounterexample(detailed.trace as SearchTrace);
    expect(counterexample.eventIds).toEqual([
      "upload-B:BLOB_PUT",
      "BLOB_SNAPSHOT",
      "DB_SNAPSHOT",
    ]);
    expect(counterexample.length).toBe(3);
    expect(counterexample.databaseSnapshot).toEqual({});
    expect(counterexample.blobSnapshot).toEqual({ "B-v1@1": "fixture-digest-B" });
    expect(counterexample.diagnostics.map((d) => d.code)).toContain("ORPHAN_BLOB");
    expect(counterexample.diagnostics.map((d) => d.code)).toContain("IN_FLIGHT_OPERATION");
    expect(counterexample.diagnostics.map((d) => d.code)).toContain("NO_COMMON_BOUNDARY");
    expect(counterexample.firstFailingOperationId).toBe("upload-B");
    expect(counterexample.diagnostics.map((d) => d.code)).toEqual(
      detailed.result.diagnostics.map((d) => d.code),
    );
  });

  it("scenario C: [DB_UNLINK, DB_SNAPSHOT, BLOB_SNAPSHOT], first failing operation delete-C", () => {
    const detailed = runSearchDetailed(deleteScenarioC());
    const counterexample = extractCounterexample(detailed.trace as SearchTrace);
    expect(counterexample.eventIds).toEqual([
      "delete-C:DB_UNLINK",
      "DB_SNAPSHOT",
      "BLOB_SNAPSHOT",
    ]);
    expect(counterexample.length).toBe(3);
    expect(counterexample.databaseSnapshot).toEqual({});
    expect(counterexample.blobSnapshot).toEqual({ "C-v1@1": "fixture-digest-C-C-v1" });
    expect(counterexample.diagnostics.map((d) => d.code)).toContain("ORPHAN_BLOB");
    expect(counterexample.diagnostics.map((d) => d.code)).toContain("IN_FLIGHT_OPERATION");
    expect(counterexample.diagnostics.map((d) => d.code)).toContain("NO_COMMON_BOUNDARY");
    expect(counterexample.firstFailingOperationId).toBe("delete-C");
    expect(counterexample.diagnostics.map((d) => d.code)).toEqual(
      detailed.result.diagnostics.map((d) => d.code),
    );
  });

  it("scenario C's §9.3 four-event ordering is the DANGLING_REFERENCE path, not the shortest", () => {
    const evaluation = evaluateSequence(deleteScenarioC(), [
      "DB_SNAPSHOT",
      "delete-C:DB_UNLINK",
      "delete-C:BLOB_DELETE",
      "BLOB_SNAPSHOT",
    ]);
    expect(evaluation.valid).toBe(true);
    expect(evaluation.consistent).toBe(false);
    expect(evaluation.diagnostics.map((d) => d.code)).toContain("DANGLING_REFERENCE");
    // The BFS shortest counterexample for the same scenario is shorter (3, not 4).
    expect(runSearch(deleteScenarioC()).counterexampleLength).toBe(3);
  });
});

describe("extractCounterexample — truncation, clean traces, edge cases", () => {
  it("truncates a longer trace to the prefix ending at the second snapshot", () => {
    const detailed = runSearchDetailed(uploadScenarioA());
    const trace = detailed.trace as SearchTrace;
    // Append a fabricated fourth step (the DB_LINK that would complete
    // the upload after both snapshots): extraction must still return the
    // 3-event prefix, not the 4-event full path.
    const extended: SearchTrace = {
      ...trace,
      steps: [
        ...trace.steps,
        {
          stepIndex: 3,
          eventId: "upload-A:DB_LINK",
          databaseStateBefore: {},
          blobStateBefore: { "A-v1@1": "fixture-digest-A" },
          databaseStateAfter: { A: { objectId: "A-v1", generation: 1, digest: "fixture-digest-A" } },
          blobStateAfter: { "A-v1@1": "fixture-digest-A" },
          completedOperationIds: ["upload-A"],
        },
      ],
    };
    expect(truncateTraceAtSecondSnapshot(extended).steps).toHaveLength(3);
    const counterexample = extractCounterexample(extended);
    expect(counterexample.eventIds).toEqual([
      "DB_SNAPSHOT",
      "upload-A:BLOB_PUT",
      "BLOB_SNAPSHOT",
    ]);
    expect(counterexample.length).toBe(3);
  });

  it("a clean trace extracts with no diagnostics and no failing operation", () => {
    const detailed = runSearchDetailed(idleScenario("DB_FIRST"));
    expect(detailed.result.verdict).toBe("SAFE_WITHIN_BOUND");
    const counterexample = extractCounterexample(detailed.trace as SearchTrace);
    expect(counterexample.eventIds).toEqual(["DB_SNAPSHOT", "BLOB_SNAPSHOT"]);
    expect(counterexample.length).toBe(2);
    expect(counterexample.diagnostics).toEqual([]);
    expect(counterexample.firstFailingOperationId).toBeNull();
    expect(extractShortestCounterexample(idleScenario("DB_FIRST"))).toBeNull();
  });

  it("ADR-002 regression: the FILE_FIRST all-empty path extracts clean (value-first)", () => {
    // [BLOB_SNAPSHOT, upload-B:BLOB_PUT, DB_SNAPSHOT]: both snapshots are
    // empty (the initial boundary), but the DB snapshot was captured while
    // upload-B was in flight. Under the T004 strict reading this extracted
    // IN_FLIGHT_OPERATION + NO_COMMON_BOUNDARY; ADR-002 overturns that —
    // the pair is value-consistent, so extraction yields zero diagnostics
    // and no failing operation. The trace is hand-built (BFS never returns
    // a consistent terminal as a counterexample trace), following the
    // fabricated-step pattern of the truncation test above.
    const blobAfterPut: BlobState = { "B-v1@1": "fixture-digest-B" };
    const trace: SearchTrace = {
      scenarioId: "U07_FILE_FIRST_UPLOAD_DANGLING",
      strategy: "FILE_FIRST",
      steps: [
        {
          stepIndex: 0,
          eventId: "BLOB_SNAPSHOT",
          databaseStateBefore: {},
          blobStateBefore: {},
          databaseStateAfter: {},
          blobStateAfter: {},
          completedOperationIds: [],
        },
        {
          stepIndex: 1,
          eventId: "upload-B:BLOB_PUT",
          databaseStateBefore: {},
          blobStateBefore: {},
          databaseStateAfter: {},
          blobStateAfter: blobAfterPut,
          completedOperationIds: [],
        },
        {
          stepIndex: 2,
          eventId: "DB_SNAPSHOT",
          databaseStateBefore: {},
          blobStateBefore: blobAfterPut,
          databaseStateAfter: {},
          blobStateAfter: blobAfterPut,
          completedOperationIds: [],
        },
      ],
    };
    // The trace really does capture upload-B in flight at the DB snapshot.
    expect(inFlightOperationsAtCaptures(trace)).toEqual(["upload-B"]);
    const counterexample = extractCounterexample(trace);
    expect(counterexample.eventIds).toEqual([
      "BLOB_SNAPSHOT",
      "upload-B:BLOB_PUT",
      "DB_SNAPSHOT",
    ]);
    expect(counterexample.length).toBe(3);
    expect(counterexample.databaseSnapshot).toEqual({});
    expect(counterexample.blobSnapshot).toEqual({});
    expect(counterexample.diagnostics).toEqual([]);
    expect(counterexample.firstFailingOperationId).toBeNull();
    // ...and it is therefore not a counterexample candidate at all.
    expect(pickShortestCounterexample([trace])).toBeNull();
  });

  it("scenario A keeps IN_FLIGHT_OPERATION as an explanatory diagnostic (ADR-002)", () => {
    // ADR-002 §4: scenario A's pair is value-inconsistent (D=initial,
    // B=post-upload, no common boundary) AND its Blob snapshot was captured
    // mid-upload — so IN_FLIGHT stays alongside ORPHAN_BLOB and
    // NO_COMMON_BOUNDARY. (Also asserted exactly in the §9 scenario A test
    // above; repeated here so the ADR-002 pair of cases lives together.)
    const counterexample = extractShortestCounterexample(uploadScenarioA());
    expect(counterexample).not.toBeNull();
    expect(counterexample?.diagnostics.map((d) => d.code)).toEqual([
      "IN_FLIGHT_OPERATION",
      "NO_COMMON_BOUNDARY",
      "ORPHAN_BLOB",
    ]);
    expect(counterexample?.firstFailingOperationId).toBe("upload-A");
  });

  it("a PAUSE_WRITES safe trace extracts clean (snapshots never run mid-operation)", () => {
    const detailed = runSearchDetailed(uploadScenarioA("PAUSE_WRITES"));
    const counterexample = extractCounterexample(detailed.trace as SearchTrace);
    expect(counterexample.diagnostics).toEqual([]);
    expect(counterexample.firstFailingOperationId).toBeNull();
  });

  it("extractShortestCounterexample returns null for invalid and over-limit input", () => {
    expect(
      extractShortestCounterexample({
        scenarioId: "",
        strategy: "DB_FIRST",
        maxEvents: 10,
        operations: [],
      }),
    ).toBeNull();
    expect(extractShortestCounterexample(fiveUploadScenario())).toBeNull();
  });

  it("an empty trace extracts to an empty, clean counterexample", () => {
    const counterexample = extractCounterexample({
      scenarioId: "EMPTY",
      strategy: "DB_FIRST",
      steps: [],
    });
    expect(counterexample.eventIds).toEqual([]);
    expect(counterexample.length).toBe(0);
    expect(counterexample.diagnostics).toEqual([]);
    expect(counterexample.firstFailingOperationId).toBeNull();
  });
});

describe("in-flight derivation from the trace alone", () => {
  it("scenario A: upload-A is in flight at the Blob capture, not at the DB capture", () => {
    const detailed = runSearchDetailed(uploadScenarioA());
    const trace = detailed.trace as SearchTrace;
    expect(inFlightOperationsAtSnapshot(trace, "DB_SNAPSHOT")).toEqual([]);
    expect(inFlightOperationsAtSnapshot(trace, "BLOB_SNAPSHOT")).toEqual(["upload-A"]);
    expect(inFlightOperationsAtCaptures(trace)).toEqual(["upload-A"]);
  });

  it("an UPDATE in flight is detected by its 3-event template", () => {
    const detailed = runSearchDetailed(updateScenario("DB_FIRST"));
    const trace = detailed.trace as SearchTrace;
    expect(inFlightOperationsAtCaptures(trace)).toContain("update-A");
    expect(extractCounterexample(trace).firstFailingOperationId).toBe("update-A");
  });
});

describe("§4.6 ordering — compareCounterexamples and pickShortestCounterexample", () => {
  it("shorter wins over longer, regardless of event IDs", () => {
    const a = extractCounterexample(
      runSearchDetailed(uploadScenarioA()).trace as SearchTrace,
    );
    const idle = extractCounterexample(
      runSearchDetailed(idleScenario("DB_FIRST")).trace as SearchTrace,
    );
    // idle is shorter (2) but clean; compare is purely by length + order.
    expect(compareCounterexamples(idle, a)).toBeLessThan(0);
    expect(compareCounterexamples(a, idle)).toBeGreaterThan(0);
    expect(compareCounterexamples(a, a)).toBe(0);
  });

  it("same length: fixed lexicographic event-ID order breaks the tie (upload-A before upload-B)", () => {
    const traceA = runSearchDetailed(uploadScenarioA()).trace as SearchTrace;
    const traceB = runSearchDetailed(uploadScenarioB("DB_FIRST")).trace as SearchTrace;
    const a = extractCounterexample(traceA);
    const b = extractCounterexample(traceB);
    expect(a.length).toBe(b.length);
    expect(a.eventIds).toEqual(["DB_SNAPSHOT", "upload-A:BLOB_PUT", "BLOB_SNAPSHOT"]);
    expect(b.eventIds).toEqual(["DB_SNAPSHOT", "upload-B:BLOB_PUT", "BLOB_SNAPSHOT"]);
    expect(compareCounterexamples(a, b)).toBeLessThan(0);
    expect(compareCounterexamples(b, a)).toBeGreaterThan(0);
    // pickShortestCounterexample returns the lexicographically smaller one
    // no matter the input order.
    expect(pickShortestCounterexample([traceB, traceA])?.eventIds).toEqual(a.eventIds);
    expect(pickShortestCounterexample([traceA, traceB])?.eventIds).toEqual(a.eventIds);
  });

  it("pickShortestCounterexample returns null when no trace is inconsistent", () => {
    expect(
      pickShortestCounterexample([
        runSearchDetailed(idleScenario("DB_FIRST")).trace as SearchTrace,
      ]),
    ).toBeNull();
    expect(pickShortestCounterexample([])).toBeNull();
  });

  it("two-upload scenario: the BFS counterexample is the lexicographically smallest shortest prefix", () => {
    const detailed = runSearchDetailed(twoUploadScenario("DB_FIRST"));
    expect(detailed.result.counterexample).toEqual([
      "DB_SNAPSHOT",
      "upload-A:BLOB_PUT",
      "BLOB_SNAPSHOT",
    ]);
  });
});
