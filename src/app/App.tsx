/**
 * SnapFence (P030) — application shell. T010.
 *
 * Authority: PROJECT_BOOK.md §5.1 (main flow: pick a strategy, pick a
 * synthetic scenario, run the check, view the two timelines, replay the
 * counterexample, export JSON/HTML) and §5.4 (start, pause and re-run;
 * the run must not block the main thread); IMPLEMENTATION_PLAN.md T010
 * (Scenario -> Strategy -> Web Worker -> BFS -> Consistency Check ->
 * Counterexample -> Timeline -> JSON / HTML).
 *
 * This shell replaces T008's temporary `TimelineApp` (which ran the
 * S0-verified `runSearch` on the main thread via a macrotask deferral in
 * `search-async.ts` — now deprecated, see that file). The search now runs
 * through `SnapFenceWorkerClient` (a real Web Worker in the browser; the
 * same typed protocol in-process under node tests) and the run lifecycle
 * is owned by `ScenarioController`, so cancelling or re-running can never
 * show a stale result. Export uses T009's `exportJson` / `exportHtml` on
 * the exact same `SearchResult` object the Timeline and the Result
 * Inspector render — the exported verdict, diagnostics, and counterexample
 * are byte-identical to what the UI shows.
 *
 * State lives only in React state and in the controller: nothing is
 * written to any browser storage API, so refreshing the page clears the
 * current state (PROJECT_BOOK.md §11.1).
 *
 * Deep links (kept from T008):
 *   ?scenario=U01&run=1   — open scenario U01 and run the check at once
 *   ?scenario=U07&strategy=FILE_FIRST&run=1
 * An unknown ?scenario value falls back to U01; an unknown ?strategy
 * falls back to the fixture's own strategy.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { BackupStrategy, SearchResult } from "../core/model/types";
import {
  GOLDEN_SCENARIOS,
  SCENARIO_LABELS,
  getGoldenFixture,
  scenarioWithStrategy,
} from "../components/scenarios";
import { STRATEGY_LABELS } from "../components/timeline/timeline-layout";
import { Timeline } from "../components/timeline/Timeline";
import { ResultInspector } from "../components/ResultInspector";
import { SnapFenceWorkerClient } from "../worker/worker-client";
import {
  ScenarioController,
  isBackupStrategy,
  type ControllerSnapshot,
} from "./scenario-controller";
import { exportJson } from "../export/json-export";
import { exportHtml } from "../export/html-export";
import "../components/timeline/timeline.css";

const STRATEGIES: readonly BackupStrategy[] = ["DB_FIRST", "FILE_FIRST", "PAUSE_WRITES"] as const;

function readInitialParams(): {
  fixtureId: string;
  strategy: BackupStrategy | null;
  autoRun: boolean;
} {
  if (typeof window === "undefined") {
    return { fixtureId: "U01", strategy: null, autoRun: false };
  }
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("scenario") ?? "U01";
  const fixture = getGoldenFixture(requested);
  const fixtureId = fixture !== undefined ? requested : "U01";
  const strategyParam = params.get("strategy");
  const strategy =
    strategyParam !== null && isBackupStrategy(strategyParam)
      ? strategyParam
      : null;
  return { fixtureId, strategy, autoRun: params.get("run") === "1" };
}

/**
 * Download a text file in the browser. No-op outside a browser (static
 * render / tests): export buttons are inert there.
 */
function downloadText(filename: string, text: string, mime: string): void {
  if (typeof document === "undefined") {
    return;
  }
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function App() {
  const initialRef = useRef<{
    fixtureId: string;
    strategy: BackupStrategy | null;
    autoRun: boolean;
  } | null>(null);
  if (initialRef.current === null) {
    initialRef.current = readInitialParams();
  }
  const initial = initialRef.current;

  // One Worker client + one controller for the lifetime of the app. The
  // transport is created lazily on the first run, so constructing the
  // client (and statically rendering this component) never touches a
  // Worker. The Worker lives as long as the page; there is no terminate
  // on unmount — a StrictMode remount must not kill the client's Worker.
  const controllerRef = useRef<ScenarioController | null>(null);
  if (controllerRef.current === null) {
    const client = new SnapFenceWorkerClient();
    const controller = new ScenarioController(client);
    controller.selectFixture(initial.fixtureId);
    if (initial.strategy !== null) {
      controller.selectStrategy(initial.strategy);
    }
    controllerRef.current = controller;
  }
  const controller = controllerRef.current;

  const subscribe = useCallback(
    (listener: () => void) => controller.subscribe(listener),
    [controller],
  );
  const getSnapshot = useCallback(
    (): ControllerSnapshot => controller.getState(),
    [controller],
  );
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const [replayStep, setReplayStep] = useState(0);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  // Auto-run once, on mount, from the deep link (?scenario=&run=1).
  useEffect(() => {
    if (initial.autoRun) {
      controller.run();
    }
    // Auto-run only once, on mount, from the deep link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new result (or a new selection) restarts the replay from step 0.
  useEffect(() => {
    setReplayStep(0);
  }, [state.result, state.fixtureId]);

  const fixture = getGoldenFixture(state.fixtureId) ?? GOLDEN_SCENARIOS[0];
  const scenario = scenarioWithStrategy(fixture, state.strategy);
  const result: SearchResult | null = state.result;

  const statusText =
    state.status === "running"
      ? "搜索中…（Web Worker 后台执行）"
      : state.status === "done" && result !== null
        ? `已完成：${result.verdict}`
        : state.status === "cancelled"
          ? "已取消"
          : state.status === "error"
            ? `运行失败：${state.error ?? "未知错误"}`
            : "未运行";

  const onFixtureChange = (nextFixtureId: string) => {
    controller.selectFixture(nextFixtureId);
    setReplayStep(0);
    setExportNotice(null);
  };

  const onStrategyChange = (nextStrategy: BackupStrategy) => {
    controller.selectStrategy(nextStrategy);
    setReplayStep(0);
    setExportNotice(null);
  };

  const onExportJson = () => {
    if (result === null) {
      return;
    }
    downloadText(`snapfence-${result.scenarioId}.json`, exportJson(result), "application/json");
    setExportNotice(`已导出 JSON：snapfence-${result.scenarioId}.json`);
  };

  const onExportHtml = () => {
    if (result === null) {
      return;
    }
    downloadText(`snapfence-${result.scenarioId}.html`, exportHtml(result), "text/html");
    setExportNotice(`已导出 HTML：snapfence-${result.scenarioId}.html`);
  };

  return (
    <main className="sf-app">
      <header className="sf-header">
        <h1>SnapFence — 快照栅</h1>
        <p>
          应用级备份快照一致性模型检查器：本地运行，全部使用合成数据，不上传任何内容。
          搜索在 Web Worker 后台线程执行，界面保持响应。刷新页面可清空当前状态。
        </p>
      </header>

      <section className="sf-controls" aria-label="实验控制">
        <label>
          合成场景
          <select
            value={state.fixtureId}
            onChange={(event) => onFixtureChange(event.target.value)}
            disabled={state.status === "running"}
          >
            {GOLDEN_SCENARIOS.map((candidate) => (
              <option key={candidate.fixtureId} value={candidate.fixtureId}>
                {candidate.fixtureId} — {SCENARIO_LABELS[candidate.fixtureId]}（
                {candidate.scenario.scenarioId}）
              </option>
            ))}
          </select>
        </label>
        <label>
          备份策略
          <select
            value={state.strategy}
            onChange={(event) => onStrategyChange(event.target.value as BackupStrategy)}
            disabled={state.status === "running"}
          >
            {STRATEGIES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {STRATEGY_LABELS[candidate]}（{candidate}）
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={state.status === "running"}
          onClick={() => controller.run()}
        >
          {state.status === "running" ? "搜索中…" : "运行模型检查"}
        </button>
        <button
          type="button"
          disabled={state.status !== "running"}
          onClick={() => controller.cancel()}
        >
          取消
        </button>
        <button type="button" disabled={result === null} onClick={onExportJson}>
          导出 JSON
        </button>
        <button type="button" disabled={result === null} onClick={onExportHtml}>
          导出 HTML
        </button>
        <span className="sf-status" role="status">
          状态：{statusText}
        </span>
        <span className="sf-meta">
          场景 {fixture.scenario.scenarioId} · 事件数 {fixture.eventCount} · 预期判定{" "}
          <code>{fixture.expectedVerdict}</code>
        </span>
      </section>

      {state.status === "error" && state.error !== null ? (
        <p className="sf-error">{state.error}</p>
      ) : null}
      {state.status === "running" ? (
        <p className="sf-running">正在搜索合法事件交错，界面保持响应…可随时取消。</p>
      ) : null}
      {state.status === "cancelled" ? (
        <p className="sf-running">已取消本次搜索，未显示任何结果。</p>
      ) : null}
      {exportNotice !== null ? <p className="sf-running">{exportNotice}</p> : null}

      {result !== null ? (
        <>
          <Timeline
            scenario={scenario}
            result={result}
            replayStep={replayStep}
            onReplayStepChange={setReplayStep}
          />
          <ResultInspector result={result} />
        </>
      ) : (
        <p className="sf-empty">
          选择一个合成场景与备份策略，点击“运行模型检查”，查看数据库与 Blob
          两条时间线、快照位置与最短反例。运行完成后可导出 JSON 或 HTML 报告。
        </p>
      )}

      <footer className="sf-footer">
        <p>
          诚实边界：SAFE_WITHIN_BOUND
          是有界结论——在本次指定的事件模板、策略与事件规模内没有发现不一致路径，
          不代表真实生产系统绝对安全。模型检查不等于真实备份成功，也不等于真实恢复成功。
        </p>
      </footer>
    </main>
  );
}
