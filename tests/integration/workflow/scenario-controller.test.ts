/**
 * SnapFence (P030) — T010 integration tests: scenario controller.
 *
 * Covers `ScenarioController` with a controllable fake runner (no Worker,
 * no timing): cancelling a run mid-flight never renders a result — even
 * when the runner answers late afterwards; re-running with a different
 * scenario shows only the latest result; changing the fixture or the
 * strategy clears the result so the UI never shows a verdict for a
 * selection that is no longer current.
 */

import { describe, expect, it } from "vitest";
import type { Scenario, SearchResult } from "../../../src/core/model/types";
import { runSearch } from "../../../src/core/search/bfs";
import { getGoldenFixture } from "../../../src/components/scenarios";
import { ScenarioController } from "../../../src/app/scenario-controller";
import type { SearchRunner } from "../../../src/worker/worker-client";

function fixtureScenario(fixtureId: string): Scenario {
  const fixture = getGoldenFixture(fixtureId);
  if (fixture === undefined) {
    throw new Error(`unknown fixture ${fixtureId}`);
  }
  return fixture.scenario;
}

/** A runner the test drives by hand: runs stay pending until resolved. */
interface FakeCall {
  scenario: Scenario;
  signal: AbortSignal | undefined;
  resolve: (result: SearchResult) => void;
  reject: (error: Error) => void;
  aborted: boolean;
}

class FakeRunner implements SearchRunner {
  public calls: FakeCall[] = [];

  public run(scenario: Scenario, options?: { signal?: AbortSignal }): Promise<SearchResult> {
    const signal = options?.signal;
    const record: FakeCall = {
      scenario,
      signal,
      resolve: () => undefined,
      reject: () => undefined,
      aborted: false,
    };
    const promise = new Promise<SearchResult>((resolve, reject) => {
      record.resolve = resolve;
      record.reject = reject;
    });
    this.calls.push(record);
    signal?.addEventListener("abort", () => {
      record.aborted = true;
    });
    return promise;
  }

  public resolveCall(index: number, result: SearchResult): void {
    const call = this.calls[index];
    if (call === undefined) {
      throw new Error(`no call ${index}`);
    }
    call.resolve(result);
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("scenario controller", () => {
  it("starts idle on the first fixture with no result", () => {
    const controller = new ScenarioController(new FakeRunner());
    const state = controller.getState();
    expect(state.status).toBe("idle");
    expect(state.result).toBeNull();
    expect(state.error).toBeNull();
    expect(state.fixtureId).toBe("G01");
  });

  it("runs through the runner and shows the result when it lands", async () => {
    const runner = new FakeRunner();
    const controller = new ScenarioController(runner);
    controller.selectFixture("U01");
    controller.run();
    expect(controller.getState().status).toBe("running");
    expect(controller.getState().result).toBeNull();
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.scenario.scenarioId).toBe("U01_DB_FIRST_UPLOAD_ORPHAN");
    runner.resolveCall(0, runSearch(fixtureScenario("U01")));
    await flush();
    const state = controller.getState();
    expect(state.status).toBe("done");
    expect(state.result?.verdict).toBe("UNSAFE_WITHIN_BOUND");
    expect(state.result?.counterexampleLength).toBe(3);
  });

  it("cancel mid-run shows no result — even when the runner answers late", async () => {
    const runner = new FakeRunner();
    const controller = new ScenarioController(runner);
    controller.selectFixture("U01");
    controller.run();
    expect(controller.getState().status).toBe("running");
    controller.cancel();
    const cancelled = controller.getState();
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.result).toBeNull();
    expect(runner.calls[0]?.aborted).toBe(true);
    // The Worker answers late, after the cancel: the run generation was
    // invalidated, so the late result must be dropped, never rendered.
    runner.resolveCall(0, runSearch(fixtureScenario("U01")));
    await flush();
    await flush();
    const state = controller.getState();
    expect(state.status).toBe("cancelled");
    expect(state.result).toBeNull();
  });

  it("re-running with a different scenario shows only the latest result", async () => {
    const runner = new FakeRunner();
    const controller = new ScenarioController(runner);
    controller.selectFixture("U01");
    controller.run();
    controller.selectFixture("G12");
    controller.run();
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]?.aborted).toBe(true);
    expect(runner.calls[1]?.scenario.scenarioId).toBe("G12_PAUSE_WRITES_FOUR_UPLOADS");
    // The first run answers late, after being superseded: dropped.
    runner.resolveCall(0, runSearch(fixtureScenario("U01")));
    await flush();
    let state = controller.getState();
    expect(state.status).toBe("running");
    expect(state.result).toBeNull();
    // The latest run answers: shown.
    runner.resolveCall(1, runSearch(fixtureScenario("G12")));
    await flush();
    state = controller.getState();
    expect(state.status).toBe("done");
    expect(state.result?.scenarioId).toBe("G12_PAUSE_WRITES_FOUR_UPLOADS");
    expect(state.result?.verdict).toBe("SAFE_WITHIN_BOUND");
  });

  it("a runner failure surfaces as an error state with no result", async () => {
    const runner = new FakeRunner();
    const controller = new ScenarioController(runner);
    controller.selectFixture("U01");
    controller.run();
    runner.calls[0]?.reject(new Error("Worker died."));
    await flush();
    const state = controller.getState();
    expect(state.status).toBe("error");
    expect(state.result).toBeNull();
    expect(state.error).toBe("Worker died.");
  });

  it("selecting another fixture clears the result and aborts the run", async () => {
    const runner = new FakeRunner();
    const controller = new ScenarioController(runner);
    controller.selectFixture("U01");
    controller.run();
    runner.resolveCall(0, runSearch(fixtureScenario("U01")));
    await flush();
    expect(controller.getState().status).toBe("done");
    expect(controller.getState().result?.verdict).toBe("UNSAFE_WITHIN_BOUND");
    controller.selectFixture("G01");
    const state = controller.getState();
    expect(state.status).toBe("idle");
    expect(state.result).toBeNull();
    expect(state.fixtureId).toBe("G01");
    expect(state.strategy).toBe("DB_FIRST");
  });

  it("switching strategy clears the result and uses the new strategy", async () => {
    const runner = new FakeRunner();
    const controller = new ScenarioController(runner);
    controller.selectFixture("U01");
    controller.run();
    runner.resolveCall(0, runSearch(fixtureScenario("U01")));
    await flush();
    expect(controller.getState().result).not.toBeNull();
    controller.selectStrategy("FILE_FIRST");
    expect(controller.getState().status).toBe("idle");
    expect(controller.getState().result).toBeNull();
    expect(controller.getState().strategy).toBe("FILE_FIRST");
    controller.run();
    expect(runner.calls[1]?.scenario.strategy).toBe("FILE_FIRST");
  });

  it("cancel when idle is a no-op and never shows a result", () => {
    const controller = new ScenarioController(new FakeRunner());
    controller.cancel();
    expect(controller.getState().status).toBe("idle");
    expect(controller.getState().result).toBeNull();
  });

  it("notifies subscribers on every state change", async () => {
    const runner = new FakeRunner();
    const controller = new ScenarioController(runner);
    let notifications = 0;
    const unsubscribe = controller.subscribe(() => {
      notifications += 1;
    });
    controller.selectFixture("U01");
    controller.run();
    runner.resolveCall(0, runSearch(fixtureScenario("U01")));
    await flush();
    expect(notifications).toBeGreaterThanOrEqual(3);
    unsubscribe();
    const before = notifications;
    controller.selectStrategy("PAUSE_WRITES");
    expect(notifications).toBe(before);
  });

  it("ignores an unknown fixture id", () => {
    const controller = new ScenarioController(new FakeRunner());
    controller.selectFixture("U99");
    expect(controller.getState().fixtureId).toBe("G01");
  });
});
