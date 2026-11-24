/**
 * SnapFence (P030) — asynchronous search runner. T008.
 *
 * @deprecated T010: replaced by the real Web Worker
 * (`src/worker/snapfence.worker.ts` + `src/worker/worker-client.ts`,
 * driven by `src/app/scenario-controller.ts`). This module is kept only
 * so the T008 UI tests (`tests/unit/ui/search-async.test.ts`) still pass;
 * no production code calls it any more — the App shell runs every search
 * through `SnapFenceWorkerClient`. Do not build new features on it: it
 * runs `runSearch` on the main thread, which is exactly the blocking
 * behaviour the Worker exists to remove.
 *
 * Authority: PROJECT_BOOK.md §5.1/§5.4 (Web Worker executes the BFS; the
 * UI must not block while a search runs) and IMPLEMENTATION_PLAN.md T008
 * ("运行搜索不阻塞 UI"). The Web Worker itself lands in T010; until then
 * this module is the async boundary: `runSearch` (S0-verified, synchronous,
 * < 11 ms on the 24 Golden scenarios) is deferred to a macrotask so the
 * browser can paint the "搜索中…" state and keep every control responsive
 * before the result arrives. Deferral is scheduling only — it never
 * changes the search, its inputs, or its result.
 */

import type { Scenario, SearchResult } from "../../core/model/types";
import { runSearch } from "../../core/search/bfs";

/**
 * Run the frozen `runSearch` asynchronously: the call returns immediately
 * with a pending promise and the search executes on a later macrotask
 * (`setTimeout(..., 0)`), so the calling render can commit the running
 * state and the user can keep interacting (switch scenario, step the
 * replay, open diagnostics) while the search is in flight.
 *
 * @deprecated T010: use `SnapFenceWorkerClient` (`src/worker/worker-client.ts`)
 * instead. Kept only for the T008 UI tests; no production code calls it.
 */
export function runSearchAsync(scenario: Scenario): Promise<SearchResult> {
  return new Promise<SearchResult>((resolve) => {
    setTimeout(() => {
      resolve(runSearch(scenario));
    }, 0);
  });
}
