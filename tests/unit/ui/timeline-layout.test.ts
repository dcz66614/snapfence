/**
 * SnapFence (P030) — T008 timeline layout model tests.
 *
 * Tests the pure layout module (no React, no DOM): lane assignment for all
 * 9 event kinds, display-sequence selection (shortest counterexample for
 * UNSAFE, canonical full sequence for SAFE), exact event/snapshot x
 * positions, orphan/dangling visual markers, and the snapshot diff.
 * Fixtures are the frozen T005 Golden inputs; results come from the
 * S0-verified production `runSearch` — nothing here re-implements search.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Scenario, SearchResult } from "../../../src/core/model/types";
import { runSearch } from "../../../src/core/search/bfs";
import { buildSearchResult } from "../../../src/core/search/search-result";
import { evaluateSequence } from "../../../src/core/search/bfs";
import {
  DIAGNOSTIC_COLORS,
  DIAGNOSTIC_EXPLANATIONS,
  DIAGNOSTIC_LABELS,
  buildDisplaySequence,
  buildTimelineModel,
  diagnosticMarkers,
  laneForEventKind,
  snapshotDiff,
} from "../../../src/components/timeline/timeline-layout";
import type { EventKind } from "../../../src/core/events/event-types";

const GOLDEN_DIR = fileURLToPath(new URL("../../../fixtures/golden/", import.meta.url));

interface GoldenFixtureFile {
  fixtureId: string;
  scenario: Scenario;
  expectedVerdict: string;
  expectedDiagnostics: readonly string[];
  expectedCounterexample: readonly string[];
  expectedCounterexampleLength: number;
  eventCount: number;
  reason: string;
}

function loadFixture(fixtureId: string): GoldenFixtureFile {
  const raw = readFileSync(`${GOLDEN_DIR}${fixtureId}.json`, "utf-8");
  return JSON.parse(raw) as GoldenFixtureFile;
}

function runFixture(fixtureId: string): { fixture: GoldenFixtureFile; result: SearchResult } {
  const fixture = loadFixture(fixtureId);
  return { fixture, result: runSearch(fixture.scenario) };
}

describe("laneForEventKind", () => {
  it("puts DB events and DB_SNAPSHOT on the database lane", () => {
    for (const kind of ["DB_LINK", "DB_UNLINK", "DB_REPOINT", "DB_SNAPSHOT"] as const) {
      expect(laneForEventKind(kind)).toBe("database");
    }
  });

  it("puts Blob events and BLOB_SNAPSHOT on the Blob lane", () => {
    for (const kind of [
      "BLOB_PUT",
      "BLOB_DELETE",
      "BLOB_PUT_NEW",
      "BLOB_DELETE_OLD",
      "BLOB_SNAPSHOT",
    ] as const) {
      expect(laneForEventKind(kind)).toBe("blob");
    }
  });

  it("covers all 9 event kinds", () => {
    const kinds: readonly EventKind[] = [
      "BLOB_PUT",
      "DB_LINK",
      "DB_UNLINK",
      "BLOB_DELETE",
      "BLOB_PUT_NEW",
      "DB_REPOINT",
      "BLOB_DELETE_OLD",
      "DB_SNAPSHOT",
      "BLOB_SNAPSHOT",
    ];
    expect(kinds).toHaveLength(9);
    for (const kind of kinds) {
      expect(["database", "blob"]).toContain(laneForEventKind(kind));
    }
  });
});

describe("buildDisplaySequence", () => {
  it("U01 shows the shortest counterexample (scenario A, orphan Blob)", () => {
    const { fixture, result } = runFixture("U01");
    const sequence = buildDisplaySequence(fixture.scenario, result);
    expect(sequence.isCounterexample).toBe(true);
    expect([...sequence.eventIds]).toEqual(fixture.expectedCounterexample);
    expect(sequence.eventIds).toHaveLength(3);
  });

  it("U07 shows its shortest counterexample (scenario B)", () => {
    const { fixture, result } = runFixture("U07");
    const sequence = buildDisplaySequence(fixture.scenario, result);
    expect(sequence.isCounterexample).toBe(true);
    expect([...sequence.eventIds]).toEqual([
      "upload-B:BLOB_PUT",
      "BLOB_SNAPSHOT",
      "DB_SNAPSHOT",
    ]);
  });

  it("G12 (SAFE, 10 events) shows the canonical full sequence, snapshots last", () => {
    const { fixture, result } = runFixture("G12");
    const sequence = buildDisplaySequence(fixture.scenario, result);
    expect(sequence.isCounterexample).toBe(false);
    expect(sequence.eventIds).toHaveLength(10);
    // 8 data events in scenario order, then the two snapshots (PAUSE_WRITES:
    // DB_SNAPSHOT before BLOB_SNAPSHOT).
    expect(sequence.eventIds.slice(0, 8)).toEqual([
      "upload-A:BLOB_PUT",
      "upload-A:DB_LINK",
      "upload-B:BLOB_PUT",
      "upload-B:DB_LINK",
      "upload-C:BLOB_PUT",
      "upload-C:DB_LINK",
      "upload-D:BLOB_PUT",
      "upload-D:DB_LINK",
    ]);
    expect(sequence.eventIds.slice(8)).toEqual(["DB_SNAPSHOT", "BLOB_SNAPSHOT"]);
  });

  it("G01 (idle, SAFE) shows only the two snapshot events", () => {
    const { fixture, result } = runFixture("G01");
    const sequence = buildDisplaySequence(fixture.scenario, result);
    expect(sequence.isCounterexample).toBe(false);
    expect([...sequence.eventIds]).toEqual(["DB_SNAPSHOT", "BLOB_SNAPSHOT"]);
  });
});

describe("buildTimelineModel positions", () => {
  it("U01: both lanes shown, events evenly spaced, both snapshots positioned", () => {
    const { fixture, result } = runFixture("U01");
    const model = buildTimelineModel(fixture.scenario, result, 0);
    expect(model.items).toHaveLength(3);
    expect(model.totalEvents).toBe(4);
    // x = 8 + (index + 0.5) / 3 * 84 (inset band, see timeline-layout.ts)
    expect(model.items[0]?.xPercent).toBeCloseTo(22, 3);
    expect(model.items[1]?.xPercent).toBeCloseTo(50, 3);
    expect(model.items[2]?.xPercent).toBeCloseTo(78, 3);
    // DB_SNAPSHOT (index 0) on the database lane, BLOB_SNAPSHOT (index 2)
    // and BLOB_PUT (index 1) on the Blob lane.
    expect(model.databaseItems.map((item) => item.eventId)).toEqual(["DB_SNAPSHOT"]);
    expect(model.blobItems.map((item) => item.eventId)).toEqual([
      "upload-A:BLOB_PUT",
      "BLOB_SNAPSHOT",
    ]);
    expect(model.snapshotMarkers).toHaveLength(2);
    expect(model.snapshotMarkers[0]?.eventId).toBe("DB_SNAPSHOT");
    expect(model.snapshotMarkers[0]?.xPercent).toBeCloseTo(22, 3);
    expect(model.snapshotMarkers[1]?.eventId).toBe("BLOB_SNAPSHOT");
    expect(model.snapshotMarkers[1]?.xPercent).toBeCloseTo(78, 3);
  });

  it("G12: first/last centres stay inside the lane (inset band, no edge clipping)", () => {
    const { fixture, result } = runFixture("G12");
    const model = buildTimelineModel(fixture.scenario, result, 0);
    expect(model.items[0]?.xPercent).toBeCloseTo(12.2, 3);
    expect(model.items[9]?.xPercent).toBeCloseTo(87.8, 3);
  });

  it("U07: BLOB_SNAPSHOT sits between BLOB_PUT and DB_SNAPSHOT", () => {
    const { fixture, result } = runFixture("U07");
    const model = buildTimelineModel(fixture.scenario, result, 0);
    expect(model.databaseItems.map((item) => item.eventId)).toEqual(["DB_SNAPSHOT"]);
    expect(model.blobItems.map((item) => item.eventId)).toEqual([
      "upload-B:BLOB_PUT",
      "BLOB_SNAPSHOT",
    ]);
    const blobSnapshot = model.snapshotMarkers.find(
      (marker) => marker.eventId === "BLOB_SNAPSHOT",
    );
    expect(blobSnapshot?.xPercent).toBeCloseTo(50, 3);
  });

  it("replayStep marks done / current / future events", () => {
    const { fixture, result } = runFixture("U01");
    const model = buildTimelineModel(fixture.scenario, result, 1);
    expect(model.items[0]?.replayState).toBe("done");
    expect(model.items[1]?.replayState).toBe("current");
    expect(model.items[2]?.replayState).toBe("future");
    const end = buildTimelineModel(fixture.scenario, result, 3);
    expect(end.items.every((item) => item.replayState === "done")).toBe(true);
  });
});

describe("diagnostic markers — orphan vs dangling are visually distinct", () => {
  it("U01 ORPHAN_BLOB is amber with the 孤立对象 label", () => {
    const { result } = runFixture("U01");
    const markers = diagnosticMarkers(result);
    const orphan = markers.find((marker) => marker.code === "ORPHAN_BLOB");
    expect(orphan).toBeDefined();
    expect(orphan?.color).toBe("#d97706");
    expect(orphan?.labelZh).toBe("孤立对象");
    expect(orphan?.kind).toBe("orphan");
    expect(orphan?.explanationZh).toContain("孤立对象");
  });

  it("the §9.3 delete-cross-snapshot sequence yields a real DANGLING_REFERENCE (red)", () => {
    // The shortest U02 counterexample is an orphan case (frozen fixture);
    // the 4-event §9.3 sequence is the dangling one. evaluateSequence is
    // the frozen core's own judge of a concrete sequence.
    const { fixture } = runFixture("U02");
    const evaluation = evaluateSequence(fixture.scenario, [
      "DB_SNAPSHOT",
      "delete-C:DB_UNLINK",
      "delete-C:BLOB_DELETE",
      "BLOB_SNAPSHOT",
    ]);
    expect(evaluation.valid).toBe(true);
    expect(evaluation.consistent).toBe(false);
    expect(evaluation.diagnostics.map((d) => d.code)).toContain("DANGLING_REFERENCE");
    const danglingResult = buildSearchResult({
      scenarioId: fixture.scenario.scenarioId,
      strategy: fixture.scenario.strategy,
      verdict: "UNSAFE_WITHIN_BOUND",
      eventCount: 4,
      counterexample: [
        "DB_SNAPSHOT",
        "delete-C:DB_UNLINK",
        "delete-C:BLOB_DELETE",
        "BLOB_SNAPSHOT",
      ],
      diagnostics: evaluation.diagnostics,
      databaseSnapshot: evaluation.databaseSnapshot ?? {},
      blobSnapshot: evaluation.blobSnapshot ?? {},
    });
    const markers = diagnosticMarkers(danglingResult);
    const dangling = markers.find((marker) => marker.code === "DANGLING_REFERENCE");
    expect(dangling).toBeDefined();
    expect(dangling?.color).toBe("#dc2626");
    expect(dangling?.labelZh).toBe("悬空引用");
    expect(dangling?.kind).toBe("dangling");
    // The two inconsistency kinds differ in colour AND label AND kind.
    const orphan = diagnosticMarkers(runFixture("U01").result).find(
      (marker) => marker.code === "ORPHAN_BLOB",
    );
    expect(dangling?.color).not.toBe(orphan?.color);
    expect(dangling?.labelZh).not.toBe(orphan?.labelZh);
    expect(dangling?.kind).not.toBe(orphan?.kind);
  });

  it("all 6 diagnostic codes have a label, explanation and colour", () => {
    const codes = Object.keys(DIAGNOSTIC_EXPLANATIONS) as (
      | "DANGLING_REFERENCE"
      | "ORPHAN_BLOB"
      | "GENERATION_MISMATCH"
      | "DIGEST_MISMATCH"
      | "IN_FLIGHT_OPERATION"
      | "NO_COMMON_BOUNDARY"
    )[];
    expect(codes).toHaveLength(6);
    for (const code of codes) {
      expect(DIAGNOSTIC_LABELS[code].length).toBeGreaterThan(0);
      expect(DIAGNOSTIC_EXPLANATIONS[code].length).toBeGreaterThan(0);
      expect(DIAGNOSTIC_COLORS[code]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("snapshotDiff", () => {
  it("U01: Blob snapshot holds A-v1, database snapshot does not — orphan row", () => {
    const { result } = runFixture("U01");
    const diff = snapshotDiff(result);
    expect(diff).toHaveLength(1);
    expect(diff[0]?.status).toBe("孤立对象");
    expect(diff[0]?.kind).toBe("orphan");
    expect(diff[0]?.inDatabase).toBe(false);
    expect(diff[0]?.inBlob).toBe(true);
    expect(diff[0]?.codes).toContain("ORPHAN_BLOB");
  });

  it("dangling row: database references C-v1, Blob snapshot is empty", () => {
    const { fixture } = runFixture("U02");
    const evaluation = evaluateSequence(fixture.scenario, [
      "DB_SNAPSHOT",
      "delete-C:DB_UNLINK",
      "delete-C:BLOB_DELETE",
      "BLOB_SNAPSHOT",
    ]);
    const danglingResult = buildSearchResult({
      scenarioId: fixture.scenario.scenarioId,
      strategy: fixture.scenario.strategy,
      verdict: "UNSAFE_WITHIN_BOUND",
      eventCount: 4,
      counterexample: [
        "DB_SNAPSHOT",
        "delete-C:DB_UNLINK",
        "delete-C:BLOB_DELETE",
        "BLOB_SNAPSHOT",
      ],
      diagnostics: evaluation.diagnostics,
      databaseSnapshot: evaluation.databaseSnapshot ?? {},
      blobSnapshot: evaluation.blobSnapshot ?? {},
    });
    const diff = snapshotDiff(danglingResult);
    expect(diff).toHaveLength(1);
    expect(diff[0]?.status).toBe("悬空引用");
    expect(diff[0]?.kind).toBe("dangling");
    expect(diff[0]?.inDatabase).toBe(true);
    expect(diff[0]?.inBlob).toBe(false);
    expect(diff[0]?.codes).toContain("DANGLING_REFERENCE");
  });

  it("G02 (SAFE): the captured pair matches — 一致 row", () => {
    const { result } = runFixture("G02");
    const diff = snapshotDiff(result);
    expect(diff).toHaveLength(1);
    expect(diff[0]?.status).toBe("一致");
    expect(diff[0]?.kind).toBe("ok");
  });
});
