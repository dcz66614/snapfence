/**
 * SnapFence (P030) — S0 core-correctness gate runner. T007.
 *
 * Authority: PROJECT_BOOK.md §10 (acceptance), IMPLEMENTATION_PLAN.md
 * T007 / §6 / §7 (S0 definition), ADR-001 (snapshotsAfter), ADR-002
 * (value-first diagnostics). This is a HARD GATE: only RESULT=PASS
 * unlocks T008–T014.
 *
 * In one run it executes and reports a single RESULT=PASS/FAIL for:
 *   (a) the four production suites via their npm scripts —
 *       test:golden (29), test:events (93), test:search (98),
 *       test:invariants (73);
 *   (b) typecheck;
 *   (c) the independent Python Oracle — `python3 -m unittest discover
 *       -s ../../oracle/python/tests -v` (39/39) plus a CLI parity run
 *       over the Golden directory (verdict + shortest-counterexample
 *       length + sequence + diagnostics, 24/24);
 *   (d) S0-specific checks, computed directly against the production
 *       `runSearch` (frozen contracts.ts signature):
 *       - Golden 24/24: 12/12 UNSAFE detected, 12/12 SAFE, 0 false
 *         positives, 0 false negatives;
 *       - shortest-counterexample repeatability: every U scenario's
 *         search run twice, byte-identical result (G scenarios checked
 *         the same way);
 *       - max events 10 (G12 = 10, no scenario exceeds 10);
 *       - search < 1 s for every scenario at <= 10 events — pure
 *         algorithm time only, measured with performance.now() around
 *         runSearch, excluding Worker/init;
 *       - external API 0 — static assertion over the invoked code
 *         paths (src/core/**): no fetch/axios/WebSocket/XMLHttpRequest/
 *         http(s) client call;
 *       - GPU not needed — static assertion: no WebGL/WebGPU/CUDA code
 *         path in src/core/**.
 *
 * The gate never stops at the first failure: every section runs so the
 * log is complete evidence either way. It never throws away a failure by
 * re-running a single case. On FAIL it exits 1 and the first failing
 * check is named in the summary.
 *
 * Invocation: `npm run s0:gate` from 04_source/source. The npm script
 * bundles this file with the already-installed esbuild (transitive dep
 * of vite/vitest — no new dependency) into node_modules/.s0-gate/ (a
 * gitignored build artifact) and runs it with node. The Oracle unittest
 * output is captured verbatim to
 * ../../05_tests/test-results/s0-oracle.log by this gate; the full log
 * of `npm run s0:gate` itself is 05_tests/test-results/s0-gate.log.
 *
 * TypeScript strict, no `any`. No network, no randomness, no wall-clock
 * in any verdict — timings are measurements only, never inputs to a
 * judgement (the < 1 s check uses the measured value as its criterion,
 * per PROJECT_BOOK.md §10.3).
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type {
  DiagnosticCode,
  Scenario,
  SearchVerdict,
} from "../src/core/model/types";
import { totalAtomicEventCount } from "../src/core/model/scenario";
import { runSearch } from "../src/core/search/bfs";

// ---------------------------------------------------------------------------
// Frozen constants (PROJECT_BOOK.md §4.4, §4.7; IMPLEMENTATION_PLAN.md §6)
// ---------------------------------------------------------------------------

const DIAGNOSTIC_CODES: readonly DiagnosticCode[] = [
  "DANGLING_REFERENCE",
  "ORPHAN_BLOB",
  "GENERATION_MISMATCH",
  "DIGEST_MISMATCH",
  "IN_FLIGHT_OPERATION",
  "NO_COMMON_BOUNDARY",
] as const;

const VERDICTS: readonly SearchVerdict[] = [
  "SAFE_WITHIN_BOUND",
  "UNSAFE_WITHIN_BOUND",
  "INCONCLUSIVE_LIMIT",
  "INVALID_INPUT",
] as const;

const EXPECTED_GOLDEN_TOTAL = 24;
const EXPECTED_UNSAFE = 12;
const EXPECTED_SAFE = 12;
const EXPECTED_ORACLE_TESTS = 39;
const EXPECTED_PARITY = 24;
const MAX_EVENTS = 10;
const SEARCH_TIME_LIMIT_MS = 1000;

/** Expected per-suite test counts (T002/T003/T004/T005 handoffs). */
const PRODUCTION_SUITES: readonly {
  script: string;
  expectedTests: number;
}[] = [
  { script: "test:golden", expectedTests: 29 },
  { script: "test:events", expectedTests: 93 },
  { script: "test:search", expectedTests: 98 },
  { script: "test:invariants", expectedTests: 73 },
];

/** Network-call patterns that must not occur anywhere in the gate path. */
const FORBIDDEN_NETWORK_PATTERNS: readonly RegExp[] = [
  /\bfetch\s*\(/,
  /\baxios\b/,
  /\bWebSocket\b/,
  /\bXMLHttpRequest\b/,
  /\bhttps?\.request\s*\(/,
  /\bhttps?\.get\s*\(/,
  /\bnet\.connect\s*\(/,
  /\bsendBeacon\s*\(/,
  /\bhttp2\b/,
];

/** GPU code paths that must not exist in the gate path. */
const FORBIDDEN_GPU_PATTERNS: readonly RegExp[] = [
  /webgl/i,
  /webgpu/i,
  /cuda/i,
];

// ---------------------------------------------------------------------------
// Paths (the gate runs with cwd = 04_source/source)
// ---------------------------------------------------------------------------

const SOURCE_DIR = resolve(process.cwd());
const WORK_DIR = resolve(SOURCE_DIR, "..", "..");
const GOLDEN_DIR = join(SOURCE_DIR, "fixtures", "golden");
const CORE_DIR = join(SOURCE_DIR, "src", "core");
const ORACLE_DIR = join(WORK_DIR, "oracle", "python");
const ORACLE_TESTS_DIR = join(ORACLE_DIR, "tests");
const TEST_RESULTS_DIR = join(WORK_DIR, "05_tests", "test-results");
const ORACLE_LOG_PATH = join(TEST_RESULTS_DIR, "s0-oracle.log");

// ---------------------------------------------------------------------------
// Check bookkeeping
// ---------------------------------------------------------------------------

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

const checks: CheckResult[] = [];

function record(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? "PASS" : "FAIL"}] ${name} — ${detail}`);
}

function section(title: string): void {
  console.log(`\n--- ${title} ---`);
}

interface SpawnOutcome {
  status: number | null;
  output: string;
}

function stripAnsi(text: string): string {
  // Vitest colourises its summary lines (e.g. `Tests <esc>[1m<esc>[32m29
  // passed`), so a plain /Tests\s+(\d+)\s+passed/ never matches. Strip
  // the escape sequences once, at capture time, so every parser below
  // sees plain text.
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): SpawnOutcome {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = stripAnsi(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  return { status: result.status, output };
}

function parseVitestCounts(output: string): {
  passed: number | null;
  failed: number | null;
} {
  const passedMatch = /Tests\s+(\d+)\s+passed/.exec(output);
  const failedMatch = /(\d+)\s+failed/.exec(output);
  return {
    passed: passedMatch?.[1] === undefined ? null : Number(passedMatch[1]),
    // Vitest omits the "N failed" segment entirely on a clean run, so
    // absence means 0 failed (a failing run always prints it, e.g.
    // "Tests  1 failed | 28 passed (29)").
    failed: failedMatch?.[1] === undefined ? 0 : Number(failedMatch[1]),
  };
}

function listTypeScriptFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listTypeScriptFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found.sort();
}

// ---------------------------------------------------------------------------
// Fixture loading (shape-guarded; no `any`)
// ---------------------------------------------------------------------------

interface GoldenFixture {
  fixtureId: string;
  scenario: Scenario;
  expectedVerdict: SearchVerdict;
  expectedDiagnostics: readonly DiagnosticCode[];
  expectedCounterexample: readonly string[];
  expectedCounterexampleLength: number;
  eventCount: number;
  reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return null;
    }
    out.push(item);
  }
  return out;
}

function loadGoldenFixtures(): GoldenFixture[] {
  const files = readdirSync(GOLDEN_DIR)
    .filter((name) => /^[UG]\d{2}\.json$/.test(name))
    .sort();
  const fixtures: GoldenFixture[] = [];
  for (const file of files) {
    const raw: unknown = JSON.parse(readFileSync(join(GOLDEN_DIR, file), "utf-8"));
    if (!isRecord(raw)) {
      throw new Error(`fixture ${file}: top level is not an object`);
    }
    const scenario = raw["scenario"];
    const expectedCounterexample = asStringArray(raw["expectedCounterexample"]);
    const expectedDiagnosticsRaw = asStringArray(raw["expectedDiagnostics"]);
    if (
      typeof raw["fixtureId"] !== "string" ||
      !isRecord(scenario) ||
      typeof raw["expectedVerdict"] !== "string" ||
      !(VERDICTS as readonly string[]).includes(raw["expectedVerdict"]) ||
      expectedCounterexample === null ||
      expectedDiagnosticsRaw === null ||
      typeof raw["expectedCounterexampleLength"] !== "number" ||
      typeof raw["eventCount"] !== "number" ||
      typeof raw["reason"] !== "string"
    ) {
      throw new Error(`fixture ${file}: shape guard failed`);
    }
    const expectedDiagnostics: DiagnosticCode[] = [];
    for (const code of expectedDiagnosticsRaw) {
      if (!(DIAGNOSTIC_CODES as readonly string[]).includes(code)) {
        throw new Error(`fixture ${file}: unknown diagnostic code ${code}`);
      }
      expectedDiagnostics.push(code as DiagnosticCode);
    }
    fixtures.push({
      fixtureId: raw["fixtureId"],
      scenario: scenario as Scenario,
      expectedVerdict: raw["expectedVerdict"] as SearchVerdict,
      expectedDiagnostics,
      expectedCounterexample,
      expectedCounterexampleLength: raw["expectedCounterexampleLength"],
      eventCount: raw["eventCount"],
      reason: raw["reason"],
    });
  }
  return fixtures;
}

function sortedCodes(codes: readonly DiagnosticCode[]): string {
  return [...codes].sort().join("+");
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

function main(): number {
  console.log("P030 SnapFence — S0 core-correctness gate (T007)");
  console.log(`source dir: ${SOURCE_DIR}`);
  console.log(`work dir:   ${WORK_DIR}`);
  console.log(`started:    ${new Date().toISOString()}`);

  // -- Load fixtures first: a shape failure fails the gate outright. ----
  let fixtures: GoldenFixture[];
  try {
    fixtures = loadGoldenFixtures();
  } catch (error) {
    record(
      "golden-fixtures-load",
      false,
      error instanceof Error ? error.message : String(error),
    );
    return finish();
  }
  record(
    "golden-fixtures-load",
    fixtures.length === EXPECTED_GOLDEN_TOTAL,
    `${fixtures.length}/${EXPECTED_GOLDEN_TOTAL} fixtures loaded ` +
      `(${fixtures.map((f) => f.fixtureId).join(", ")})`,
  );

  // -- (a) Production suites -------------------------------------------- 
  section("(a) Production suites");
  for (const suite of PRODUCTION_SUITES) {
    const { status, output } = runCommand("npm", ["run", suite.script], SOURCE_DIR);
    const counts = parseVitestCounts(output);
    const passed =
      status === 0 &&
      counts.passed === suite.expectedTests &&
      counts.failed === 0;
    record(
      `suite:${suite.script}`,
      passed,
      `exit=${String(status)} tests passed=${String(counts.passed)} ` +
        `(expected ${suite.expectedTests}) failed=${String(counts.failed)}`,
    );
    if (!passed) {
      console.log(`--- output of npm run ${suite.script} (tail) ---`);
      console.log(output.split("\n").slice(-25).join("\n"));
    }
  }

  // -- (b) Typecheck ------------------------------------------------------ 
  section("(b) Typecheck");
  {
    const { status, output } = runCommand("npm", ["run", "typecheck"], SOURCE_DIR);
    record("typecheck", status === 0, `exit=${String(status)}`);
    if (status !== 0) {
      console.log("--- output of npm run typecheck (tail) ---");
      console.log(output.split("\n").slice(-40).join("\n"));
    }
  }

  // -- (c) Oracle --------------------------------------------------------- 
  section("(c) Independent Python Oracle");
  mkdirSync(TEST_RESULTS_DIR, { recursive: true });
  const oracleOutcome = runCommand(
    "python3",
    ["-m", "unittest", "discover", "-s", "../../oracle/python/tests", "-v"],
    SOURCE_DIR,
  );
  writeFileSync(ORACLE_LOG_PATH, oracleOutcome.output, "utf-8");
  console.log(`oracle unittest log captured to ${ORACLE_LOG_PATH}`);
  const ranMatch = /Ran (\d+) tests?/.exec(oracleOutcome.output);
  const ran = ranMatch?.[1] === undefined ? null : Number(ranMatch[1]);
  const oracleOk =
    oracleOutcome.status === 0 &&
    ran === EXPECTED_ORACLE_TESTS &&
    /(^|\n)OK(\n|$)/.test(oracleOutcome.output);
  record(
    "oracle:unittest",
    oracleOk,
    `exit=${String(oracleOutcome.status)} ran=${String(ran)} ` +
      `(expected ${EXPECTED_ORACLE_TESTS}) result=${oracleOk ? "OK" : "NOT OK"}`,
  );
  if (!oracleOk) {
    console.log("--- oracle unittest output (tail) ---");
    console.log(oracleOutcome.output.split("\n").slice(-30).join("\n"));
  }

  // -- (d) S0-specific checks -------------------------------------------- 
  section("(d) S0-specific checks (direct runSearch)");

  // Golden verdicts, repeatability, timing, max events — one timed pass
  // per scenario (performance.now() around runSearch only).
  const timings = new Map<string, number>();
  const firstRun = new Map<string, string>();
  let unsafeDetected = 0;
  let safeDetected = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let repeatableCount = 0;
  let maxEventsSeen = 0;
  let maxEventScenario = "";
  let maxTimeMs = 0;
  let maxTimeScenario = "";
  const verdictMismatches: string[] = [];
  const repeatabilityMismatches: string[] = [];
  const timingViolations: string[] = [];
  const eventCountViolations: string[] = [];

  for (const fixture of fixtures) {
    const scenario = fixture.scenario;
    const totalEvents = totalAtomicEventCount(scenario);
    if (totalEvents > maxEventsSeen) {
      maxEventsSeen = totalEvents;
      maxEventScenario = fixture.fixtureId;
    }
    if (totalEvents > MAX_EVENTS || totalEvents !== fixture.eventCount) {
      eventCountViolations.push(
        `${fixture.fixtureId}: totalAtomicEventCount=${totalEvents} ` +
          `fixture eventCount=${fixture.eventCount}`,
      );
    }

    const startMs = performance.now();
    const result = runSearch(scenario);
    const elapsedMs = performance.now() - startMs;
    timings.set(fixture.fixtureId, elapsedMs);
    if (elapsedMs > maxTimeMs) {
      maxTimeMs = elapsedMs;
      maxTimeScenario = fixture.fixtureId;
    }
    if (elapsedMs >= SEARCH_TIME_LIMIT_MS) {
      timingViolations.push(`${fixture.fixtureId}: ${elapsedMs.toFixed(1)} ms`);
    }

    const serialized = JSON.stringify(result);
    firstRun.set(fixture.fixtureId, serialized);

    if (result.verdict === fixture.expectedVerdict) {
      if (result.verdict === "UNSAFE_WITHIN_BOUND") {
        unsafeDetected += 1;
      } else if (result.verdict === "SAFE_WITHIN_BOUND") {
        safeDetected += 1;
      }
    } else {
      verdictMismatches.push(
        `${fixture.fixtureId}: expected ${fixture.expectedVerdict}, ` +
          `got ${result.verdict}`,
      );
      if (fixture.expectedVerdict === "SAFE_WITHIN_BOUND") {
        falsePositives += 1;
      } else {
        falseNegatives += 1;
      }
    }
  }

  // Second pass for repeatability (byte-identical serialised result).
  for (const fixture of fixtures) {
    const again = JSON.stringify(runSearch(fixture.scenario));
    if (again === firstRun.get(fixture.fixtureId)) {
      repeatableCount += 1;
    } else {
      repeatabilityMismatches.push(fixture.fixtureId);
    }
  }

  const unsafeScenarios = fixtures.filter(
    (f) => f.expectedVerdict === "UNSAFE_WITHIN_BOUND",
  );
  const safeScenarios = fixtures.filter(
    (f) => f.expectedVerdict === "SAFE_WITHIN_BOUND",
  );
  record(
    "s0:golden-counts",
    unsafeDetected === EXPECTED_UNSAFE &&
      safeDetected === EXPECTED_SAFE &&
      falsePositives === 0 &&
      falseNegatives === 0 &&
      unsafeScenarios.length === EXPECTED_UNSAFE &&
      safeScenarios.length === EXPECTED_SAFE,
    `golden ${fixtures.length}/24; UNSAFE detected ${unsafeDetected}/12; ` +
      `SAFE detected ${safeDetected}/12; false positives ${falsePositives}; ` +
      `false negatives ${falseNegatives}` +
      (verdictMismatches.length > 0 ? `; mismatches: ${verdictMismatches.join("; ")}` : ""),
  );

  const unsafeRepeatable = unsafeScenarios.filter(
    (f) => !repeatabilityMismatches.includes(f.fixtureId),
  ).length;
  record(
    "s0:repeatability",
    repeatableCount === fixtures.length && unsafeRepeatable === EXPECTED_UNSAFE,
    `shortest counterexample byte-identical across two runs: ` +
      `${repeatableCount}/${fixtures.length} scenarios ` +
      `(U scenarios ${unsafeRepeatable}/12)` +
      (repeatabilityMismatches.length > 0
        ? `; differ: ${repeatabilityMismatches.join(", ")}`
        : ""),
  );

  const g12 = fixtures.find((f) => f.fixtureId === "G12");
  record(
    "s0:max-events",
    maxEventsSeen === MAX_EVENTS &&
      eventCountViolations.length === 0 &&
      g12 !== undefined &&
      totalAtomicEventCount(g12.scenario) === MAX_EVENTS,
    `max events ${maxEventsSeen} (${maxEventScenario}); G12 = ` +
      `${g12 === undefined ? "missing" : totalAtomicEventCount(g12.scenario)}; ` +
      `no scenario exceeds ${MAX_EVENTS}` +
      (eventCountViolations.length > 0
        ? `; violations: ${eventCountViolations.join("; ")}`
        : ""),
  );

  const timingDetail = [...timings.entries()]
    .map(([id, ms]) => `${id}=${ms.toFixed(1)}ms`)
    .join(" ");
  record(
    "s0:search-time",
    timingViolations.length === 0,
    `pure runSearch time per scenario (ms): ${timingDetail}; ` +
      `max ${maxTimeMs.toFixed(1)} ms (${maxTimeScenario}) < ${SEARCH_TIME_LIMIT_MS} ms` +
      (timingViolations.length > 0
        ? `; violations: ${timingViolations.join("; ")}`
        : ""),
  );

  // Oracle parity via the CLI (independent computation vs production).
  section("(c) Oracle parity (CLI, per-fixture comparison)");
  const parityOutcome = runCommand(
    "python3",
    [
      join(ORACLE_DIR, "snapfence_oracle.py"),
      "--golden-dir",
      GOLDEN_DIR,
    ],
    SOURCE_DIR,
  );
  let parityMatches = 0;
  const parityMismatches: string[] = [];
  if (parityOutcome.status !== 0) {
    parityMismatches.push(`oracle CLI exit=${String(parityOutcome.status)}`);
  } else {
    let oracleResults: unknown;
    try {
      oracleResults = JSON.parse(parityOutcome.output) as unknown;
    } catch {
      parityMismatches.push("oracle CLI output is not JSON");
      oracleResults = null;
    }
    if (Array.isArray(oracleResults)) {
      const byFixture = new Map<string, Record<string, unknown>>();
      for (const entry of oracleResults) {
        if (isRecord(entry) && typeof entry["fixture"] === "string") {
          byFixture.set(entry["fixture"], entry);
        }
      }
      for (const fixture of fixtures) {
        const oracle = byFixture.get(fixture.fixtureId);
        if (oracle === undefined) {
          parityMismatches.push(`${fixture.fixtureId}: no Oracle result`);
          continue;
        }
        const production = JSON.parse(
          firstRun.get(fixture.fixtureId) ?? "{}",
        ) as Record<string, unknown>;
        const oracleDiagnostics = asStringArray(oracle["diagnostics"]);
        const productionDiagnostics = asStringArray(
          Array.isArray(production["diagnostics"])
            ? (production["diagnostics"] as unknown[]).map((d) =>
                isRecord(d) && typeof d["code"] === "string" ? d["code"] : "",
              )
            : null,
        );
        const oracleCounterexample = asStringArray(oracle["counterexample"]);
        const productionCounterexample = asStringArray(production["counterexample"]);
        const verdictOk =
          oracle["verdict"] === fixture.expectedVerdict &&
          production["verdict"] === fixture.expectedVerdict;
        const lengthOk =
          oracle["counterexampleLength"] === fixture.expectedCounterexampleLength &&
          production["counterexampleLength"] === fixture.expectedCounterexampleLength;
        const sequenceOk =
          oracleCounterexample !== null &&
          productionCounterexample !== null &&
          JSON.stringify(oracleCounterexample) ===
            JSON.stringify(fixture.expectedCounterexample) &&
          JSON.stringify(productionCounterexample) ===
            JSON.stringify(fixture.expectedCounterexample);
        const diagnosticsOk =
          oracleDiagnostics !== null &&
          productionDiagnostics !== null &&
          sortedCodes(oracleDiagnostics as DiagnosticCode[]) ===
            sortedCodes(fixture.expectedDiagnostics) &&
          sortedCodes(productionDiagnostics as DiagnosticCode[]) ===
            sortedCodes(fixture.expectedDiagnostics);
        if (verdictOk && lengthOk && sequenceOk && diagnosticsOk) {
          parityMatches += 1;
        } else {
          parityMismatches.push(
            `${fixture.fixtureId}: verdictOk=${verdictOk} lengthOk=${lengthOk} ` +
              `sequenceOk=${sequenceOk} diagnosticsOk=${diagnosticsOk}`,
          );
        }
      }
    } else {
      parityMismatches.push("oracle CLI output is not a JSON array");
    }
  }
  record(
    "oracle:parity",
    parityMatches === EXPECTED_PARITY,
    `parity ${parityMatches}/${EXPECTED_PARITY} ` +
      `(verdict + shortest-counterexample length + sequence + diagnostics)` +
      (parityMismatches.length > 0
        ? `; mismatches: ${parityMismatches.join("; ")}`
        : ""),
  );

  // Static external-API / GPU assertions over the invoked code paths.
  section("(d) Static assertions over the gate path (src/core/**)");
  const coreFiles = listTypeScriptFiles(CORE_DIR);
  const networkHits: string[] = [];
  const gpuHits: string[] = [];
  for (const file of coreFiles) {
    const text = readFileSync(file, "utf-8");
    for (const pattern of FORBIDDEN_NETWORK_PATTERNS) {
      if (pattern.test(text)) {
        networkHits.push(`${file} matches ${String(pattern)}`);
      }
    }
    for (const pattern of FORBIDDEN_GPU_PATTERNS) {
      if (pattern.test(text)) {
        gpuHits.push(`${file} matches ${String(pattern)}`);
      }
    }
  }
  record(
    "s0:external-api-zero",
    networkHits.length === 0,
    `scanned ${coreFiles.length} files under src/core/** for ` +
      `${FORBIDDEN_NETWORK_PATTERNS.map((p) => String(p)).join(" ")}: ` +
      `${networkHits.length} hits` +
      (networkHits.length > 0 ? ` — ${networkHits.join("; ")}` : ""),
  );
  record(
    "s0:gpu-not-needed",
    gpuHits.length === 0,
    `scanned ${coreFiles.length} files under src/core/** for ` +
      `${FORBIDDEN_GPU_PATTERNS.map((p) => String(p)).join(" ")}: ` +
      `${gpuHits.length} hits (no GPU code path exists)` +
      (gpuHits.length > 0 ? ` — ${gpuHits.join("; ")}` : ""),
  );

  // __pycache__ cleanup: running the Oracle tests regenerates these
  // (T006 L-T006-07); remove them so the repo stays clean. .gitignore
  // is intentionally NOT modified.
  for (const dir of [ORACLE_DIR, ORACLE_TESTS_DIR]) {
    const cache = join(dir, "__pycache__");
    if (existsSync(cache)) {
      rmSync(cache, { recursive: true, force: true });
    }
  }

  return finish();
}

function finish(): number {
  const failed = checks.filter((c) => !c.passed);
  const passedCount = checks.length - failed.length;
  console.log("\n================ S0 GATE SUMMARY ================");
  for (const check of checks) {
    console.log(`${check.passed ? "PASS" : "FAIL"}  ${check.name}`);
  }
  console.log(`checks passed: ${passedCount}/${checks.length}`);
  if (failed.length > 0) {
    console.log(`FIRST FAILING CHECK: ${failed[0]?.name ?? "unknown"}`);
  }
  const result = failed.length === 0 ? "PASS" : "FAIL";
  console.log(`\nRESULT=${result}`);
  console.log(`finished:   ${new Date().toISOString()}`);
  return result === "PASS" ? 0 : 1;
}

process.exitCode = main();
