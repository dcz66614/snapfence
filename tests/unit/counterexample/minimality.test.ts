/**
 * SnapFence (P030) — T004 minimality proofs: the BFS counterexample is
 * provably shortest (§4.6). These tests do NOT trust the BFS layering
 * argument: they brute-force every permutation of a scenario's events,
 * replay each legal prefix ending at the second snapshot through
 * evaluateSequence, and check (a) no inconsistent prefix shorter than
 * the BFS counterexample exists, and (b) among all inconsistent prefixes
 * of the minimal length, the BFS counterexample is the lexicographically
 * smallest. Scenarios are capped at 6 events (720 permutations) so the
 * exhaustive check stays cheap; the 10-event G12 shape is covered by the
 * BFS counts in T003, not by brute force here.
 */
import { describe, expect, it } from "vitest";
import type { Scenario } from "../../../src/core/model/types";
import { expandScenario } from "../../../src/core/events/event-types";
import {
  evaluateSequence,
  runSearch,
} from "../../../src/core/search/bfs";
import {
  deleteScenarioC,
  twoUploadScenario,
  updateScenario,
  uploadScenarioA,
  uploadScenarioB,
} from "../search/helpers";

/** All permutations of a list (brute-force oracle for small scenarios). */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length === 0) {
    return [[]];
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const head = items[i] as T;
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) {
      out.push([head, ...tail]);
    }
  }
  return out;
}

/**
 * Length of the shortest inconsistent prefix (ending at the second
 * snapshot) over ALL legal interleavings of a scenario, by exhaustive
 * permutation replay. Returns null when no inconsistent prefix exists.
 * Also returns every inconsistent prefix of that minimal length, so the
 * lexicographic tie-break can be checked independently of the BFS.
 */
function bruteForceShortestInconsistent(scenario: Scenario): {
  minLength: number | null;
  shortestPrefixes: readonly (readonly string[])[];
} {
  const eventIds = expandScenario(scenario).allEvents.map((e) => e.eventId);
  let minLength: number | null = null;
  const shortest: string[][] = [];
  for (const order of permutations(eventIds)) {
    // Every prefix ending at the second snapshot event.
    let snapshotsSeen = 0;
    for (let end = 1; end <= order.length; end++) {
      const prefix = order.slice(0, end);
      const last = prefix[prefix.length - 1] as string;
      if (last === "DB_SNAPSHOT" || last === "BLOB_SNAPSHOT") {
        snapshotsSeen += 1;
      }
      if (snapshotsSeen !== 2) {
        continue;
      }
      const evaluation = evaluateSequence(scenario, prefix);
      if (!evaluation.valid || evaluation.consistent !== false) {
        // Only the FIRST prefix ending at the second snapshot matters
        // per order (later prefixes extend past the terminal state);
        // but keep scanning: a longer prefix of the same order is a
        // different (longer) terminal path only if snapshots repeat,
        // which they cannot — so break after the first such prefix.
        break;
      }
      if (minLength === null || prefix.length < minLength) {
        minLength = prefix.length;
        shortest.length = 0;
        shortest.push([...prefix]);
      } else if (prefix.length === minLength) {
        const key = prefix.join(",");
        if (!shortest.some((p) => p.join(",") === key)) {
          shortest.push([...prefix]);
        }
      }
      break;
    }
  }
  return { minLength, shortestPrefixes: shortest };
}

function compareEventSequences(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] as string;
    const y = b[i] as string;
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return a.length - b.length;
}

describe("minimality — no shorter inconsistent prefix exists (§4.6)", () => {
  it.each([
    ["scenario A (DB_FIRST upload)", uploadScenarioA()],
    ["scenario B (FILE_FIRST upload)", uploadScenarioB()],
    ["scenario C (DB_FIRST delete)", deleteScenarioC()],
    ["UPDATE (DB_FIRST)", updateScenario("DB_FIRST")],
    ["two uploads (DB_FIRST)", twoUploadScenario("DB_FIRST")],
  ])("%s: BFS counterexample length equals the exhaustive minimum", (_name, scenario) => {
    const bfs = runSearch(scenario);
    expect(bfs.verdict).toBe("UNSAFE_WITHIN_BOUND");
    const brute = bruteForceShortestInconsistent(scenario);
    expect(brute.minLength).not.toBeNull();
    expect(bfs.counterexampleLength).toBe(brute.minLength);
    // Explicitly: no inconsistent prefix of any shorter length exists.
    expect(brute.shortestPrefixes.every((p) => p.length === brute.minLength)).toBe(true);
  });

  it("scenario A: the exhaustive minimum is 3, and length-2 prefixes are all consistent", () => {
    const brute = bruteForceShortestInconsistent(uploadScenarioA());
    expect(brute.minLength).toBe(3);
    // The only length-2 prefix ending at the second snapshot is the two
    // snapshots back to back on the initial state — consistent.
    const evaluation = evaluateSequence(uploadScenarioA(), ["DB_SNAPSHOT", "BLOB_SNAPSHOT"]);
    expect(evaluation.valid).toBe(true);
    expect(evaluation.consistent).toBe(true);
  });
});

describe("tie-break — the BFS counterexample is the lexicographically smallest shortest prefix (§4.6)", () => {
  it.each([
    ["scenario A", uploadScenarioA()],
    ["scenario B", uploadScenarioB()],
    ["scenario C", deleteScenarioC()],
    ["two uploads (DB_FIRST)", twoUploadScenario("DB_FIRST")],
  ])("%s: BFS counterexample is the lexicographic minimum of the shortest prefixes", (_name, scenario) => {
    const bfs = runSearch(scenario);
    const brute = bruteForceShortestInconsistent(scenario);
    expect(brute.minLength).toBe(bfs.counterexampleLength);
    const sorted = [...brute.shortestPrefixes].sort(compareEventSequences);
    expect(sorted.length).toBeGreaterThan(0);
    expect(bfs.counterexample).toEqual(sorted[0]);
  });

  it("two uploads: exactly four shortest prefixes exist; upload-A with DB_SNAPSHOT first wins", () => {
    const brute = bruteForceShortestInconsistent(twoUploadScenario("DB_FIRST"));
    expect(brute.minLength).toBe(3);
    // Four length-3 inconsistent prefixes: for each upload (A or B), the
    // BLOB_PUT may run either before the DB snapshot or between the two
    // snapshots — either way the Blob snapshot holds an unreferenced
    // version while the DB snapshot does not reference it.
    expect(brute.shortestPrefixes).toHaveLength(4);
    expect(brute.shortestPrefixes.map((p) => [...p]).sort(compareEventSequences)).toEqual([
      ["DB_SNAPSHOT", "upload-A:BLOB_PUT", "BLOB_SNAPSHOT"],
      ["DB_SNAPSHOT", "upload-B:BLOB_PUT", "BLOB_SNAPSHOT"],
      ["upload-A:BLOB_PUT", "DB_SNAPSHOT", "BLOB_SNAPSHOT"],
      ["upload-B:BLOB_PUT", "DB_SNAPSHOT", "BLOB_SNAPSHOT"],
    ]);
    expect(runSearch(twoUploadScenario("DB_FIRST")).counterexample).toEqual([
      "DB_SNAPSHOT",
      "upload-A:BLOB_PUT",
      "BLOB_SNAPSHOT",
    ]);
  });
});
