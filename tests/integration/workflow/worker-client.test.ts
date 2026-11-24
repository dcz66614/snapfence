/**
 * SnapFence (P030) — T010 integration tests: Worker client.
 *
 * Covers `SnapFenceWorkerClient` over the in-process `LocalWorkerTransport`
 * (the same typed protocol the browser Worker speaks): request/response
 * matching across concurrent runs, timeout, cancellation, termination,
 * and — the fail-closed rule — an unknown message type is rejected, never
 * silently accepted. A late response for a cancelled or timed-out run is
 * ignored, so it can never surface as a stale result.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Scenario } from "../../../src/core/model/types";
import {
  WORKER_PROTOCOL_VERSION,
  type WorkerSearchRequest,
} from "../../../src/worker/snapfence.worker";
import {
  LocalWorkerTransport,
  SnapFenceWorkerClient,
  createLocalWorkerClient,
  type WorkerTransport,
} from "../../../src/worker/worker-client";

const GOLDEN_DIR = fileURLToPath(new URL("../../../fixtures/golden/", import.meta.url));

function loadScenario(fixtureId: string): Scenario {
  const raw = JSON.parse(readFileSync(`${GOLDEN_DIR}${fixtureId}.json`, "utf8")) as {
    scenario: Scenario;
  };
  return raw.scenario;
}

/** A transport the test drives by hand (delivers whatever it is told). */
class ManualTransport implements WorkerTransport {
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public onerror: ((event: unknown) => void) | null = null;
  public posted: unknown[] = [];
  public terminated = false;

  public postMessage(message: unknown): void {
    this.posted.push(message);
  }

  public deliver(data: unknown): void {
    this.onmessage?.({ data });
  }

  public terminate(): void {
    this.terminated = true;
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("worker client", () => {
  it("runs U01 through the client and returns the S0-verified result", async () => {
    const client = createLocalWorkerClient();
    try {
      const result = await client.run(loadScenario("U01"));
      expect(result.verdict).toBe("UNSAFE_WITHIN_BOUND");
      expect(result.scenarioId).toBe("U01_DB_FIRST_UPLOAD_ORPHAN");
      expect(result.counterexampleLength).toBe(3);
      expect(result.diagnostics.map((d) => d.code)).toEqual([
        "IN_FLIGHT_OPERATION",
        "NO_COMMON_BOUNDARY",
        "ORPHAN_BLOB",
      ]);
    } finally {
      client.terminate();
    }
  });

  it("matches concurrent runs to their own requests (no cross-talk)", async () => {
    const client = createLocalWorkerClient();
    try {
      const [u01, g12, u07] = await Promise.all([
        client.run(loadScenario("U01")),
        client.run(loadScenario("G12")),
        client.run(loadScenario("U07")),
      ]);
      expect(u01.scenarioId).toBe("U01_DB_FIRST_UPLOAD_ORPHAN");
      expect(u01.verdict).toBe("UNSAFE_WITHIN_BOUND");
      expect(g12.scenarioId).toBe("G12_PAUSE_WRITES_FOUR_UPLOADS");
      expect(g12.verdict).toBe("SAFE_WITHIN_BOUND");
      expect(u07.scenarioId).toBe("U07_FILE_FIRST_UPLOAD_DANGLING");
      expect(u07.verdict).toBe("UNSAFE_WITHIN_BOUND");
    } finally {
      client.terminate();
    }
  });

  it("rejects on abort mid-flight; a late worker response is ignored", async () => {
    const transport = new LocalWorkerTransport({ delayMs: 50 });
    const client = new SnapFenceWorkerClient(() => transport);
    const controller = new AbortController();
    const late = client.run(loadScenario("G12"), { signal: controller.signal });
    const rejection = expect(late).rejects.toThrow(/Search cancelled/);
    controller.abort();
    await rejection;
    // The delayed worker reply arrives after the abort; the client has no
    // pending entry for it, so it is ignored (no unhandled rejection, no
    // protocol error recorded for a well-formed late response).
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(client.protocolErrors).toBe(0);
    expect(client.lastProtocolError).toBeNull();
    client.terminate();
  });

  it("posts a snapfence.search.cancel message to the worker on abort", async () => {
    const transport = new ManualTransport();
    const client = new SnapFenceWorkerClient(() => transport);
    const controller = new AbortController();
    const promise = client.run(loadScenario("U01"), { signal: controller.signal });
    const rejection = expect(promise).rejects.toThrow(/Search cancelled/);
    await flush();
    expect(transport.posted).toHaveLength(1);
    controller.abort();
    await rejection;
    expect(transport.posted).toHaveLength(2);
    const cancel = transport.posted[1] as {
      type: string;
      protocol: string;
      requestId: string;
    };
    expect(cancel.type).toBe("snapfence.search.cancel");
    expect(cancel.protocol).toBe(WORKER_PROTOCOL_VERSION);
    const posted = transport.posted[0] as WorkerSearchRequest;
    expect(cancel.requestId).toBe(posted.requestId);
    client.terminate();
  });

  it("rejects immediately when the signal is already aborted (nothing posted)", async () => {
    const transport = new ManualTransport();
    const client = new SnapFenceWorkerClient(() => transport);
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.run(loadScenario("U01"), { signal: controller.signal }),
    ).rejects.toThrow(/Search cancelled/);
    expect(transport.posted).toEqual([]);
    client.terminate();
  });

  it("rejects a run that does not answer within the timeout", async () => {
    const client = new SnapFenceWorkerClient(
      () => new LocalWorkerTransport({ delayMs: 200 }),
      { timeoutMs: 20 },
    );
    await expect(client.run(loadScenario("U01"))).rejects.toThrow(/timed out after 20 ms/);
    // The late answer (at ~200 ms) must be ignored, not crash the client.
    await new Promise((resolve) => setTimeout(resolve, 250));
    client.terminate();
  });

  it("rejects an unknown message type for a pending request (never silently accepts it)", async () => {
    const transport = new ManualTransport();
    const client = new SnapFenceWorkerClient(() => transport);
    const promise = client.run(loadScenario("U01"));
    const rejection = expect(promise).rejects.toThrow(/Unknown worker message type/);
    await flush();
    expect(transport.posted).toHaveLength(1);
    const posted = transport.posted[0] as WorkerSearchRequest;
    expect(posted.type).toBe("snapfence.search.request");
    transport.deliver({
      type: "snapfence.search.mystery",
      protocol: WORKER_PROTOCOL_VERSION,
      requestId: posted.requestId,
    });
    await rejection;
    expect(client.protocolErrors).toBe(1);
    expect(client.lastProtocolError).toMatch(/Unknown worker message type/);
    client.terminate();
  });

  it("rejects a response with a wrong protocol version", async () => {
    const transport = new ManualTransport();
    const client = new SnapFenceWorkerClient(() => transport);
    const promise = client.run(loadScenario("U01"));
    const rejection = expect(promise).rejects.toThrow(/protocol mismatch/);
    await flush();
    const posted = transport.posted[0] as WorkerSearchRequest;
    transport.deliver({
      type: "snapfence.search.response",
      protocol: "snapfence.worker/v999",
      requestId: posted.requestId,
      result: null,
      durationMs: 0,
    });
    await rejection;
    expect(client.protocolErrors).toBe(1);
    client.terminate();
  });

  it("rejects a response carrying a malformed result (unknown verdict)", async () => {
    const transport = new ManualTransport();
    const client = new SnapFenceWorkerClient(() => transport);
    const promise = client.run(loadScenario("U01"));
    const rejection = expect(promise).rejects.toThrow(/not a well-formed SearchResult/);
    await flush();
    const posted = transport.posted[0] as WorkerSearchRequest;
    transport.deliver({
      type: "snapfence.search.response",
      protocol: WORKER_PROTOCOL_VERSION,
      requestId: posted.requestId,
      result: {
        schemaVersion: "snapfence.report/v1",
        scenarioId: "U01_DB_FIRST_UPLOAD_ORPHAN",
        strategy: "DB_FIRST",
        verdict: "MAYBE_SAFE",
        eventCount: 4,
        counterexample: [],
        counterexampleLength: 0,
        diagnostics: [],
      },
      durationMs: 1,
    });
    await rejection;
    client.terminate();
  });

  it("rejects a worker error reply with the worker's message", async () => {
    const transport = new ManualTransport();
    const client = new SnapFenceWorkerClient(() => transport);
    const promise = client.run(loadScenario("U01"));
    const rejection = expect(promise).rejects.toThrow(/Worker search failed/);
    await flush();
    const posted = transport.posted[0] as WorkerSearchRequest;
    transport.deliver({
      type: "snapfence.search.error",
      protocol: WORKER_PROTOCOL_VERSION,
      requestId: posted.requestId,
      error: "Unknown worker message type: snapfence.search.bogus.",
    });
    await rejection;
    client.terminate();
  });

  it("ignores an unsolicited unknown message (records it, rejects nothing)", async () => {
    const transport = new ManualTransport();
    const client = new SnapFenceWorkerClient(() => transport);
    // Prime the transport without a pending request.
    const run = client.run(loadScenario("U01"));
    await flush();
    const posted = transport.posted[0] as WorkerSearchRequest;
    transport.deliver({
      type: "snapfence.search.mystery",
      protocol: WORKER_PROTOCOL_VERSION,
      requestId: "req-no-such-request",
    });
    expect(client.protocolErrors).toBe(1);
    expect(client.lastProtocolError).toMatch(/Unknown worker message type/);
    // The real pending run is untouched: answer it properly.
    transport.deliver({
      type: "snapfence.search.response",
      protocol: WORKER_PROTOCOL_VERSION,
      requestId: posted.requestId,
      result: {
        schemaVersion: "snapfence.report/v1",
        scenarioId: "U01_DB_FIRST_UPLOAD_ORPHAN",
        strategy: "DB_FIRST",
        verdict: "UNSAFE_WITHIN_BOUND",
        eventCount: 4,
        counterexample: ["DB_SNAPSHOT", "upload-A:BLOB_PUT", "BLOB_SNAPSHOT"],
        counterexampleLength: 3,
        diagnostics: [],
        databaseSnapshot: {},
        blobSnapshot: {},
        assumptions: [],
        limitations: [],
      },
      durationMs: 1,
    });
    const result = await run;
    expect(result.verdict).toBe("UNSAFE_WITHIN_BOUND");
    client.terminate();
  });

  it("terminate() rejects in-flight runs and refuses new ones", async () => {
    const client = new SnapFenceWorkerClient(
      () => new LocalWorkerTransport({ delayMs: 100 }),
    );
    const promise = client.run(loadScenario("U01"));
    const rejection = expect(promise).rejects.toThrow(/terminated/);
    client.terminate();
    await rejection;
    expect(client.isTerminated).toBe(true);
    await expect(client.run(loadScenario("U01"))).rejects.toThrow(/terminated/);
  });
});
