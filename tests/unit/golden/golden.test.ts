/**
 * SnapFence (P030) — T005 Golden scenario tests.
 *
 * Loads the 24 hand-designed fixtures in `fixtures/golden/` (plus
 * `manifest.json`), runs each scenario through the production `runSearch`,
 * and asserts verdict + counterexample sequence + counterexample length +
 * diagnostic codes match the fixture's hand-derived expectations.
 *
 * Conventions asserted here (PROJECT_BOOK.md §4.6, §10.3; ADR-001/ADR-002;
 * T004 L-10 prefix convention):
 * - exactly 12 UNSAFE_WITHIN_BOUND and 12 SAFE_WITHIN_BOUND;
 * - every scenario has at most 10 events (including the 2 snapshot events);
 * - every inconsistent case has a hand-derived `reason` and a shortest
 *   counterexample that ends at the second snapshot (prefix convention);
 * - value-first diagnostics (ADR-002): a SAFE pair carries zero diagnostics;
 * - G02–G04 / G06–G08 pin both snapshots after their single operation via
 *   `snapshotsAfter` (ADR-001); U01–U12 omit it (full interleaving);
 * - correct cases are not faked by deleting events or empty input: only
 *   G01/G05 (idle, plan §6.2) have zero operations.
 *
 * The suite lives in tests/unit/golden/ (unit: it exercises the frozen
 * core search only, no UI/worker/export). Fixtures are read from disk with
 * `node:fs` and shape-checked by the guards below (no `any` anywhere).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  BackupStrategy,
  DiagnosticCode,
  LogicalOperation,
  Scenario,
  SearchVerdict,
} from "../../../src/core/model/types";
import { totalAtomicEventCount } from "../../../src/core/model/scenario";
import { evaluateSequence, runSearch } from "../../../src/core/search/bfs";

const GOLDEN_DIR = fileURLToPath(new URL("../../../fixtures/golden/", import.meta.url));

const DIAGNOSTIC_CODES: readonly DiagnosticCode[] = [
  "DANGLING_REFERENCE",
  "ORPHAN_BLOB",
  "GENERATION_MISMATCH",
  "DIGEST_MISMATCH",
  "IN_FLIGHT_OPERATION",
  "NO_COMMON_BOUNDARY",
] as const;

const STRATEGIES: readonly BackupStrategy[] = ["DB_FIRST", "FILE_FIRST", "PAUSE_WRITES"] as const;

const VERDICTS: readonly SearchVerdict[] = [
  "SAFE_WITHIN_BOUND",
  "UNSAFE_WITHIN_BOUND",
  "INCONCLUSIVE_LIMIT",
  "INVALID_INPUT",
] as const;

// ---------------------------------------------------------------------------
// Fixture + manifest shapes (mirrors fixtures/golden/*.json, manifest.json)
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

interface ManifestScenarioEntry {
  fixtureId: string;
  scenarioId: string;
  strategy: BackupStrategy;
  operations: readonly { opId: string; kind: string; fileId: string }[];
  snapshotsAfter: readonly string[];
  eventCount: number;
  expectedVerdict: SearchVerdict;
  expectedCounterexampleLength: number;
}

interface ManifestCoverageItem {
  item: string;
  covered: boolean;
  scenarios: readonly string[];
  note: string;
}

interface GoldenManifest {
  manifestVersion: number;
  projectId: string;
  specVersion: string;
  goldenTotal: number;
  unsafeExpected: number;
  safeExpected: number;
  scenarios: readonly ManifestScenarioEntry[];
  coverage: {
    operationsByStrategy: Readonly<Record<string, readonly string[]>>;
    items: readonly ManifestCoverageItem[];
  };
}

// ---------------------------------------------------------------------------
// Shape guards (unknown -> typed, fail loudly on malformed fixtures)
// ---------------------------------------------------------------------------

function fail(message: string): never {
  throw new Error(`golden fixture parse error: ${message}`);
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

function asBoolean(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") {
    fail(`${what} must be a boolean`);
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

function asDiagnosticCode(value: unknown): DiagnosticCode {
  if (!DIAGNOSTIC_CODES.includes(value as DiagnosticCode)) {
    fail(`diagnostic code must be one of ${DIAGNOSTIC_CODES.join(" | ")}, got ${String(value)}`);
  }
  return value as DiagnosticCode;
}

function parseOperation(value: unknown): LogicalOperation {
  const record = asRecord(value, "operation");
  const opId = asString(record.opId, "operation.opId");
  const kind = asString(record.kind, "operation.kind");
  const fileId = asString(record.fileId, "operation.fileId");
  if (kind === "UPLOAD") {
    const objectId = asString(record.objectId, "operation.objectId");
    const digest = asString(record.digest, "operation.digest");
    return { opId, kind: "UPLOAD", fileId, objectId, digest };
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

function parseFixture(value: unknown, fileName: string): GoldenFixture {
  const record = asRecord(value, fileName);
  return {
    fixtureId: asString(record.fixtureId, `${fileName}.fixtureId`),
    scenario: parseScenario(record.scenario),
    expectedVerdict: asVerdict(record.expectedVerdict),
    expectedDiagnostics: asArray(record.expectedDiagnostics, `${fileName}.expectedDiagnostics`).map(
      asDiagnosticCode,
    ),
    expectedCounterexample: asStringArray(
      record.expectedCounterexample,
      `${fileName}.expectedCounterexample`,
    ),
    expectedCounterexampleLength: asNumber(
      record.expectedCounterexampleLength,
      `${fileName}.expectedCounterexampleLength`,
    ),
    eventCount: asNumber(record.eventCount, `${fileName}.eventCount`),
    reason: asString(record.reason, `${fileName}.reason`),
  };
}

function parseManifestEntry(value: unknown): ManifestScenarioEntry {
  const record = asRecord(value, "manifest.scenarios[]");
  return {
    fixtureId: asString(record.fixtureId, "manifest.scenarios[].fixtureId"),
    scenarioId: asString(record.scenarioId, "manifest.scenarios[].scenarioId"),
    strategy: asBackupStrategy(record.strategy),
    operations: asArray(record.operations, "manifest.scenarios[].operations").map((entry) => {
      const op = asRecord(entry, "manifest.scenarios[].operations[]");
      return {
        opId: asString(op.opId, "operation.opId"),
        kind: asString(op.kind, "operation.kind"),
        fileId: asString(op.fileId, "operation.fileId"),
      };
    }),
    snapshotsAfter: asStringArray(record.snapshotsAfter, "manifest.scenarios[].snapshotsAfter"),
    eventCount: asNumber(record.eventCount, "manifest.scenarios[].eventCount"),
    expectedVerdict: asVerdict(record.expectedVerdict),
    expectedCounterexampleLength: asNumber(
      record.expectedCounterexampleLength,
      "manifest.scenarios[].expectedCounterexampleLength",
    ),
  };
}

function parseManifest(value: unknown): GoldenManifest {
  const record = asRecord(value, "manifest.json");
  const coverage = asRecord(record.coverage, "manifest.coverage");
  const operationsByStrategy: Record<string, readonly string[]> = {};
  for (const [key, entry] of Object.entries(
    asRecord(coverage.operationsByStrategy, "manifest.coverage.operationsByStrategy"),
  )) {
    operationsByStrategy[key] = asStringArray(entry, `coverage.operationsByStrategy.${key}`);
  }
  return {
    manifestVersion: asNumber(record.manifestVersion, "manifest.manifestVersion"),
    projectId: asString(record.projectId, "manifest.projectId"),
    specVersion: asString(record.specVersion, "manifest.specVersion"),
    goldenTotal: asNumber(record.goldenTotal, "manifest.goldenTotal"),
    unsafeExpected: asNumber(record.unsafeExpected, "manifest.unsafeExpected"),
    safeExpected: asNumber(record.safeExpected, "manifest.safeExpected"),
    scenarios: asArray(record.scenarios, "manifest.scenarios").map(parseManifestEntry),
    coverage: {
      operationsByStrategy,
      items: asArray(coverage.items, "manifest.coverage.items").map((entry) => {
        const item = asRecord(entry, "manifest.coverage.items[]");
        return {
          item: asString(item.item, "coverage.item"),
          covered: asBoolean(item.covered, "coverage.covered"),
          scenarios: asStringArray(item.scenarios, "coverage.scenarios"),
          note: asString(item.note, "coverage.note"),
        };
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Load once: manifest + all 24 fixtures named by the manifest
// ---------------------------------------------------------------------------

function readJson(path: string): unknown {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return parsed;
}

const MANIFEST: GoldenManifest = parseManifest(readJson(`${GOLDEN_DIR}manifest.json`));

const FIXTURES: readonly GoldenFixture[] = MANIFEST.scenarios.map((entry) =>
  parseFixture(readJson(`${GOLDEN_DIR}${entry.fixtureId}.json`), `${entry.fixtureId}.json`),
);

// ---------------------------------------------------------------------------
// Manifest tests
// ---------------------------------------------------------------------------

describe("Golden manifest (P030-T005)", () => {
  it("lists exactly 24 scenarios: 12 unsafe, 12 safe (SPEC_VERSION 1.0.1)", () => {
    expect(MANIFEST.projectId).toBe("P030");
    expect(MANIFEST.specVersion).toBe("1.0.1");
    expect(MANIFEST.goldenTotal).toBe(24);
    expect(MANIFEST.scenarios).toHaveLength(24);
    expect(FIXTURES).toHaveLength(24);
    const unsafe = MANIFEST.scenarios.filter(
      (entry) => entry.expectedVerdict === "UNSAFE_WITHIN_BOUND",
    );
    const safe = MANIFEST.scenarios.filter(
      (entry) => entry.expectedVerdict === "SAFE_WITHIN_BOUND",
    );
    expect(unsafe).toHaveLength(12);
    expect(safe).toHaveLength(12);
    expect(MANIFEST.unsafeExpected).toBe(12);
    expect(MANIFEST.safeExpected).toBe(12);
    const fixtureIds = MANIFEST.scenarios.map((entry) => entry.fixtureId);
    expect(new Set(fixtureIds).size).toBe(24);
    const scenarioIds = MANIFEST.scenarios.map((entry) => entry.scenarioId);
    expect(new Set(scenarioIds).size).toBe(24);
  });

  it("covers all 3 operations x 3 strategies", () => {
    const cells = new Map<string, string[]>();
    for (const fixture of FIXTURES) {
      for (const operation of fixture.scenario.operations) {
        const key = `${operation.kind}/${fixture.scenario.strategy}`;
        const list = cells.get(key) ?? [];
        if (!list.includes(fixture.fixtureId)) {
          list.push(fixture.fixtureId);
        }
        cells.set(key, list);
      }
    }
    const kinds = ["UPLOAD", "DELETE", "UPDATE"] as const;
    for (const kind of kinds) {
      for (const strategy of STRATEGIES) {
        const key = `${kind}/${strategy}`;
        expect(cells.has(key)).toBe(true);
        expect([...(cells.get(key) ?? [])].sort()).toEqual([
          ...(MANIFEST.coverage.operationsByStrategy[key] ?? []),
        ].sort());
      }
    }
  });

  it("coverage checklist items are all marked covered", () => {
    const required = [
      "orphan",
      "dangling",
      "delete across",
      "old-version",
      "new-version",
      "two-operation",
      "pause-writes",
      "max-event",
    ];
    for (const needle of required) {
      const item = MANIFEST.coverage.items.find((entry) =>
        entry.item.toLowerCase().includes(needle),
      );
      expect(item).toBeDefined();
      expect(item?.covered).toBe(true);
      expect((item?.scenarios ?? []).length).toBeGreaterThan(0);
      expect((item?.note ?? "").trim().length).toBeGreaterThan(0);
    }
    for (const item of MANIFEST.coverage.items) {
      expect(item.covered).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Per-fixture tests: production runSearch vs hand-derived expectations
// ---------------------------------------------------------------------------

describe("Golden fixtures (P030-T005)", () => {
  it("scenario IDs and fixture IDs are unique across all 24 fixtures", () => {
    const scenarioIds = FIXTURES.map((fixture) => fixture.scenario.scenarioId);
    expect(new Set(scenarioIds).size).toBe(FIXTURES.length);
    const fixtureIds = FIXTURES.map((fixture) => fixture.fixtureId);
    expect(new Set(fixtureIds).size).toBe(FIXTURES.length);
  });

  it("correct cases are not faked by deleting events or empty input", () => {
    for (const fixture of FIXTURES) {
      if (fixture.expectedVerdict !== "SAFE_WITHIN_BOUND") {
        continue;
      }
      // Idle scenarios are the only ones allowed zero operations (plan §6.2).
      if (fixture.fixtureId === "G01" || fixture.fixtureId === "G05") {
        expect(fixture.scenario.operations).toHaveLength(0);
      } else {
        expect(fixture.scenario.operations.length).toBeGreaterThan(0);
        expect(fixture.eventCount).toBeGreaterThan(2);
      }
      // Every operation contributes its full template event count: nothing deleted.
      expect(fixture.eventCount).toBe(totalAtomicEventCount(fixture.scenario));
    }
  });

  it.each(FIXTURES)(
    "$fixtureId ($scenarioId) matches the production search",
    (fixture) => {
      const { scenario } = fixture;
      // Structural expectations: event bound, manifest agreement, reason present.
      expect(fixture.eventCount).toBe(totalAtomicEventCount(scenario));
      expect(fixture.eventCount).toBeLessThanOrEqual(10);
      expect(fixture.expectedCounterexampleLength).toBe(fixture.expectedCounterexample.length);
      expect(fixture.reason.trim().length).toBeGreaterThan(0);
      const manifestEntry = MANIFEST.scenarios.find(
        (entry) => entry.fixtureId === fixture.fixtureId,
      );
      expect(manifestEntry).toBeDefined();
      expect(manifestEntry?.scenarioId).toBe(scenario.scenarioId);
      expect(manifestEntry?.strategy).toBe(scenario.strategy);
      expect(manifestEntry?.eventCount).toBe(fixture.eventCount);
      expect(manifestEntry?.expectedVerdict).toBe(fixture.expectedVerdict);
      expect(manifestEntry?.expectedCounterexampleLength).toBe(
        fixture.expectedCounterexampleLength,
      );

      // Production search, run twice: verdict + counterexample must be deterministic.
      const first = runSearch(scenario);
      const second = runSearch(scenario);
      expect(first.verdict).toBe(fixture.expectedVerdict);
      expect(second.verdict).toBe(first.verdict);
      expect([...second.counterexample]).toEqual([...first.counterexample]);
      expect(second.diagnostics.map((d) => d.code)).toEqual(
        first.diagnostics.map((d) => d.code),
      );
      expect(first.eventCount).toBe(fixture.eventCount);
      expect(first.diagnostics.map((d) => d.code).sort()).toEqual([
        ...fixture.expectedDiagnostics,
      ].sort());

      if (fixture.expectedVerdict === "UNSAFE_WITHIN_BOUND") {
        expect([...first.counterexample]).toEqual([...fixture.expectedCounterexample]);
        expect(first.counterexampleLength).toBe(fixture.expectedCounterexampleLength);
        // L-10 prefix convention: both snapshots exactly once, last event is a snapshot.
        const snapshots = first.counterexample.filter(
          (id) => id === "DB_SNAPSHOT" || id === "BLOB_SNAPSHOT",
        );
        expect([...snapshots].sort()).toEqual(["BLOB_SNAPSHOT", "DB_SNAPSHOT"]);
        const last = first.counterexample[first.counterexample.length - 1];
        expect(last === "DB_SNAPSHOT" || last === "BLOB_SNAPSHOT").toBe(true);
        // Independent replay of the recorded counterexample: legal and inconsistent.
        const replay = evaluateSequence(scenario, fixture.expectedCounterexample);
        expect(replay.valid).toBe(true);
        expect(replay.consistent).toBe(false);
        expect(replay.diagnostics.map((d) => d.code).sort()).toEqual([
          ...fixture.expectedDiagnostics,
        ].sort());
      } else {
        // SAFE_WITHIN_BOUND (ADR-002 value-first): no counterexample, zero diagnostics.
        expect(first.counterexample).toEqual([]);
        expect(first.counterexampleLength).toBe(0);
        expect(first.diagnostics).toEqual([]);
        expect(fixture.expectedCounterexample).toEqual([]);
        expect(fixture.expectedDiagnostics).toEqual([]);
      }
    },
  );
});
