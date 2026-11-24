/**
 * SnapFence (P030) — event dependency DAG construction + cycle detection. T002.
 *
 * Authority: PROJECT_BOOK.md §4.5 (event dependency DAG; candidates processed
 * in fixed event-ID order), §8.6 (dependencies must form a legal DAG, no
 * cycles), §3.3 (strategy snapshot-order constraints).
 * Inputs (frozen, read-only): src/core/model/scenario.ts
 * (OPERATION_TEMPLATES, STRATEGY_SNAPSHOT_ORDER); event-types.ts (this task).
 *
 * Rules for this file:
 * - TypeScript strict mode; `any` is forbidden.
 * - All functions are pure and deterministic: no randomness, no wall-clock,
 *   no mutation of inputs. Neighbours and ready sets are always processed in
 *   lexicographic event-ID order so identical input yields identical output.
 * - A cycle is never silently resolved: `detectCycle` reports it and
 *   `topologicalOrder` returns null, so validators fail closed.
 */

import type { Scenario } from "../model/types";
import { STRATEGY_SNAPSHOT_ORDER, type SnapshotEventKind } from "../model/scenario";
import {
  BLOB_SNAPSHOT_EVENT_ID,
  DB_SNAPSHOT_EVENT_ID,
  eventIdFor,
  expandScenario,
  templateKindsFor,
  type SnapFenceEvent,
} from "./event-types";

// ---------------------------------------------------------------------------
// Graph shape
// ---------------------------------------------------------------------------

/** One directed dependency edge: `from` must execute before `to`. */
export interface DependencyEdge {
  from: string;
  to: string;
  /** Why the edge exists (template order, same-file chain, strategy order). */
  reason: string;
}

/**
 * The event dependency DAG of a scenario (or of an explicit event list).
 * `events` are in canonical order (scenario order, then snapshot events);
 * `edges` are deduplicated and sorted by (from, to) for determinism.
 */
export interface DependencyGraph {
  events: readonly SnapFenceEvent[];
  edges: readonly DependencyEdge[];
}

/** Look up an event in a graph by its ID, or undefined when absent. */
export function eventById(
  graph: DependencyGraph,
  eventId: string,
): SnapFenceEvent | undefined {
  for (const event of graph.events) {
    if (event.eventId === eventId) {
      return event;
    }
  }
  return undefined;
}

/** Event IDs that must execute before `eventId` (its direct prerequisites). */
export function prerequisitesOf(
  graph: DependencyGraph,
  eventId: string,
): readonly string[] {
  const prerequisites: string[] = [];
  for (const edge of graph.edges) {
    if (edge.to === eventId && !prerequisites.includes(edge.from)) {
      prerequisites.push(edge.from);
    }
  }
  return prerequisites.sort();
}

/** Event IDs that directly depend on `eventId`. */
export function dependentsOf(
  graph: DependencyGraph,
  eventId: string,
): readonly string[] {
  const dependents: string[] = [];
  for (const edge of graph.edges) {
    if (edge.from === eventId && !dependents.includes(edge.to)) {
      dependents.push(edge.to);
    }
  }
  return dependents.sort();
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

function dedupeAndSortEdges(edges: readonly DependencyEdge[]): readonly DependencyEdge[] {
  const seen = new Set<string>();
  const unique: DependencyEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.from}\u0000${edge.to}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(edge);
    }
  }
  unique.sort((a, b) =>
    a.from === b.from
      ? a.to < b.to
        ? -1
        : a.to > b.to
          ? 1
          : 0
      : a.from < b.from
        ? -1
        : 1,
  );
  return unique;
}

/**
 * Build a dependency graph from an explicit event list and edge list.
 * Edges that reference event IDs absent from the list are kept as-is (they
 * are reported by `validateEventGraph` in validate-events.ts); construction
 * itself never throws.
 */
export function buildGraph(
  events: readonly SnapFenceEvent[],
  edges: readonly DependencyEdge[],
): DependencyGraph {
  return { events, edges: dedupeAndSortEdges(edges) };
}

/**
 * Build the dependency DAG for one scenario. Edges:
 * 1. Template order — within each operation, each atomic event depends on
 *    the previous template event (UPLOAD: BLOB_PUT -> DB_LINK; DELETE:
 *    DB_UNLINK -> BLOB_DELETE; UPDATE: BLOB_PUT_NEW -> DB_REPOINT ->
 *    BLOB_DELETE_OLD).
 * 2. Same-file chains — operations sharing a fileId execute sequentially in
 *    scenario order: each operation's first event depends on the previous
 *    operation's last event for that file (e.g. an upload of file A must
 *    finish before a later delete of file A can start).
 * 3. Strategy snapshot order — DB_FIRST: DB_SNAPSHOT -> BLOB_SNAPSHOT;
 *    FILE_FIRST: BLOB_SNAPSHOT -> DB_SNAPSHOT; PAUSE_WRITES: no fixed
 *    order edge (its pause constraint is enforced by the search, T003).
 */
export function buildDependencyGraph(scenario: Scenario): DependencyGraph {
  const expansion = expandScenario(scenario);
  const edges: DependencyEdge[] = [];

  for (const operation of scenario.operations) {
    const kinds = templateKindsFor(operation);
    for (let i = 1; i < kinds.length; i++) {
      const fromKind = kinds[i - 1];
      const toKind = kinds[i];
      if (fromKind === undefined || toKind === undefined) {
        continue;
      }
      edges.push({
        from: eventIdFor(operation.opId, fromKind),
        to: eventIdFor(operation.opId, toKind),
        reason: `template order of operation ${operation.opId} (${operation.kind})`,
      });
    }
  }

  const lastEventByFile = new Map<string, string>();
  for (const operation of scenario.operations) {
    const kinds = templateKindsFor(operation);
    const firstKind = kinds[0];
    const lastKind = kinds[kinds.length - 1];
    if (firstKind === undefined || lastKind === undefined) {
      continue;
    }
    const previousLast = lastEventByFile.get(operation.fileId);
    if (previousLast !== undefined) {
      edges.push({
        from: previousLast,
        to: eventIdFor(operation.opId, firstKind),
        reason:
          `same-file chain for ${operation.fileId}: operation ${operation.opId} ` +
          `starts after the previous operation on this file finishes`,
      });
    }
    lastEventByFile.set(operation.fileId, eventIdFor(operation.opId, lastKind));
  }

  // Unknown strategies (only reachable from untyped callers; typed scenarios
  // are limited to the three literals) yield undefined here, not null: treat
  // them as "no fixed order" so graph construction stays total.
  const snapshotOrder: readonly [SnapshotEventKind, SnapshotEventKind] | null | undefined =
    STRATEGY_SNAPSHOT_ORDER[scenario.strategy];
  if (snapshotOrder !== null && snapshotOrder !== undefined) {
    edges.push({
      from: snapshotOrder[0] === "DB_SNAPSHOT" ? DB_SNAPSHOT_EVENT_ID : BLOB_SNAPSHOT_EVENT_ID,
      to: snapshotOrder[1] === "DB_SNAPSHOT" ? DB_SNAPSHOT_EVENT_ID : BLOB_SNAPSHOT_EVENT_ID,
      reason: `strategy ${scenario.strategy} snapshot order`,
    });
  }

  return buildGraph(expansion.allEvents, edges);
}

// ---------------------------------------------------------------------------
// Cycle detection — deterministic DFS, lexicographic neighbour order
// ---------------------------------------------------------------------------

/**
 * Detect a cycle in the graph. Returns the cycle as an ordered list of
 * event IDs, closed by repeating the first ID at the end
 * (e.g. ["a", "b", "a"]), or null when the graph is acyclic.
 * Deterministic: nodes are visited in graph order, neighbours in
 * lexicographic event-ID order, so the same cyclic graph always yields the
 * same reported cycle.
 */
export function detectCycle(graph: DependencyGraph): readonly string[] | null {
  const adjacency = new Map<string, readonly string[]>();
  for (const event of graph.events) {
    adjacency.set(event.eventId, dependentsOf(graph, event.eventId));
  }
  // Edges may reference IDs outside the event list; include them as nodes so
  // a cycle through an unknown ID is still detected, not silently dropped.
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.from)) {
      adjacency.set(edge.from, dependentsOf(graph, edge.from));
    }
    if (!adjacency.has(edge.to)) {
      adjacency.set(edge.to, dependentsOf(graph, edge.to));
    }
  }

  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (node: string): readonly string[] | null => {
    state.set(node, "visiting");
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const nextState = state.get(next);
      if (nextState === "visiting") {
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
      if (nextState === undefined) {
        const found = visit(next);
        if (found !== null) {
          return found;
        }
      }
    }
    stack.pop();
    state.set(node, "done");
    return null;
  };

  const nodes = [...adjacency.keys()].sort();
  for (const node of nodes) {
    if (state.get(node) === undefined) {
      const found = visit(node);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

/** True when the graph contains a dependency cycle. */
export function hasCycle(graph: DependencyGraph): boolean {
  return detectCycle(graph) !== null;
}

// ---------------------------------------------------------------------------
// Topological order — Kahn's algorithm, lexicographic tie-break
// ---------------------------------------------------------------------------

/**
 * Deterministic topological order of the graph's event IDs: Kahn's
 * algorithm with the ready set always processed in lexicographic event-ID
 * order (PROJECT_BOOK.md §4.5/§4.6 — fixed event-ID order). Returns null
 * when the graph contains a cycle (fail-closed: no partial order is
 * returned as if it were valid).
 */
export function topologicalOrder(graph: DependencyGraph): readonly string[] | null {
  if (hasCycle(graph)) {
    return null;
  }
  const inDegree = new Map<string, number>();
  for (const event of graph.events) {
    inDegree.set(event.eventId, 0);
  }
  for (const edge of graph.edges) {
    if (inDegree.has(edge.to)) {
      inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    }
  }
  const ready: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      ready.push(id);
    }
  }
  ready.sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const current = ready.shift();
    if (current === undefined) {
      break;
    }
    order.push(current);
    for (const next of dependentsOf(graph, current)) {
      if (!inDegree.has(next)) {
        continue;
      }
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) {
        ready.push(next);
        ready.sort();
      }
    }
  }
  if (order.length !== graph.events.length) {
    return null;
  }
  return order;
}
