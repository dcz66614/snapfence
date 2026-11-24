/**
 * SnapFence (P030) — T010 integration tests: Worker protocol.
 *
 * Covers the typed message protocol of `src/worker/snapfence.worker.ts`
 * (the exact protocol the browser Web Worker speaks): well-formed
 * requests return the S0-verified `runSearch` result; malformed requests,
 * wrong protocol versions, and unknown message types are answered with
 * `snapfence.search.error` — never silently accepted and never answered
 * with a result. All 24 Golden scenarios run through the Worker path
 * (the pure handler, exercised identically in node and in the Worker).
 *
 * Frozen vocabulary (PROJECT_BOOK.md §4.4 / §4.7, D-02):
 * - diagnostic codes: DANGLING_REFERENCE, ORPHAN_BLOB,
 *   GENERATION_MISMATCH, DIGEST_MISMATCH, IN_FLIGHT_OPERATION,
 *   NO_COMMON_BOUNDARY
 * - verdict literals: SAFE_WITHIN_BOUND, UNSAFE_WITHIN_BOUND,
 *   INCONCLUSIVE_LIMIT, INVALID_INPUT
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Scenario, SearchResult } from "../../../src/core/model/types";
import {
  WORKER_PROTOCOL_VERSION,
  handleWorkerMessage,
  isWorkerSearchRequest,
  validateWorkerRequest,
  type WorkerSearchRequest,
} from "../../../src/worker/snapfence.worker";

const GOLDEN_DIR = fileURLToPath(new URL("../../../fixtures/golden/", import.meta.url));

interface GoldenFixtureFile {
  fixtureId: string;
  scenario: Scenario;
  expectedVerdict: string;
  expectedDiagnostics: readonly string[];
  expectedCounterexample: readonly string[];
  expectedCounterexampleLength: number;
}

function loadFixture(fixtureId: string): GoldenFixtureFile {
  const raw = JSON.parse(readFileSync(`${GOLDEN_DIR}${fixtureId}.json`, "utf8")) as GoldenFixtureFile;
  return raw;
}

const UNSAFE_IDS = ["U01", "U02", "U03", "U04", "U05", "U06", "U07", "U08", "U09", "U10", "U11", "U12"];
const SAFE_IDS = ["G01", "G02", "G03", "G04", "G05", "G06", "G07", "G08", "G09", "G10", "G11", "G12"];

function makeRequest(scenario: Scenario, requestId = "req-1"): WorkerSearchRequest {
  return {
    type: "snapfence.search.request",
    protocol: WORKER_PROTOCOL_VERSION,
    requestId,
    scenario,
  };
}

describe("worker protocol", () => {
  it("names the frozen protocol version on every message", () => {
    expect(WORKER_PROTOCOL_VERSION).toBe("snapfence.worker/v1");
    const reply = handleWorkerMessage(makeRequest(loadFixture("U01").scenario));
    expect(reply).not.toBeNull();
    expect(reply?.protocol).toBe("snapfence.worker/v1");
    expect(reply?.requestId).toBe("req-1");
  });

  it("answers a well-formed U01 request with the S0-verified result", () => {
    const fixture = loadFixture("U01");
    const reply = handleWorkerMessage(makeRequest(fixture.scenario));
    expect(reply?.type).toBe("snapfence.search.response");
    if (reply?.type !== "snapfence.search.response") {
      throw new Error("expected a search response");
    }
    const result: SearchResult = reply.result;
    expect(result.verdict).toBe("UNSAFE_WITHIN_BOUND");
    expect(result.scenarioId).toBe(fixture.scenario.scenarioId);
    expect(result.counterexample).toEqual(fixture.expectedCounterexample);
    expect(result.counterexampleLength).toBe(fixture.expectedCounterexampleLength);
    expect(result.diagnostics.map((d) => d.code)).toEqual(fixture.expectedDiagnostics);
    expect(typeof reply.durationMs).toBe("number");
    expect(reply.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("runs all 24 Golden scenarios through the Worker path with the expected verdicts", () => {
    for (const fixtureId of [...UNSAFE_IDS, ...SAFE_IDS]) {
      const fixture = loadFixture(fixtureId);
      const reply = handleWorkerMessage(makeRequest(fixture.scenario, `req-${fixtureId}`));
      expect(reply?.type).toBe("snapfence.search.response");
      if (reply?.type !== "snapfence.search.response") {
        throw new Error(`expected a search response for ${fixtureId}`);
      }
      expect(reply.result.verdict).toBe(fixture.expectedVerdict);
      expect(reply.result.diagnostics.map((d) => d.code)).toEqual(
        fixture.expectedDiagnostics,
      );
      expect(reply.result.counterexampleLength).toBe(
        fixture.expectedCounterexampleLength,
      );
    }
  });

  it("is deterministic: the same request twice yields an identical result", () => {
    const fixture = loadFixture("U11");
    const first = handleWorkerMessage(makeRequest(fixture.scenario));
    const second = handleWorkerMessage(makeRequest(fixture.scenario));
    expect(first?.type).toBe("snapfence.search.response");
    expect(second?.type).toBe("snapfence.search.response");
    if (
      first?.type !== "snapfence.search.response" ||
      second?.type !== "snapfence.search.response"
    ) {
      throw new Error("expected search responses");
    }
    // The SearchResult itself is byte-identical; durationMs is wall-clock
    // timing of the run, not part of the search output, so it may differ.
    expect(JSON.stringify(first.result)).toBe(JSON.stringify(second.result));
    expect(first.requestId).toBe(second.requestId);
    expect(typeof first.durationMs).toBe("number");
    expect(typeof second.durationMs).toBe("number");
  });

  it("rejects a message with an unknown type (never silently accepts it)", () => {
    const reply = handleWorkerMessage({
      type: "snapfence.search.bogus",
      protocol: WORKER_PROTOCOL_VERSION,
      requestId: "req-bogus",
      scenario: loadFixture("U01").scenario,
    });
    expect(reply?.type).toBe("snapfence.search.error");
    if (reply?.type !== "snapfence.search.error") {
      throw new Error("expected a search error");
    }
    expect(reply.requestId).toBe("req-bogus");
    expect(reply.error).toMatch(/Unknown worker message type/);
  });

  it("rejects a request with a wrong protocol version", () => {
    const bad = makeRequest(loadFixture("U01").scenario);
    const reply = handleWorkerMessage({ ...bad, protocol: "snapfence.worker/v999" });
    expect(reply?.type).toBe("snapfence.search.error");
    if (reply?.type !== "snapfence.search.error") {
      throw new Error("expected a search error");
    }
    expect(reply.error).toMatch(/protocol mismatch/);
  });

  it("rejects a request with no requestId, keeping requestId 'unknown'", () => {
    const bad = makeRequest(loadFixture("U01").scenario);
    const { requestId: _dropped, ...withoutId } = bad;
    void _dropped;
    const reply = handleWorkerMessage(withoutId);
    expect(reply?.type).toBe("snapfence.search.error");
    if (reply?.type !== "snapfence.search.error") {
      throw new Error("expected a search error");
    }
    expect(reply.requestId).toBe("unknown");
    expect(reply.error).toMatch(/no requestId/);
  });

  it("rejects non-object messages with requestId 'unknown'", () => {
    for (const bad of [null, "search", 42, undefined]) {
      const reply = handleWorkerMessage(bad);
      expect(reply?.type).toBe("snapfence.search.error");
      if (reply?.type !== "snapfence.search.error") {
        throw new Error("expected a search error");
      }
      expect(reply.requestId).toBe("unknown");
    }
  });

  it("rejects a request whose scenario is malformed", () => {
    const bad = makeRequest(loadFixture("U01").scenario);
    const reply = handleWorkerMessage({ ...bad, scenario: { strategy: "DB_FIRST" } });
    expect(reply?.type).toBe("snapfence.search.error");
    if (reply?.type !== "snapfence.search.error") {
      throw new Error("expected a search error");
    }
    expect(reply.requestId).toBe("req-1");
  });

  it("answers a cancel message with no reply (null)", () => {
    const reply = handleWorkerMessage({
      type: "snapfence.search.cancel",
      protocol: WORKER_PROTOCOL_VERSION,
      requestId: "req-1",
    });
    expect(reply).toBeNull();
  });

  it("rejects a cancel with a wrong protocol version", () => {
    const reply = handleWorkerMessage({
      type: "snapfence.search.cancel",
      protocol: "snapfence.worker/v999",
      requestId: "req-1",
    });
    expect(reply?.type).toBe("snapfence.search.error");
  });

  it("isWorkerSearchRequest accepts a well-formed request and rejects the rest", () => {
    expect(isWorkerSearchRequest(makeRequest(loadFixture("G12").scenario))).toBe(true);
    expect(isWorkerSearchRequest({ type: "snapfence.search.request" })).toBe(false);
    expect(isWorkerSearchRequest(null)).toBe(false);
    expect(validateWorkerRequest(makeRequest(loadFixture("G12").scenario))).toBeNull();
    expect(validateWorkerRequest({ type: "nope" })).toMatch(/Unknown worker message type/);
  });

  it("routes an over-limit scenario to INCONCLUSIVE_LIMIT through the Worker", () => {
    const overLimit: Scenario = {
      scenarioId: "T010_OVER_LIMIT",
      strategy: "DB_FIRST",
      maxEvents: 12,
      operations: ["A", "B", "C", "D", "E"].map((fileId) => ({
        opId: `upload-${fileId}`,
        kind: "UPLOAD" as const,
        fileId,
        objectId: `${fileId}-v1`,
        digest: `fixture-digest-${fileId}`,
      })),
    };
    const reply = handleWorkerMessage(makeRequest(overLimit, "req-limit"));
    expect(reply?.type).toBe("snapfence.search.response");
    if (reply?.type !== "snapfence.search.response") {
      throw new Error("expected a search response");
    }
    // INCONCLUSIVE_LIMIT — never a downgraded SAFE (PROJECT_BOOK.md §4.7).
    expect(reply.result.verdict).toBe("INCONCLUSIVE_LIMIT");
    expect(reply.result.counterexampleLength).toBe(0);
  });

  it("routes an invalid scenario to INVALID_INPUT through the Worker", () => {
    const invalid: Scenario = {
      scenarioId: "T010_INVALID",
      strategy: "DB_FIRST",
      maxEvents: 10,
      snapshotsAfter: ["no-such-op"],
      operations: [
        {
          opId: "upload-A",
          kind: "UPLOAD",
          fileId: "A",
          objectId: "A-v1",
          digest: "fixture-digest-A",
        },
      ],
    };
    const reply = handleWorkerMessage(makeRequest(invalid, "req-invalid"));
    expect(reply?.type).toBe("snapfence.search.response");
    if (reply?.type !== "snapfence.search.response") {
      throw new Error("expected a search response");
    }
    expect(reply.result.verdict).toBe("INVALID_INPUT");
    expect(reply.result.counterexampleLength).toBe(0);
  });
});
