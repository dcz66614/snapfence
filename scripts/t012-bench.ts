/**
 * SnapFence (P030) — T012 10-event performance benchmark runner.
 *
 * Authority: PROJECT_BOOK.md §10 (10 events, < 1 s per scenario, record
 * the real machine, never drop the slowest sample) and
 * IMPLEMENTATION_PLAN.md T012 / §6 (G12 = 10 events is the max-scale
 * sample; `npm run bench:10-events` is the acceptance command).
 *
 * What is measured, separately, for every one of the 24 Golden scenarios:
 *   (a) pure algorithm time — `performance.now()` around `runSearch`
 *       only. Worker initialisation is NOT mixed into this number.
 *   (b) full interaction response time — Worker round-trip through
 *       `createLocalWorkerClient()` (the same typed protocol the browser
 *       Worker speaks; in-process transport in node). The FIRST run on a
 *       fresh client (which includes lazy transport creation) is reported
 *       separately from the STEADY-STATE runs on the same client.
 *
 * Each scenario is run 5 times per measurement; min / median / max are
 * reported for every scenario, including the slowest — no sample is
 * dropped. One untimed warm-up pass over all scenarios runs first so
 * JIT warm-up does not pollute the measured samples; the warm-up is
 * discarded and stated here and in the log, it is not counted as a
 * repeat. Timings are measurements only, never inputs to a verdict,
 * except that the < 1000 ms check uses the measured value as its
 * criterion (PROJECT_BOOK.md §10.3).
 *
 * Outputs (paths are relative to 04_source/source, the cwd of the run):
 *   ../../05_tests/benchmark/performance.json — machine-readable results
 *   ../../05_tests/benchmark/performance.log  — full real run log
 * Exit 0 on PASS (every scenario < 1000 ms pure AND Worker, verdicts
 * match fixtures, no scenario exceeds 10 events), exit 1 on FAIL.
 * The 1 s threshold is FROZEN (PROJECT_BOOK.md §10); this script never
 * changes it and never drops a scenario.
 *
 * Invocation: `npm run bench:10-events` from 04_source/source. The npm
 * script bundles this file with the already-installed esbuild
 * (transitive dep of vite/vitest — no new dependency) into
 * node_modules/.t012-bench/ (a gitignored build artifact) and runs it
 * with node. TypeScript strict, no `any`. No network, no randomness.
 */

import { spawnSync } from "node:child_process";
import { cpus, freemem, release, totalmem, type as osType, arch } from "node:os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type {
  BackupStrategy,
  LogicalOperation,
  Scenario,
  SearchVerdict,
} from "../src/core/model/types";
import { totalAtomicEventCount } from "../src/core/model/scenario";
import { runSearch } from "../src/core/search/bfs";
import { createLocalWorkerClient } from "../src/worker/worker-client";

// ---------------------------------------------------------------------------
// Frozen constants (PROJECT_BOOK.md §10, IMPLEMENTATION_PLAN.md §6 / T012)
// ---------------------------------------------------------------------------

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
// Fixture loading (shape guards; mirrors tests/unit/golden/golden.test.ts)
// ---------------------------------------------------------------------------

const GOLDEN_DIR = resolve(process.cwd(), "fixtures/golden");

function fail(message: string): never {
  throw new Error(`t012-bench fixture parse error: ${message}`);
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
  expectedCounterexampleLength: number;
  eventCount: number;
}

function parseFixture(value: unknown, fileName: string): GoldenFixture {
  const record = asRecord(value, fileName);
  return {
    fixtureId: asString(record.fixtureId, `${fileName}.fixtureId`),
    scenario: parseScenario(record.scenario),
    expectedVerdict: asVerdict(record.expectedVerdict),
    expectedCounterexampleLength: asNumber(
      record.expectedCounterexampleLength,
      `${fileName}.expectedCounterexampleLength`,
    ),
    eventCount: asNumber(record.eventCount, `${fileName}.eventCount`),
  };
}

function loadFixtures(): readonly GoldenFixture[] {
  const manifest: unknown = JSON.parse(
    readFileSync(join(GOLDEN_DIR, "manifest.json"), "utf8"),
  );
  const manifestRecord = asRecord(manifest, "manifest.json");
  const entries = asArray(manifestRecord.scenarios, "manifest.scenarios");
  return entries.map((entry) => {
    const entryRecord = asRecord(entry, "manifest.scenarios[]");
    const fixtureId = asString(entryRecord.fixtureId, "manifest.scenarios[].fixtureId");
    const parsed: unknown = JSON.parse(
      readFileSync(join(GOLDEN_DIR, `${fixtureId}.json`), "utf8"),
    );
    return parseFixture(parsed, `${fixtureId}.json`);
  });
}

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

interface TimingStats {
  samplesMs: readonly number[];
  minMs: number;
  medianMs: number;
  maxMs: number;
  meanMs: number;
}

function stats(samples: readonly number[]): TimingStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((acc, value) => acc + value, 0);
  return {
    samplesMs: samples.map(round4),
    minMs: round4(sorted[0]),
    medianMs: round4(sorted[Math.floor(sorted.length / 2)]),
    maxMs: round4(sorted[sorted.length - 1]),
    meanMs: round4(sum / samples.length),
  };
}

// ---------------------------------------------------------------------------
// Environment (PROJECT_BOOK.md §10.3: record the actual machine)
// ---------------------------------------------------------------------------

function commandVersion(command: string, args: readonly string[]): string {
  const result = spawnSync(command, [...args], { encoding: "utf8" });
  if (result.status !== 0) {
    return "unknown";
  }
  return result.stdout.trim().split("\n")[0].trim();
}

function collectEnvironment(): Record<string, string | number> {
  const cpuList = cpus();
  return {
    os: `${osType()} ${release()} ${arch()}`,
    cpuModel: cpuList.length > 0 ? cpuList[0].model.trim() : "unknown",
    cpuCores: cpuList.length,
    ramTotalMB: Math.round(totalmem() / 1024 / 1024),
    ramFreeMB: Math.round(freemem() / 1024 / 1024),
    nodeVersion: process.version,
    npmVersion: commandVersion("npm", ["--version"]),
    pythonVersion: commandVersion("python3", ["--version"]),
  };
}

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------

interface ScenarioResult {
  fixtureId: string;
  scenarioId: string;
  strategy: BackupStrategy;
  eventCount: number;
  expectedVerdict: SearchVerdict;
  verdict: SearchVerdict;
  verdictMatches: boolean;
  pureMs: TimingStats;
  workerFirstRunMs: number;
  workerSteadyMs: TimingStats;
  pass: boolean;
}

async function main(): Promise<number> {
  const startedAt = new Date().toISOString();
  const fixtures = loadFixtures();
  if (fixtures.length !== 24) {
    throw new Error(`expected 24 Golden fixtures, loaded ${fixtures.length}`);
  }
  const environment = collectEnvironment();

  // Untimed warm-up pass (discarded, not counted as a repeat): stabilises
  // JIT so the measured samples are not polluted by first-compile cost.
  for (const fixture of fixtures) {
    runSearch(fixture.scenario);
  }

  const results: ScenarioResult[] = [];
  for (const fixture of fixtures) {
    const { scenario } = fixture;

    // (a) Pure algorithm time: performance.now() around runSearch only.
    const pureSamples: number[] = [];
    let verdict: SearchVerdict = "INVALID_INPUT";
    for (let i = 0; i < REPEATS; i += 1) {
      const start = performance.now();
      const result = runSearch(scenario);
      const end = performance.now();
      pureSamples.push(end - start);
      verdict = result.verdict;
    }

    // (b) Full interaction response time: Worker round-trip via the local
    // client (same typed protocol as the browser Worker). First run on a
    // fresh client (includes lazy transport creation) is reported
    // separately from the steady-state runs on the same client.
    const client = createLocalWorkerClient();
    const firstStart = performance.now();
    const firstResult = await client.run(scenario);
    const firstMs = performance.now() - firstStart;
    const steadySamples: number[] = [];
    for (let i = 0; i < REPEATS; i += 1) {
      const start = performance.now();
      await client.run(scenario);
      steadySamples.push(performance.now() - start);
    }
    client.terminate();
    if (firstResult.verdict !== verdict) {
      throw new Error(
        `Worker verdict ${firstResult.verdict} differs from pure runSearch verdict ${verdict} for ${fixture.fixtureId}`,
      );
    }

    const eventCount = totalAtomicEventCount(scenario);
    const pure = stats(pureSamples);
    const steady = stats(steadySamples);
    const pass =
      eventCount <= MAX_EVENTS &&
      eventCount === fixture.eventCount &&
      verdict === fixture.expectedVerdict &&
      pure.maxMs < SEARCH_TIME_LIMIT_MS &&
      round4(firstMs) < SEARCH_TIME_LIMIT_MS &&
      steady.maxMs < SEARCH_TIME_LIMIT_MS;
    results.push({
      fixtureId: fixture.fixtureId,
      scenarioId: fixture.scenario.scenarioId,
      strategy: fixture.scenario.strategy,
      eventCount,
      expectedVerdict: fixture.expectedVerdict,
      verdict,
      verdictMatches: verdict === fixture.expectedVerdict,
      pureMs: pure,
      workerFirstRunMs: round4(firstMs),
      workerSteadyMs: steady,
      pass,
    });
  }

  const slowestPure = [...results].sort((a, b) => b.pureMs.maxMs - a.pureMs.maxMs)[0];
  const slowestSteady = [...results].sort(
    (a, b) => b.workerSteadyMs.maxMs - a.workerSteadyMs.maxMs,
  )[0];
  const slowestFirst = [...results].sort((a, b) => b.workerFirstRunMs - a.workerFirstRunMs)[0];
  const maxEventCount = Math.max(...results.map((r) => r.eventCount));
  const allPass = results.every((r) => r.pass);
  const finishedAt = new Date().toISOString();

  const report = {
    taskId: "P030-T012",
    projectId: "P030",
    projectName: "SnapFence",
    specVersion: "1.0.1",
    thresholdMs: SEARCH_TIME_LIMIT_MS,
    thresholdSource: "PROJECT_BOOK.md §10 (FROZEN, 1 s per scenario at <= 10 events)",
    repeatsPerScenario: REPEATS,
    warmupPass: "1 untimed runSearch pass over all 24 scenarios, discarded, not counted",
    generatedAtStart: startedAt,
    generatedAtEnd: finishedAt,
    environment,
    measurementNotes: [
      "pureMs: performance.now() around runSearch only; Worker initialisation is NOT mixed in.",
      "workerFirstRunMs: first Worker round-trip on a fresh LocalWorkerTransport client (includes lazy transport creation).",
      "workerSteadyMs: 5 Worker round-trips on the same client after the first run.",
      "Worker round-trip measured via createLocalWorkerClient() (in-process LocalWorkerTransport, same typed protocol snapfence.worker/v1 as the browser Worker); not a real browser Worker thread.",
      "No sample was dropped: all 24 scenarios are reported, including the slowest, with all 5 samples each.",
    ],
    scenarios: results,
    summary: {
      scenarios: results.length,
      scenariosPassed: results.filter((r) => r.pass).length,
      maxEventCount,
      maxScaleScenario: "G12 (10 events)",
      slowestPure: {
        fixtureId: slowestPure.fixtureId,
        maxMs: slowestPure.pureMs.maxMs,
        medianMs: slowestPure.pureMs.medianMs,
      },
      slowestWorkerSteady: {
        fixtureId: slowestSteady.fixtureId,
        maxMs: slowestSteady.workerSteadyMs.maxMs,
        medianMs: slowestSteady.workerSteadyMs.medianMs,
      },
      slowestWorkerFirstRun: {
        fixtureId: slowestFirst.fixtureId,
        ms: slowestFirst.workerFirstRunMs,
      },
      result: allPass ? "PASS" : "FAIL",
    },
  };

  // Slowest-first table (all 24 rows, none deleted).
  const byPure = [...results].sort((a, b) => b.pureMs.maxMs - a.pureMs.maxMs);
  const lines: string[] = [];
  lines.push("P030-T012 10-event performance benchmark");
  lines.push(`started: ${startedAt}`);
  lines.push(`finished: ${finishedAt}`);
  lines.push(`threshold: < ${SEARCH_TIME_LIMIT_MS} ms per scenario (PROJECT_BOOK.md §10, FROZEN)`);
  lines.push(`repeats per scenario: ${REPEATS} (pure + Worker steady-state); 1 untimed warm-up pass, discarded`);
  lines.push("");
  lines.push("Environment:");
  for (const [key, value] of Object.entries(environment)) {
    lines.push(`  ${key}: ${value}`);
  }
  lines.push("");
  lines.push("Per-scenario results (slowest pure max first; all 24 scenarios, none dropped):");
  lines.push(
    "fixture  events  verdict             pure min/median/max (ms)        worker first (ms)  worker steady min/median/max (ms)  pass",
  );
  for (const r of byPure) {
    lines.push(
      `${r.fixtureId.padEnd(8)} ${String(r.eventCount).padEnd(7)} ${r.verdict.padEnd(19)} ` +
        `${r.pureMs.minMs.toFixed(3)}/${r.pureMs.medianMs.toFixed(3)}/${r.pureMs.maxMs.toFixed(3)}`.padEnd(27) +
        `${r.workerFirstRunMs.toFixed(3)}`.padEnd(19) +
        `${r.workerSteadyMs.minMs.toFixed(3)}/${r.workerSteadyMs.medianMs.toFixed(3)}/${r.workerSteadyMs.maxMs.toFixed(3)}`.padEnd(33) +
        `${r.pass ? "PASS" : "FAIL"}`,
    );
  }
  lines.push("");
  lines.push("Pure samples (ms, 5 repeats each, in fixture order U01-U12, G01-G12):");
  for (const r of results) {
    lines.push(`  ${r.fixtureId}: [${r.pureMs.samplesMs.map((v) => v.toFixed(3)).join(", ")}]`);
  }
  lines.push("Worker steady-state samples (ms, 5 repeats each):");
  for (const r of results) {
    lines.push(`  ${r.fixtureId}: [${r.workerSteadyMs.samplesMs.map((v) => v.toFixed(3)).join(", ")}]`);
  }
  lines.push("Worker first-run samples (ms, 1 per scenario, fresh client each):");
  for (const r of results) {
    lines.push(`  ${r.fixtureId}: ${r.workerFirstRunMs.toFixed(3)}`);
  }
  lines.push("");
  lines.push(`Max event count: ${maxEventCount} (G12 = 10; none exceeds 10)`);
  lines.push(`Slowest pure: ${slowestPure.fixtureId} max ${slowestPure.pureMs.maxMs.toFixed(3)} ms (median ${slowestPure.pureMs.medianMs.toFixed(3)} ms)`);
  lines.push(`Slowest Worker steady-state: ${slowestSteady.fixtureId} max ${slowestSteady.workerSteadyMs.maxMs.toFixed(3)} ms (median ${slowestSteady.workerSteadyMs.medianMs.toFixed(3)} ms)`);
  lines.push(`Slowest Worker first run: ${slowestFirst.fixtureId} ${slowestFirst.workerFirstRunMs.toFixed(3)} ms`);
  lines.push(`Scenarios passed: ${results.filter((r) => r.pass).length}/${results.length}`);
  lines.push(`RESULT=${allPass ? "PASS" : "FAIL"}`);
  const logText = `${lines.join("\n")}\n`;

  const outDir = resolve(process.cwd(), "..", "..", "05_tests", "benchmark");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "performance.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(join(outDir, "performance.log"), logText, "utf8");

  process.stdout.write(logText);
  return allPass ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `T012 bench FAILED with error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
