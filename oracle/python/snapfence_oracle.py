#!/usr/bin/env python3
"""SnapFence independent Oracle (P030-T006).

A reference calculator for the 24 Golden scenarios, written independently
from the production TypeScript BFS:

* It parses the Golden fixture files itself (only the ``scenario`` key of
  each fixture is an input; the ``expected*`` fields are NEVER read by this
  module -- they are the test oracle inputs used by the test suite to
  compare against, not values this module may see).
* It enumerates legal event interleavings by depth-first search over
  topological orders (the production implementation uses breadth-first
  search; this module uses no BFS, no queue, no visited-key dedup).
* It maintains database state and Blob state independently, checks
  complete-operation boundaries independently, computes the consistency
  verdict independently, and computes the shortest-counterexample length
  independently (minimum over ALL terminal prefixes, tracked during the
  enumeration).
* It reads no production TypeScript module, runs no Node process, spawns
  no child process, and reads no production test output.  Pure Python
  standard library only (json, sys, pathlib, importlib).

Search semantics (derived from PROJECT_BOOK SS3-SS4 + MODEL_CONTRACT +
ADR-001 + ADR-002 + T005_GOLDEN_DERIVATIONS.md):

* A path is a prefix of a legal topological order.  It is TERMINAL once
  both snapshot events have executed (L-10 prefix convention: the
  counterexample ends at the second snapshot; the path is not extended
  beyond it).  A terminal path is inconsistent iff its snapshot pair
  equals no legal operation boundary (value-first, ADR-002).
* Candidates are always considered in fixed lexicographic event-ID order,
  so the enumeration is deterministic; among shortest counterexamples the
  first found in that order is reported.
* Candidate eligibility enforces, all at once: the per-operation template
  order (an event is eligible only when all earlier events of its
  operation have executed); the strategy snapshot order (DB_FIRST:
  DB_SNAPSHOT before BLOB_SNAPSHOT; FILE_FIRST: the reverse);
  ADR-001 snapshotsAfter (a snapshot is eligible only when every listed
  operation is COMPLETED); PAUSE_WRITES (a snapshot is eligible only when
  no operation is in flight, and no data event may execute between the
  two snapshots); and each event's own precondition (e.g. BLOB_PUT_NEW
  needs the file to exist in D at that moment).

Verdicts: SAFE_WITHIN_BOUND (every terminal path consistent),
UNSAFE_WITHIN_BOUND (some terminal path inconsistent, with the shortest
counterexample), INCONCLUSIVE_LIMIT (the scenario exceeds the frozen
10-event bound, or the DFS node cap is hit -- never silently SAFE),
INVALID_INPUT (illegal scenario: unknown strategy, duplicate opId, unknown
snapshotsAfter opId, conflicting implied pre-state, illegal DAG, bad
operation shape, objectId containing "@").

Usage:
    python3 snapfence_oracle.py <fixture.json> [...]
    python3 snapfence_oracle.py --golden-dir <dir>   # *.json except manifest
    python3 snapfence_oracle.py --self-check          # model self-check
Results are printed as JSON to stdout, one object per scenario.
Exit code is 0 when every scenario was computed (even UNSAFE); non-zero
only for Oracle errors (unreadable input, INVALID_INPUT, INCONCLUSIVE).
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_MODEL_PATH = _HERE / "independent-model.py"


def _load_model():
    spec = importlib.util.spec_from_file_location(
        "snapfence_independent_model", _MODEL_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


model = _load_model()

# A generous cap so a pathological scenario can never hang the Oracle;
# hitting it reports INCONCLUSIVE_LIMIT, never SAFE.  The largest Golden
# scenario (G12, 10 events) visits only a few thousand nodes.
NODE_CAP = 200_000


# ---------------------------------------------------------------------------
# Scenario validation (PROJECT_BOOK SS8.6)
# ---------------------------------------------------------------------------

def validate_scenario(scenario):
    """Return (issues, oversize).

    ``issues`` is a list of (code, message); non-empty means INVALID_INPUT.
    ``oversize`` is True when the scenario exceeds the bounded search size
    (total events > scenario maxEvents, or > frozen MAX_EVENTS) -- that is
    INCONCLUSIVE_LIMIT, not INVALID_INPUT.
    """
    issues = []
    if not isinstance(scenario, dict):
        return [("INVALID_SCENARIO", "scenario is not an object")], False

    strategy = scenario.get("strategy")
    if strategy not in model.STRATEGIES:
        issues.append(("UNKNOWN_STRATEGY", "unknown strategy %r" % (strategy,)))

    operations = scenario.get("operations")
    if not isinstance(operations, list):
        issues.append(("INVALID_OPERATIONS", "operations is not a list"))
        return issues, False

    seen_op_ids = set()
    for op in operations:
        if not isinstance(op, dict):
            issues.append(("INVALID_OPERATION", "operation is not an object: %r" % (op,)))
            continue
        op_id = op.get("opId")
        if not op_id or not isinstance(op_id, str):
            issues.append(("MISSING_OP_ID", "operation without opId: %r" % (op,)))
            continue
        if op_id in seen_op_ids:
            issues.append(("DUPLICATE_OP_ID", "duplicate opId %r" % (op_id,)))
        seen_op_ids.add(op_id)
        kind = op.get("kind")
        if kind not in model.OPERATION_TEMPLATES:
            issues.append(("INVALID_OPERATION_KIND",
                           "op %r has unknown kind %r" % (op_id, kind)))
            continue
        if not op.get("fileId") or not isinstance(op.get("fileId"), str):
            issues.append(("MISSING_FILE_ID", "op %r has no fileId" % (op_id,)))
        for field in ("objectId", "digest") if kind == "UPLOAD" else ():
            if not op.get(field):
                issues.append(("MISSING_FIELD",
                               "op %r (%s) lacks %s" % (op_id, kind, field)))
        if kind == "DELETE" and not op.get("objectId"):
            issues.append(("MISSING_FIELD", "op %r (DELETE) lacks objectId" % (op_id,)))
        if kind == "UPDATE":
            for field in ("objectId", "oldObjectId", "digest"):
                if not op.get(field):
                    issues.append(("MISSING_FIELD",
                                   "op %r (UPDATE) lacks %s" % (op_id, field)))
        for oid_field in ("objectId", "oldObjectId"):
            oid = op.get(oid_field)
            if isinstance(oid, str) and "@" in oid:
                issues.append(("INVALID_OBJECT_ID",
                               "op %r: %s %r contains '@' (I-03)" % (op_id, oid_field, oid)))

    # ADR-001: every snapshotsAfter opId must exist in operations.
    snapshots_after = scenario.get("snapshotsAfter") or []
    if not isinstance(snapshots_after, list):
        issues.append(("INVALID_SNAPSHOTS_AFTER", "snapshotsAfter is not a list"))
        snapshots_after = []
    for op_id in snapshots_after:
        if op_id not in seen_op_ids:
            issues.append(("UNKNOWN_SNAPSHOTS_AFTER_OP",
                           "snapshotsAfter lists unknown opId %r" % (op_id,)))

    # Implied pre-state must be contradiction-free (I-02).
    _db0, _blob0, prestate_issues = model.derive_initial_state(operations)
    issues.extend(prestate_issues)

    # The event dependency DAG must be legal (SS8.6).
    event_ids = model.all_event_ids(
        [op for op in operations if isinstance(op, dict)
         and op.get("kind") in model.OPERATION_TEMPLATES])
    edges = model.scenario_dag_edges(
        [op for op in operations if isinstance(op, dict)
         and op.get("kind") in model.OPERATION_TEMPLATES],
        strategy if strategy in model.STRATEGIES else "DB_FIRST")
    issues.extend(model.validate_event_dag(event_ids, edges))

    # Duplicate event IDs are impossible once opIds are unique (event IDs
    # are "<opId>:<KIND>"), but check anyway -- defence in depth.
    if len(event_ids) != len(set(event_ids)):
        issues.append(("DUPLICATE_EVENT_ID", "two operations produce the same event ID"))

    max_events = scenario.get("maxEvents")
    total_events = len(event_ids)
    oversize = False
    if isinstance(max_events, int) and not isinstance(max_events, bool):
        if total_events > max_events or total_events > model.MAX_EVENTS:
            oversize = True
    elif total_events > model.MAX_EVENTS:
        oversize = True
    return issues, oversize


# ---------------------------------------------------------------------------
# DFS enumeration
# ---------------------------------------------------------------------------

class _Search:
    """Depth-first enumeration of legal topological-order prefixes.

    ``best`` holds the shortest inconsistent terminal prefix found so far:
    (length, event-id list, db snapshot, blob snapshot, in-flight opIds at
    the two captures).  Every terminal prefix is visited, so the minimum
    is exact; ties keep the first found in lexicographic candidate order.
    """

    def __init__(self, scenario, initial_db, initial_blob, boundaries):
        self.scenario = scenario
        self.strategy = scenario["strategy"]
        self.snapshots_after = list(dict.fromkeys(scenario.get("snapshotsAfter") or []))
        self.ops = scenario["operations"]
        self.by_id = {op["opId"]: op for op in self.ops}
        self.templates = {op["opId"]: model.OPERATION_TEMPLATES[op["kind"]]
                          for op in self.ops}
        self.initial_db = initial_db
        self.initial_blob = initial_blob
        self.boundaries = boundaries
        self.best = None
        self.terminals_checked = 0
        self.nodes_visited = 0
        self.capped = False

    # -- candidate eligibility -------------------------------------------
    def _op_status(self, executed):
        status = {}
        for op in self.ops:
            ids = model.operation_event_ids(op)
            done = sum(1 for eid in ids if eid in executed)
            status[op["opId"]] = ("COMPLETED" if done == len(ids)
                                  else "IN_FLIGHT" if done > 0
                                  else "NOT_STARTED")
        return status

    def _candidates(self, executed, db, blob, op_ctx):
        """Eligible next event IDs, in fixed lexicographic order."""
        status = self._op_status(executed)
        db_taken = model.DB_SNAPSHOT in executed
        blob_taken = model.BLOB_SNAPSHOT in executed
        one_snapshot_taken = db_taken != blob_taken
        in_flight = [op_id for op_id, st in status.items() if st == "IN_FLIGHT"]
        snapshots_ready = all(status[op_id] == "COMPLETED"
                              for op_id in self.snapshots_after)

        cands = []
        # Data events.  Only PAUSE_WRITES forbids data events between the
        # two snapshots (SS3.3); under DB_FIRST / FILE_FIRST writes may
        # continue between the snapshots.
        if not (self.strategy == "PAUSE_WRITES" and one_snapshot_taken):
            for op in self.ops:
                ids = model.operation_event_ids(op)
                nxt = next((eid for eid in ids if eid not in executed), None)
                if nxt is None:
                    continue
                kind = nxt.split(":", 1)[1]
                # Precondition dry-run: an event whose precondition fails
                # in this state simply cannot execute in this interleaving.
                if model.apply_event(db, blob, op, kind, op_ctx) is not None:
                    cands.append(nxt)
        # Snapshot events.
        for snap in model.SNAPSHOT_EVENTS:
            if snap in executed:
                continue
            if not snapshots_ready:
                continue
            if self.strategy == "PAUSE_WRITES" and in_flight:
                continue
            if self.strategy == "DB_FIRST" and snap == model.BLOB_SNAPSHOT and not db_taken:
                continue
            if self.strategy == "FILE_FIRST" and snap == model.DB_SNAPSHOT and not blob_taken:
                continue
            cands.append(snap)
        return sorted(cands)

    # -- recursion ---------------------------------------------------------
    def run(self):
        self._dfs(frozenset(), dict(self.initial_db), dict(self.initial_blob),
                  {}, [], {}, {})
        return self.best

    def _dfs(self, executed, db, blob, op_ctx, path, captures, capture_in_flight):
        if self.capped:
            return
        self.nodes_visited += 1
        if self.nodes_visited > NODE_CAP:
            self.capped = True
            return
        if model.DB_SNAPSHOT in executed and model.BLOB_SNAPSHOT in executed:
            # Terminal prefix (L-10): check the pair, do not extend.
            self.terminals_checked += 1
            db_snap, blob_snap = captures[model.DB_SNAPSHOT], captures[model.BLOB_SNAPSHOT]
            if not model.is_consistent(db_snap, blob_snap, self.boundaries):
                in_flight = sorted(set(capture_in_flight[model.DB_SNAPSHOT])
                                   | set(capture_in_flight[model.BLOB_SNAPSHOT]))
                if self.best is None or len(path) < self.best[0]:
                    self.best = (len(path), list(path), db_snap, blob_snap, in_flight)
            return
        for eid in self._candidates(executed, db, blob, op_ctx):
            if eid in model.SNAPSHOT_EVENTS:
                new_db, new_blob, new_ctx = db, blob, op_ctx
                new_captures = dict(captures)
                new_captures[eid] = (dict(db) if eid == model.DB_SNAPSHOT
                                     else dict(blob))
                new_in_flight = dict(capture_in_flight)
                status = self._op_status(executed)
                new_in_flight[eid] = [op_id for op_id, st in status.items()
                                      if st == "IN_FLIGHT"]
                self._dfs(executed | {eid}, new_db, new_blob, new_ctx,
                          path + [eid], new_captures, new_in_flight)
            else:
                op_id, kind = eid.split(":", 1)
                applied = model.apply_event(db, blob, self.by_id[op_id], kind, op_ctx)
                if applied is None:
                    continue
                new_db, new_blob, new_ctx = applied
                self._dfs(executed | {eid}, new_db, new_blob, new_ctx,
                          path + [eid], captures, capture_in_flight)
            if self.capped:
                return


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

def run_oracle(scenario):
    """Run the Oracle on one scenario dict. Returns a result dict."""
    scenario_id = scenario.get("scenarioId", "?")
    issues, oversize = validate_scenario(scenario)
    if issues:
        return {
            "scenarioId": scenario_id,
            "strategy": scenario.get("strategy"),
            "verdict": "INVALID_INPUT",
            "counterexample": [],
            "counterexampleLength": 0,
            "diagnostics": [],
            "databaseSnapshot": None,
            "blobSnapshot": None,
            "terminalsChecked": 0,
            "nodesVisited": 0,
            "issues": ["%s: %s" % (code, msg) for code, msg in issues],
        }
    if oversize:
        return {
            "scenarioId": scenario_id,
            "strategy": scenario.get("strategy"),
            "verdict": "INCONCLUSIVE_LIMIT",
            "counterexample": [],
            "counterexampleLength": 0,
            "diagnostics": [],
            "databaseSnapshot": None,
            "blobSnapshot": None,
            "terminalsChecked": 0,
            "nodesVisited": 0,
            "issues": ["event count exceeds the bounded search size"],
        }

    initial_db, initial_blob, _ = model.derive_initial_state(scenario["operations"])
    boundaries = model.compute_boundaries(scenario["operations"], initial_db, initial_blob)
    search = _Search(scenario, initial_db, initial_blob, boundaries)
    best = search.run()
    if search.capped:
        return {
            "scenarioId": scenario_id,
            "strategy": scenario.get("strategy"),
            "verdict": "INCONCLUSIVE_LIMIT",
            "counterexample": [],
            "counterexampleLength": 0,
            "diagnostics": [],
            "databaseSnapshot": None,
            "blobSnapshot": None,
            "terminalsChecked": search.terminals_checked,
            "nodesVisited": search.nodes_visited,
            "issues": ["DFS node cap %d exceeded" % NODE_CAP],
        }
    if best is None:
        return {
            "scenarioId": scenario_id,
            "strategy": scenario.get("strategy"),
            "verdict": "SAFE_WITHIN_BOUND",
            "counterexample": [],
            "counterexampleLength": 0,
            "diagnostics": [],
            "databaseSnapshot": None,
            "blobSnapshot": None,
            "terminalsChecked": search.terminals_checked,
            "nodesVisited": search.nodes_visited,
            "issues": [],
        }
    length, sequence, db_snap, blob_snap, in_flight = best
    diagnostics = model.diagnose(db_snap, blob_snap, boundaries, in_flight)
    return {
        "scenarioId": scenario_id,
        "strategy": scenario.get("strategy"),
        "verdict": "UNSAFE_WITHIN_BOUND",
        "counterexample": sequence,
        "counterexampleLength": length,
        "diagnostics": diagnostics,
        "databaseSnapshot": {fid: {"objectId": r[0], "generation": r[1], "digest": r[2]}
                             for fid, r in sorted(db_snap.items())},
        "blobSnapshot": {model.blob_key(oid, gen): digest
                         for (oid, gen), digest in sorted(blob_snap.items())},
        "terminalsChecked": search.terminals_checked,
        "nodesVisited": search.nodes_visited,
        "issues": [],
    }


def load_fixture(path):
    """Parse one Golden fixture file. Only the ``scenario`` key is read;
    the ``expected*`` fields are deliberately never touched here."""
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if "scenario" not in data:
        raise ValueError("%s: no 'scenario' key" % (path,))
    return data["scenario"]


def main(argv):
    args = [a for a in argv if a != "--self-check"]
    if "--self-check" in argv:
        model._self_check()
        return 0
    paths = []
    i = 0
    while i < len(args):
        if args[i] == "--golden-dir":
            i += 1
            if i >= len(args):
                print("missing directory after --golden-dir", file=sys.stderr)
                return 2
            directory = Path(args[i])
            paths.extend(sorted(p for p in directory.glob("*.json")
                                if p.name != "manifest.json"))
        else:
            paths.append(Path(args[i]))
        i += 1
    if not paths:
        print("usage: snapfence_oracle.py [--golden-dir DIR | fixture.json ...]",
              file=sys.stderr)
        return 2
    results = []
    failed = False
    for path in paths:
        try:
            result = run_oracle(load_fixture(path))
        except (OSError, ValueError, KeyError) as exc:
            print("%s: %s" % (path, exc), file=sys.stderr)
            failed = True
            continue
        result = {"fixture": path.stem, **result}
        results.append(result)
        if result["verdict"] in ("INVALID_INPUT", "INCONCLUSIVE_LIMIT"):
            failed = True
    print(json.dumps(results, indent=2, sort_keys=True))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
