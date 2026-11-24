/**
 * SnapFence (P030) — Web Worker client (main-thread side). T010.
 *
 * Authority: PROJECT_BOOK.md §5.1/§5.4 (the Web Worker executes the BFS;
 * the UI must not block) and IMPLEMENTATION_PLAN.md T010 (Worker and
 * main-thread interface must be consistent; cancelling or re-running must
 * never show a stale result) and §10.3 (the Worker must not display an old
 * result as the current one).
 *
 * `SnapFenceWorkerClient` is the only way the UI runs a search. It speaks
 * the typed protocol of `snapfence.worker.ts` over a pluggable transport:
 *
 * - in the browser the default transport is a real
 *   `Worker(new URL("./snapfence.worker.ts", import.meta.url),
 *   { type: "module" })` (Vite bundles the worker file as its own chunk);
 * - in node / tests `createLocalWorkerClient()` uses `LocalWorkerTransport`,
 *   which routes the same typed messages through `handleWorkerMessage`
 *   asynchronously — the full protocol (request/response matching,
 *   validation, error and cancel handling) is exercised without a browser
 *   Worker. A test may also inject its own transport via the constructor
 *   factory to deliver malformed or out-of-order messages.
 *
 * Stale-result safety (fail-closed, never silent):
 * - every request carries a unique requestId; a response is delivered
 *   only to the pending request with the same id. A late response for a
 *   request that was already resolved, rejected, cancelled, or timed out
 *   has no pending entry and is ignored;
 * - a message with an unknown `type` (or a wrong protocol version) is
 *   never silently accepted: when it carries the requestId of a pending
 *   request that request is rejected with a protocol error, and the error
 *   is recorded on `lastProtocolError` for diagnosis;
 * - a response whose `result` is not a well-formed SearchResult (wrong
 *   schemaVersion or an unknown verdict literal) is rejected, not rendered;
 * - `run()` accepts an `AbortSignal`: aborting rejects the pending run
 *   with "Search cancelled" and sends `snapfence.search.cancel` to the
 *   worker; the run's result can never surface afterwards;
 * - a run that does not answer within `timeoutMs` (default 5000 ms — the
 *   S0-measured pure search is < 11 ms for every Golden scenario) is
 *   rejected with a timeout error; a late answer afterwards is ignored.
 */

import type { Scenario, SearchResult, SearchVerdict } from "../core/model/types";
import {
  WORKER_PROTOCOL_VERSION,
  handleWorkerMessage,
  type WorkerSearchCancel,
  type WorkerSearchRequest,
} from "./snapfence.worker";

/** Minimal event shape a transport delivers to the client. */
export interface WorkerMessageEventLike {
  data: unknown;
}

/**
 * The transport surface the client needs. A real browser `Worker`
 * satisfies this shape; `LocalWorkerTransport` (below) implements the
 * same surface in-process for node / tests.
 */
export interface WorkerTransport {
  postMessage(message: unknown): void;
  onmessage: ((event: WorkerMessageEventLike) => void) | null;
  onerror: ((event: unknown) => void) | null;
  terminate(): void;
}

/** A factory that builds one transport (one Worker) for a client. */
export type WorkerTransportFactory = () => WorkerTransport;

/** Minimal runner surface the scenario controller depends on. */
export interface SearchRunner {
  run(scenario: Scenario, options?: { signal?: AbortSignal }): Promise<SearchResult>;
}

const REQUEST_TYPE = "snapfence.search.request" as const;
const RESPONSE_TYPE = "snapfence.search.response" as const;
const ERROR_TYPE = "snapfence.search.error" as const;
const CANCEL_TYPE = "snapfence.search.cancel" as const;

const VERDICTS: readonly SearchVerdict[] = [
  "SAFE_WITHIN_BOUND",
  "UNSAFE_WITHIN_BOUND",
  "INCONCLUSIVE_LIMIT",
  "INVALID_INPUT",
] as const;

/** Default timeout: 5000 ms (S0 pure search is < 11 ms per Golden). */
export const DEFAULT_WORKER_TIMEOUT_MS = 5000;

interface PendingEntry {
  resolve: (result: SearchResult) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  scenarioId: string;
}

/**
 * Browser transport: wraps a real Web Worker. The worker module URL is
 * resolved by Vite at build time into a separate worker chunk; the
 * transport is created lazily (on the first `run()`), never at import.
 */
export class BrowserWorkerTransport implements WorkerTransport {
  private readonly worker: Worker;

  public constructor() {
    this.worker = new Worker(new URL("./snapfence.worker.ts", import.meta.url), {
      type: "module",
    });
  }

  public postMessage(message: unknown): void {
    this.worker.postMessage(message);
  }

  public get onmessage(): ((event: WorkerMessageEventLike) => void) | null {
    const handler = this.worker.onmessage;
    return handler === null
      ? null
      : (event: WorkerMessageEventLike) => {
          handler.call(this.worker, event as MessageEvent);
        };
  }

  public set onmessage(handler: ((event: WorkerMessageEventLike) => void) | null) {
    this.worker.onmessage =
      handler === null ? null : (event: MessageEvent) => handler({ data: event.data });
  }

  public get onerror(): ((event: unknown) => void) | null {
    const handler = this.worker.onerror;
    return handler === null
      ? null
      : (event: unknown) => {
          handler.call(this.worker, event as ErrorEvent);
        };
  }

  public set onerror(handler: ((event: unknown) => void) | null) {
    this.worker.onerror =
      handler === null ? null : (event: ErrorEvent) => handler(event);
  }

  public terminate(): void {
    this.worker.terminate();
  }
}

/**
 * In-process transport for node / tests: routes each posted message
 * through the real worker handler (`handleWorkerMessage`) on a later
 * macrotask, so the typed protocol — including validation, error replies,
 * and cancel handling — is exercised exactly as the browser Worker
 * speaks it. `delayMs` stretches the round-trip for cancellation tests.
 */
export class LocalWorkerTransport implements WorkerTransport {
  public onmessage: ((event: WorkerMessageEventLike) => void) | null = null;
  public onerror: ((event: unknown) => void) | null = null;
  private readonly delayMs: number;
  private terminated = false;

  public constructor(options?: { delayMs?: number }) {
    this.delayMs = options?.delayMs ?? 0;
  }

  public postMessage(message: unknown): void {
    if (this.terminated) {
      return;
    }
    setTimeout(() => {
      if (this.terminated) {
        return;
      }
      let reply: unknown;
      try {
        reply = handleWorkerMessage(message);
      } catch (error) {
        this.onerror?.(error);
        return;
      }
      if (reply !== null) {
        this.onmessage?.({ data: reply });
      }
    }, this.delayMs);
  }

  public terminate(): void {
    this.terminated = true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWellFormedResult(value: unknown): value is SearchResult {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value["schemaVersion"] === "snapfence.report/v1" &&
    typeof value["scenarioId"] === "string" &&
    typeof value["strategy"] === "string" &&
    typeof value["verdict"] === "string" &&
    (VERDICTS as readonly string[]).includes(value["verdict"]) &&
    Array.isArray(value["counterexample"]) &&
    typeof value["counterexampleLength"] === "number" &&
    Array.isArray(value["diagnostics"])
  );
}

export interface SnapFenceWorkerClientOptions {
  /** Per-run timeout in ms (default {@link DEFAULT_WORKER_TIMEOUT_MS}). */
  timeoutMs?: number;
}

/**
 * Main-thread client for the SnapFence search Worker. One client owns one
 * transport (one Worker); `terminate()` releases it. Safe to construct
 * without a browser: the transport is created lazily on the first run.
 */
export class SnapFenceWorkerClient implements SearchRunner {
  private readonly factory: WorkerTransportFactory;
  private readonly timeoutMs: number;
  private transport: WorkerTransport | null = null;
  private readonly pending = new Map<string, PendingEntry>();
  private nextRequestNumber = 1;
  private terminated = false;
  private protocolErrorCount = 0;
  private lastProtocolErrorValue: string | null = null;

  public constructor(
    factory: WorkerTransportFactory = () => new BrowserWorkerTransport(),
    options?: SnapFenceWorkerClientOptions,
  ) {
    this.factory = factory;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
  }

  /** Number of protocol violations observed (unknown type / version). */
  public get protocolErrors(): number {
    return this.protocolErrorCount;
  }

  /** Last protocol-violation message, or null when none was observed. */
  public get lastProtocolError(): string | null {
    return this.lastProtocolErrorValue;
  }

  /** True once `terminate()` has been called. */
  public get isTerminated(): boolean {
    return this.terminated;
  }

  public run(
    scenario: Scenario,
    options?: { signal?: AbortSignal },
  ): Promise<SearchResult> {
    if (this.terminated) {
      return Promise.reject(new Error("SnapFence worker client is terminated."));
    }
    const signal = options?.signal;
    if (signal?.aborted === true) {
      return Promise.reject(new Error("Search cancelled."));
    }
    const requestId = `req-${this.nextRequestNumber}`;
    this.nextRequestNumber += 1;
    const transport = this.ensureTransport();
    const request: WorkerSearchRequest = {
      type: REQUEST_TYPE,
      protocol: WORKER_PROTOCOL_VERSION,
      requestId,
      scenario,
    };
    return new Promise<SearchResult>((resolve, reject) => {
      const entry: PendingEntry = {
        resolve,
        reject,
        timeoutId: setTimeout(() => {
          this.pending.delete(requestId);
          reject(
            new Error(
              `Search timed out after ${this.timeoutMs} ms (request ${requestId}, scenario ${scenario.scenarioId}).`,
            ),
          );
        }, this.timeoutMs),
        scenarioId: scenario.scenarioId,
      };
      this.pending.set(requestId, entry);
      const onAbort = (): void => {
        if (!this.pending.has(requestId)) {
          return;
        }
        this.pending.delete(requestId);
        clearTimeout(entry.timeoutId);
        const cancel: WorkerSearchCancel = {
          type: CANCEL_TYPE,
          protocol: WORKER_PROTOCOL_VERSION,
          requestId,
        };
        try {
          transport.postMessage(cancel);
        } catch {
          // The transport is already gone; the rejection below is enough.
        }
        reject(new Error("Search cancelled."));
      };
      if (signal !== undefined) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      try {
        transport.postMessage(request);
      } catch (error) {
        this.pending.delete(requestId);
        clearTimeout(entry.timeoutId);
        reject(
          new Error(
            `Failed to post search request ${requestId}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  }

  /** Release the Worker and reject every run still in flight. */
  public terminate(): void {
    if (this.terminated) {
      return;
    }
    this.terminated = true;
    for (const [requestId, entry] of this.pending) {
      clearTimeout(entry.timeoutId);
      entry.reject(new Error(`Search ${requestId} cancelled: worker client terminated.`));
    }
    this.pending.clear();
    this.transport?.terminate();
    this.transport = null;
  }

  private ensureTransport(): WorkerTransport {
    if (this.transport === null) {
      const transport = this.factory();
      transport.onmessage = (event) => this.handleMessage(event.data);
      transport.onerror = (event) => {
        const message =
          event instanceof Error
            ? event.message
            : `Worker error: ${String(event)}`;
        this.rejectAll(new Error(message));
      };
      this.transport = transport;
    }
    return this.transport;
  }

  private rejectAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeoutId);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private recordProtocolError(message: string): void {
    this.protocolErrorCount += 1;
    this.lastProtocolErrorValue = message;
  }

  /**
   * Handle one message from the Worker. Unknown types and protocol
   * mismatches are rejected, never silently accepted: when the message
   * carries the requestId of a pending request that request is rejected
   * with a protocol error; an unsolicited bad message is recorded on
   * `lastProtocolError` and dropped. Responses for requests that are no
   * longer pending (cancelled, timed out, superseded) are ignored.
   */
  private handleMessage(data: unknown): void {
    if (!isRecord(data)) {
      this.recordProtocolError("Worker message is not an object.");
      return;
    }
    const type = data["type"];
    const requestId = data["requestId"];
    if (type !== RESPONSE_TYPE && type !== ERROR_TYPE) {
      const detail = `Unknown worker message type: ${String(type)} (protocol ${String(data["protocol"])}).`;
      this.recordProtocolError(detail);
      if (typeof requestId === "string") {
        const entry = this.pending.get(requestId);
        if (entry !== undefined) {
          this.pending.delete(requestId);
          clearTimeout(entry.timeoutId);
          entry.reject(new Error(detail));
        }
      }
      return;
    }
    if (data["protocol"] !== WORKER_PROTOCOL_VERSION) {
      const detail = `Worker protocol mismatch: expected ${WORKER_PROTOCOL_VERSION}, got ${String(data["protocol"])}.`;
      this.recordProtocolError(detail);
      if (typeof requestId === "string") {
        const entry = this.pending.get(requestId);
        if (entry !== undefined) {
          this.pending.delete(requestId);
          clearTimeout(entry.timeoutId);
          entry.reject(new Error(detail));
        }
      }
      return;
    }
    if (typeof requestId !== "string" || requestId.length === 0) {
      this.recordProtocolError("Worker message has no requestId.");
      return;
    }
    const entry = this.pending.get(requestId);
    if (entry === undefined) {
      // Stale or late response (cancelled / timed out / superseded): ignore.
      return;
    }
    this.pending.delete(requestId);
    clearTimeout(entry.timeoutId);
    if (type === ERROR_TYPE) {
      const errorText =
        typeof data["error"] === "string" ? data["error"] : "Worker search failed.";
      entry.reject(new Error(`Worker search failed (${requestId}): ${errorText}`));
      return;
    }
    const result = data["result"];
    if (!isWellFormedResult(result)) {
      entry.reject(
        new Error(
          `Worker response for ${requestId} is not a well-formed SearchResult (unknown verdict or schema version).`,
        ),
      );
      return;
    }
    entry.resolve(result);
  }
}

/**
 * Build a client that runs the Worker protocol in-process (node / tests).
 * The same typed messages, request/response matching, validation, error
 * and cancel handling apply — only the transport differs from the browser.
 */
export function createLocalWorkerClient(
  options?: SnapFenceWorkerClientOptions & { delayMs?: number },
): SnapFenceWorkerClient {
  return new SnapFenceWorkerClient(
    () => new LocalWorkerTransport({ delayMs: options?.delayMs }),
    { timeoutMs: options?.timeoutMs },
  );
}
