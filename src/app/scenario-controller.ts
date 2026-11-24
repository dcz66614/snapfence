/**
 * SnapFence (P030) — scenario / strategy state machine. T010.
 *
 * Authority: IMPLEMENTATION_PLAN.md T010 (Scenario -> Strategy -> Web
 * Worker -> BFS -> ...; cancelling or re-running must never show a stale
 * result) and §10.3 (the Worker must not display an old result as the
 * current one).
 *
 * `ScenarioController` owns everything the App shell needs to run a check
 * without knowing about React or the Worker transport: the selected Golden
 * fixture, the selected strategy, the run status, the current result, and
 * the cancellation of the run in flight. It depends only on the minimal
 * `SearchRunner` surface (`run(scenario, { signal })`), so the production
 * `SnapFenceWorkerClient` and the tests' controllable fake runners are
 * interchangeable.
 *
 * Stale-result safety is a generation counter (`runId`):
 * - every `run()` aborts the previous run (if any) and takes a new runId;
 * - a run's settlement applies to the state only when its runId is still
 *   the current one. A late resolution from a cancelled or superseded run
 *   is dropped, never rendered;
 * - `cancel()` aborts the in-flight run, clears the result, and sets the
 *   status to "cancelled" — a cancelled run can never render a result,
 *   even if the Worker answers afterwards;
 * - changing the fixture or the strategy clears the result and resets the
 *   status to "idle": the UI never shows a result for a scenario/strategy
 *   pair that is no longer selected.
 *
 * The controller is framework-free and synchronous to observe: `getState()`
 * returns a stable snapshot object (replaced only on change) suitable for
 * `useSyncExternalStore`, and `subscribe()` notifies React of changes.
 */

import type { BackupStrategy, Scenario, SearchResult } from "../core/model/types";
import { GOLDEN_SCENARIOS, getGoldenFixture, scenarioWithStrategy } from "../components/scenarios";
import type { GoldenFixture } from "../components/scenarios";
import type { SearchRunner } from "../worker/worker-client";

/** Run status shown by the App shell. */
export type RunStatus = "idle" | "running" | "done" | "error" | "cancelled";

/** One immutable snapshot of the controller state. */
export interface ControllerSnapshot {
  fixtureId: string;
  strategy: BackupStrategy;
  status: RunStatus;
  /** The SearchResult the UI renders; null whenever no run is current. */
  result: SearchResult | null;
  /** Human-readable error for status "error", else null. */
  error: string | null;
  /** Monotonic run generation (increments on every run). */
  runId: number;
}

export type ControllerListener = () => void;

const STRATEGIES: readonly BackupStrategy[] = ["DB_FIRST", "FILE_FIRST", "PAUSE_WRITES"] as const;

export function isBackupStrategy(value: string): value is BackupStrategy {
  return (STRATEGIES as readonly string[]).includes(value);
}

export class ScenarioController {
  private readonly runner: SearchRunner;
  private readonly fixtures: readonly GoldenFixture[];
  private listeners = new Set<ControllerListener>();
  private snapshot: ControllerSnapshot;
  private runCounter = 0;
  private abortController: AbortController | null = null;

  public constructor(
    runner: SearchRunner,
    fixtures: readonly GoldenFixture[] = GOLDEN_SCENARIOS,
  ) {
    this.runner = runner;
    this.fixtures = fixtures;
    const first = fixtures[0];
    if (first === undefined) {
      throw new Error("ScenarioController needs at least one fixture.");
    }
    this.snapshot = {
      fixtureId: first.fixtureId,
      strategy: first.scenario.strategy,
      status: "idle",
      result: null,
      error: null,
      runId: 0,
    };
  }

  /** Current state snapshot (stable reference until the next change). */
  public getState(): ControllerSnapshot {
    return this.snapshot;
  }

  /** Subscribe to state changes; returns an unsubscribe function. */
  public subscribe(listener: ControllerListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The fixture currently selected. */
  public get fixture(): GoldenFixture {
    return getGoldenFixture(this.snapshot.fixtureId) ?? this.fixtures[0] as GoldenFixture;
  }

  /** The Scenario for the current fixture + strategy selection. */
  public currentScenario(): Scenario {
    return scenarioWithStrategy(this.fixture, this.snapshot.strategy);
  }

  /** Select a fixture (unknown ids are ignored); clears any result. */
  public selectFixture(fixtureId: string): void {
    const fixture = getGoldenFixture(fixtureId);
    if (fixture === undefined) {
      return;
    }
    this.abortInFlight();
    this.setSnapshot({
      ...this.snapshot,
      fixtureId,
      strategy: fixture.scenario.strategy,
      status: "idle",
      result: null,
      error: null,
      runId: this.runCounter,
    });
  }

  /** Select a strategy; clears any result. */
  public selectStrategy(strategy: BackupStrategy): void {
    if (strategy === this.snapshot.strategy) {
      return;
    }
    this.abortInFlight();
    this.setSnapshot({
      ...this.snapshot,
      strategy,
      status: "idle",
      result: null,
      error: null,
      runId: this.runCounter,
    });
  }

  /**
   * Run the check for the current fixture + strategy through the runner
   * (the Worker in production). Fire-and-forget by design: the result
   * arrives via `subscribe()`/`getState()`. A previous in-flight run is
   * aborted first; its late settlement is dropped by the runId guard.
   */
  public run(): void {
    this.abortInFlight();
    this.runCounter += 1;
    const runId = this.runCounter;
    const abortController = new AbortController();
    this.abortController = abortController;
    const scenario = this.currentScenario();
    this.setSnapshot({
      ...this.snapshot,
      status: "running",
      result: null,
      error: null,
      runId,
    });
    void this.runner
      .run(scenario, { signal: abortController.signal })
      .then((result) => {
        if (runId !== this.runCounter) {
          return; // Superseded or cancelled: never show a stale result.
        }
        this.abortController = null;
        this.setSnapshot({
          ...this.snapshot,
          status: "done",
          result,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (runId !== this.runCounter) {
          return; // Superseded or cancelled: the newer run owns the state.
        }
        this.abortController = null;
        if (abortController.signal.aborted) {
          this.setSnapshot({
            ...this.snapshot,
            status: "cancelled",
            result: null,
            error: null,
          });
          return;
        }
        this.setSnapshot({
          ...this.snapshot,
          status: "error",
          result: null,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /**
   * Cancel the run in flight, if any. The result stays null and the
   * status becomes "cancelled"; a late Worker answer for the cancelled
   * run is dropped by the runId guard and can never render.
   */
  public cancel(): void {
    if (this.snapshot.status !== "running") {
      return;
    }
    this.abortInFlight();
    this.setSnapshot({
      ...this.snapshot,
      status: "cancelled",
      result: null,
      error: null,
      runId: this.runCounter,
    });
  }

  /**
   * Abort the in-flight run, if any, and invalidate its generation so a
   * late settlement from it can never apply (the runId guard in `run()`
   * drops it). No-op when nothing is in flight — the counter only moves
   * when there is a run to invalidate.
   */
  private abortInFlight(): void {
    if (this.abortController !== null) {
      this.abortController.abort();
      this.abortController = null;
      this.runCounter += 1;
    }
  }

  private setSnapshot(next: ControllerSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
