/**
 * SnapFence (P030) — T003 unit tests: determinism and no wall-clock /
 * randomness dependence (§4.5/§4.6).
 * Covers: identical input run twice gives byte-identical results (full
 * SearchResult JSON, detailed execution, and SHA-256 of the result);
 * results do not depend on run order or on repeated execution; the search
 * sources contain no randomness or wall-clock reads (source grep).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Scenario } from "../../../src/core/model/types";
import { runSearch, runSearchDetailed } from "../../../src/core/search/bfs";
import {
  deleteScenarioC,
  fourUploadScenario,
  idleScenario,
  twoUploadScenario,
  updateScenario,
  uploadScenarioA,
  uploadScenarioB,
} from "./helpers";

const SCENARIOS: Scenario[] = [
  uploadScenarioA("DB_FIRST"),
  uploadScenarioA("FILE_FIRST"),
  uploadScenarioA("PAUSE_WRITES"),
  uploadScenarioB(),
  deleteScenarioC(),
  deleteScenarioC("FILE_FIRST"),
  updateScenario("DB_FIRST"),
  updateScenario("PAUSE_WRITES"),
  twoUploadScenario("DB_FIRST"),
  twoUploadScenario("FILE_FIRST"),
  fourUploadScenario("DB_FIRST"),
  fourUploadScenario("PAUSE_WRITES"),
  idleScenario("DB_FIRST"),
  idleScenario("PAUSE_WRITES"),
];

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("determinism — same input, byte-identical output", () => {
  it("runSearch twice gives byte-identical JSON for every scenario", () => {
    for (const scenario of SCENARIOS) {
      const first = JSON.stringify(runSearch(scenario));
      const second = JSON.stringify(runSearch(scenario));
      expect(second).toBe(first);
      expect(sha256(second)).toBe(sha256(first));
    }
  });

  it("runSearchDetailed twice gives byte-identical JSON (result, trace, pairs, stats)", () => {
    for (const scenario of SCENARIOS) {
      const first = JSON.stringify(runSearchDetailed(scenario));
      const second = JSON.stringify(runSearchDetailed(scenario));
      expect(second).toBe(first);
    }
  });

  it("result is independent of run order (interleaved runs agree)", () => {
    const aFirst = JSON.stringify(runSearch(uploadScenarioA()));
    const bFirst = JSON.stringify(runSearch(uploadScenarioB()));
    const aSecond = JSON.stringify(runSearch(uploadScenarioA()));
    const bSecond = JSON.stringify(runSearch(uploadScenarioB()));
    expect(aSecond).toBe(aFirst);
    expect(bSecond).toBe(bFirst);
  });

  it("the SHA-256 of the scenario A result is stable and logged", () => {
    const first = sha256(JSON.stringify(runSearch(uploadScenarioA())));
    const second = sha256(JSON.stringify(runSearch(uploadScenarioA())));
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    // Logged so the determinism evidence file carries the fingerprint.
    console.log(`T003_DETERMINISM scenario A result sha256: ${first}`);
  });

  it("repeated runs do not mutate the input scenario", () => {
    const scenario = uploadScenarioA();
    const before = JSON.stringify(scenario);
    runSearch(scenario);
    runSearchDetailed(scenario);
    expect(JSON.stringify(scenario)).toBe(before);
  });
});

describe("no randomness, no wall-clock dependence", () => {
  it("search sources contain no randomness or wall-clock reads", () => {
    const files = [
      "src/core/search/bfs.ts",
      "src/core/search/search-state.ts",
      "src/core/search/visited-key.ts",
      "src/core/search/search-result.ts",
    ];
    for (const file of files) {
      const source = readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
      expect(source).not.toContain("Math.random");
      expect(source).not.toContain("Date.now");
      expect(source).not.toContain("new Date");
      expect(source).not.toContain("performance.now");
      expect(source).not.toContain("crypto.random");
    }
  });

  it("search sources contain no `any` type escape", () => {
    const files = [
      "src/core/search/bfs.ts",
      "src/core/search/search-state.ts",
      "src/core/search/visited-key.ts",
      "src/core/search/search-result.ts",
    ];
    const anyPattern = /:\s*any\b|as\s+any\b|<\s*any\s*>|Array<any>|any\[\]/;
    for (const file of files) {
      const source = readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
      expect(source).not.toMatch(anyPattern);
    }
  });
});
