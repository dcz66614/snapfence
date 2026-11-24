/**
 * P030-T013 verify:docs — documentation assertions for SnapFence.
 *
 * Checks (all must pass; any failure exits 1):
 *  1. README names the 3 strategies, the 3 operations, the 10-event bound,
 *     0-human participation, and the model-checking vs real-restore
 *     distinction (PROJECT_BOOK §6 / IMPLEMENTATION_PLAN T013).
 *  2. README does NOT reuse the S0 (10.8 ms) or T011 (10.0 ms) timings as
 *     performance conclusions — only the T012 measurements count.
 *  3. docs/LIMITATIONS.md carries every limitation id from T005–T012 and
 *     FIX-V-01 (56 ids).
 *  4. Performance numbers cited in README match 05_tests/benchmark/
 *     performance.json by parsing comparison (3-decimal rounded values),
 *     and the S0 14/14 result cited matches 05_tests/S0_GATE.md.
 *
 * This script is a deterministic text/parse check. It does NOT re-run BFS,
 * re-measure performance, or re-execute the Oracle (see L-T013-02).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function findRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate project root (package.json)");
}

const ROOT = findRoot();
const WORKDIR = path.resolve(ROOT, "..", "..");

const failures: string[] = [];
const passes: string[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passes.push(name);
  } else {
    failures.push(detail ? `${name}: ${detail}` : name);
  }
}

function mustContain(haystack: string, needle: string, where: string): void {
  check(
    `${where} contains "${needle}"`,
    haystack.includes(needle),
    `missing "${needle}" in ${where}`,
  );
}

const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const limitations = fs.readFileSync(
  path.join(ROOT, "docs", "LIMITATIONS.md"),
  "utf8",
);
const perf = JSON.parse(
  fs.readFileSync(
    path.join(WORKDIR, "05_tests", "benchmark", "performance.json"),
    "utf8",
  ),
) as {
  summary: {
    scenarios: number;
    scenariosPassed: number;
    maxEventCount: number;
    slowestPure: { maxMs: number; medianMs: number };
    slowestWorkerSteady: { maxMs: number };
    slowestWorkerFirstRun: { ms: number };
  };
  thresholdMs: number;
};
const s0Gate = fs.readFileSync(
  path.join(WORKDIR, "05_tests", "S0_GATE.md"),
  "utf8",
);

// 1. README vocabulary (plan T013 acceptance).
for (const s of ["DB_FIRST", "FILE_FIRST", "PAUSE_WRITES"]) {
  mustContain(readme, s, "README.md");
}
for (const op of ["UPLOAD", "DELETE", "UPDATE"]) {
  mustContain(readme, op, "README.md");
}
mustContain(readme, "10 个事件", "README.md");
mustContain(readme, "0 真人", "README.md");
mustContain(readme, "模型检查不等于真实恢复", "README.md");
mustContain(readme, "1 秒", "README.md");

// 2. Forbidden reuse of older timings as performance conclusions.
check(
  'README.md does not cite S0 timing "10.8"',
  !readme.includes("10.8"),
  'README.md cites "10.8" (S0 timing) as a performance number',
);
check(
  'README.md does not cite T011 timing "10.0 ms"',
  !readme.includes("10.0 ms"),
  'README.md cites "10.0 ms" (T011 timing) as a performance number',
);

// 3. LIMITATIONS.md carries all 56 ids.
const requiredIds: string[] = [];
for (const [prefix, n] of [
  ["L-T005", 6],
  ["L-T006", 7],
  ["L-T007", 6],
  ["L-T008", 8],
  ["L-T009", 6],
  ["L-T010", 6],
  ["L-T011", 9],
  ["L-T012", 5],
  ["L-FIX-V-01", 3],
] as const) {
  for (let i = 1; i <= n; i++) {
    requiredIds.push(`${prefix}-${String(i).padStart(2, "0")}`);
  }
}
const missingIds = requiredIds.filter((id) => !limitations.includes(id));
check(
  `LIMITATIONS.md carries all ${requiredIds.length} limitation ids`,
  missingIds.length === 0,
  `missing ids: ${missingIds.join(", ")}`,
);

// 4. Cited performance numbers match performance.json (3-decimal rounding).
function round3(n: number): string {
  return n.toFixed(3);
}
const cited: Array<[string, number, string]> = [
  ["G12 pure max ms", perf.summary.slowestPure.maxMs, "8.187"],
  ["G12 pure median ms", perf.summary.slowestPure.medianMs, "5.609"],
  ["G12 worker steady max ms", perf.summary.slowestWorkerSteady.maxMs, "8.239"],
  ["G12 worker first run ms", perf.summary.slowestWorkerFirstRun.ms, "13.430"],
];
for (const [label, measured, expected] of cited) {
  check(
    `${label}: measured ${measured} rounds to cited ${expected}`,
    round3(measured) === expected && readme.includes(expected),
    `measured ${measured} -> ${round3(measured)}, expected cited "${expected}" in README.md`,
  );
}
check(
  "performance.json scenarios 24/24",
  perf.summary.scenarios === 24 && perf.summary.scenariosPassed === 24,
  `scenarios=${perf.summary.scenarios} passed=${perf.summary.scenariosPassed}`,
);
mustContain(readme, "24/24", "README.md");
check(
  "performance.json threshold is 1000 ms",
  perf.thresholdMs === 1000,
  `thresholdMs=${perf.thresholdMs}`,
);
mustContain(readme, "1000 ms", "README.md");
check(
  "performance.json max events is 10",
  perf.summary.maxEventCount === 10,
  `maxEventCount=${perf.summary.maxEventCount}`,
);
check(
  "S0_GATE.md records 14/14 and README cites it",
  s0Gate.includes("14/14") && readme.includes("14/14"),
  "S0_GATE.md or README.md missing 14/14",
);

console.log(`verify:docs: ${passes.length} checks passed, ${failures.length} failed`);
for (const p of passes) console.log(`  PASS ${p}`);
for (const f of failures) console.log(`  FAIL ${f}`);
if (failures.length > 0) {
  process.exit(1);
}
console.log("verify:docs: RESULT=PASS");
