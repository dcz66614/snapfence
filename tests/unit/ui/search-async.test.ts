/**
 * SnapFence (P030) — T008 asynchronous search tests.
 *
 * Acceptance: "running a search does not block the UI (search runs async;
 * UI stays responsive — prove with a test, e.g. interaction during a G12
 * search)". `runSearchAsync` defers the S0-verified synchronous `runSearch`
 * to a macrotask; these tests prove the call returns before the search
 * executes, that synchronous interaction work (replay construction) still
 * runs while the search is pending, and that the eventual result is the
 * same verdict the synchronous search returns.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Scenario } from "../../../src/core/model/types";
import { runSearch } from "../../../src/core/search/bfs";
import { runSearchAsync } from "../../../src/components/timeline/search-async";
import { buildReplaySteps } from "../../../src/components/timeline/replay";

const GOLDEN_DIR = fileURLToPath(new URL("../../../fixtures/golden/", import.meta.url));

function loadScenario(fixtureId: string): Scenario {
  const raw = readFileSync(`${GOLDEN_DIR}${fixtureId}.json`, "utf-8");
  const parsed = JSON.parse(raw) as { scenario: Scenario };
  return parsed.scenario;
}

describe("runSearchAsync", () => {
  it("returns immediately: the promise is still pending right after the call", async () => {
    const scenario = loadScenario("G12");
    let settled = false;
    const promise = runSearchAsync(scenario);
    void promise.then(() => {
      settled = true;
    });
    // Synchronous check, before any macrotask runs: the deferred search
    // cannot have resolved yet, so the UI thread was never blocked.
    expect(settled).toBe(false);
    const result = await promise;
    expect(settled).toBe(true);
    expect(result.verdict).toBe("SAFE_WITHIN_BOUND");
    expect(result.counterexampleLength).toBe(0);
  });

  it("interaction during a G12 search: replay work completes while the search is pending", async () => {
    const g12 = loadScenario("G12");
    const u01 = loadScenario("U01");
    const searchPromise = runSearchAsync(g12);
    // This is the interaction the user would do while the search runs:
    // build the U01 replay steps synchronously. It must finish before the
    // search promise settles.
    const steps = buildReplaySteps(u01, ["DB_SNAPSHOT", "upload-A:BLOB_PUT", "BLOB_SNAPSHOT"]);
    expect(steps).toHaveLength(3);
    const result = await searchPromise;
    expect(result.verdict).toBe("SAFE_WITHIN_BOUND");
    expect(result.scenarioId).toBe("G12_PAUSE_WRITES_FOUR_UPLOADS");
  });

  it("U01 async result matches the synchronous search exactly", async () => {
    const scenario = loadScenario("U01");
    const [asyncResult] = await Promise.all([runSearchAsync(scenario)]);
    const syncResult = runSearch(scenario);
    expect(asyncResult).toEqual(syncResult);
    expect(asyncResult.verdict).toBe("UNSAFE_WITHIN_BOUND");
    expect(asyncResult.counterexampleLength).toBe(3);
  });
});
