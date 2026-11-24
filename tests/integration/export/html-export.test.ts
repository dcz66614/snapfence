/**
 * SnapFence (P030) — T009 export integration tests: standalone HTML export.
 *
 * Covers: the document opens standalone (no server / build step — it is
 * one static file); it requests NO external resources (no `src` / `href`
 * attributes at all, no http(s) URL anywhere, no `<script>`, no `<link>`,
 * no `@import`, no React runtime); it carries the complete verdict /
 * diagnostic / counterexample / snapshot information; text is correctly
 * escaped (a hand-built result with `<`, `>`, `&`, quotes and Chinese
 * text in IDs renders only as entities, never as live markup); and the
 * output is deterministic (same input -> byte-identical HTML, SHA-256).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Scenario } from "../../../src/core/model/types";
import { runSearch } from "../../../src/core/search/bfs";
import { buildSearchResult } from "../../../src/core/search/search-result";
import { escapeHtml, exportHtml } from "../../../src/export/html-export";

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

/** The no-external-resources assertion, shared with the evidence check. */
export function assertNoExternalResources(html: string): void {
  expect(html).not.toMatch(/\bsrc\s*=/i);
  expect(html).not.toMatch(/\bhref\s*=/i);
  expect(html).not.toMatch(/https?:\/\//);
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/<link/i);
  expect(html).not.toMatch(/@import/i);
  expect(html).not.toMatch(/react/i);
  expect(html).not.toMatch(/url\s*\(/i);
}

describe("html-export", () => {
  it("exports scenario A (U01) as a complete standalone document", () => {
    const html = exportHtml(runSearch(loadScenario("U01")));
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("U01_DB_FIRST_UPLOAD_ORPHAN");
    expect(html).toContain("DB_FIRST");
    expect(html).toContain("UNSAFE_WITHIN_BOUND");
    expect(html).toContain("ORPHAN_BLOB");
    expect(html).toContain("NO_COMMON_BOUNDARY");
    expect(html).toContain("IN_FLIGHT_OPERATION");
    expect(html).toContain("DB_SNAPSHOT");
    expect(html).toContain("BLOB_SNAPSHOT");
    expect(html).toContain("A-v1@1");
    expect(html).toContain("fixture-digest-A");
    expect(html).toContain("snapfence.report/v1");
    // The honest-boundary note must be present (§4.7 / §6).
    expect(html).toContain("不表示真实生产系统绝对安全");
  });

  it("requests no external resources and uses no JavaScript or React", () => {
    for (const id of ["U01", "U07", "G12", "G01"]) {
      assertNoExternalResources(exportHtml(runSearch(loadScenario(id))));
    }
  });

  it("has no external resources for any of the 24 Golden reports", () => {
    const ids = [
      ...Array.from({ length: 12 }, (_, i) => `U${String(i + 1).padStart(2, "0")}`),
      ...Array.from({ length: 12 }, (_, i) => `G${String(i + 1).padStart(2, "0")}`),
    ];
    for (const id of ids) {
      assertNoExternalResources(exportHtml(runSearch(loadScenario(id))));
    }
  });

  it("is deterministic: same input produces byte-identical output (SHA-256)", () => {
    for (const id of ["U01", "G12"]) {
      const result = runSearch(loadScenario(id));
      const first = exportHtml(result);
      const second = exportHtml(result);
      expect(second).toBe(first);
      expect(sha256(second)).toBe(sha256(first));
      expect(sha256(exportHtml(runSearch(loadScenario(id))))).toBe(sha256(first));
    }
  });

  it("escapes <, >, &, quotes and Chinese text in IDs (no live markup)", () => {
    const trickyFileId = '文件<x>&"\'中文';
    const result = buildSearchResult({
      scenarioId: '场景<SC>&"\'中文',
      strategy: "FILE_FIRST",
      verdict: "UNSAFE_WITHIN_BOUND",
      eventCount: 3,
      counterexample: ["BLOB_SNAPSHOT", "BLOB_PUT", "DB_SNAPSHOT"],
      diagnostics: [
        {
          code: "DANGLING_REFERENCE",
          severity: "CRITICAL",
          fileId: trickyFileId,
          objectId: '对象<y>&"\'中文-v1',
          message: '悬空引用 <b>&"c" 中文',
        },
      ],
      databaseSnapshot: {
        [trickyFileId]: {
          objectId: '对象<y>&"\'中文-v1',
          generation: 1,
          digest: '摘要<>&"\'中文',
        },
      },
      blobSnapshot: {},
      extraLimitations: [],
    });
    const html = exportHtml(result);
    // Escaped forms are present …
    expect(html).toContain("文件&lt;x&gt;&amp;&quot;&#39;中文");
    expect(html).toContain("场景&lt;SC&gt;&amp;&quot;&#39;中文");
    expect(html).toContain("悬空引用 &lt;b&gt;&amp;&quot;c&quot; 中文");
    // … and the raw tricky strings never appear as live markup.
    expect(html).not.toContain(trickyFileId);
    expect(html).not.toContain("<x>");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<SC>");
    assertNoExternalResources(html);
  });

  it("escapeHtml escapes every dangerous character, & first", () => {
    expect(escapeHtml('<a href="x">&\'b\'</a>')).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;b&#39;&lt;/a&gt;",
    );
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
    expect(escapeHtml("中文 plain")).toBe("中文 plain");
    expect(escapeHtml("")).toBe("");
  });

  it("renders a SAFE report with empty counterexample and diagnostics sections", () => {
    const result = runSearch(loadScenario("G12"));
    const html = exportHtml(result);
    expect(html).toContain("SAFE_WITHIN_BOUND");
    expect(html).toContain("PAUSE_WRITES");
    expect(html).toContain("无反例");
    expect(html).toContain("无诊断");
    // G12's reported snapshots are the first-terminal pair (both empty:
    // both snapshots at boundary 0), so the tables render the empty state.
    expect(result.databaseSnapshot).toEqual({});
    expect(result.blobSnapshot).toEqual({});
    expect(html).toContain("数据库快照为空");
    expect(html).toContain("Blob 快照为空");
  });

  it("HTML verdict agrees with the JSON export for every Golden scenario", () => {
    const ids = [
      ...Array.from({ length: 12 }, (_, i) => `U${String(i + 1).padStart(2, "0")}`),
      ...Array.from({ length: 12 }, (_, i) => `G${String(i + 1).padStart(2, "0")}`),
    ];
    for (const id of ids) {
      const result = runSearch(loadScenario(id));
      const html = exportHtml(result);
      expect(html).toContain(result.verdict);
      for (const diagnostic of result.diagnostics) {
        expect(html).toContain(diagnostic.code);
      }
      for (const eventId of result.counterexample) {
        expect(html).toContain(eventId);
      }
    }
  });
});
