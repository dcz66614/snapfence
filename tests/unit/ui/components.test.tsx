/**
 * SnapFence (P030) — T008 component rendering tests.
 *
 * Renders the real components to static markup in the node vitest
 * environment (react-dom/server — no jsdom, no new dependencies) and
 * asserts what the user sees: both lanes with correct events and snapshot
 * markers, counterexample highlight + replay controls, verbatim diagnostic
 * codes and verdict literals in Chinese UI, and the orphan/dangling visual
 * distinction. Results come from the S0-verified `runSearch` (or, for the
 * DANGLING_REFERENCE case, from the frozen core's own `evaluateSequence`
 * of the §9.3 4-event delete sequence — no Golden shortest counterexample
 * carries DANGLING_REFERENCE; see timeline-layout.test.ts).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Scenario, SearchResult, SearchVerdict } from "../../../src/core/model/types";
import { runSearch, evaluateSequence } from "../../../src/core/search/bfs";
import { buildSearchResult } from "../../../src/core/search/search-result";
import { Timeline } from "../../../src/components/timeline/Timeline";
import { DatabaseLane } from "../../../src/components/DatabaseLane";
import { BlobLane } from "../../../src/components/BlobLane";
import { SnapshotMarker } from "../../../src/components/SnapshotMarker";
import { CounterexamplePath } from "../../../src/components/CounterexamplePath";
import { ResultInspector } from "../../../src/components/ResultInspector";
import { buildTimelineModel } from "../../../src/components/timeline/timeline-layout";
import { buildReplaySteps, stateAfterSteps } from "../../../src/components/timeline/replay";

const GOLDEN_DIR = fileURLToPath(new URL("../../../fixtures/golden/", import.meta.url));

interface GoldenFixtureFile {
  fixtureId: string;
  scenario: Scenario;
  expectedCounterexample: readonly string[];
}

function loadFixture(fixtureId: string): GoldenFixtureFile {
  const raw = readFileSync(`${GOLDEN_DIR}${fixtureId}.json`, "utf-8");
  return JSON.parse(raw) as GoldenFixtureFile;
}

function runFixture(fixtureId: string): { fixture: GoldenFixtureFile; result: SearchResult } {
  const fixture = loadFixture(fixtureId);
  return { fixture, result: runSearch(fixture.scenario) };
}

/** A real DANGLING_REFERENCE result, judged by the frozen core. */
function danglingResult(): SearchResult {
  const fixture = loadFixture("U02");
  const evaluation = evaluateSequence(fixture.scenario, [
    "DB_SNAPSHOT",
    "delete-C:DB_UNLINK",
    "delete-C:BLOB_DELETE",
    "BLOB_SNAPSHOT",
  ]);
  return buildSearchResult({
    scenarioId: fixture.scenario.scenarioId,
    strategy: fixture.scenario.strategy,
    verdict: "UNSAFE_WITHIN_BOUND",
    eventCount: 4,
    counterexample: [
      "DB_SNAPSHOT",
      "delete-C:DB_UNLINK",
      "delete-C:BLOB_DELETE",
      "BLOB_SNAPSHOT",
    ],
    diagnostics: evaluation.diagnostics,
    databaseSnapshot: evaluation.databaseSnapshot ?? {},
    blobSnapshot: evaluation.blobSnapshot ?? {},
  });
}

describe("Timeline", () => {
  it("U01 renders both lanes, both snapshot markers, and the counterexample path", () => {
    const { fixture, result } = runFixture("U01");
    const html = renderToStaticMarkup(
      <Timeline scenario={fixture.scenario} result={result} replayStep={1} onReplayStepChange={() => undefined} />,
    );
    expect(html).toContain("数据库");
    expect(html).toContain("Blob 存储");
    expect(html).toContain("DB_SNAPSHOT");
    expect(html).toContain("BLOB_SNAPSHOT");
    expect(html).toContain("upload-A:BLOB_PUT");
    expect(html).toContain("snapshot-marker-database");
    expect(html).toContain("snapshot-marker-blob");
    expect(html).toContain("最短反例路径（3 个事件）");
    expect(html).toContain("第 1 / 3 步");
    expect(html).toContain("上一步");
    expect(html).toContain("下一步");
    // The replay cursor event is marked current; the applied one is done.
    expect(html).toContain('data-replay-state="current"');
    expect(html).toContain('data-replay-state="done"');
    // The counterexample polyline connects the events across lanes.
    expect(html).toContain("<polyline");
    // The SVG overlay has an explicit pixel height (324px = 2 normal lanes
    // + 8px gap); without it the replaced-element sizing would spill the
    // highlight line far below the timeline.
    expect(html).toContain("height:324px");
  });

  it("G12 (SAFE) renders the full sequence and says there is no counterexample", () => {
    const { fixture, result } = runFixture("G12");
    const html = renderToStaticMarkup(
      <Timeline scenario={fixture.scenario} result={result} replayStep={0} onReplayStepChange={() => undefined} />,
    );
    expect(html).toContain("完整事件顺序（10 个事件，无反例）");
    expect(html).toContain("upload-D:DB_LINK");
    expect(html).toContain("第 0 / 10 步");
    // 10 events: compact staggered layout so neighbouring chips cannot
    // overlap (rows at 25% / 75% of the taller track).
    expect(html).toContain("sf-compact");
    expect(html).toContain("top:25%");
    expect(html).toContain("top:75%");
    // G12 is SAFE, so no counterexample SVG is rendered at all.
    expect(html).not.toContain("<svg");
  });

  it("a 10-event counterexample renders the compact overlay at 448px height", () => {
    const { fixture } = runFixture("G12");
    const canonical = [
      "upload-A:BLOB_PUT",
      "upload-A:DB_LINK",
      "upload-B:BLOB_PUT",
      "upload-B:DB_LINK",
      "upload-C:BLOB_PUT",
      "upload-C:DB_LINK",
      "upload-D:BLOB_PUT",
      "upload-D:DB_LINK",
      "DB_SNAPSHOT",
      "BLOB_SNAPSHOT",
    ];
    const longResult = buildSearchResult({
      scenarioId: fixture.scenario.scenarioId,
      strategy: fixture.scenario.strategy,
      verdict: "UNSAFE_WITHIN_BOUND",
      eventCount: 10,
      counterexample: canonical,
      diagnostics: [],
      databaseSnapshot: {},
      blobSnapshot: {},
    });
    const html = renderToStaticMarkup(
      <Timeline
        scenario={fixture.scenario}
        result={longResult}
        replayStep={0}
        onReplayStepChange={() => undefined}
      />,
    );
    expect(html).toContain("sf-compact");
    expect(html).toContain("<polyline");
    // Compact lanes area: 2 * 220px + 8px gap = 448px overlay height.
    expect(html).toContain("height:448px");
  });

  it("U01 (3 events) uses the single-row layout, not the compact one", () => {
    const { fixture, result } = runFixture("U01");
    const html = renderToStaticMarkup(
      <Timeline scenario={fixture.scenario} result={result} replayStep={0} onReplayStepChange={() => undefined} />,
    );
    expect(html).not.toContain("sf-compact");
    expect(html).toContain("top:50%");
  });
});

describe("DatabaseLane / BlobLane", () => {
  it("DatabaseLane shows only database-lane events", () => {
    const { fixture, result } = runFixture("U01");
    const model = buildTimelineModel(fixture.scenario, result, 0);
    const html = renderToStaticMarkup(<DatabaseLane items={model.databaseItems} compact={false} />);
    expect(html).toContain("数据库");
    expect(html).toContain("DB_SNAPSHOT");
    expect(html).not.toContain("upload-A:BLOB_PUT");
    expect(html).not.toContain("BLOB_SNAPSHOT");
  });

  it("BlobLane shows only Blob-lane events", () => {
    const { fixture, result } = runFixture("U01");
    const model = buildTimelineModel(fixture.scenario, result, 0);
    const html = renderToStaticMarkup(<BlobLane items={model.blobItems} compact={false} />);
    expect(html).toContain("Blob 存储");
    expect(html).toContain("upload-A:BLOB_PUT");
    expect(html).toContain("BLOB_SNAPSHOT");
    expect(html).not.toContain("DB_SNAPSHOT");
  });
});

describe("SnapshotMarker", () => {
  it("renders the label text for both snapshot kinds", () => {
    const db = renderToStaticMarkup(
      <SnapshotMarker labelZh="数据库快照" xPercent={16.67} lane="database" />,
    );
    expect(db).toContain("数据库快照");
    expect(db).toContain("#2563eb");
    const blob = renderToStaticMarkup(
      <SnapshotMarker labelZh="Blob 快照" xPercent={83.33} lane="blob" />,
    );
    expect(blob).toContain("Blob 快照");
    expect(blob).toContain("#059669");
  });
});

describe("CounterexamplePath", () => {
  it("at step 0 the back buttons are disabled; at the end the forward buttons are", () => {
    const { fixture, result } = runFixture("U01");
    const model = buildTimelineModel(fixture.scenario, result, 0);
    const steps = buildReplaySteps(fixture.scenario, model.sequence.eventIds);
    const start = renderToStaticMarkup(
      <CounterexamplePath
        items={model.items}
        isCounterexample
        replayStep={0}
        onReplayStepChange={() => undefined}
        lastAppliedStep={null}
        currentState={stateAfterSteps(fixture.scenario, model.sequence.eventIds, 0)}
      />,
    );
    expect(start).toContain("回到开头");
    expect(start).toContain("尚未开始回放");
    // Both back buttons disabled at step 0 (two disabled attributes on buttons).
    expect((start.match(/disabled/g) ?? []).length).toBeGreaterThanOrEqual(2);
    const end = renderToStaticMarkup(
      <CounterexamplePath
        items={model.items}
        isCounterexample
        replayStep={3}
        onReplayStepChange={() => undefined}
        lastAppliedStep={steps[2] ?? null}
        currentState={stateAfterSteps(fixture.scenario, model.sequence.eventIds, 3)}
      />,
    );
    expect(end).toContain("回放完成");
    expect(end).toContain("第 3 / 3 步");
    expect((end.match(/disabled/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe("ResultInspector — verbatim codes and verdicts", () => {
  it("U01 shows the verbatim verdict, codes, affected file, and orphan diff row", () => {
    const { result } = runFixture("U01");
    const html = renderToStaticMarkup(<ResultInspector result={result} />);
    expect(html).toContain("UNSAFE_WITHIN_BOUND");
    expect(html).toContain("ORPHAN_BLOB");
    expect(html).toContain("NO_COMMON_BOUNDARY");
    expect(html).toContain("IN_FLIGHT_OPERATION");
    expect(html).toContain("孤立对象");
    expect(html).toContain("最短反例长度");
    expect(html).toContain("展开诊断代码解释");
    expect(html).not.toContain("DANGLING_REFERENCE");
  });

  it("a real DANGLING_REFERENCE result is red 悬空引用, distinct from orphan", () => {
    const html = renderToStaticMarkup(<ResultInspector result={danglingResult()} />);
    expect(html).toContain("DANGLING_REFERENCE");
    expect(html).toContain("悬空引用");
    expect(html).toContain("#dc2626");
    expect(html).toContain("受影响的文件：C");
    expect(html).toContain("受影响的对象：C-v1");
    const orphanHtml = renderToStaticMarkup(<ResultInspector result={runFixture("U01").result} />);
    expect(orphanHtml).toContain("#d97706");
    expect(html).not.toContain("ORPHAN_BLOB");
  });

  it("renders all 6 diagnostic codes verbatim when present", () => {
    const { result } = runFixture("U01");
    const allCodes = buildSearchResult({
      scenarioId: result.scenarioId,
      strategy: result.strategy,
      verdict: "UNSAFE_WITHIN_BOUND",
      eventCount: result.eventCount,
      counterexample: result.counterexample,
      diagnostics: [
        { code: "DANGLING_REFERENCE", severity: "CRITICAL", message: "dangling", fileId: "A", objectId: "A-v1" },
        { code: "ORPHAN_BLOB", severity: "WARNING", message: "orphan", objectId: "A-v1" },
        { code: "GENERATION_MISMATCH", severity: "CRITICAL", message: "generation" },
        { code: "DIGEST_MISMATCH", severity: "CRITICAL", message: "digest" },
        { code: "IN_FLIGHT_OPERATION", severity: "WARNING", message: "in flight" },
        { code: "NO_COMMON_BOUNDARY", severity: "CRITICAL", message: "no boundary" },
      ],
      databaseSnapshot: result.databaseSnapshot,
      blobSnapshot: result.blobSnapshot,
    });
    const html = renderToStaticMarkup(<ResultInspector result={allCodes} />);
    for (const code of [
      "DANGLING_REFERENCE",
      "ORPHAN_BLOB",
      "GENERATION_MISMATCH",
      "DIGEST_MISMATCH",
      "IN_FLIGHT_OPERATION",
      "NO_COMMON_BOUNDARY",
    ]) {
      expect(html).toContain(code);
    }
  });

  it("renders all 4 verdict literals verbatim", () => {
    const { result } = runFixture("U01");
    const verdicts: readonly SearchVerdict[] = [
      "SAFE_WITHIN_BOUND",
      "UNSAFE_WITHIN_BOUND",
      "INCONCLUSIVE_LIMIT",
      "INVALID_INPUT",
    ];
    for (const verdict of verdicts) {
      const shaped: SearchResult = {
        ...result,
        verdict,
        counterexample: verdict === "UNSAFE_WITHIN_BOUND" ? result.counterexample : [],
        counterexampleLength:
          verdict === "UNSAFE_WITHIN_BOUND" ? result.counterexampleLength : 0,
      };
      const html = renderToStaticMarkup(<ResultInspector result={shaped} />);
      expect(html).toContain(verdict);
    }
  });

  it("SAFE result shows no diagnostics and no counterexample", () => {
    const { result } = runFixture("G02");
    const html = renderToStaticMarkup(<ResultInspector result={result} />);
    expect(html).toContain("SAFE_WITHIN_BOUND");
    expect(html).toContain("无诊断");
    expect(html).toContain("无反例");
  });
});
