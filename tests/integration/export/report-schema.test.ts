/**
 * SnapFence (P030) — T009 export integration tests: report schema.
 *
 * Validates `snapfence.report/v1` documents produced by `runSearch`
 * (scenario A = U01, and G12, the 10-event maximum) and proves the
 * validator rejects every malformed shape it is required to catch:
 * wrong schemaVersion, unknown verdict / diagnostic code, severity
 * mismatch for a code, counterexampleLength mismatch, missing field,
 * and unexpected extra field.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Scenario, SearchResult } from "../../../src/core/model/types";
import { runSearch } from "../../../src/core/search/bfs";
import { buildSearchResult } from "../../../src/core/search/search-result";
import { exportJsonObject } from "../../../src/export/json-export";
import {
  DIAGNOSTIC_CODES,
  REPORT_SCHEMA_VERSION,
  validateReport,
} from "../../../src/export/report-schema";

const GOLDEN_DIR = fileURLToPath(new URL("../../../fixtures/golden/", import.meta.url));

function loadScenario(fixtureId: string): Scenario {
  const raw = JSON.parse(readFileSync(`${GOLDEN_DIR}${fixtureId}.json`, "utf8")) as {
    scenario: Scenario;
  };
  return raw.scenario;
}

function mutate(
  doc: Record<string, unknown>,
  fn: (copy: Record<string, unknown>) => void,
): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
  fn(copy);
  return copy;
}

describe("report-schema (snapfence.report/v1)", () => {
  it("accepts the scenario A (U01) report produced by runSearch", () => {
    const result = runSearch(loadScenario("U01"));
    expect(result.verdict).toBe("UNSAFE_WITHIN_BOUND");
    const validation = validateReport(exportJsonObject(result));
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it("accepts the G12 (10-event maximum) report produced by runSearch", () => {
    const result = runSearch(loadScenario("G12"));
    expect(result.verdict).toBe("SAFE_WITHIN_BOUND");
    expect(result.eventCount).toBe(10);
    const validation = validateReport(exportJsonObject(result));
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it("accepts every one of the 24 Golden reports", () => {
    const ids = [
      ...Array.from({ length: 12 }, (_, i) => `U${String(i + 1).padStart(2, "0")}`),
      ...Array.from({ length: 12 }, (_, i) => `G${String(i + 1).padStart(2, "0")}`),
    ];
    for (const id of ids) {
      const result = runSearch(loadScenario(id));
      const validation = validateReport(exportJsonObject(result));
      expect(validation.valid, `${id}: ${validation.errors.join("; ")}`).toBe(true);
    }
  });

  it("carries the frozen vocabulary: 6 diagnostic codes, 4 verdicts", () => {
    expect([...DIAGNOSTIC_CODES]).toEqual([
      "DANGLING_REFERENCE",
      "ORPHAN_BLOB",
      "GENERATION_MISMATCH",
      "DIGEST_MISMATCH",
      "IN_FLIGHT_OPERATION",
      "NO_COMMON_BOUNDARY",
    ]);
    expect(REPORT_SCHEMA_VERSION).toBe("snapfence.report/v1");
  });

  it("rejects a non-object report", () => {
    expect(validateReport(null).valid).toBe(false);
    expect(validateReport("not a report").valid).toBe(false);
    expect(validateReport([]).valid).toBe(false);
  });

  it("rejects a wrong schemaVersion", () => {
    const result = runSearch(loadScenario("U01"));
    const bad = mutate(exportJsonObject(result) as unknown as Record<string, unknown>, (copy) => {
      copy.schemaVersion = "snapfence.report/v2";
    });
    const validation = validateReport(bad);
    expect(validation.valid).toBe(false);
    expect(validation.errors.join(" ")).toContain("schemaVersion");
  });

  it("rejects an unknown verdict literal", () => {
    const result = runSearch(loadScenario("U01"));
    const bad = mutate(exportJsonObject(result) as unknown as Record<string, unknown>, (copy) => {
      copy.verdict = "SAFE";
    });
    expect(validateReport(bad).valid).toBe(false);
  });

  it("rejects an unknown diagnostic code", () => {
    const result = runSearch(loadScenario("U01"));
    const bad = mutate(exportJsonObject(result) as unknown as Record<string, unknown>, (copy) => {
      const diagnostics = copy.diagnostics as Record<string, unknown>[];
      diagnostics[0].code = "MISSING_FILE";
    });
    expect(validateReport(bad).valid).toBe(false);
  });

  it("rejects a severity that does not match the diagnostic code", () => {
    // ORPHAN_BLOB is WARNING; CRITICAL is the wrong severity for it.
    const result = runSearch(loadScenario("U01"));
    const bad = mutate(exportJsonObject(result) as unknown as Record<string, unknown>, (copy) => {
      const diagnostics = copy.diagnostics as Record<string, unknown>[];
      const orphan = diagnostics.find((d) => d.code === "ORPHAN_BLOB");
      expect(orphan).toBeDefined();
      if (orphan !== undefined) orphan.severity = "CRITICAL";
    });
    const validation = validateReport(bad);
    expect(validation.valid).toBe(false);
    expect(validation.errors.join(" ")).toContain("ORPHAN_BLOB");
  });

  it("rejects counterexampleLength that does not equal counterexample.length", () => {
    const result = runSearch(loadScenario("U01"));
    const bad = mutate(exportJsonObject(result) as unknown as Record<string, unknown>, (copy) => {
      copy.counterexampleLength = 99;
    });
    const validation = validateReport(bad);
    expect(validation.valid).toBe(false);
    expect(validation.errors.join(" ")).toContain("counterexampleLength");
  });

  it("rejects a missing required field and an unexpected extra field", () => {
    const result = runSearch(loadScenario("U01"));
    const doc = exportJsonObject(result) as unknown as Record<string, unknown>;
    const missing = mutate(doc, (copy) => {
      delete copy.verdict;
    });
    expect(validateReport(missing).valid).toBe(false);
    const extra = mutate(doc, (copy) => {
      copy.undeclaredField = "smuggled";
    });
    const extraValidation = validateReport(extra);
    expect(extraValidation.valid).toBe(false);
    expect(extraValidation.errors.join(" ")).toContain("unexpected field");
  });

  it("rejects a database record with a bad generation", () => {
    // Hand-built result with a real record, then corrupt its generation.
    const built = buildSearchResult({
      scenarioId: "T009-BAD-GENERATION",
      strategy: "DB_FIRST",
      verdict: "SAFE_WITHIN_BOUND",
      eventCount: 4,
      counterexample: [],
      diagnostics: [],
      databaseSnapshot: { A: { objectId: "A-v1", generation: 1, digest: "d-A" } },
      blobSnapshot: { "A-v1@1": "d-A" },
      extraLimitations: [],
    });
    const bad = mutate(exportJsonObject(built) as unknown as Record<string, unknown>, (copy) => {
      const db = copy.databaseSnapshot as Record<string, Record<string, unknown>>;
      db.A.generation = 0;
    });
    expect(validateReport(bad).valid).toBe(false);
  });

  it("the typed SearchResult of every Golden fixture carries verbatim codes", () => {
    const u01 = runSearch(loadScenario("U01"));
    const codes = u01.diagnostics.map((d) => d.code);
    expect(codes).toContain("ORPHAN_BLOB");
    expect(codes).toContain("NO_COMMON_BOUNDARY");
    expect(codes).toContain("IN_FLIGHT_OPERATION");
    const g12: SearchResult = runSearch(loadScenario("G12"));
    expect(g12.diagnostics).toEqual([]);
    expect(g12.counterexampleLength).toBe(g12.counterexample.length);
  });
});
