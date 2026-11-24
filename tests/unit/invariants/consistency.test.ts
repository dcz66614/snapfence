/**
 * SnapFence (P030) — T004 unit tests: §4.3 common-boundary consistency.
 * Covers PROJECT_BOOK.md §4.2 (complete operation boundary: an operation
 * IN_FLIGHT is never a boundary), §4.3 (common legal operation boundary
 * + reference integrity + no unreferenced Blob + no operation in flight)
 * and §4.4 (all six diagnostic codes, with the frozen severities).
 *
 * Two judgements are tested, and the tests pin down exactly where they
 * differ (see src/core/invariants/consistency.ts header):
 * - checkConsistency (frozen signature): value-only; agrees exactly with
 *   T003 isConsistentSnapshotPair / diagnoseSnapshotPair on every
 *   distinct snapshot pair the BFS enumerates.
 * - checkConsistencyDetailed: value-first (ADR-002). The verdict is the
 *   value judgement; capture-time in-flight information only adds
 *   IN_FLIGHT_OPERATION as an explanatory diagnostic for
 *   value-inconsistent pairs. A value-consistent pair produces no
 *   diagnostics, even when a snapshot was captured mid-operation
 *   (reachable FILE_FIRST case asserted below).
 */
import { describe, expect, it } from "vitest";
import type {
  BlobState,
  DatabaseState,
  DiagnosticCode,
} from "../../../src/core/model/types";
import {
  checkConsistency,
  checkConsistencyDetailed,
  findMatchingBoundary,
  hasCommonBoundary,
} from "../../../src/core/invariants/consistency";
import { checkReferences } from "../../../src/core/invariants/reference-check";
import {
  computeBoundaries,
  diagnoseSnapshotPair,
  evaluateSequence,
  isConsistentSnapshotPair,
  runSearchDetailed,
} from "../../../src/core/search/bfs";
import { DIAGNOSTIC_SEVERITY } from "../../../src/core/search/search-result";
import {
  deleteScenarioC,
  fourUploadScenario,
  idleScenario,
  twoUploadScenario,
  updateScenario,
  uploadScenarioA,
  uploadScenarioB,
} from "../search/helpers";

const digestA = "fixture-digest-A";
const digestB = "fixture-digest-B";

describe("diagnostic code inventory (§4.4, verbatim)", () => {
  it("all six diagnostic codes exist with their frozen severities", () => {
    const codes: readonly DiagnosticCode[] = [
      "DANGLING_REFERENCE",
      "ORPHAN_BLOB",
      "GENERATION_MISMATCH",
      "DIGEST_MISMATCH",
      "IN_FLIGHT_OPERATION",
      "NO_COMMON_BOUNDARY",
    ];
    expect(codes).toHaveLength(6);
    expect(DIAGNOSTIC_SEVERITY["DANGLING_REFERENCE"]).toBe("CRITICAL");
    expect(DIAGNOSTIC_SEVERITY["ORPHAN_BLOB"]).toBe("WARNING");
    expect(DIAGNOSTIC_SEVERITY["GENERATION_MISMATCH"]).toBe("CRITICAL");
    expect(DIAGNOSTIC_SEVERITY["DIGEST_MISMATCH"]).toBe("CRITICAL");
    expect(DIAGNOSTIC_SEVERITY["IN_FLIGHT_OPERATION"]).toBe("WARNING");
    expect(DIAGNOSTIC_SEVERITY["NO_COMMON_BOUNDARY"]).toBe("CRITICAL");
  });
});

describe("checkConsistency — common legal operation boundary (§4.3)", () => {
  it("the initial boundary matches: two empty snapshots are consistent", () => {
    const boundaries = computeBoundaries(uploadScenarioA());
    const result = checkConsistency({}, {}, boundaries);
    expect(result.consistent).toBe(true);
    expect(result.matchedBoundaryIndex).toBe(0);
    expect(result.diagnostics).toEqual([]);
    expect(hasCommonBoundary({}, {}, boundaries)).toBe(true);
  });

  it("the completed-upload boundary matches: D and B both hold A-v1", () => {
    const boundaries = computeBoundaries(uploadScenarioA());
    const database: DatabaseState = { A: { objectId: "A-v1", generation: 1, digest: digestA } };
    const blob: BlobState = { "A-v1@1": digestA };
    const result = checkConsistency(database, blob, boundaries);
    expect(result.consistent).toBe(true);
    expect(result.matchedBoundaryIndex).toBe(1);
    expect(findMatchingBoundary(database, blob, boundaries)?.completedOperationIds).toEqual([
      "upload-A",
    ]);
  });

  it("scenario A straddling pair is inconsistent: ORPHAN_BLOB + NO_COMMON_BOUNDARY", () => {
    const boundaries = computeBoundaries(uploadScenarioA());
    const blob: BlobState = { "A-v1@1": digestA };
    const result = checkConsistency({}, blob, boundaries);
    expect(result.consistent).toBe(false);
    expect(result.matchedBoundaryIndex).toBeNull();
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "NO_COMMON_BOUNDARY",
      "ORPHAN_BLOB",
    ]);
  });

  it("scenario B dangling pair is inconsistent: DANGLING_REFERENCE + NO_COMMON_BOUNDARY", () => {
    const boundaries = computeBoundaries(uploadScenarioB());
    const database: DatabaseState = { B: { objectId: "B-v1", generation: 1, digest: digestB } };
    const result = checkConsistency(database, {}, boundaries);
    expect(result.consistent).toBe(false);
    expect(result.matchedBoundaryIndex).toBeNull();
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "DANGLING_REFERENCE",
      "NO_COMMON_BOUNDARY",
    ]);
  });

  it("a generation mismatch can never be a common boundary", () => {
    const boundaries = computeBoundaries(updateScenario("DB_FIRST"));
    // D points at A-v1 generation 2; the Blob snapshot holds the same
    // objectId A-v1 at generation 1 only. (A-v2 would be a different
    // objectId, not a different generation of A-v1 — that case is a
    // DANGLING_REFERENCE, asserted in reference-check.test.ts.)
    const database: DatabaseState = { A: { objectId: "A-v1", generation: 2, digest: "fixture-digest-A-v2" } };
    const blob: BlobState = { "A-v1@1": "fixture-digest-A-A-v1" };
    const result = checkConsistency(database, blob, boundaries);
    expect(result.consistent).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain("GENERATION_MISMATCH");
    expect(result.diagnostics.map((d) => d.code)).toContain("NO_COMMON_BOUNDARY");
    // The held generation-1 version is itself unreferenced at generation 2.
    expect(result.diagnostics.map((d) => d.code)).toContain("ORPHAN_BLOB");
  });

  it("a digest mismatch can never be a common boundary", () => {
    const boundaries = computeBoundaries(uploadScenarioA());
    const database: DatabaseState = { A: { objectId: "A-v1", generation: 1, digest: digestA } };
    const blob: BlobState = { "A-v1@1": "tampered-digest" };
    const result = checkConsistency(database, blob, boundaries);
    expect(result.consistent).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain("DIGEST_MISMATCH");
    expect(result.diagnostics.map((d) => d.code)).toContain("NO_COMMON_BOUNDARY");
  });

  it("a boundary matching only one component is not a common boundary", () => {
    const boundaries = computeBoundaries(twoUploadScenario("DB_FIRST"));
    // D is the both-uploads boundary, B is the A-only boundary: no single k fits both.
    const database: DatabaseState = {
      A: { objectId: "A-v1", generation: 1, digest: digestA },
      B: { objectId: "B-v1", generation: 1, digest: digestB },
    };
    const blob: BlobState = { "A-v1@1": digestA };
    const result = checkConsistency(database, blob, boundaries);
    expect(result.consistent).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain("DANGLING_REFERENCE");
    expect(result.diagnostics.map((d) => d.code)).toContain("NO_COMMON_BOUNDARY");
  });
});

describe("checkConsistencyDetailed — value-first, IN_FLIGHT is explanatory only (ADR-002)", () => {
  it("with no in-flight information it behaves exactly like checkConsistency", () => {
    const boundaries = computeBoundaries(uploadScenarioA());
    const blob: BlobState = { "A-v1@1": digestA };
    expect(checkConsistencyDetailed({}, blob, boundaries)).toEqual(
      checkConsistency({}, blob, boundaries),
    );
  });

  it("ADR-002: a value-consistent pair produces NO diagnostics even when captured mid-operation", () => {
    // CORRECTED by FIX-T004-L17 (was: "an in-flight operation is reported
    // even when the values match a boundary" — asserted inconsistent with
    // IN_FLIGHT_OPERATION + NO_COMMON_BOUNDARY). ADR-002 overturns the
    // T004 strict reading: the verdict is value-first, and
    // IN_FLIGHT_OPERATION is an explanatory diagnostic for
    // value-inconsistent pairs only. Values equal the completed-upload
    // boundary, so this pair is consistent with zero diagnostics even
    // though the capture happened while upload-A was still in flight.
    const boundaries = computeBoundaries(uploadScenarioA());
    const database: DatabaseState = { A: { objectId: "A-v1", generation: 1, digest: digestA } };
    const blob: BlobState = { "A-v1@1": digestA };
    const result = checkConsistencyDetailed(database, blob, boundaries, ["upload-A"]);
    expect(result.consistent).toBe(true);
    expect(result.matchedBoundaryIndex).toBe(1);
    expect(result.diagnostics).toEqual([]);
    // ...and the value-only judgement agrees, as before.
    expect(checkConsistency(database, blob, boundaries).consistent).toBe(true);
  });

  it("in-flight + value mismatch reports IN_FLIGHT_OPERATION and NO_COMMON_BOUNDARY together", () => {
    const boundaries = computeBoundaries(uploadScenarioA());
    const fileIdByOp = new Map([["upload-A", "A"]]);
    const result = checkConsistencyDetailed(
      {},
      { "A-v1@1": digestA },
      boundaries,
      ["upload-A"],
      fileIdByOp,
    );
    expect(result.consistent).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("IN_FLIGHT_OPERATION");
    expect(codes).toContain("ORPHAN_BLOB");
    expect(codes).toContain("NO_COMMON_BOUNDARY");
    expect(codes.filter((c) => c === "NO_COMMON_BOUNDARY")).toHaveLength(1);
    const inFlight = result.diagnostics.find((d) => d.code === "IN_FLIGHT_OPERATION");
    expect(inFlight?.fileId).toBe("A");
    expect(inFlight?.severity).toBe("WARNING");
  });

  it("ADR-002 regression: empty pair captured mid-upload IS consistent (FILE_FIRST all-empty path)", () => {
    // CORRECTED by FIX-T004-L17 (was: "reachable FILE_FIRST case: empty
    // pair captured mid-upload is not a boundary" — asserted inconsistent
    // with IN_FLIGHT_OPERATION + NO_COMMON_BOUNDARY). ADR-002 overturns
    // the T004 strict reading: [BLOB_SNAPSHOT, upload-B:BLOB_PUT,
    // DB_SNAPSHOT] captures two empty snapshots, value-matching the
    // initial boundary, so the pair is CONSISTENT with zero diagnostics
    // even though the DB snapshot was captured while upload-B was in
    // flight. A snapshot captures a state, not a moment: the captured
    // state equals a legal boundary state.
    const evaluation = evaluateSequence(uploadScenarioB(), [
      "BLOB_SNAPSHOT",
      "upload-B:BLOB_PUT",
      "DB_SNAPSHOT",
    ]);
    expect(evaluation.valid).toBe(true);
    expect(evaluation.consistent).toBe(true); // value-only (T003 semantics)
    expect(evaluation.databaseSnapshot).toEqual({});
    expect(evaluation.blobSnapshot).toEqual({});
    const boundaries = computeBoundaries(uploadScenarioB());
    const detailed = checkConsistencyDetailed(
      evaluation.databaseSnapshot ?? {},
      evaluation.blobSnapshot ?? {},
      boundaries,
      ["upload-B"],
      new Map([["upload-B", "B"]]),
    );
    expect(detailed.consistent).toBe(true);
    expect(detailed.matchedBoundaryIndex).toBe(0);
    expect(detailed.diagnostics).toEqual([]);
  });
});

describe("cross-check — T004 agrees with T003 on every enumerated snapshot pair", () => {
  it("checkConsistency matches isConsistentSnapshotPair for all distinct pairs", () => {
    const scenarios = [
      uploadScenarioA(),
      uploadScenarioB(),
      deleteScenarioC(),
      updateScenario("DB_FIRST"),
      updateScenario("FILE_FIRST"),
      twoUploadScenario("DB_FIRST"),
      twoUploadScenario("FILE_FIRST"),
      idleScenario("DB_FIRST"),
      fourUploadScenario("PAUSE_WRITES"),
    ];
    for (const scenario of scenarios) {
      const detailed = runSearchDetailed(scenario);
      for (const pair of detailed.snapshotPairs) {
        const t004 = checkConsistency(pair.database, pair.blob, detailed.boundaries);
        expect(t004.consistent).toBe(
          isConsistentSnapshotPair(pair.database, pair.blob, detailed.boundaries),
        );
        expect(t004.matchedBoundaryIndex).toBe(
          isConsistentSnapshotPair(pair.database, pair.blob, detailed.boundaries)
            ? findMatchingBoundary(pair.database, pair.blob, detailed.boundaries)
                ?.boundaryIndex ?? null
            : null,
        );
      }
    }
  });

  it("reference-clean is equivalent to a common boundary over every enumerated snapshot pair (ADR-002 extract gate)", () => {
    // extractCounterexample carries no boundaries list, so its value gate
    // is reference-cleanliness: a reachable reference-clean pair always
    // value-matches a common boundary, because any partially executed
    // operation leaves an orphan Blob or a dangling / mismatched
    // reference in the pair. This cross-check proves that gate exact on
    // every distinct snapshot pair the BFS enumerates for 9 scenarios;
    // if it ever failed, the extract gate would need the real boundaries.
    const scenarios = [
      uploadScenarioA(),
      uploadScenarioB(),
      deleteScenarioC(),
      updateScenario("DB_FIRST"),
      updateScenario("FILE_FIRST"),
      twoUploadScenario("DB_FIRST"),
      twoUploadScenario("FILE_FIRST"),
      idleScenario("DB_FIRST"),
      fourUploadScenario("PAUSE_WRITES"),
    ];
    let pairCount = 0;
    for (const scenario of scenarios) {
      const detailed = runSearchDetailed(scenario);
      for (const pair of detailed.snapshotPairs) {
        pairCount += 1;
        const referenceClean = checkReferences(pair.database, pair.blob).length === 0;
        expect(referenceClean).toBe(
          hasCommonBoundary(pair.database, pair.blob, detailed.boundaries),
        );
      }
    }
    expect(pairCount).toBeGreaterThan(0);
  });

  it("checkConsistencyDetailed matches diagnoseSnapshotPair on BFS counterexample pairs", () => {
    const scenarios = [
      uploadScenarioA(),
      uploadScenarioB(),
      deleteScenarioC(),
      updateScenario("DB_FIRST"),
      twoUploadScenario("DB_FIRST"),
    ];
    for (const scenario of scenarios) {
      const detailed = runSearchDetailed(scenario);
      expect(detailed.result.verdict).toBe("UNSAFE_WITHIN_BOUND");
      const trace = detailed.trace;
      expect(trace).not.toBeNull();
      if (trace === null) {
        continue;
      }
      const dbStep = trace.steps.find((s) => s.eventId === "DB_SNAPSHOT");
      const blobStep = trace.steps.find((s) => s.eventId === "BLOB_SNAPSHOT");
      expect(dbStep).toBeDefined();
      expect(blobStep).toBeDefined();
      const databaseSnapshot = dbStep?.databaseStateAfter ?? {};
      const blobSnapshot = blobStep?.blobStateAfter ?? {};
      const fileIdByOp = new Map(
        scenario.operations.map((op) => [op.opId, op.fileId] as const),
      );
      // Exact per-snapshot in-flight derivation from the trace: an op is
      // in flight at a snapshot when it has a data event before that
      // snapshot and its template is not complete before it. Template
      // sizes: UPLOAD / DELETE 2 events, UPDATE 3 (§3.2).
      const templateSize = (opId: string): number => {
        const op = scenario.operations.find((o) => o.opId === opId);
        return op?.kind === "UPDATE" ? 3 : 2;
      };
      const inFlightAt = (snapshotId: string): readonly string[] => {
        const idx = trace.steps.findIndex((s) => s.eventId === snapshotId);
        const counts = new Map<string, number>();
        for (let i = 0; i < idx; i++) {
          const step = trace.steps[i];
          if (step === undefined || !step.eventId.includes(":")) {
            continue;
          }
          const opId = step.eventId.split(":")[0] as string;
          counts.set(opId, (counts.get(opId) ?? 0) + 1);
        }
        const inFlight: string[] = [];
        for (const [opId, count] of counts) {
          if (count > 0 && count < templateSize(opId)) {
            inFlight.push(opId);
          }
        }
        return inFlight.sort();
      };
      const dbInFlight = inFlightAt("DB_SNAPSHOT");
      const blobInFlight = inFlightAt("BLOB_SNAPSHOT");
      const union = [...new Set([...dbInFlight, ...blobInFlight])].sort();
      const t004 = checkConsistencyDetailed(
        databaseSnapshot,
        blobSnapshot,
        detailed.boundaries,
        union,
        fileIdByOp,
      );
      const t003 = diagnoseSnapshotPair(
        databaseSnapshot,
        blobSnapshot,
        false,
        dbInFlight,
        blobInFlight,
        fileIdByOp,
      );
      expect(t004.diagnostics).toEqual(t003);
      expect(t004.consistent).toBe(false);
      expect(t004.diagnostics).toEqual(detailed.result.diagnostics);
    }
  });
});
