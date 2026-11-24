/**
 * SnapFence (P030) — application shell for the T008 dual-track timeline UI.
 * T008.
 *
 * SUPERSEDED in T010 by `src/app/App.tsx` (Worker integration + export):
 * `main.tsx` now renders `App`. This file is kept unchanged in behaviour
 * so the T008 UI tests (`tests/unit/ui/app.test.tsx`) still pass; do not
 * build new features on it. It ran the S0-verified `runSearch` on the
 * main thread via the (now deprecated) `runSearchAsync` macrotask
 * deferral; the real shell runs every search in the Web Worker.
 *
 * Authority: PROJECT_BOOK.md §5.1 (main flow: pick a strategy, pick a
 * synthetic scenario, run the check, view the two timelines, replay the
 * counterexample) and §11.1 (refreshing the browser clears the current
 * state). State lives only in React state: nothing is written to any
 * browser storage API, so a refresh always starts from the default
 * scenario with no result.
 *
 * The search runs through `runSearchAsync` (see timeline/search-async.ts):
 * the S0-verified synchronous `runSearch` is deferred to a macrotask, so
 * the "搜索中…" state paints and every control stays responsive while the
 * search is in flight. The Web Worker itself lands in T010; this shell is
 * replaced by src/app/App.tsx there.
 *
 * Deep links (used by the T008 screenshot evidence and by hand-testing):
 *   ?scenario=U01&run=1   — open scenario U01 and run the check at once
 *   ?scenario=U07&strategy=FILE_FIRST&run=1
 * An unknown ?scenario value falls back to U01; an unknown ?strategy
 * falls back to the fixture's own strategy.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { BackupStrategy, SearchResult } from "../core/model/types";
import {
  GOLDEN_SCENARIOS,
  SCENARIO_LABELS,
  getGoldenFixture,
  scenarioWithStrategy,
} from "./scenarios";
import { STRATEGY_LABELS } from "./timeline/timeline-layout";
import { runSearchAsync } from "./timeline/search-async";
import { Timeline } from "./timeline/Timeline";
import { ResultInspector } from "./ResultInspector";
import "./timeline/timeline.css";

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
    strategyParam !== null &&
    (STRATEGIES as readonly string[]).includes(strategyParam)
      ? (strategyParam as BackupStrategy)
      : null;
  return { fixtureId, strategy, autoRun: params.get("run") === "1" };
}

export function TimelineApp() {
  const initialRef = useRef<{
    fixtureId: string;
    strategy: BackupStrategy | null;
    autoRun: boolean;
  } | null>(null);
  if (initialRef.current === null) {
    initialRef.current = readInitialParams();
  }
  const initial = initialRef.current;
  const [fixtureId, setFixtureId] = useState(initial.fixtureId);
  const fixture = getGoldenFixture(fixtureId) ?? GOLDEN_SCENARIOS[0];
  const [strategy, setStrategy] = useState<BackupStrategy>(
    initial.strategy ?? fixture.scenario.strategy,
  );
  const [result, setResult] = useState<SearchResult | null>(null);
  const [running, setRunning] = useState(false);
  const [replayStep, setReplayStep] = useState(0);
  const [runError, setRunError] = useState<string | null>(null);

  const run = useCallback((targetFixtureId: string, targetStrategy: BackupStrategy) => {
    const target = getGoldenFixture(targetFixtureId);
    if (target === undefined) {
      setRunError(`未知场景：${targetFixtureId}`);
      return;
    }
    setRunning(true);
    setResult(null);
    setReplayStep(0);
    setRunError(null);
    const scenario = scenarioWithStrategy(target, targetStrategy);
    void runSearchAsync(scenario).then((next) => {
      setResult(next);
      setRunning(false);
    });
  }, []);

  useEffect(() => {
    if (initial.autoRun) {
      run(initial.fixtureId, initial.strategy ?? fixture.scenario.strategy);
    }
    // Auto-run only once, on mount, from the deep link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onFixtureChange = (nextFixtureId: string) => {
    const next = getGoldenFixture(nextFixtureId);
    if (next === undefined) {
      return;
    }
    setFixtureId(nextFixtureId);
    setStrategy(next.scenario.strategy);
    setResult(null);
    setReplayStep(0);
    setRunError(null);
  };

  const onStrategyChange = (nextStrategy: BackupStrategy) => {
    setStrategy(nextStrategy);
    setResult(null);
    setReplayStep(0);
    setRunError(null);
  };

  const scenario = scenarioWithStrategy(fixture, strategy);
  const statusText = running
    ? "搜索中…"
    : result !== null
      ? `已完成：${result.verdict}`
      : "未运行";
  return (
    <main className="sf-app">
      <header className="sf-header">
        <h1>SnapFence — 快照栅</h1>
        <p>
          应用级备份快照一致性模型检查器：本地运行，全部使用合成数据，不上传任何内容。
          刷新页面可清空当前状态。
        </p>
      </header>

      <section className="sf-controls" aria-label="实验控制">
        <label>
          合成场景
          <select
            value={fixtureId}
            onChange={(event) => onFixtureChange(event.target.value)}
            disabled={running}
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
            value={strategy}
            onChange={(event) => onStrategyChange(event.target.value as BackupStrategy)}
            disabled={running}
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
          disabled={running}
          onClick={() => run(fixtureId, strategy)}
        >
          {running ? "搜索中…" : "运行模型检查"}
        </button>
        <span className="sf-status" role="status">
          状态：{statusText}
        </span>
        <span className="sf-meta">
          场景 {fixture.scenario.scenarioId} · 事件数 {fixture.eventCount} · 预期判定{" "}
          <code>{fixture.expectedVerdict}</code>
        </span>
      </section>

      {runError !== null ? <p className="sf-error">{runError}</p> : null}
      {running ? <p className="sf-running">正在搜索合法事件交错，界面保持响应…</p> : null}

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
          两条时间线、快照位置与最短反例。
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
