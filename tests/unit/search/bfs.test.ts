/**
 * SnapFence (P030) — T003 unit tests: deterministic BFS bounded search.
 * Covers PROJECT_BOOK.md §4.5–§4.7 and §9.1–§9.3:
 * - legal interleaving enumeration (incl. the §9 A/B/C orderings, judged
 *   through evaluateSequence);
 * - no DAG violations (brute-force permutation cross-check);
 * - all three snapshot orderings (DB_FIRST, FILE_FIRST, PAUSE_WRITES);
 * - max 10 atomic events incl. the 2 snapshot events (§10.3, D-05);
 * - all possible snapshot combinations identified;
 * - deterministic dedup (visited-state counts hand-derived in comments);
 * - over-limit input returns INCONCLUSIVE_LIMIT, never SAFE;
 * - invalid input returns INVALID_INPUT.
 *
 * Hand-derived expectations (see bfs.ts for the BFS order argument).
 * A terminal state is reached as soon as BOTH snapshots have executed —
 * the path need not execute the remaining data events, because the
 * captured pair is already fixed. The shortest counterexample is therefore
 * a prefix ending with the second snapshot, and BFS never extends a
 * terminal state (so states reachable only through a terminal state are
 * never visited):
 * - Scenario A (1 upload, DB_FIRST): 6 legal interleavings; visited 15
 *   deduped states; 6 terminal states; 3 distinct snapshot pairs;
 *   4 inconsistent terminals. Shortest counterexample (length 3):
 *   [DB_SNAPSHOT, upload-A:BLOB_PUT, BLOB_SNAPSHOT] — the Blob snapshot
 *   is taken while upload-A is in flight, so the diagnostics also carry
 *   IN_FLIGHT_OPERATION. (The §9.1 ordering
 *   [DB_SNAPSHOT, BLOB_PUT, DB_LINK, BLOB_SNAPSHOT] is also inconsistent,
 *   but longer.)
 * - Scenario B (1 upload, FILE_FIRST): 6 interleavings; visited 15;
 *   6 terminals; 4 pairs; 2 inconsistent terminals. Counterexample
 *   (length 3): [upload-B:BLOB_PUT, BLOB_SNAPSHOT, DB_SNAPSHOT].
 * - Scenario C (1 delete, DB_FIRST): 6 interleavings; visited 15;
 *   6 terminals; 4 pairs; 2 inconsistent terminals. Counterexample
 *   (length 3): [delete-C:DB_UNLINK, DB_SNAPSHOT, BLOB_SNAPSHOT].
 * - UPDATE has 3 data events, so 5!/(3!·2!) = 10 legal interleavings.
 * - PAUSE_WRITES, 1 upload: 4 legal interleavings; visited 9;
 *   2 terminals; 2 pairs; SAFE.
 *
 * NOTE (spec tension, L-08 in P030-T003.md): under the §4.5
 * full-interleaving enumeration ANY scenario with ≥1 operation under
 * DB_FIRST or FILE_FIRST is UNSAFE, because a snapshot pair can always
 * straddle two different operation boundaries. That contradicts plan §6.2
 * G02–G04 / G06–G08 ("upload/delete/update complete, then backup, SAFE"
 * as single-operation scenarios). These tests assert the §4.5 book
 * semantics (the book is authoritative per plan §14.1); the tension is
 * flagged for T005 / final review to resolve via ADR, not papered over
 * by restricting the search.
 */
import { describe, expect, it } from "vitest";
import type { BackupStrategy, Scenario } from "../../../src/core/model/types";
import { expandScenario } from "../../../src/core/events/event-types";
import { validateEventSequence } from "../../../src/core/events/validate-events";
import {
  computeBoundaries,
  countLegalInterleavings,
  evaluateSequence,
  renderPair,
  runSearch,
  runSearchDetailed,
} from "../../../src/core/search/bfs";
import { snapshotPairKey } from "../../../src/core/search/visited-key";
import {
  deleteScenarioC,
  fiveUploadScenario,
  fourUploadScenario,
  idleScenario,
  twoUploadScenario,
  updateScenario,
  uploadScenarioA,
  uploadScenarioB,
} from "./helpers";

/** All permutations of a list (brute-force oracle for small scenarios). */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length === 0) {
    return [[]];
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const head = items[i] as T;
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) {
      out.push([head, ...tail]);
    }
  }
  return out;
}

/** Complete legal orders of a scenario, by brute-force permutation filter. */
function bruteForceCompleteOrders(scenario: Scenario): string[][] {
  const ids = expandScenario(scenario).allEvents.map((event) => event.eventId);
  const orders: string[][] = [];
  for (const order of permutations(ids)) {
    if (validateEventSequence(scenario, order).valid) {
      orders.push(order);
    }
  }
  return orders;
}

function diagnosticCodes(result: ReturnType<typeof runSearch>): string[] {
  return result.diagnostics.map((d) => d.code);
}

describe("§9 scenarios A / B / C — verdict, shortest counterexample, snapshots", () => {
  it("scenario A (DB_FIRST upload) is UNSAFE with the shortest counterexample", () => {
    const result = runSearch(uploadScenarioA());
    expect(result.verdict).toBe("UNSAFE_WITHIN_BOUND");
    expect(result.schemaVersion).toBe("snapfence.report/v1");
    expect(result.eventCount).toBe(4);
    // Shortest inconsistent path: both snapshots complete at step 3; the
    // remaining DB_LINK is irrelevant to the captured pair, so BFS stops.
    // The Blob snapshot is taken while upload-A is in flight.
    expect(result.counterexample).toEqual([
      "DB_SNAPSHOT",
      "upload-A:BLOB_PUT",
      "BLOB_SNAPSHOT",
    ]);
    expect(result.counterexampleLength).toBe(3);
    expect(diagnosticCodes(result)).toEqual([
      "IN_FLIGHT_OPERATION",
      "NO_COMMON_BOUNDARY",
      "ORPHAN_BLOB",
    ]);
    expect(result.databaseSnapshot).toEqual({});
    expect(result.blobSnapshot).toEqual({ "A-v1@1": "fixture-digest-A" });
    // The counterexample path itself is a legal interleaving.
    expect(validateEventSequence(uploadScenarioA(), result.counterexample).valid).toBe(true);
  });

  it("scenario B (FILE_FIRST upload) is UNSAFE with the shortest counterexample", () => {
    const result = runSearch(uploadScenarioB());
    expect(result.verdict).toBe("UNSAFE_WITHIN_BOUND");
    expect(result.eventCount).toBe(4);
    // Shortest inconsistent path (length 3): the Blob snapshot is taken
    // after BLOB_PUT but the DB snapshot before DB_LINK; the §9.2 ordering
    // [BLOB_SNAPSHOT, BLOB_PUT, DB_LINK, DB_SNAPSHOT] is also inconsistent
    // but longer, so it is not the shortest counterexample.
    expect(result.counterexample).toEqual([
      "upload-B:BLOB_PUT",
      "BLOB_SNAPSHOT",
      "DB_SNAPSHOT",
    ]);
    expect(result.counterexampleLength).toBe(3);
    expect(diagnosticCodes(result)).toEqual([
      "IN_FLIGHT_OPERATION",
      "NO_COMMON_BOUNDARY",
      "ORPHAN_BLOB",
    ]);
    expect(result.databaseSnapshot).toEqual({});
    expect(result.blobSnapshot).toEqual({ "B-v1@1": "fixture-digest-B" });
  });

  it("scenario C (DB_FIRST delete) is UNSAFE with the shortest counterexample", () => {
    const result = runSearch(deleteScenarioC());
    expect(result.verdict).toBe("UNSAFE_WITHIN_BOUND");
    expect(result.eventCount).toBe(4);
    // Shortest inconsistent path (length 3): the DB snapshot is taken
    // after DB_UNLINK but the Blob snapshot before BLOB_DELETE. The §9.3
    // ordering [DB_SNAPSHOT, DB_UNLINK, BLOB_DELETE, BLOB_SNAPSHOT] is
    // also inconsistent but longer.
    expect(result.counterexample).toEqual([
      "delete-C:DB_UNLINK",
      "DB_SNAPSHOT",
      "BLOB_SNAPSHOT",
    ]);
    expect(result.counterexampleLength).toBe(3);
    expect(diagnosticCodes(result)).toEqual([
      "IN_FLIGHT_OPERATION",
      "NO_COMMON_BOUNDARY",
      "ORPHAN_BLOB",
    ]);
    expect(result.databaseSnapshot).toEqual({});
    expect(result.blobSnapshot).toEqual({ "C-v1@1": "fixture-digest-C-C-v1" });
  });

  it("the §9.1 / §9.2 / §9.3 orderings are all inconsistent when judged directly", () => {
    const a = evaluateSequence(uploadScenarioA(), [
      "DB_SNAPSHOT",
      "upload-A:BLOB_PUT",
      "upload-A:DB_LINK",
      "BLOB_SNAPSHOT",
    ]);
    expect(a.valid).toBe(true);
    expect(a.consistent).toBe(false);
    expect(a.diagnostics.map((d) => d.code)).toContain("ORPHAN_BLOB");

    const b = evaluateSequence(uploadScenarioB(), [
      "BLOB_SNAPSHOT",
      "upload-B:BLOB_PUT",
      "upload-B:DB_LINK",
      "DB_SNAPSHOT",
    ]);
    expect(b.valid).toBe(true);
    expect(b.consistent).toBe(false);
    expect(b.diagnostics.map((d) => d.code)).toContain("DANGLING_REFERENCE");

    const c = evaluateSequence(deleteScenarioC(), [
      "DB_SNAPSHOT",
      "delete-C:DB_UNLINK",
      "delete-C:BLOB_DELETE",
      "BLOB_SNAPSHOT",
    ]);
    expect(c.valid).toBe(true);
    expect(c.consistent).toBe(false);
    expect(c.diagnostics.map((d) => d.code)).toContain("DANGLING_REFERENCE");
  });

  it("consistent orderings judge consistent (both snapshots at one boundary)", () => {
    const a = evaluateSequence(uploadScenarioA(), [
      "upload-A:BLOB_PUT",
      "upload-A:DB_LINK",
      "DB_SNAPSHOT",
      "BLOB_SNAPSHOT",
    ]);
    expect(a.valid).toBe(true);
    expect(a.consistent).toBe(true);
    expect(a.diagnostics).toEqual([]);

    const idle = evaluateSequence(uploadScenarioA(), ["DB_SNAPSHOT", "BLOB_SNAPSHOT"]);
    expect(idle.valid).toBe(true);
    expect(idle.consistent).toBe(true);
  });

  it("the counterexample trace carries per-event before/after states (§4.6)", () => {
    const detailed = runSearchDetailed(uploadScenarioA());
    expect(detailed.result.verdict).toBe("UNSAFE_WITHIN_BOUND");
    expect(detailed.trace).not.toBeNull();
    const trace = detailed.trace;
    if (trace === null) {
      throw new Error("expected a trace");
    }
    expect(trace.steps.map((s) => s.eventId)).toEqual([...detailed.result.counterexample]);
    expect(trace.steps).toHaveLength(3);
    expect(trace.steps.map((s) => s.stepIndex)).toEqual([0, 1, 2]);
    // Step 0: DB_SNAPSHOT captures the empty database.
    expect(trace.steps[0]?.databaseStateBefore).toEqual({});
    expect(trace.steps[0]?.databaseStateAfter).toEqual({});
    // Step 1: BLOB_PUT writes the object; the upload is now in flight.
    expect(trace.steps[1]?.eventId).toBe("upload-A:BLOB_PUT");
    expect(trace.steps[1]?.blobStateBefore).toEqual({});
    expect(trace.steps[1]?.blobStateAfter).toEqual({ "A-v1@1": "fixture-digest-A" });
    expect(trace.steps[1]?.completedOperationIds).toEqual([]);
    // Step 2: BLOB_SNAPSHOT captures the written object while DB_LINK
    // has not executed yet.
    expect(trace.steps[2]?.eventId).toBe("BLOB_SNAPSHOT");
    expect(trace.steps[2]?.blobStateBefore).toEqual({ "A-v1@1": "fixture-digest-A" });
    expect(trace.steps[2]?.blobStateAfter).toEqual({ "A-v1@1": "fixture-digest-A" });
    expect(trace.steps[2]?.completedOperationIds).toEqual([]);
    expect(trace.steps[2]?.databaseStateAfter).toEqual({});
  });
});

describe("legal interleaving enumeration and DAG legality", () => {
  it("counts the legal interleavings for each §9 single-operation scenario", () => {
    expect(countLegalInterleavings(uploadScenarioA())).toBe(6);
    expect(countLegalInterleavings(uploadScenarioB())).toBe(6);
    expect(countLegalInterleavings(deleteScenarioC())).toBe(6);
    // UPDATE has 3 data events + 2 snapshots: 5!/(3!·2!) = 10.
    expect(countLegalInterleavings(updateScenario("DB_FIRST"))).toBe(10);
  });

  it("countLegalInterleavings matches brute-force permutation enumeration", () => {
    for (const scenario of [
      uploadScenarioA(),
      uploadScenarioB(),
      deleteScenarioC(),
      updateScenario("FILE_FIRST"),
      uploadScenarioA("PAUSE_WRITES"),
      idleScenario("DB_FIRST"),
    ]) {
      expect(countLegalInterleavings(scenario)).toBe(bruteForceCompleteOrders(scenario).length);
    }
  });

  it("every brute-force complete order replays cleanly and no counted order violates the DAG", () => {
    for (const scenario of [uploadScenarioA(), deleteScenarioC(), twoUploadScenario("DB_FIRST")]) {
      const orders = bruteForceCompleteOrders(scenario);
      expect(orders.length).toBe(countLegalInterleavings(scenario));
      for (const order of orders) {
        expect(validateEventSequence(scenario, order).valid).toBe(true);
        const judged = evaluateSequence(scenario, order);
        expect(judged.valid).toBe(true);
        expect(judged.appliedEventIds).toEqual(order);
      }
    }
  });

  it("two independent uploads (DB_FIRST) have 90 legal interleavings", () => {
    expect(countLegalInterleavings(twoUploadScenario("DB_FIRST"))).toBe(90);
    expect(bruteForceCompleteOrders(twoUploadScenario("DB_FIRST")).length).toBe(90);
  });

  it("PAUSE_WRITES with one upload has exactly 4 legal interleavings", () => {
    // [P,L,D,B], [P,L,B,D], [D,B,P,L], [B,D,P,L] — snapshots adjacent or
    // both after the operation; [B,D,P,L] is legal (nothing executes
    // between the two snapshots).
    expect(countLegalInterleavings(uploadScenarioA("PAUSE_WRITES"))).toBe(4);
    expect(bruteForceCompleteOrders(uploadScenarioA("PAUSE_WRITES")).length).toBe(4);
  });
});

describe("three snapshot orderings", () => {
  it("DB_FIRST / FILE_FIRST upload are UNSAFE; PAUSE_WRITES upload is SAFE", () => {
    expect(runSearch(uploadScenarioA("DB_FIRST")).verdict).toBe("UNSAFE_WITHIN_BOUND");
    expect(runSearch(uploadScenarioA("FILE_FIRST")).verdict).toBe("UNSAFE_WITHIN_BOUND");
    const paused = runSearch(uploadScenarioA("PAUSE_WRITES"));
    expect(paused.verdict).toBe("SAFE_WITHIN_BOUND");
    expect(paused.counterexample).toEqual([]);
    expect(paused.counterexampleLength).toBe(0);
    expect(paused.diagnostics).toEqual([]);
  });

  it("DB_FIRST and FILE_FIRST give different counterexamples for the same upload", () => {
    const dbFirst = runSearch(uploadScenarioA("DB_FIRST"));
    const fileFirst = runSearch(uploadScenarioA("FILE_FIRST"));
    expect(dbFirst.counterexample[0]).toBe("DB_SNAPSHOT");
    expect(fileFirst.counterexample[0]).toBe("upload-A:BLOB_PUT");
    expect(fileFirst.counterexample).toEqual([
      "upload-A:BLOB_PUT",
      "BLOB_SNAPSHOT",
      "DB_SNAPSHOT",
    ]);
    expect(dbFirst.counterexample).not.toEqual(fileFirst.counterexample);
  });

  it("PAUSE_WRITES is SAFE for delete and update too", () => {
    expect(runSearch(deleteScenarioC("PAUSE_WRITES")).verdict).toBe("SAFE_WITHIN_BOUND");
    expect(runSearch(updateScenario("PAUSE_WRITES")).verdict).toBe("SAFE_WITHIN_BOUND");
  });

  it("DB_FIRST / FILE_FIRST delete and update are UNSAFE", () => {
    expect(runSearch(deleteScenarioC("FILE_FIRST")).verdict).toBe("UNSAFE_WITHIN_BOUND");
    expect(runSearch(updateScenario("DB_FIRST")).verdict).toBe("UNSAFE_WITHIN_BOUND");
    expect(runSearch(updateScenario("FILE_FIRST")).verdict).toBe("UNSAFE_WITHIN_BOUND");
  });

  it("idle scenarios are SAFE under all three strategies", () => {
    for (const strategy of ["DB_FIRST", "FILE_FIRST", "PAUSE_WRITES"] as const) {
      const result = runSearch(idleScenario(strategy));
      expect(result.verdict).toBe("SAFE_WITHIN_BOUND");
      expect(result.eventCount).toBe(2);
      expect(result.databaseSnapshot).toEqual({});
      expect(result.blobSnapshot).toEqual({});
    }
  });

  it("PAUSE_WRITES rejects snapshot-while-in-flight and data-between-snapshots orders", () => {
    const scenario = uploadScenarioA("PAUSE_WRITES");
    expect(
      validateEventSequence(scenario, [
        "upload-A:BLOB_PUT",
        "DB_SNAPSHOT",
        "upload-A:DB_LINK",
        "BLOB_SNAPSHOT",
      ]).valid,
    ).toBe(false);
    expect(
      validateEventSequence(scenario, [
        "DB_SNAPSHOT",
        "upload-A:BLOB_PUT",
        "BLOB_SNAPSHOT",
        "upload-A:DB_LINK",
      ]).valid,
    ).toBe(false);
    expect(
      evaluateSequence(scenario, [
        "upload-A:BLOB_PUT",
        "upload-A:DB_LINK",
        "DB_SNAPSHOT",
        "BLOB_SNAPSHOT",
      ]).consistent,
    ).toBe(true);
  });
});

describe("all possible snapshot combinations", () => {
  it("scenario A yields exactly the 3 reachable snapshot pairs", () => {
    const detailed = runSearchDetailed(uploadScenarioA());
    expect(detailed.snapshotPairs).toHaveLength(3);
    const keys = new Set(
      detailed.snapshotPairs.map((p) => snapshotPairKey(p.database, p.blob)),
    );
    expect(keys.has(snapshotPairKey({}, {}))).toBe(true);
    expect(keys.has(snapshotPairKey({}, { "A-v1@1": "fixture-digest-A" }))).toBe(true);
    expect(
      keys.has(
        snapshotPairKey(
          { A: { objectId: "A-v1", generation: 1, digest: "fixture-digest-A" } },
          { "A-v1@1": "fixture-digest-A" },
        ),
      ),
    ).toBe(true);
    // The pair (D={A}, B={}) is NOT reachable under DB_FIRST.
    expect(
      keys.has(
        snapshotPairKey(
          { A: { objectId: "A-v1", generation: 1, digest: "fixture-digest-A" } },
          {},
        ),
      ),
    ).toBe(false);
  });

  it("scenario B yields all 4 snapshot pairs", () => {
    const detailed = runSearchDetailed(uploadScenarioB());
    expect(detailed.snapshotPairs).toHaveLength(4);
    expect(detailed.statistics.distinctSnapshotPairCount).toBe(4);
  });

  it("scenario C yields all 4 snapshot pairs", () => {
    const detailed = runSearchDetailed(deleteScenarioC());
    expect(detailed.snapshotPairs).toHaveLength(4);
  });

  it("two-upload snapshot pairs from BFS match the brute-force pair set", () => {
    const scenario = twoUploadScenario("DB_FIRST");
    const detailed = runSearchDetailed(scenario);
    const brutePairs = new Set<string>();
    for (const order of bruteForceCompleteOrders(scenario)) {
      const judged = evaluateSequence(scenario, order);
      if (judged.databaseSnapshot !== null && judged.blobSnapshot !== null) {
        brutePairs.add(renderPair(judged.databaseSnapshot, judged.blobSnapshot));
      }
    }
    const bfsPairs = new Set(
      detailed.snapshotPairs.map((p) => renderPair(p.database, p.blob)),
    );
    expect(bfsPairs).toEqual(brutePairs);
  });
});

describe("deterministic dedup", () => {
  it("scenario A visits 15 deduped states (hand-derived), far fewer than raw paths", () => {
    const detailed = runSearchDetailed(uploadScenarioA());
    expect(detailed.statistics.visitedStateCount).toBe(15);
    expect(detailed.statistics.terminalStateCount).toBe(6);
    expect(detailed.statistics.distinctSnapshotPairCount).toBe(3);
    expect(detailed.statistics.inconsistentTerminalCount).toBe(4);
    expect(detailed.statistics.rejectedTransitionCount).toBe(0);
  });

  it("scenario B visits 15 deduped states; 6 terminals; 4 pairs; 2 inconsistent", () => {
    const detailed = runSearchDetailed(uploadScenarioB());
    expect(detailed.statistics.visitedStateCount).toBe(15);
    expect(detailed.statistics.terminalStateCount).toBe(6);
    expect(detailed.statistics.distinctSnapshotPairCount).toBe(4);
    expect(detailed.statistics.inconsistentTerminalCount).toBe(2);
    expect(detailed.statistics.rejectedTransitionCount).toBe(0);
  });

  it("scenario C visits 15 deduped states; 6 terminals; 4 pairs; 2 inconsistent", () => {
    const detailed = runSearchDetailed(deleteScenarioC());
    expect(detailed.statistics.visitedStateCount).toBe(15);
    expect(detailed.statistics.terminalStateCount).toBe(6);
    expect(detailed.statistics.distinctSnapshotPairCount).toBe(4);
    expect(detailed.statistics.inconsistentTerminalCount).toBe(2);
    expect(detailed.statistics.rejectedTransitionCount).toBe(0);
  });

  it("PAUSE_WRITES upload visits 9 deduped states; 2 terminals; 2 pairs; 0 inconsistent", () => {
    const detailed = runSearchDetailed(uploadScenarioA("PAUSE_WRITES"));
    expect(detailed.statistics.visitedStateCount).toBe(9);
    expect(detailed.statistics.terminalStateCount).toBe(2);
    expect(detailed.statistics.distinctSnapshotPairCount).toBe(2);
    expect(detailed.statistics.inconsistentTerminalCount).toBe(0);
    expect(detailed.statistics.rejectedTransitionCount).toBe(0);
  });

  it("two-upload BFS visits far fewer states than the 90 raw interleavings", () => {
    const detailed = runSearchDetailed(twoUploadScenario("DB_FIRST"));
    expect(detailed.statistics.visitedStateCount).toBeGreaterThan(0);
    expect(detailed.statistics.visitedStateCount).toBeLessThan(90);
    expect(detailed.statistics.rejectedTransitionCount).toBe(0);
  });
});

describe("legal operation boundaries", () => {
  it("enumerates the initial + per-operation boundaries for one upload", () => {
    const boundaries = computeBoundaries(uploadScenarioA());
    expect(boundaries).toHaveLength(2);
    expect(boundaries[0]?.boundaryIndex).toBe(0);
    expect(boundaries[0]?.databaseState).toEqual({});
    expect(boundaries[0]?.blobState).toEqual({});
    expect(boundaries[0]?.completedOperationIds).toEqual([]);
    expect(boundaries[1]?.completedOperationIds).toEqual(["upload-A"]);
    expect(boundaries[1]?.databaseState).toEqual({
      A: { objectId: "A-v1", generation: 1, digest: "fixture-digest-A" },
    });
    expect(boundaries[1]?.blobState).toEqual({ "A-v1@1": "fixture-digest-A" });
  });

  it("enumerates 4 boundaries for two independent uploads (one per subset)", () => {
    const boundaries = computeBoundaries(twoUploadScenario("DB_FIRST"));
    expect(boundaries).toHaveLength(4);
    expect(boundaries.map((b) => b.boundaryIndex)).toEqual([0, 1, 2, 3]);
  });
});

describe("10-event bound (§10.3, D-05: the bound INCLUDES the 2 snapshot events)", () => {
  it("G12 shape (4 uploads, PAUSE_WRITES) is SAFE at exactly 10 events", () => {
    const result = runSearch(fourUploadScenario("PAUSE_WRITES"));
    expect(result.eventCount).toBe(10);
    expect(result.verdict).toBe("SAFE_WITHIN_BOUND");
    expect(countLegalInterleavings(fourUploadScenario("PAUSE_WRITES"))).toBeGreaterThan(0);
  });

  it("G12 shape under DB_FIRST is UNSAFE at exactly 10 events", () => {
    const result = runSearch(fourUploadScenario("DB_FIRST"));
    expect(result.eventCount).toBe(10);
    expect(result.verdict).toBe("UNSAFE_WITHIN_BOUND");
    expect(result.counterexampleLength).toBeGreaterThan(0);
    expect(result.counterexampleLength).toBeLessThanOrEqual(10);
  });

  it("5 uploads (12 events incl. snapshots) return INCONCLUSIVE_LIMIT, never SAFE", () => {
    const result = runSearch(fiveUploadScenario("DB_FIRST"));
    expect(result.eventCount).toBe(12);
    expect(result.verdict).toBe("INCONCLUSIVE_LIMIT");
    expect(result.verdict).not.toBe("SAFE_WITHIN_BOUND");
    expect(result.counterexample).toEqual([]);
  });

  it("maxEvents above 10 returns INCONCLUSIVE_LIMIT", () => {
    const scenario: Scenario = { ...uploadScenarioA(), maxEvents: 11 };
    expect(runSearch(scenario).verdict).toBe("INCONCLUSIVE_LIMIT");
  });

  it("maxEvents below the events the scenario needs returns INCONCLUSIVE_LIMIT", () => {
    const scenario: Scenario = { ...uploadScenarioA(), maxEvents: 3 };
    expect(runSearch(scenario).verdict).toBe("INCONCLUSIVE_LIMIT");
  });

  it("countLegalInterleavings is 0 for over-limit scenarios", () => {
    expect(countLegalInterleavings(fiveUploadScenario())).toBe(0);
  });
});

describe("invalid input", () => {
  it("empty scenarioId returns INVALID_INPUT", () => {
    const scenario: Scenario = { ...uploadScenarioA(), scenarioId: "   " };
    expect(runSearch(scenario).verdict).toBe("INVALID_INPUT");
  });

  it("unknown strategy returns INVALID_INPUT", () => {
    const scenario = {
      ...uploadScenarioA(),
      strategy: "DB_LAST",
    } as unknown as Scenario;
    expect(runSearch(scenario).verdict).toBe("INVALID_INPUT");
  });

  it("duplicate operation ids return INVALID_INPUT", () => {
    const scenario: Scenario = {
      scenarioId: "DUP_OP",
      strategy: "DB_FIRST",
      maxEvents: 10,
      operations: [
        { opId: "upload-A", kind: "UPLOAD", fileId: "A", objectId: "A-v1", digest: "fixture-digest-A" },
        { opId: "upload-A", kind: "UPLOAD", fileId: "B", objectId: "B-v1", digest: "fixture-digest-B" },
      ],
    };
    expect(runSearch(scenario).verdict).toBe("INVALID_INPUT");
  });

  it("upload of a file that already holds a live record returns INVALID_INPUT", () => {
    const scenario: Scenario = {
      scenarioId: "UPLOAD_TWICE",
      strategy: "DB_FIRST",
      maxEvents: 10,
      operations: [
        { opId: "upload-A1", kind: "UPLOAD", fileId: "A", objectId: "A-v1", digest: "fixture-digest-A" },
        { opId: "upload-A2", kind: "UPLOAD", fileId: "A", objectId: "A-v2", digest: "fixture-digest-A-v2" },
      ],
    };
    expect(runSearch(scenario).verdict).toBe("INVALID_INPUT");
  });

  it("delete of an already-deleted file returns INVALID_INPUT", () => {
    const scenario: Scenario = {
      scenarioId: "DELETE_TWICE",
      strategy: "DB_FIRST",
      maxEvents: 10,
      operations: [
        { opId: "delete-C1", kind: "DELETE", fileId: "C", objectId: "C-v1" },
        { opId: "delete-C2", kind: "DELETE", fileId: "C", objectId: "C-v1" },
      ],
    };
    expect(runSearch(scenario).verdict).toBe("INVALID_INPUT");
  });

  it("update targeting the wrong old version returns INVALID_INPUT", () => {
    const scenario: Scenario = {
      scenarioId: "UPDATE_WRONG_OLD",
      strategy: "DB_FIRST",
      maxEvents: 10,
      operations: [
        {
          opId: "update-A",
          kind: "UPDATE",
          fileId: "A",
          objectId: "A-v2",
          oldObjectId: "A-WRONG",
          digest: "fixture-digest-A-v2",
        },
      ],
    };
    // First UPDATE on a never-seen file implies A-WRONG as the pre-existing
    // record, so this is valid; the genuinely invalid case is an UPDATE
    // after an UPLOAD that holds a different version.
    expect(runSearch(scenario).verdict).toBe("UNSAFE_WITHIN_BOUND");
    const chained: Scenario = {
      scenarioId: "UPDATE_WRONG_OLD_CHAINED",
      strategy: "DB_FIRST",
      maxEvents: 10,
      operations: [
        { opId: "upload-A", kind: "UPLOAD", fileId: "A", objectId: "A-v1", digest: "fixture-digest-A" },
        {
          opId: "update-A",
          kind: "UPDATE",
          fileId: "A",
          objectId: "A-v2",
          oldObjectId: "A-WRONG",
          digest: "fixture-digest-A-v2",
        },
      ],
    };
    expect(runSearch(chained).verdict).toBe("INVALID_INPUT");
  });

  it("runSearch never throws on null / non-object input", () => {
    expect(runSearch(null as unknown as Scenario).verdict).toBe("INVALID_INPUT");
    expect(runSearch(undefined as unknown as Scenario).verdict).toBe("INVALID_INPUT");
    expect(runSearch("nope" as unknown as Scenario).verdict).toBe("INVALID_INPUT");
  });

  it("INVALID_INPUT results name the validation failure and carry no counterexample", () => {
    const result = runSearch({ ...uploadScenarioA(), scenarioId: "" });
    expect(result.verdict).toBe("INVALID_INPUT");
    expect(result.counterexample).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.limitations.join(" ")).toContain("EMPTY_SCENARIO_ID");
  });
});

describe("in-flight diagnostics", () => {
  it("a snapshot taken mid-operation carries IN_FLIGHT_OPERATION", () => {
    const judged = evaluateSequence(uploadScenarioA(), [
      "DB_SNAPSHOT",
      "upload-A:BLOB_PUT",
      "BLOB_SNAPSHOT",
      "upload-A:DB_LINK",
    ]);
    // The DB snapshot was taken before the operation started; the Blob
    // snapshot was taken while upload-A was in flight (BLOB_PUT done,
    // DB_LINK not yet). The pair is inconsistent and in-flight.
    expect(judged.consistent).toBe(false);
    expect(judged.diagnostics.map((d) => d.code)).toContain("IN_FLIGHT_OPERATION");
    const inFlight = judged.diagnostics.find((d) => d.code === "IN_FLIGHT_OPERATION");
    expect(inFlight?.fileId).toBe("A");
    expect(inFlight?.severity).toBe("WARNING");
  });

  it("ADR-002 regression: the FILE_FIRST all-empty path is consistent with zero diagnostics", () => {
    // [BLOB_SNAPSHOT, upload-B:BLOB_PUT, DB_SNAPSHOT]: both snapshots are
    // empty, value-matching the initial boundary — yet the DB snapshot was
    // captured while upload-B was in flight (BLOB_PUT done, DB_LINK not
    // yet). ADR-002 value-first: the pair is CONSISTENT and produces NO
    // diagnostics; IN_FLIGHT_OPERATION is an explanatory diagnostic for
    // value-inconsistent pairs only. (The in-flight fact is real, not a
    // fixture omission: BLOB_PUT executed before DB_SNAPSHOT, DB_LINK
    // after it, so upload-B was definitionally in flight at capture.)
    const judged = evaluateSequence(uploadScenarioB(), [
      "BLOB_SNAPSHOT",
      "upload-B:BLOB_PUT",
      "DB_SNAPSHOT",
    ]);
    expect(judged.valid).toBe(true);
    expect(judged.consistent).toBe(true);
    expect(judged.databaseSnapshot).toEqual({});
    expect(judged.blobSnapshot).toEqual({});
    expect(judged.diagnostics).toEqual([]);
  });

  it("ADR-002: scenario A counterexample keeps IN_FLIGHT_OPERATION + ORPHAN_BLOB + NO_COMMON_BOUNDARY", () => {
    // The scenario A counterexample pair is value-inconsistent (D =
    // initial, B = after upload-A, no common boundary) AND its Blob
    // snapshot was captured mid-upload, so IN_FLIGHT_OPERATION stays as
    // an explanatory diagnostic alongside ORPHAN_BLOB and
    // NO_COMMON_BOUNDARY. Judged directly through evaluateSequence (the
    // same path runSearch reports as its counterexample).
    const judged = evaluateSequence(uploadScenarioA(), [
      "DB_SNAPSHOT",
      "upload-A:BLOB_PUT",
      "BLOB_SNAPSHOT",
    ]);
    expect(judged.valid).toBe(true);
    expect(judged.consistent).toBe(false);
    expect(judged.diagnostics.map((d) => d.code)).toEqual([
      "IN_FLIGHT_OPERATION",
      "NO_COMMON_BOUNDARY",
      "ORPHAN_BLOB",
    ]);
  });
});

describe("strategy type import sanity", () => {
  it("accepts every BackupStrategy literal", () => {
    for (const strategy of ["DB_FIRST", "FILE_FIRST", "PAUSE_WRITES"] as BackupStrategy[]) {
      expect(runSearch(idleScenario(strategy)).verdict).toBe("SAFE_WITHIN_BOUND");
    }
  });
});
