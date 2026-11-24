/**
 * SnapFence (P030) — T012 10-event performance tests.
 *
 * Authority: PROJECT_BOOK.md §10 (10 events, < 1 s per scenario, never
 * drop the slowest sample) and IMPLEMENTATION_PLAN.md T012 (acceptance
 * command `npm run bench:10-events`; this suite is the in-test
 * counterpart — the bench script `scripts/t012-bench.ts` produces the
 * machine-readable `05_tests/benchmark/performance.json`).
 *
 * What is measured, separately, for every one of the 24 Golden scenarios:
 *   (a) pure algorithm time — `performance.now()` around `runSearch`
 *       only. Worker initialisation is NOT mixed into this number.
 *   (b) full interaction response time — Worker round-trip through
 *       `createLocalWorkerClient()` (same typed protocol as the browser
 *       Worker; in-process transport in node). The FIRST run on a fresh
 *       client is asserted separately from the STEADY-STATE runs on the
 *       same client.
 *
 * Each scenario is run 5 times per measurement; every repeat must be
 * < 1000 ms and the median is reported in the test name on failure
 * context via the assertion message. No sample is dropped: all 24
 * scenarios are tested, including the slowest (G12, 10 events).
 * One untimed warm-up pass runs first so JIT warm-up does not pollute
 * the measured samples; it is discarded and not counted as a repeat.
 * Timings are measurements only, never inputs to a verdict, except that
 * the < 1000 ms check uses the measured value as its criterion
 * (PROJECT_BOOK.md §10.3). The 1 s threshold is FROZEN and is asserted
 * here, never changed.
 *
 * Fixture parsing mirrors tests/unit/golden/golden.test.ts (small,
 * self-contained shape guards; no `any` anywhere).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  BackupStrategy,
  LogicalOperation,
  Scenario,
  SearchVerdict,
} from "../../src/core/model/types";
import { totalAtomicEventCount } from "../../src/core/model/scenario";
import { runSearch } from "../../src/core/search/bfs";
import { createLocalWorkerClient } from "../../src/worker/worker-client";

const GOLDEN_DIR = fileURLToPath(new URL("../../fixtures/golden/", import.meta.url));

/** FROZEN threshold: PROJECT_BOOK.md §10 — 1 s per scenario at <= 10 events. */
const SEARCH_TIME_LIMIT_MS = 1000;
const MAX_EVENTS = 10;
const REPEATS = 5;

const VERDICTS: readonly SearchVerdict[] = [
  "SAFE_WITHIN_BOUND",
  "UNSAFE_WITHIN_BOUND",
  "INCONCLUSIVE_LIMIT",
  "INVALID_INPUT",
] as const;

// ---------------------------------------------------------------------------
// Fixture loading (shape guards)
// ---------------------------------------------------------------------------

function fail(message: string): never {
  throw new Error(`performance fixture parse error: ${message}`);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== "string") {
    fail(`${what} must be a string`);
  }
  return value;
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(`${what} must be an integer`);
  }
  return value;
}

function asArray(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    fail(`${what} must be an array`);
  }
  return value;
}

function asStringArray(value: unknown, what: string): readonly string[] {
  return asArray(value, what).map((entry) => asString(entry, what));
}

function asBackupStrategy(value: unknown): BackupStrategy {
  if (value !== "DB_FIRST" && value !== "FILE_FIRST" && value !== "PAUSE_WRITES") {
    fail(`strategy must be one of DB_FIRST | FILE_FIRST | PAUSE_WRITES, got ${String(value)}`);
  }
  return value;
}

function asVerdict(value: unknown): SearchVerdict {
  if (!VERDICTS.includes(value as SearchVerdict)) {
    fail(`verdict must be one of ${VERDICTS.join(" | ")}, got ${String(value)}`);
  }
  return value as SearchVerdict;
}

function parseOperation(value: unknown): LogicalOperation {
  const record = asRecord(value, "operation");
  const opId = asString(record.opId, "operation.opId");
  const kind = asString(record.kind, "operation.kind");
  const fileId = asString(record.fileId, "operation.fileId");
  if (kind === "UPLOAD") {
    return {
      opId,
      kind: "UPLOAD",
      fileId,
      objectId: asString(record.objectId, "operation.objectId"),
      digest: asString(record.digest, "operation.digest"),
    };
  }
  if (kind === "DELETE") {
    const objectId = asString(record.objectId, "operation.objectId");
    const digest =
      record.digest === undefined ? undefined : asString(record.digest, "operation.digest");
    return digest === undefined
      ? { opId, kind: "DELETE", fileId, objectId }
      : { opId, kind: "DELETE", fileId, objectId, digest };
  }
  if (kind === "UPDATE") {
    const objectId = asString(record.objectId, "operation.objectId");
    const oldObjectId = asString(record.oldObjectId, "operation.oldObjectId");
    const digest = asString(record.digest, "operation.digest");
    const oldDigest =
      record.oldDigest === undefined
        ? undefined
        : asString(record.oldDigest, "operation.oldDigest");
    return oldDigest === undefined
      ? { opId, kind: "UPDATE", fileId, objectId, oldObjectId, digest }
      : { opId, kind: "UPDATE", fileId, objectId, oldObjectId, digest, oldDigest };
  }
  return fail(`unknown operation kind: ${kind}`);
}

function parseScenario(value: unknown): Scenario {
  const record = asRecord(value, "scenario");
  const scenarioId = asString(record.scenarioId, "scenario.scenarioId");
  const strategy = asBackupStrategy(record.strategy);
  const maxEvents = asNumber(record.maxEvents, "scenario.maxEvents");
  const operations = asArray(record.operations, "scenario.operations").map(parseOperation);
  const snapshotsAfter =
    record.snapshotsAfter === undefined
      ? undefined
      : asStringArray(record.snapshotsAfter, "scenario.snapshotsAfter");
  return snapshotsAfter === undefined
    ? { scenarioId, strategy, operations, maxEvents }
    : { scenarioId, strategy, operations, maxEvents, snapshotsAfter };
}

interface GoldenFixture {
  fixtureId: string;
  scenario: Scenario;
  expectedVerdict: SearchVerdict;
  eventCount: number;
}

function parseFixture(value: unknown, fileName: string): GoldenFixture {
  const record = asRecord(value, fileName);
  return {
    fixtureId: asString(record.fixtureId, `${fileName}.fixtureId`),
    scenario: parseScenario(record.scenario),
    expectedVerdict: asVerdict(record.expectedVerdict),
    eventCount: asNumber(record.eventCount, `${fileName}.eventCount`),
  };
}

function loadFixtures(): readonly GoldenFixture[] {
  const manifest: unknown = JSON.parse(readFileSync(`${GOLDEN_DIR}manifest.json`, "utf8"));
  const manifestRecord = asRecord(manifest, "manifest.json");
  const entries = asArray(manifestRecord.scenarios, "manifest.scenarios");
  return entries.map((entry) => {
    const entryRecord = asRecord(entry, "manifest.scenarios[]");
    const fixtureId = asString(entryRecord.fixtureId, "manifest.scenarios[].fixtureId");
    const parsed: unknown = JSON.parse(readFileSync(`${GOLDEN_DIR}${fixtureId}.json`, "utf8"));
    return parseFixture(parsed, `${fixtureId}.json`);
  });
}

const FIXTURES: readonly GoldenFixture[] = loadFixtures();

// Untimed warm-up pass (discarded, not counted): stabilises JIT so the
// measured samples are not polluted by first-compile cost.
for (const fixture of FIXTURES) {
  runSearch(fixture.scenario);
}

function medianMs(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// ---------------------------------------------------------------------------
// Performance suite
// ---------------------------------------------------------------------------

describe("Performance at max scale (P030-T012)", () => {
  it("covers exactly 24 Golden scenarios, none exceeding 10 events (G12 = 10)", () => {
    expect(FIXTURES).toHaveLength(24);
    for (const fixture of FIXTURES) {
      expect(totalAtomicEventCount(fixture.scenario)).toBeLessThanOrEqual(MAX_EVENTS);
      expect(totalAtomicEventCount(fixture.scenario)).toBe(fixture.eventCount);
    }
    const g12 = FIXTURES.find((fixture) => fixture.fixtureId === "G12");
    expect(g12).toBeDefined();
    expect(totalAtomicEventCount(g12?.scenario as Scenario)).toBe(10);
    expect(Math.max(...FIXTURES.map((f) => totalAtomicEventCount(f.scenario)))).toBe(10);
  });

  it.each(FIXTURES)(
    "$fixtureId pure runSearch: 5 repeats, every repeat < 1000 ms, verdict matches fixture",
    (fixture) => {
      const samples: number[] = [];
      let verdict: SearchVerdict = "INVALID_INPUT";
      for (let i = 0; i < REPEATS; i += 1) {
        const start = performance.now();
        const result = runSearch(fixture.scenario);
        samples.push(performance.now() - start);
        verdict = result.verdict;
      }
      expect(verdict).toBe(fixture.expectedVerdict);
      for (const sample of samples) {
        expect(
          sample,
          `${fixture.fixtureId} pure runSearch repeat ${sample.toFixed(3)} ms exceeds the frozen 1000 ms limit (samples: ${samples.map((s) => s.toFixed(3)).join(", ")}; median ${medianMs(samples).toFixed(3)} ms)`,
        ).toBeLessThan(SEARCH_TIME_LIMIT_MS);
      }
      expect(Math.max(...samples)).toBeLessThan(SEARCH_TIME_LIMIT_MS);
    },
  );

  it.each(FIXTURES)(
    "$fixtureId Worker round-trip: first run and 5 steady-state runs, every run < 1000 ms, verdict matches fixture",
    async (fixture) => {
      const client = createLocalWorkerClient();
      try {
        const firstStart = performance.now();
        const first = await client.run(fixture.scenario);
        const firstMs = performance.now() - firstStart;
        expect(first.verdict).toBe(fixture.expectedVerdict);
        expect(
          firstMs,
          `${fixture.fixtureId} Worker first run ${firstMs.toFixed(3)} ms exceeds the frozen 1000 ms limit`,
        ).toBeLessThan(SEARCH_TIME_LIMIT_MS);

        const steady: number[] = [];
        for (let i = 0; i < REPEATS; i += 1) {
          const start = performance.now();
          const result = await client.run(fixture.scenario);
          steady.push(performance.now() - start);
          expect(result.verdict).toBe(fixture.expectedVerdict);
        }
        for (const sample of steady) {
          expect(
            sample,
            `${fixture.fixtureId} Worker steady-state repeat ${sample.toFixed(3)} ms exceeds the frozen 1000 ms limit (samples: ${steady.map((s) => s.toFixed(3)).join(", ")}; median ${medianMs(steady).toFixed(3)} ms)`,
          ).toBeLessThan(SEARCH_TIME_LIMIT_MS);
        }
      } finally {
        client.terminate();
      }
    },
  );

  it("G12 max-scale case (10 events): pure and Worker round-trip both < 1000 ms", async () => {
    const g12 = FIXTURES.find((fixture) => fixture.fixtureId === "G12");
    expect(g12).toBeDefined();
    const scenario = (g12 as GoldenFixture).scenario;
    expect(totalAtomicEventCount(scenario)).toBe(10);

    const pureSamples: number[] = [];
    for (let i = 0; i < REPEATS; i += 1) {
      const start = performance.now();
      const result = runSearch(scenario);
      pureSamples.push(performance.now() - start);
      expect(result.verdict).toBe("SAFE_WITHIN_BOUND");
    }
    expect(Math.max(...pureSamples)).toBeLessThan(SEARCH_TIME_LIMIT_MS);

    const client = createLocalWorkerClient();
    try {
      const firstStart = performance.now();
      const first = await client.run(scenario);
      expect(first.verdict).toBe("SAFE_WITHIN_BOUND");
      expect(performance.now() - firstStart).toBeLessThan(SEARCH_TIME_LIMIT_MS);
      for (let i = 0; i < REPEATS; i += 1) {
        const start = performance.now();
        const result = await client.run(scenario);
        expect(result.verdict).toBe("SAFE_WITHIN_BOUND");
        expect(performance.now() - start).toBeLessThan(SEARCH_TIME_LIMIT_MS);
      }
    } finally {
      client.terminate();
    }
  });
});
