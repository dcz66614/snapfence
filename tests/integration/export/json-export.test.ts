/**
 * SnapFence (P030) — T009 export integration tests: JSON export.
 *
 * Covers: schema conformance of the serialized string (parse + validate),
 * completeness (strategy / verdict / diagnostics / counterexample /
 * snapshots / assumptions / limitations all present), determinism
 * (same input -> byte-identical output, SHA-256), and correct text
 * handling — a hand-built SearchResult carrying `<`, `>`, `&`, quotes
 * and non-ASCII / Chinese text in file/object IDs round-trips exactly
 * through JSON.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Scenario, SearchResult } from "../../../src/core/model/types";
import { runSearch } from "../../../src/core/search/bfs";
import { buildSearchResult } from "../../../src/core/search/search-result";
import { exportJson } from "../../../src/export/json-export";
import { validateReport } from "../../../src/export/report-schema";

const GOLDEN_DIR = fileURLToPath(new URL("../../../fixtures/golden/", import.meta.url));

function loadScenario(fixtureId: string): Scenario {
  const raw = JSON.parse(readFileSync(`${GOLDEN_DIR}${fixtureId}.json`, "utf8")) as {
    scenario: Scenario;
  };
  return raw.scenario;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("json-export", () => {
  it("exports scenario A (U01) as valid snapfence.report/v1 JSON", () => {
    const result = runSearch(loadScenario("U01"));
    const text = exportJson(result);
    expect(text.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(text) as unknown;
    const validation = validateReport(parsed);
    expect(validation.valid, validation.errors.join("; ")).toBe(true);
    const doc = parsed as SearchResult;
    expect(doc.schemaVersion).toBe("snapfence.report/v1");
    expect(doc.scenarioId).toBe("U01_DB_FIRST_UPLOAD_ORPHAN");
    expect(doc.strategy).toBe("DB_FIRST");
    expect(doc.verdict).toBe("UNSAFE_WITHIN_BOUND");
    expect(doc.counterexample).toEqual([
      "DB_SNAPSHOT",
      "upload-A:BLOB_PUT",
      "BLOB_SNAPSHOT",
    ]);
    expect(doc.counterexampleLength).toBe(3);
    expect(doc.diagnostics.map((d) => d.code)).toEqual([
      "IN_FLIGHT_OPERATION",
      "NO_COMMON_BOUNDARY",
      "ORPHAN_BLOB",
    ]);
    // Complete snapshot information: the Blob snapshot holds A-v1, the
    // database snapshot does not reference it (that is the orphan).
    expect(doc.blobSnapshot["A-v1@1"]).toBe("fixture-digest-A");
    expect(doc.databaseSnapshot).toEqual({});
    expect(doc.assumptions.length).toBeGreaterThan(0);
    expect(doc.limitations.length).toBeGreaterThan(0);
  });

  it("exports G12 (10 events, SAFE) as valid JSON with an empty counterexample", () => {
    const result = runSearch(loadScenario("G12"));
    const parsed = JSON.parse(exportJson(result)) as SearchResult;
    const validation = validateReport(parsed);
    expect(validation.valid).toBe(true);
    expect(parsed.verdict).toBe("SAFE_WITHIN_BOUND");
    expect(parsed.strategy).toBe("PAUSE_WRITES");
    expect(parsed.counterexample).toEqual([]);
    expect(parsed.counterexampleLength).toBe(0);
    expect(parsed.diagnostics).toEqual([]);
    // The reported snapshots are those of the first complete interleaving
    // in deterministic BFS order: for G12 both snapshots are taken at
    // boundary 0 (before any upload starts), so both are empty — a
    // consistent boundary pair. The exporter must carry exactly what
    // runSearch produced, not invent snapshot content.
    expect(parsed.databaseSnapshot).toEqual(result.databaseSnapshot);
    expect(parsed.blobSnapshot).toEqual(result.blobSnapshot);
    expect(parsed.databaseSnapshot).toEqual({});
    expect(parsed.blobSnapshot).toEqual({});
  });

  it("is deterministic: same input produces byte-identical output (SHA-256)", () => {
    for (const id of ["U01", "U07", "G12", "G01"]) {
      const result = runSearch(loadScenario(id));
      const first = exportJson(result);
      const second = exportJson(result);
      expect(second).toBe(first);
      expect(sha256(second)).toBe(sha256(first));
      // A fresh runSearch of the same scenario must export identically too.
      const rerun = exportJson(runSearch(loadScenario(id)));
      expect(sha256(rerun)).toBe(sha256(first));
    }
  });

  it("round-trips <, >, &, quotes and non-ASCII/Chinese text in IDs exactly", () => {
    const trickyFileId = '文件<x>&"\'中文';
    const trickyObjectId = '对象<y>&"\'中文-v1';
    const trickyDigest = '摘要<>&"\'中文';
    const result = buildSearchResult({
      scenarioId: '场景<SC>&"\'中文',
      strategy: "DB_FIRST",
      verdict: "UNSAFE_WITHIN_BOUND",
      eventCount: 3,
      counterexample: ["DB_SNAPSHOT", "BLOB_PUT", "BLOB_SNAPSHOT"],
      diagnostics: [
        {
          code: "ORPHAN_BLOB",
          severity: "WARNING",
          fileId: trickyFileId,
          objectId: trickyObjectId,
          message: '孤立对象 <a>&"b" 中文',
        },
      ],
      databaseSnapshot: {},
      blobSnapshot: { [`${trickyObjectId}@1`]: trickyDigest },
      extraLimitations: [],
    });
    const text = exportJson(result);
    const parsed = JSON.parse(text) as SearchResult;
    expect(parsed.scenarioId).toBe('场景<SC>&"\'中文');
    expect(parsed.diagnostics[0].fileId).toBe(trickyFileId);
    expect(parsed.diagnostics[0].objectId).toBe(trickyObjectId);
    expect(parsed.diagnostics[0].message).toBe('孤立对象 <a>&"b" 中文');
    expect(parsed.blobSnapshot[`${trickyObjectId}@1`]).toBe(trickyDigest);
    // The raw JSON text must not contain the unescaped tricky markup as
    // live content: quotes inside strings are backslash-escaped by JSON.
    expect(text).toContain('\\"');
    const validation = validateReport(parsed);
    expect(validation.valid, validation.errors.join("; ")).toBe(true);
  });

  it("sorts snapshot keys so map insertion order cannot change the bytes", () => {
    const base = runSearch(loadScenario("G12"));
    const reordered: SearchResult = {
      ...base,
      databaseSnapshot: Object.fromEntries(
        Object.entries(base.databaseSnapshot).reverse(),
      ),
      blobSnapshot: Object.fromEntries(Object.entries(base.blobSnapshot).reverse()),
    };
    expect(exportJson(reordered)).toBe(exportJson(base));
  });
});
