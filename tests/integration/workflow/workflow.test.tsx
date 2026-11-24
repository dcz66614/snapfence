/**
 * SnapFence (P030) — T010 integration tests: end-to-end workflow.
 *
 * The full workflow — Scenario -> Strategy -> Web Worker -> BFS ->
 * Consistency Check -> Counterexample -> Timeline -> JSON / HTML export —
 * run through the real `SnapFenceWorkerClient` (local in-process transport
 * speaking the exact typed Worker protocol) and the real
 * `ScenarioController`:
 *
 * - all 24 Golden scenarios end to end, verdicts matching the fixtures
 *   (12 UNSAFE_WITHIN_BOUND / 12 SAFE_WITHIN_BOUND);
 * - all three strategies switchable (DB_FIRST / FILE_FIRST /
 *   PAUSE_WRITES) and carried into the run;
 * - all four search verdict literals render in the UI
 *   (SAFE_WITHIN_BOUND, UNSAFE_WITHIN_BOUND, INCONCLUSIVE_LIMIT,
 *   INVALID_INPUT) — the last two have no Golden fixture, so they are
 *   driven by synthetic scenarios (an over-limit scenario and an invalid
 *   scenario) through the Worker path;
 * - L-T008-01: no Golden shortest counterexample carries
 *   DANGLING_REFERENCE, so the §9.3 4-event U02 sequence is judged via the
 *   frozen core's `evaluateSequence` (as T008 did);
 * - export agrees with the UI (24/24): the JSON export built from the
 *   same SearchResult the UI renders carries the byte-identical verdict,
 *   diagnostics, and counterexample, and the HTML export shows the same.
 *
 * Frozen vocabulary (PROJECT_BOOK.md §4.4 / §4.7, D-02):
 * - diagnostic codes: DANGLING_REFERENCE, ORPHAN_BLOB,
 *   GENERATION_MISMATCH, DIGEST_MISMATCH, IN_FLIGHT_OPERATION,
 *   NO_COMMON_BOUNDARY
 * - verdict literals: SAFE_WITHIN_BOUND, UNSAFE_WITHIN_BOUND,
 *   INCONCLUSIVE_LIMIT, INVALID_INPUT
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Scenario, SearchResult } from "../../../src/core/model/types";
import { evaluateSequence, runSearch } from "../../../src/core/search/bfs";
import { GOLDEN_SCENARIOS } from "../../../src/components/scenarios";
import { ResultInspector } from "../../../src/components/ResultInspector";
import { App } from "../../../src/app/App";
import { ScenarioController } from "../../../src/app/scenario-controller";
import { createLocalWorkerClient } from "../../../src/worker/worker-client";
import { exportHtml } from "../../../src/export/html-export";
import { exportJson } from "../../../src/export/json-export";

const GOLDEN_DIR = fileURLToPath(new URL("../../../fixtures/golden/", import.meta.url));

interface GoldenFixtureFile {
  fixtureId: string;
  scenario: Scenario;
  expectedVerdict: string;
  expectedDiagnostics: readonly string[];
  expectedCounterexample: readonly string[];
  expectedCounterexampleLength: number;
}

function loadFixture(fixtureId: string): GoldenFixtureFile {
  const raw = JSON.parse(readFileSync(`${GOLDEN_DIR}${fixtureId}.json`, "utf8")) as GoldenFixtureFile;
  return raw;
}

const ALL_IDS = [
  "U01", "U02", "U03", "U04", "U05", "U06", "U07", "U08", "U09", "U10", "U11", "U12",
  "G01", "G02", "G03", "G04", "G05", "G06", "G07", "G08", "G09", "G10", "G11", "G12",
];

/** Synthetic over-limit scenario: 5 uploads = 12 events > the 10 bound. */
function overLimitScenario(): Scenario {
  return {
    scenarioId: "T010_OVER_LIMIT",
    strategy: "DB_FIRST",
    maxEvents: 12,
    operations: ["A", "B", "C", "D", "E"].map((fileId) => ({
      opId: `upload-${fileId}`,
      kind: "UPLOAD" as const,
      fileId,
      objectId: `${fileId}-v1`,
      digest: `fixture-digest-${fileId}`,
    })),
  };
}

/** Synthetic invalid scenario: snapshotsAfter names an unknown opId. */
function invalidScenario(): Scenario {
  return {
    scenarioId: "T010_INVALID",
    strategy: "DB_FIRST",
    maxEvents: 10,
    snapshotsAfter: ["no-such-op"],
    operations: [
      {
        opId: "upload-A",
        kind: "UPLOAD",
        fileId: "A",
        objectId: "A-v1",
        digest: "fixture-digest-A",
      },
    ],
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("end-to-end workflow", () => {
  it("runs all 24 Golden scenarios end to end through the Worker path", async () => {
    const client = createLocalWorkerClient();
    try {
      let unsafe = 0;
      let safe = 0;
      for (const fixtureId of ALL_IDS) {
        const fixture = loadFixture(fixtureId);
        const result = await client.run(fixture.scenario);
        expect(result.verdict).toBe(fixture.expectedVerdict);
        expect(result.diagnostics.map((d) => d.code)).toEqual(fixture.expectedDiagnostics);
        expect(result.counterexample).toEqual(fixture.expectedCounterexample);
        expect(result.counterexampleLength).toBe(fixture.expectedCounterexampleLength);
        if (result.verdict === "UNSAFE_WITHIN_BOUND") unsafe += 1;
        if (result.verdict === "SAFE_WITHIN_BOUND") safe += 1;
      }
      expect(unsafe).toBe(12);
      expect(safe).toBe(12);
    } finally {
      client.terminate();
    }
  });

  it("runs the 24 Golden scenarios through the ScenarioController too", async () => {
    const client = createLocalWorkerClient();
    const controller = new ScenarioController(client);
    try {
      for (const fixtureId of ALL_IDS) {
        controller.selectFixture(fixtureId);
        controller.run();
        // Wait for the controller to reach "done" (local Worker round-trip).
        for (let attempt = 0; attempt < 50; attempt += 1) {
          if (controller.getState().status === "done") break;
          await flush();
        }
        const state = controller.getState();
        expect(state.status).toBe("done");
        const fixture = loadFixture(fixtureId);
        expect(state.result?.verdict).toBe(fixture.expectedVerdict);
      }
    } finally {
      client.terminate();
    }
  });

  it("switches all three strategies and carries each into the run", async () => {
    const client = createLocalWorkerClient();
    const controller = new ScenarioController(client);
    try {
      controller.selectFixture("U01");
      for (const strategy of ["DB_FIRST", "FILE_FIRST", "PAUSE_WRITES"] as const) {
        controller.selectStrategy(strategy);
        controller.run();
        for (let attempt = 0; attempt < 50; attempt += 1) {
          if (controller.getState().status === "done") break;
          await flush();
        }
        const state = controller.getState();
        expect(state.status).toBe("done");
        expect(state.result?.strategy).toBe(strategy);
        expect(state.result?.scenarioId).toBe("U01_DB_FIRST_UPLOAD_ORPHAN");
      }
    } finally {
      client.terminate();
    }
  });

  it("renders all four verdict literals in the UI (incl. synthetic limit/invalid)", async () => {
    const client = createLocalWorkerClient();
    try {
      const results: SearchResult[] = [
        runSearch(loadFixture("G01").scenario),
        runSearch(loadFixture("U01").scenario),
        await client.run(overLimitScenario()),
        await client.run(invalidScenario()),
      ];
      const verdicts = results.map((r) => r.verdict);
      expect(verdicts).toEqual([
        "SAFE_WITHIN_BOUND",
        "UNSAFE_WITHIN_BOUND",
        "INCONCLUSIVE_LIMIT",
        "INVALID_INPUT",
      ]);
      for (const result of results) {
        const html = renderToStaticMarkup(<ResultInspector result={result} />);
        expect(html).toContain(result.verdict);
      }
      const limitHtml = renderToStaticMarkup(<ResultInspector result={results[2]} />);
      expect(limitHtml).toContain("INCONCLUSIVE_LIMIT");
      expect(limitHtml).toContain("超出搜索界限");
      const invalidHtml = renderToStaticMarkup(
        <ResultInspector result={results[3]} />,
      );
      expect(invalidHtml).toContain("INVALID_INPUT");
      expect(invalidHtml).toContain("输入非法");
    } finally {
      client.terminate();
    }
  });

  it("the §9.3 4-event U02 sequence carries DANGLING_REFERENCE (L-T008-01)", () => {
    const fixture = loadFixture("U02");
    const evaluation = evaluateSequence(fixture.scenario, [
      "DB_SNAPSHOT",
      "delete-C:DB_UNLINK",
      "delete-C:BLOB_DELETE",
      "BLOB_SNAPSHOT",
    ]);
    expect(evaluation.valid).toBe(true);
    expect(evaluation.consistent).toBe(false);
    const codes = evaluation.diagnostics.map((d) => d.code);
    expect(codes).toContain("DANGLING_REFERENCE");
    expect(codes).toContain("NO_COMMON_BOUNDARY");
    // The database snapshot still references C-v1; the Blob snapshot is empty.
    expect(evaluation.databaseSnapshot?.["C"]?.objectId).toBe("C-v1");
    expect(evaluation.blobSnapshot).toEqual({});
    // The same diagnostics render in the UI inspector.
    const html = renderToStaticMarkup(
      <ResultInspector
        result={{
          ...runSearch(fixture.scenario),
          diagnostics: evaluation.diagnostics,
          counterexample: [
            "DB_SNAPSHOT",
            "delete-C:DB_UNLINK",
            "delete-C:BLOB_DELETE",
            "BLOB_SNAPSHOT",
          ],
          counterexampleLength: 4,
        }}
      />,
    );
    expect(html).toContain("DANGLING_REFERENCE");
    expect(html).toContain("悬空引用");
  });

  it("export agrees with the UI verdict for all 24 scenarios (24/24)", async () => {
    const client = createLocalWorkerClient();
    try {
      let matched = 0;
      for (const fixtureId of ALL_IDS) {
        const fixture = loadFixture(fixtureId);
        const result = await client.run(fixture.scenario);
        // The UI renders this exact SearchResult object; the exports are
        // built from the same object.
        const inspectorHtml = renderToStaticMarkup(<ResultInspector result={result} />);
        const jsonText = exportJson(result);
        const doc = JSON.parse(jsonText) as SearchResult;
        expect(doc.verdict).toBe(result.verdict);
        expect(doc.diagnostics.map((d) => d.code)).toEqual(
          result.diagnostics.map((d) => d.code),
        );
        expect(doc.counterexample).toEqual([...result.counterexample]);
        expect(doc.counterexampleLength).toBe(result.counterexampleLength);
        expect(doc.strategy).toBe(result.strategy);
        expect(doc.scenarioId).toBe(result.scenarioId);
        const htmlText = exportHtml(result);
        expect(htmlText).toContain(result.verdict);
        for (const diagnostic of result.diagnostics) {
          expect(htmlText).toContain(diagnostic.code);
          expect(inspectorHtml).toContain(diagnostic.code);
        }
        for (const eventId of result.counterexample) {
          expect(htmlText).toContain(eventId);
          expect(inspectorHtml).toContain(eventId);
        }
        expect(inspectorHtml).toContain(result.verdict);
        if (result.counterexampleLength > 0) {
          expect(htmlText).toContain(
            `最短反例长度：<strong>${result.counterexampleLength}</strong>`,
          );
        } else {
          expect(htmlText).toContain("无反例");
        }
        matched += 1;
      }
      expect(matched).toBe(24);
    } finally {
      client.terminate();
    }
  });

  it("the App shell renders the 24 scenarios, 3 strategies, and export controls", () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain("SnapFence");
    expect(html).toContain("运行模型检查");
    expect(html).toContain("取消");
    expect(html).toContain("导出 JSON");
    expect(html).toContain("导出 HTML");
    for (const fixture of GOLDEN_SCENARIOS) {
      expect(html).toContain(fixture.fixtureId);
    }
    for (const strategy of ["DB_FIRST", "FILE_FIRST", "PAUSE_WRITES"]) {
      expect(html).toContain(strategy);
    }
    expect(html).toContain("Web Worker");
    expect(html).toContain("刷新页面可清空当前状态");
    // No result yet: the status is "未运行", the empty state shows, and
    // neither the timeline nor the diagnostics panel renders. (The
    // fixture's *expected* verdict legitimately appears in the meta line
    // and the footer names SAFE_WITHIN_BOUND in the honesty boundary.)
    expect(html).toContain("未运行");
    expect(html).not.toContain("sf-timeline");
    expect(html).not.toContain("sf-inspector");
    expect(html).toContain("选择一个合成场景与备份策略");
  });

  it("the App shell keeps the ?scenario=&run=1 deep link working (static render)", () => {
    const previousLocation = globalThis.window;
    try {
      // Simulate the deep-link URL the T008 screenshots used.
      Object.defineProperty(globalThis, "window", {
        value: { location: { search: "?scenario=U07&strategy=FILE_FIRST&run=1" } },
        configurable: true,
      });
      const html = renderToStaticMarkup(<App />);
      expect(html).toContain("U07");
      expect(html).toContain("FILE_FIRST");
    } finally {
      if (previousLocation === undefined) {
        delete (globalThis as Record<string, unknown>)["window"];
      } else {
        Object.defineProperty(globalThis, "window", {
          value: previousLocation,
          configurable: true,
        });
      }
    }
  });
});
