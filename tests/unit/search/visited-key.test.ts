/**
 * SnapFence (P030) — T003 unit tests: deterministic visited-state dedup key.
 * Covers: key components from PROJECT_BOOK.md §4.5 (executed set, current
 * DB state, current Blob state, both snapshot-captured states, per-operation
 * completion status) plus the documented capture-time in-flight extension;
 * equivalent states share one key; states differing in any component do not
 * merge; key is insensitive to record insertion order and execution order.
 */
import { describe, expect, it } from "vitest";
import type { SearchState } from "../../../src/core/search/search-state";
import {
  databaseStateKey,
  blobStateKey,
  stableStringify,
  visitedKey,
} from "../../../src/core/search/visited-key";

function baseState(): SearchState {
  return {
    path: ["upload-A:BLOB_PUT"],
    executedEventIds: ["upload-A:BLOB_PUT"],
    systemState: {
      database: {},
      blob: { "A-v1@1": "fixture-digest-A" },
      operationStatus: { "upload-A": "IN_FLIGHT" },
    },
    databaseSnapshot: null,
    blobSnapshot: null,
    dbSnapshotInFlightOperationIds: [],
    blobSnapshotInFlightOperationIds: [],
    steps: [],
  };
}

describe("stableStringify", () => {
  it("emits object keys in sorted order regardless of insertion order", () => {
    expect(stableStringify({ b: 1, a: { d: 4, c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: 4 }, b: 1 }),
    );
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("keeps array order (execution order matters inside arrays)", () => {
    expect(stableStringify(["b", "a"])).not.toBe(stableStringify(["a", "b"]));
  });
});

describe("databaseStateKey / blobStateKey", () => {
  it("is insensitive to record insertion order", () => {
    const dbA = {
      A: { objectId: "A-v1", generation: 1, digest: "fixture-digest-A" },
      B: { objectId: "B-v1", generation: 1, digest: "fixture-digest-B" },
    };
    const dbB = {
      B: { objectId: "B-v1", generation: 1, digest: "fixture-digest-B" },
      A: { objectId: "A-v1", generation: 1, digest: "fixture-digest-A" },
    };
    expect(databaseStateKey(dbA)).toBe(databaseStateKey(dbB));
    expect(blobStateKey({ "A-v1@1": "x", "B-v1@1": "y" })).toBe(
      blobStateKey({ "B-v1@1": "y", "A-v1@1": "x" }),
    );
  });

  it("changes when a digest, generation, or objectId changes", () => {
    const db = {
      A: { objectId: "A-v1", generation: 1, digest: "fixture-digest-A" },
    };
    expect(
      databaseStateKey({
        A: { objectId: "A-v1", generation: 1, digest: "other-digest" },
      }),
    ).not.toBe(databaseStateKey(db));
    expect(
      databaseStateKey({
        A: { objectId: "A-v1", generation: 2, digest: "fixture-digest-A" },
      }),
    ).not.toBe(databaseStateKey(db));
  });
});

describe("visitedKey", () => {
  it("is identical for equivalent states reached by different event orders", () => {
    // Two independent uploads: [A-PUT, B-PUT] vs [B-PUT, A-PUT] reach the
    // same executed set, same D/B, same snapshots, same op status.
    const viaAB: SearchState = {
      path: ["upload-A:BLOB_PUT", "upload-B:BLOB_PUT"],
      executedEventIds: ["upload-A:BLOB_PUT", "upload-B:BLOB_PUT"],
      systemState: {
        database: {},
        blob: { "A-v1@1": "fixture-digest-A", "B-v1@1": "fixture-digest-B" },
        operationStatus: { "upload-A": "IN_FLIGHT", "upload-B": "IN_FLIGHT" },
      },
      databaseSnapshot: null,
      blobSnapshot: null,
      dbSnapshotInFlightOperationIds: [],
      blobSnapshotInFlightOperationIds: [],
      steps: [],
    };
    const viaBA: SearchState = {
      ...viaAB,
      path: ["upload-B:BLOB_PUT", "upload-A:BLOB_PUT"],
      systemState: {
        database: {},
        blob: { "B-v1@1": "fixture-digest-B", "A-v1@1": "fixture-digest-A" },
        operationStatus: { "upload-B": "IN_FLIGHT", "upload-A": "IN_FLIGHT" },
      },
    };
    expect(visitedKey(viaAB)).toBe(visitedKey(viaBA));
  });

  it("is insensitive to the order of the executed-event list", () => {
    const a = baseState();
    const b: SearchState = {
      ...a,
      executedEventIds: ["upload-A:BLOB_PUT"],
      path: ["upload-A:BLOB_PUT"],
    };
    expect(visitedKey(a)).toBe(visitedKey(b));
    const withTwo: SearchState = {
      ...a,
      path: ["upload-A:BLOB_PUT", "upload-B:BLOB_PUT"],
      executedEventIds: ["upload-B:BLOB_PUT", "upload-A:BLOB_PUT"],
    };
    const withTwoSorted: SearchState = {
      ...withTwo,
      executedEventIds: ["upload-A:BLOB_PUT", "upload-B:BLOB_PUT"],
    };
    expect(visitedKey(withTwo)).toBe(visitedKey(withTwoSorted));
  });

  it("differs when the executed set differs", () => {
    const a = baseState();
    const b: SearchState = {
      ...a,
      path: ["upload-A:BLOB_PUT", "upload-A:DB_LINK"],
      executedEventIds: ["upload-A:BLOB_PUT", "upload-A:DB_LINK"],
    };
    expect(visitedKey(a)).not.toBe(visitedKey(b));
  });

  it("differs when the current database state differs", () => {
    const a = baseState();
    const b: SearchState = {
      ...a,
      systemState: {
        ...a.systemState,
        database: {
          A: { objectId: "A-v1", generation: 1, digest: "fixture-digest-A" },
        },
      },
    };
    expect(visitedKey(a)).not.toBe(visitedKey(b));
  });

  it("differs when the current Blob state differs", () => {
    const a = baseState();
    const b: SearchState = {
      ...a,
      systemState: { ...a.systemState, blob: {} },
    };
    expect(visitedKey(a)).not.toBe(visitedKey(b));
  });

  it("differs when the captured database snapshot differs", () => {
    const a: SearchState = { ...baseState(), databaseSnapshot: {} };
    const b: SearchState = {
      ...a,
      databaseSnapshot: {
        A: { objectId: "A-v1", generation: 1, digest: "fixture-digest-A" },
      },
    };
    expect(visitedKey(a)).not.toBe(visitedKey(b));
  });

  it("differs when the captured Blob snapshot differs", () => {
    const a: SearchState = { ...baseState(), blobSnapshot: {} };
    const b: SearchState = {
      ...a,
      blobSnapshot: { "A-v1@1": "fixture-digest-A" },
    };
    expect(visitedKey(a)).not.toBe(visitedKey(b));
  });

  it("differs when per-operation completion status differs", () => {
    const a = baseState();
    const b: SearchState = {
      ...a,
      systemState: {
        ...a.systemState,
        operationStatus: { "upload-A": "COMPLETED" },
      },
    };
    expect(visitedKey(a)).not.toBe(visitedKey(b));
  });

  it("differs when the snapshot was captured mid-operation vs at a boundary", () => {
    // Same captured D ({}), same executed set, same current states — but
    // one DB snapshot was taken while upload-A was in flight and the other
    // was taken before it started. The keys must NOT merge (the
    // IN_FLIGHT_OPERATION diagnostic differs).
    const atBoundary: SearchState = {
      ...baseState(),
      databaseSnapshot: {},
      dbSnapshotInFlightOperationIds: [],
    };
    const midOperation: SearchState = {
      ...atBoundary,
      dbSnapshotInFlightOperationIds: ["upload-A"],
    };
    expect(visitedKey(atBoundary)).not.toBe(visitedKey(midOperation));
  });

  it("is a pure function of the state (same input, same key)", () => {
    const a = baseState();
    expect(visitedKey(a)).toBe(visitedKey(baseState()));
    expect(visitedKey(a)).toBe(visitedKey(a));
  });
});
