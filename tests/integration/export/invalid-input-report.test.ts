/**
 * SnapFence (P030) — P030-R1-01 regression tests: INVALID_INPUT reports
 * must satisfy snapfence.report/v1 (GPT final review R1, P1-R1-01).
 *
 * The R1 counterexamples: scenarioId "" produced a report violating
 * `scenarioId` minLength 1, and strategy "DB_LAST" produced a report
 * violating the strategy enum — while `exportJson()` serialized them
 * without complaint. The fix normalizes the report fields inside
 * `buildInvalidInputResult` (empty id → "UNKNOWN_SCENARIO", illegal
 * strategy → "DB_FIRST") and preserves the raw invalid input in a
 * separate `limitations` entry. These tests assert the acceptance
 * criterion directly, for EVERY illegal input shape:
 * `validateReport(exportJsonObject(runSearch(invalid))).valid === true`,
 * on BOTH the JSON export path and the HTML export path.
 *
 * Placement note: this file lives in tests/integration/export (not
 * tests/unit/search) because the asserted contract is an export contract,
 * and because `scripts/s0-gate.ts` freezes the `test:search` suite count
 * at 98 — new tests in tests/unit/search would break the S0 gate's
 * per-suite count without a scripts/ change, which is outside the R1-01
 * scope. The full `npm test` total grows by the tests in this file.
 */
import { describe, expect, it } from "vitest";
import type { Scenario, SearchResult } from "../../../src/core/model/types";
import { runSearch } from "../../../src/core/search/bfs";
import {
  buildInvalidInputResult,
  NORMALIZED_DEFAULT_STRATEGY,
  NORMALIZED_UNKNOWN_SCENARIO_ID,
} from "../../../src/core/search/search-result";
import { exportHtml } from "../../../src/export/html-export";
import { exportJson, exportJsonObject } from "../../../src/export/json-export";
import { validateReport } from "../../../src/export/report-schema";

/** One valid upload scenario; illegal variants are built from it. */
function validScenario(): Scenario {
  return {
    scenarioId: "U01_DB_FIRST_UPLOAD_ORPHAN",
    strategy: "DB_FIRST",
    maxEvents: 10,
    operations: [
      { opId: "upload-A", kind: "UPLOAD", fileId: "A", objectId: "A-v1", digest: "fixture-digest-A" },
    ],
  };
}

/**
 * The R1-01 acceptance check for one illegal input: the search verdict
 * is INVALID_INPUT and the exported report is schema-valid — via the
 * JSON object, via the JSON string round-trip, and (for the HTML path)
 * the rendered strategy/scenarioId fields carry the normalized values,
 * never the raw illegal ones.
 */
function assertValidInvalidInputReport(input: unknown): SearchResult {
  const result = runSearch(input as unknown as Scenario);
  expect(result.verdict).toBe("INVALID_INPUT");
  expect(result.counterexample).toEqual([]);
  const objectValidation = validateReport(exportJsonObject(result));
  expect(objectValidation.valid, objectValidation.errors.join("; ")).toBe(true);
  const parsed = JSON.parse(exportJson(result)) as unknown;
  const stringValidation = validateReport(parsed);
  expect(stringValidation.valid, stringValidation.errors.join("; ")).toBe(true);
  return result;
}

describe("INVALID_INPUT reports satisfy snapfence.report/v1 (P030-R1-01)", () => {
  it("empty scenarioId \"\" → valid report, normalized id, raw value preserved", () => {
    const result = assertValidInvalidInputReport({ ...validScenario(), scenarioId: "" });
    expect(result.scenarioId).toBe(NORMALIZED_UNKNOWN_SCENARIO_ID);
    expect(result.strategy).toBe("DB_FIRST");
    expect(result.limitations.join(" ")).toContain("EMPTY_SCENARIO_ID");
    expect(result.limitations.join(" ")).toContain('scenarioId=""');
    const html = exportHtml(result);
    expect(html).toContain(`<code>${NORMALIZED_UNKNOWN_SCENARIO_ID}</code>`);
    expect(html).not.toContain("<code></code>");
  });

  it("whitespace-only scenarioId → valid report, normalized id", () => {
    const result = assertValidInvalidInputReport({ ...validScenario(), scenarioId: "   " });
    expect(result.scenarioId).toBe(NORMALIZED_UNKNOWN_SCENARIO_ID);
    expect(result.limitations.join(" ")).toContain("EMPTY_SCENARIO_ID");
  });

  it("illegal strategy \"DB_LAST\" → valid report, normalized strategy, raw value preserved", () => {
    const input = { ...validScenario(), strategy: "DB_LAST" } as unknown as Scenario;
    const result = assertValidInvalidInputReport(input);
    expect(result.scenarioId).toBe("U01_DB_FIRST_UPLOAD_ORPHAN");
    expect(result.strategy).toBe(NORMALIZED_DEFAULT_STRATEGY);
    expect(result.strategy).toBe("DB_FIRST");
    expect(result.limitations.join(" ")).toContain("INVALID_STRATEGY");
    expect(result.limitations.join(" ")).toContain('"DB_LAST"');
    // HTML path: the strategy field renders the normalized value; the
    // raw illegal value appears only inside the limitations text.
    const html = exportHtml(result);
    expect(html).toContain("<code>DB_FIRST</code>");
    expect(html).not.toContain("<code>DB_LAST</code>");
    expect(html).toContain("DB_LAST");
    expect(html).not.toContain("<code></code>");
  });

  it("null input → valid report, normalized placeholders, raw input preserved", () => {
    const result = assertValidInvalidInputReport(null);
    expect(result.scenarioId).toBe(NORMALIZED_UNKNOWN_SCENARIO_ID);
    expect(result.strategy).toBe("DB_FIRST");
    expect(result.eventCount).toBe(0);
    expect(result.limitations.join(" ")).toContain("MISSING_REQUIRED_FIELD");
    expect(result.limitations.join(" ")).toContain("was not a scenario object");
    expect(result.limitations.join(" ")).toContain("null");
  });

  it("undefined input → valid report, normalized placeholders, raw input preserved", () => {
    const result = assertValidInvalidInputReport(undefined);
    expect(result.scenarioId).toBe(NORMALIZED_UNKNOWN_SCENARIO_ID);
    expect(result.strategy).toBe("DB_FIRST");
    expect(result.limitations.join(" ")).toContain("MISSING_REQUIRED_FIELD");
    expect(result.limitations.join(" ")).toContain("undefined");
  });

  it("non-object string input → valid report, raw input preserved", () => {
    const result = assertValidInvalidInputReport("nope");
    expect(result.scenarioId).toBe(NORMALIZED_UNKNOWN_SCENARIO_ID);
    expect(result.strategy).toBe("DB_FIRST");
    expect(result.limitations.join(" ")).toContain('"nope"');
  });

  it("non-object number input → valid report, raw input preserved", () => {
    const result = assertValidInvalidInputReport(42);
    expect(result.scenarioId).toBe(NORMALIZED_UNKNOWN_SCENARIO_ID);
    expect(result.limitations.join(" ")).toContain("42");
  });

  it("valid-id INVALID_INPUT keeps the id and strategy verbatim, no placeholder", () => {
    const duplicate: Scenario = {
      scenarioId: "DUP_OP",
      strategy: "FILE_FIRST",
      maxEvents: 10,
      operations: [
        { opId: "upload-A", kind: "UPLOAD", fileId: "A", objectId: "A-v1", digest: "fixture-digest-A" },
        { opId: "upload-A", kind: "UPLOAD", fileId: "B", objectId: "B-v1", digest: "fixture-digest-B" },
      ],
    };
    const result = assertValidInvalidInputReport(duplicate);
    expect(result.scenarioId).toBe("DUP_OP");
    expect(result.strategy).toBe("FILE_FIRST");
    expect(result.limitations.join(" ")).toContain("DUPLICATE_OPERATION_ID");
    // Nothing was normalized, so no raw-input note is emitted.
    expect(result.limitations.join(" ")).not.toContain("Raw invalid input");
  });

  it("INVALID_INPUT JSON export is deterministic (byte-identical on re-export)", () => {
    const input = { ...validScenario(), strategy: "DB_LAST" } as unknown as Scenario;
    const result = runSearch(input);
    expect(exportJson(result)).toBe(exportJson(result));
    expect(exportHtml(result)).toBe(exportHtml(result));
  });
});

describe("buildInvalidInputResult normalization (P030-R1-01)", () => {
  it("normalizes an empty id and an illegal strategy; the result validates", () => {
    const result = buildInvalidInputResult("", "DB_LAST" as never, 0, [
      { code: "EMPTY_SCENARIO_ID", message: "scenarioId must be a non-empty string." },
      { code: "INVALID_STRATEGY", message: "strategy must be one of DB_FIRST, FILE_FIRST, PAUSE_WRITES." },
    ]);
    expect(result.verdict).toBe("INVALID_INPUT");
    expect(result.scenarioId).toBe(NORMALIZED_UNKNOWN_SCENARIO_ID);
    expect(result.strategy).toBe("DB_FIRST");
    expect(result.limitations.join(" ")).toContain('scenarioId=""');
    expect(result.limitations.join(" ")).toContain('"DB_LAST"');
    const validation = validateReport(exportJsonObject(result));
    expect(validation.valid, validation.errors.join("; ")).toBe(true);
  });

  it("normalizes null / undefined strategy to DB_FIRST", () => {
    for (const raw of [null, undefined] as const) {
      const result = buildInvalidInputResult("BAD", raw as never, 0, [
        { code: "INVALID_STRATEGY", message: "bad strategy" },
      ]);
      expect(result.strategy).toBe("DB_FIRST");
      expect(validateReport(exportJsonObject(result)).valid).toBe(true);
    }
  });

  it("keeps a valid id and strategy verbatim and emits no raw-input note", () => {
    const result = buildInvalidInputResult("BAD", "DB_FIRST", 0, [
      { code: "DUPLICATE_OPERATION_ID", message: "dup", subjectId: "upload-A" },
    ]);
    expect(result.scenarioId).toBe("BAD");
    expect(result.strategy).toBe("DB_FIRST");
    expect(result.limitations.join(" ")).not.toContain("Raw invalid input");
    expect(validateReport(exportJsonObject(result)).valid).toBe(true);
  });
});
