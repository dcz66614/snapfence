/**
 * SnapFence (P030) — T003 unit tests: SearchResult construction.
 * Covers: fixed schemaVersion "snapfence.report/v1", counterexampleLength
 * always equalling counterexample.length, deterministic diagnostic sorting,
 * frozen severities (§4.4), frozen assumptions/limitations (§6, §4.7), and
 * the INVALID_INPUT / INCONCLUSIVE_LIMIT builders (limit never SAFE).
 */
import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../../../src/core/model/types";
import {
  buildInvalidInputResult,
  buildLimitResult,
  buildSearchResult,
  EMPTY_BLOB_SNAPSHOT,
  EMPTY_DATABASE_SNAPSHOT,
  makeDiagnostic,
  REPORT_SCHEMA_VERSION,
  SEARCH_ASSUMPTIONS,
  SEARCH_LIMITATIONS,
  severityFor,
  sortDiagnostics,
} from "../../../src/core/search/search-result";

describe("buildSearchResult", () => {
  it("carries the fixed schema version and a consistent counterexample length", () => {
    expect(REPORT_SCHEMA_VERSION).toBe("snapfence.report/v1");
    const result = buildSearchResult({
      scenarioId: "U01_DB_FIRST_UPLOAD_ORPHAN",
      strategy: "DB_FIRST",
      verdict: "UNSAFE_WITHIN_BOUND",
      eventCount: 4,
      counterexample: ["DB_SNAPSHOT", "upload-A:BLOB_PUT", "BLOB_SNAPSHOT", "upload-A:DB_LINK"],
      diagnostics: [],
      databaseSnapshot: {},
      blobSnapshot: { "A-v1@1": "fixture-digest-A" },
    });
    expect(result.schemaVersion).toBe("snapfence.report/v1");
    expect(result.counterexampleLength).toBe(4);
    expect(result.counterexampleLength).toBe(result.counterexample.length);
    expect(result.eventCount).toBe(4);
    expect(result.assumptions).toEqual([...SEARCH_ASSUMPTIONS]);
    expect(result.limitations.slice(0, SEARCH_LIMITATIONS.length)).toEqual([
      ...SEARCH_LIMITATIONS,
    ]);
  });

  it("reports counterexampleLength 0 for a SAFE result with no counterexample", () => {
    const result = buildSearchResult({
      scenarioId: "IDLE_DB_FIRST",
      strategy: "DB_FIRST",
      verdict: "SAFE_WITHIN_BOUND",
      eventCount: 2,
      counterexample: [],
      diagnostics: [],
      databaseSnapshot: {},
      blobSnapshot: {},
    });
    expect(result.counterexample).toEqual([]);
    expect(result.counterexampleLength).toBe(0);
  });

  it("appends extra limitations after the frozen ones, in order", () => {
    const result = buildSearchResult({
      scenarioId: "X",
      strategy: "PAUSE_WRITES",
      verdict: "SAFE_WITHIN_BOUND",
      eventCount: 2,
      counterexample: [],
      diagnostics: [],
      databaseSnapshot: {},
      blobSnapshot: {},
      extraLimitations: ["extra one", "extra two"],
    });
    expect(result.limitations.slice(-2)).toEqual(["extra one", "extra two"]);
    expect(result.limitations.length).toBe(SEARCH_LIMITATIONS.length + 2);
  });

  it("copies the counterexample (later caller mutation cannot change it)", () => {
    const ids = ["DB_SNAPSHOT"];
    const result = buildSearchResult({
      scenarioId: "X",
      strategy: "DB_FIRST",
      verdict: "UNSAFE_WITHIN_BOUND",
      eventCount: 4,
      counterexample: ids,
      diagnostics: [],
      databaseSnapshot: {},
      blobSnapshot: {},
    });
    ids.push("MUTATED");
    expect(result.counterexample).toEqual(["DB_SNAPSHOT"]);
    expect(result.counterexampleLength).toBe(1);
  });
});

describe("diagnostics", () => {
  it("maps every §4.4 code to its frozen severity", () => {
    expect(severityFor("DANGLING_REFERENCE")).toBe("CRITICAL");
    expect(severityFor("ORPHAN_BLOB")).toBe("WARNING");
    expect(severityFor("GENERATION_MISMATCH")).toBe("CRITICAL");
    expect(severityFor("DIGEST_MISMATCH")).toBe("CRITICAL");
    expect(severityFor("IN_FLIGHT_OPERATION")).toBe("WARNING");
    expect(severityFor("NO_COMMON_BOUNDARY")).toBe("CRITICAL");
  });

  it("makeDiagnostic attaches severity and optional file/object ids", () => {
    const withIds = makeDiagnostic("DANGLING_REFERENCE", "msg", "A", "A-v1");
    expect(withIds).toEqual({
      code: "DANGLING_REFERENCE",
      severity: "CRITICAL",
      message: "msg",
      fileId: "A",
      objectId: "A-v1",
    });
    const bare = makeDiagnostic("NO_COMMON_BOUNDARY", "msg");
    expect(bare).toEqual({
      code: "NO_COMMON_BOUNDARY",
      severity: "CRITICAL",
      message: "msg",
    });
    expect("fileId" in bare).toBe(false);
    expect("objectId" in bare).toBe(false);
  });

  it("sortDiagnostics orders deterministically by code, file, object, message", () => {
    const input: Diagnostic[] = [
      makeDiagnostic("ORPHAN_BLOB", "b", undefined, "B-v1"),
      makeDiagnostic("DANGLING_REFERENCE", "a", "A", "A-v1"),
      makeDiagnostic("ORPHAN_BLOB", "a", undefined, "A-v1"),
      makeDiagnostic("NO_COMMON_BOUNDARY", "z"),
    ];
    expect(sortDiagnostics(input).map((d) => `${d.code}:${d.objectId ?? ""}`)).toEqual([
      "DANGLING_REFERENCE:A-v1",
      "NO_COMMON_BOUNDARY:",
      "ORPHAN_BLOB:A-v1",
      "ORPHAN_BLOB:B-v1",
    ]);
  });
});

describe("buildInvalidInputResult", () => {
  it("returns INVALID_INPUT with empty snapshots and the issue codes listed", () => {
    const result = buildInvalidInputResult("BAD", "DB_FIRST", 0, [
      { code: "EMPTY_SCENARIO_ID", message: "scenarioId must be a non-empty string." },
      { code: "DUPLICATE_OPERATION_ID", message: "dup", subjectId: "upload-A" },
    ]);
    expect(result.verdict).toBe("INVALID_INPUT");
    expect(result.counterexample).toEqual([]);
    expect(result.counterexampleLength).toBe(0);
    expect(result.diagnostics).toEqual([]);
    expect(result.databaseSnapshot).toEqual(EMPTY_DATABASE_SNAPSHOT);
    expect(result.blobSnapshot).toEqual(EMPTY_BLOB_SNAPSHOT);
    expect(result.limitations.join(" ")).toContain("DUPLICATE_OPERATION_ID");
    expect(result.limitations.join(" ")).toContain("EMPTY_SCENARIO_ID");
  });
});

describe("buildLimitResult", () => {
  it("returns INCONCLUSIVE_LIMIT — never SAFE — and names the bound", () => {
    const result = buildLimitResult("OVER", "DB_FIRST", 12, 12);
    expect(result.verdict).toBe("INCONCLUSIVE_LIMIT");
    expect(result.verdict).not.toBe("SAFE_WITHIN_BOUND");
    expect(result.eventCount).toBe(12);
    expect(result.counterexample).toEqual([]);
    expect(result.limitations.join(" ")).toContain("12");
    expect(result.limitations.join(" ")).toContain("10");
  });
});
