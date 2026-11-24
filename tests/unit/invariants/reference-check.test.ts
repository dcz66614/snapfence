/**
 * SnapFence (P030) — T004 unit tests: reference integrity checks.
 * Covers PROJECT_BOOK.md §4.3 (reference half) and §4.4:
 * - DANGLING_REFERENCE: a database reference with no Blob object at all.
 * - GENERATION_MISMATCH: the object exists at a different generation.
 * - DIGEST_MISMATCH: the version exists with a different digest.
 * - ORPHAN_BLOB: a Blob version no database record references.
 * Completeness is the point: no dangling reference and no orphan Blob
 * may be missed, so the multi-failure tests assert EVERY failure is
 * reported, and the precedence test asserts a broken reference yields
 * exactly one of the three reference codes.
 */
import { describe, expect, it } from "vitest";
import type { BlobState, DatabaseState } from "../../../src/core/model/types";
import {
  checkDatabaseReference,
  checkReferences,
  findDanglingReferences,
  findOrphanBlobs,
  isReferenceClean,
} from "../../../src/core/invariants/reference-check";

const digestA = "fixture-digest-A";
const digestB = "fixture-digest-B";

describe("checkDatabaseReference — one reference", () => {
  it("reports DANGLING_REFERENCE when the Blob snapshot holds no such object", () => {
    const diagnostics = checkDatabaseReference(
      "A",
      { objectId: "A-v1", generation: 1, digest: digestA },
      {},
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("DANGLING_REFERENCE");
    expect(diagnostics[0]?.severity).toBe("CRITICAL");
    expect(diagnostics[0]?.fileId).toBe("A");
    expect(diagnostics[0]?.objectId).toBe("A-v1");
  });

  it("reports GENERATION_MISMATCH (not DANGLING_REFERENCE) when another generation is held", () => {
    const diagnostics = checkDatabaseReference(
      "A",
      { objectId: "A-v1", generation: 2, digest: digestA },
      { "A-v1@1": digestA },
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("GENERATION_MISMATCH");
    expect(diagnostics[0]?.severity).toBe("CRITICAL");
    expect(diagnostics.map((d) => d.code)).not.toContain("DANGLING_REFERENCE");
  });

  it("reports DIGEST_MISMATCH when the version exists with a different digest", () => {
    const diagnostics = checkDatabaseReference(
      "A",
      { objectId: "A-v1", generation: 1, digest: digestA },
      { "A-v1@1": "different-digest" },
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("DIGEST_MISMATCH");
    expect(diagnostics[0]?.severity).toBe("CRITICAL");
  });

  it("reports nothing when object, generation and digest all match", () => {
    expect(
      checkDatabaseReference(
        "A",
        { objectId: "A-v1", generation: 1, digest: digestA },
        { "A-v1@1": digestA },
      ),
    ).toEqual([]);
  });
});

describe("checkReferences — whole snapshot pair", () => {
  it("returns no diagnostics for a clean pair", () => {
    const database: DatabaseState = { A: { objectId: "A-v1", generation: 1, digest: digestA } };
    const blob: BlobState = { "A-v1@1": digestA };
    expect(checkReferences(database, blob)).toEqual([]);
    expect(isReferenceClean(database, blob)).toBe(true);
  });

  it("returns no diagnostics for two empty snapshots", () => {
    expect(checkReferences({}, {})).toEqual([]);
  });

  it("never misses a dangling reference: two broken records yield two DANGLING_REFERENCE diagnostics", () => {
    const database: DatabaseState = {
      A: { objectId: "A-v1", generation: 1, digest: digestA },
      B: { objectId: "B-v1", generation: 1, digest: digestB },
    };
    const diagnostics = checkReferences(database, {});
    expect(diagnostics.filter((d) => d.code === "DANGLING_REFERENCE")).toHaveLength(2);
    expect(diagnostics.map((d) => d.fileId).sort()).toEqual(["A", "B"]);
    expect(findDanglingReferences(database, {})).toEqual(["A", "B"]);
  });

  it("never misses an orphan Blob: two unreferenced versions yield two ORPHAN_BLOB diagnostics", () => {
    const blob: BlobState = { "A-v1@1": digestA, "B-v1@1": digestB };
    const diagnostics = checkReferences({}, blob);
    expect(diagnostics.filter((d) => d.code === "ORPHAN_BLOB")).toHaveLength(2);
    expect(diagnostics.every((d) => d.severity === "WARNING")).toBe(true);
    expect(findOrphanBlobs({}, blob)).toEqual([
      { objectId: "A-v1", generation: 1, digest: digestA },
      { objectId: "B-v1", generation: 1, digest: digestB },
    ]);
  });

  it("reports every failure kind present in one pair: dangling + digest + orphan", () => {
    const database: DatabaseState = {
      A: { objectId: "A-v1", generation: 1, digest: digestA },
      B: { objectId: "B-v1", generation: 1, digest: digestB },
      C: { objectId: "C-v1", generation: 1, digest: "fixture-digest-C" },
    };
    const blob: BlobState = {
      "A-v1@1": "tampered-digest",
      "C-v1@1": "fixture-digest-C",
      "D-v1@1": "fixture-digest-D",
    };
    const codes = checkReferences(database, blob).map((d) => d.code);
    expect(codes).toContain("DANGLING_REFERENCE"); // B-v1 missing entirely
    expect(codes).toContain("DIGEST_MISMATCH"); // A-v1 digest differs
    expect(codes).toContain("ORPHAN_BLOB"); // D-v1 unreferenced
    expect(codes).not.toContain("GENERATION_MISMATCH");
    expect(codes).toHaveLength(3);
  });

  it("a Blob version referenced by any record is not an orphan, even when another record is broken", () => {
    const database: DatabaseState = {
      A: { objectId: "A-v1", generation: 1, digest: digestA },
      B: { objectId: "B-v1", generation: 1, digest: digestB },
    };
    const blob: BlobState = { "A-v1@1": digestA };
    const orphans = findOrphanBlobs(database, blob);
    expect(orphans).toEqual([]);
    const codes = checkReferences(database, blob).map((d) => d.code);
    expect(codes).toEqual(["DANGLING_REFERENCE"]);
  });

  it("a shared generation held under a different objectId is not a generation match", () => {
    const database: DatabaseState = { A: { objectId: "A-v1", generation: 1, digest: digestA } };
    const blob: BlobState = { "X-v9@1": digestA };
    expect(checkReferences(database, blob).map((d) => d.code)).toEqual([
      "DANGLING_REFERENCE",
      "ORPHAN_BLOB",
    ]);
  });

  it("diagnostics are deterministically ordered by code, then fileId", () => {
    const database: DatabaseState = {
      B: { objectId: "B-v1", generation: 1, digest: digestB },
      A: { objectId: "A-v1", generation: 1, digest: digestA },
    };
    const first = checkReferences(database, {});
    const second = checkReferences(database, {});
    expect(first).toEqual(second);
    expect(first.map((d) => d.fileId)).toEqual(["A", "B"]);
  });
});
