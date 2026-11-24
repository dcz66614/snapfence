/**
 * SnapFence (P030) — Web Worker: BFS search off the main thread. T010.
 *
 * Authority: PROJECT_BOOK.md §5.1/§5.4 (the Web Worker executes the BFS;
 * the UI must not block while a search runs) and IMPLEMENTATION_PLAN.md
 * T010 ("Scenario -> Strategy -> Web Worker -> BFS -> Consistency Check ->
 * Counterexample -> Timeline -> JSON / HTML").
 *
 * This module is the worker side of the typed message protocol. The
 * main-thread side lives in `worker-client.ts` (`SnapFenceWorkerClient`).
 * The protocol has exactly four message types, all carrying the frozen
 * protocol version `snapfence.worker/v1`:
 *
 * - `snapfence.search.request`  (main -> worker): { requestId, scenario }
 * - `snapfence.search.response` (worker -> main): { requestId, result, durationMs }
 * - `snapfence.search.error`    (worker -> main): { requestId, error }
 * - `snapfence.search.cancel`   (main -> worker): { requestId } — no reply;
 *   the search itself is synchronous, so a cancel only means "the client
 *   no longer wants this result"; a late response for a cancelled request
 *   is discarded by the client via its pending-request map.
 *
 * Fail-closed rules (plan §10.3 — a mismatched or unknown message is
 * rejected, never silently accepted):
 * - a request with a wrong protocol version, a missing/empty requestId, or
 *   a malformed scenario is answered with `snapfence.search.error`, never
 *   with a result;
 * - a message whose `type` is not one of the four protocol types is
 *   answered with `snapfence.search.error` (requestId "unknown" when the
 *   message carries no usable requestId);
 * - `runSearch` itself never throws for a well-formed Scenario (malformed
 *   input yields INVALID_INPUT, over-limit input yields
 *   INCONCLUSIVE_LIMIT); a defensive catch converts any unexpected throw
 *   into `snapfence.search.error` so the worker never dies silently.
 *
 * `handleWorkerMessage` is pure and runs identically in the worker and in
 * the node test environment, so the integration tests exercise the exact
 * protocol the browser Worker speaks. The worker-scope wiring at the
 * bottom of this file is guarded: importing this module in node (where no
 * worker scope exists) installs nothing and throws nothing.
 */

import type { Scenario, SearchResult } from "../core/model/types";
import { runSearch } from "../core/search/bfs";

/** Frozen protocol version carried on every message, both directions. */
export const WORKER_PROTOCOL_VERSION = "snapfence.worker/v1" as const;

/** All message types in the protocol — no others are accepted. */
export type WorkerMessageType =
  | "snapfence.search.request"
  | "snapfence.search.response"
  | "snapfence.search.error"
  | "snapfence.search.cancel";

/** Main thread -> worker: run the BFS for one scenario. */
export interface WorkerSearchRequest {
  type: "snapfence.search.request";
  protocol: typeof WORKER_PROTOCOL_VERSION;
  requestId: string;
  scenario: Scenario;
}

/** Worker -> main thread: the S0-verified SearchResult for the request. */
export interface WorkerSearchResponse {
  type: "snapfence.search.response";
  protocol: typeof WORKER_PROTOCOL_VERSION;
  requestId: string;
  result: SearchResult;
  /** Pure `runSearch` time in ms (excludes message round-trip). */
  durationMs: number;
}

/** Worker -> main thread: the request was rejected (see fail-closed rules). */
export interface WorkerSearchError {
  type: "snapfence.search.error";
  protocol: typeof WORKER_PROTOCOL_VERSION;
  requestId: string;
  error: string;
}

/**
 * Main thread -> worker: the client no longer wants this request's result.
 * No reply is sent; a response that arrives afterwards is discarded by
 * the client because the request is no longer pending.
 */
export interface WorkerSearchCancel {
  type: "snapfence.search.cancel";
  protocol: typeof WORKER_PROTOCOL_VERSION;
  requestId: string;
}

/** Any message the worker can receive. */
export type WorkerToWorkerMessage = WorkerSearchRequest | WorkerSearchCancel;

/** Any message the worker can send. */
export type WorkerToMainMessage = WorkerSearchResponse | WorkerSearchError;

/** Any message in the protocol, either direction. */
export type WorkerMessage =
  | WorkerSearchRequest
  | WorkerSearchResponse
  | WorkerSearchError
  | WorkerSearchCancel;

const REQUEST_TYPE = "snapfence.search.request" as const;
const RESPONSE_TYPE = "snapfence.search.response" as const;
const ERROR_TYPE = "snapfence.search.error" as const;
const CANCEL_TYPE = "snapfence.search.cancel" as const;

const STRATEGIES: readonly string[] = ["DB_FIRST", "FILE_FIRST", "PAUSE_WRITES"] as const;

function errorReply(requestId: string, error: string): WorkerSearchError {
  return {
    type: ERROR_TYPE,
    protocol: WORKER_PROTOCOL_VERSION,
    requestId,
    error,
  };
}

/** Extract a usable requestId from an untrusted message, or "unknown". */
function requestIdOf(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    const requestId = (value as Record<string, unknown>)["requestId"];
    if (typeof requestId === "string" && requestId.length > 0) {
      return requestId;
    }
  }
  return "unknown";
}

/**
 * Strict shape check for a search request. Returns the error string when
 * the value is not a usable request, or null when it is one. The scenario
 * itself is validated by the frozen `runSearch` (INVALID_INPUT /
 * INCONCLUSIVE_LIMIT); this check only rejects values that are not a
 * request at all, so a malformed scenario still reaches `runSearch` and
 * comes back as a typed SearchResult instead of a crash.
 */
export function validateWorkerRequest(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return "Worker message is not an object.";
  }
  const record = value as Record<string, unknown>;
  if (record["type"] !== REQUEST_TYPE) {
    return `Unknown worker message type: ${String(record["type"])}.`;
  }
  if (record["protocol"] !== WORKER_PROTOCOL_VERSION) {
    return `Worker protocol mismatch: expected ${WORKER_PROTOCOL_VERSION}, got ${String(record["protocol"])}.`;
  }
  if (typeof record["requestId"] !== "string" || record["requestId"].length === 0) {
    return "Worker search request has no requestId.";
  }
  const scenario = record["scenario"];
  if (typeof scenario !== "object" || scenario === null) {
    return "Worker search request has no scenario object.";
  }
  const scenarioRecord = scenario as Record<string, unknown>;
  if (typeof scenarioRecord["scenarioId"] !== "string") {
    return "Worker search request scenario has no scenarioId.";
  }
  if (
    typeof scenarioRecord["strategy"] !== "string" ||
    !STRATEGIES.includes(scenarioRecord["strategy"])
  ) {
    return "Worker search request scenario has an unknown strategy.";
  }
  if (!Array.isArray(scenarioRecord["operations"])) {
    return "Worker search request scenario has no operations array.";
  }
  if (typeof scenarioRecord["maxEvents"] !== "number") {
    return "Worker search request scenario has no maxEvents.";
  }
  return null;
}

/** Type guard: is this value a well-formed worker search request? */
export function isWorkerSearchRequest(value: unknown): value is WorkerSearchRequest {
  return validateWorkerRequest(value) === null;
}

/**
 * Handle one incoming worker message and produce the reply, or null when
 * no reply is owed (a cancel). Never throws: every rejection becomes a
 * `snapfence.search.error` reply, and every unknown message type becomes
 * one too — the worker never silently accepts a message it does not
 * understand.
 */
export function handleWorkerMessage(
  value: unknown,
): WorkerToMainMessage | null {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (record["type"] === CANCEL_TYPE) {
      if (record["protocol"] !== WORKER_PROTOCOL_VERSION) {
        return errorReply(
          requestIdOf(value),
          `Worker protocol mismatch: expected ${WORKER_PROTOCOL_VERSION}, got ${String(record["protocol"])}.`,
        );
      }
      return null;
    }
  }
  const validationError = validateWorkerRequest(value);
  if (validationError !== null) {
    return errorReply(requestIdOf(value), validationError);
  }
  const request = value as WorkerSearchRequest;
  try {
    const start = Date.now();
    const result = runSearch(request.scenario);
    const response: WorkerSearchResponse = {
      type: RESPONSE_TYPE,
      protocol: WORKER_PROTOCOL_VERSION,
      requestId: request.requestId,
      result,
      durationMs: Date.now() - start,
    };
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorReply(request.requestId, `Worker search failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Worker-scope wiring (runs only inside a real Web Worker)
// ---------------------------------------------------------------------------

type WorkerScope = {
  addEventListener?: (
    type: string,
    listener: (event: { data: unknown }) => void,
  ) => void;
  postMessage?: (message: unknown) => void;
};

/**
 * Install the `message` handler on the current scope when this module is
 * loaded inside a Web Worker. No-op anywhere else (node import, tests):
 * the scope there has no `postMessage`, so nothing is installed and
 * nothing throws.
 */
export function installWorkerMessageHandler(): void {
  const scope = globalThis as unknown as WorkerScope;
  if (typeof scope.postMessage !== "function") {
    return;
  }
  const onMessage = (event: { data: unknown }): void => {
    const reply = handleWorkerMessage(event.data);
    if (reply !== null) {
      scope.postMessage?.(reply);
    }
  };
  if (typeof scope.addEventListener === "function") {
    scope.addEventListener("message", onMessage);
  }
}

installWorkerMessageHandler();
