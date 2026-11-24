#!/usr/bin/env python3
"""SnapFence independent model (P030-T006).

A self-contained statement of the SnapFence mathematical model, written
directly from PROJECT_BOOK.md SS3-SS4, docs/MODEL_CONTRACT.md (I-01..I-06),
ADR-001 (snapshot placement) and ADR-002 (value-first consistency) -- NOT
from the production TypeScript implementation.  It shares no code with the
production BFS: it defines the state components, the operation templates,
the event-application rules, the operation-boundary enumeration and the
value-first consistency check in plain Python (standard library only).

The Oracle driver (snapfence_oracle.py) loads this file with importlib and
uses it to enumerate legal interleavings by depth-first search.

State representation
--------------------
* Database state D: dict fileId -> (objectId, generation, digest).
* Blob state B: dict (objectId, generation) -> digest.
  (The frozen string key "<objectId>@<generation>" is only used when a
  state has to be serialised to JSON; internally the tuple key is used.)
* Operation status Q: per opId, one of NOT_STARTED / IN_FLIGHT / COMPLETED.

Operation templates (PROJECT_BOOK SS3.2, frozen)
-------------------------------------------------
* UPLOAD : BLOB_PUT -> DB_LINK
* DELETE : DB_UNLINK -> BLOB_DELETE
* UPDATE : BLOB_PUT_NEW -> DB_REPOINT -> BLOB_DELETE_OLD

Initial state (MODEL_CONTRACT I-01 / I-02)
-------------------------------------------
A Scenario carries no initial state.  A DELETE or UPDATE operation implies
its referenced file already exists before the scenario starts: the initial
database state contains fileId -> (objectId, generation 1, digest) and the
initial Blob state contains (objectId, 1) -> digest.  When the fixture
gives no digest for the pre-existing record (DELETE has none; UPDATE gives
only the *new* digest), this module derives one deterministically as
"fixture-digest-<fileId>-v1" -- the SAME value in both components, so the
implied pre-state is consistent by construction, exactly as I-02 requires.
The concrete derived string is an Oracle-local choice; only the equality
of the two components matters for any verdict, never the literal.

Generations (R-GEN-1 / R-GEN-2)
--------------------------------
* An UPLOAD creates its object version at generation 1.
* An UPDATE creates its new object version at old generation + 1, where the
  old generation is the generation of the reference current in D when
  BLOB_PUT_NEW executes (1 for an implied pre-existing record, or the
  generation created by an earlier UPLOAD of the same file).

Consistency (PROJECT_BOOK SS4.3 + ADR-002, value-first)
--------------------------------------------------------
A snapshot pair (D_s, B_s) is consistent IFF there exists a legal operation
boundary k with (D_s, B_s) == (D(k), B(k)).  A boundary is a state in which
every logical operation is either not started or fully completed.  The
four SS4.3 conditions (reference resolves, generation agrees, digest
agrees, no unreferenced Blob, no unfinished operation) are properties of
the boundary k, not of the moment a snapshot was taken.

IN_FLIGHT_OPERATION is therefore an explanatory diagnostic only: it is
emitted only for a value-INCONSISTENT pair, when a snapshot was captured
while an operation was in flight.  A value-consistent pair carries zero
diagnostics, even if a snapshot happened to be taken mid-operation
(ADR-002; e.g. the all-empty pair [BLOB_SNAPSHOT, BLOB_PUT, DB_SNAPSHOT]
is consistent because it equals the initial boundary).

Run as a script (`python3 independent-model.py`) for a self-check of the
templates, the initial-state derivation and the boundary enumeration on a
small built-in scenario.  No file I/O, no subprocesses, no imports beyond
the standard library.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Frozen constants (PROJECT_BOOK SS4.7, SS8.6; MODEL_CONTRACT SS7)
# ---------------------------------------------------------------------------

MAX_EVENTS = 10  # frozen bound; a scenario needing more is INCONCLUSIVE_LIMIT

DB_SNAPSHOT = "DB_SNAPSHOT"
BLOB_SNAPSHOT = "BLOB_SNAPSHOT"
SNAPSHOT_EVENTS = (DB_SNAPSHOT, BLOB_SNAPSHOT)

STRATEGIES = ("DB_FIRST", "FILE_FIRST", "PAUSE_WRITES")

VERDICTS = (
    "SAFE_WITHIN_BOUND",
    "UNSAFE_WITHIN_BOUND",
    "INCONCLUSIVE_LIMIT",
    "INVALID_INPUT",
)

DIAGNOSTIC_CODES = (
    "DANGLING_REFERENCE",
    "ORPHAN_BLOB",
    "GENERATION_MISMATCH",
    "DIGEST_MISMATCH",
    "IN_FLIGHT_OPERATION",
    "NO_COMMON_BOUNDARY",
)

# Operation templates: kind -> ordered tuple of atomic event kinds.
# PROJECT_BOOK SS3.2 -- frozen, must not be reordered or skipped.
OPERATION_TEMPLATES = {
    "UPLOAD": ("BLOB_PUT", "DB_LINK"),
    "DELETE": ("DB_UNLINK", "BLOB_DELETE"),
    "UPDATE": ("BLOB_PUT_NEW", "DB_REPOINT", "BLOB_DELETE_OLD"),
}

# Event kinds that modify data (as opposed to snapshot events).
DATA_EVENT_KINDS = (
    "BLOB_PUT",
    "DB_LINK",
    "DB_UNLINK",
    "BLOB_DELETE",
    "BLOB_PUT_NEW",
    "DB_REPOINT",
    "BLOB_DELETE_OLD",
)


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def blob_key(object_id: str, generation: int) -> str:
    """Frozen string form of a Blob version key (MODEL_CONTRACT I-03)."""
    return "%s@%d" % (object_id, generation)


def event_id(op_id: str, event_kind: str) -> str:
    """Data-event IDs are '<opId>:<KIND>' (T002 convention, per fixtures)."""
    return "%s:%s" % (op_id, event_kind)


def derived_digest(file_id: str) -> str:
    """Deterministic digest for an implied pre-existing record (see module
    docstring).  Used identically in D and in B."""
    return "fixture-digest-%s-v1" % file_id


def freeze_db(db):
    """Hashable snapshot of a database state."""
    return frozenset((fid, ref[0], ref[1], ref[2]) for fid, ref in db.items())


def freeze_blob(blob):
    """Hashable snapshot of a Blob state."""
    return frozenset((oid, gen, digest) for (oid, gen), digest in blob.items())


def freeze_pair(db, blob):
    return (freeze_db(db), freeze_blob(blob))


# ---------------------------------------------------------------------------
# Initial state (I-02)
# ---------------------------------------------------------------------------

def derive_initial_state(operations):
    """Build the implied initial (D, B) from the operations.

    Returns (db, blob, issues).  ``issues`` is a list of (code, message)
    describing statically contradictory inputs; an empty list means the
    implied pre-state is well-defined.  A DELETE or UPDATE implies its file
    pre-exists at generation 1; two operations implying DIFFERENT
    pre-existing records for the same fileId are contradictory.
    """
    db = {}
    blob = {}
    issues = []
    for op in operations:
        kind = op.get("kind")
        file_id = op.get("fileId")
        if kind == "DELETE":
            object_id = op.get("objectId")
            digest = op.get("digest") or derived_digest(file_id)
            _imply_record(db, blob, file_id, object_id, 1, digest, issues, op)
        elif kind == "UPDATE":
            object_id = op.get("oldObjectId")
            digest = op.get("oldDigest") or derived_digest(file_id)
            _imply_record(db, blob, file_id, object_id, 1, digest, issues, op)
        elif kind == "UPLOAD":
            pass  # an upload creates its record; nothing pre-exists.
        else:
            issues.append(("INVALID_OPERATION_KIND",
                           "op %r has unknown kind %r" % (op.get("opId"), kind)))
    return db, blob, issues


def _imply_record(db, blob, file_id, object_id, generation, digest, issues, op):
    existing = db.get(file_id)
    ref = (object_id, generation, digest)
    if existing is None:
        db[file_id] = ref
        blob[(object_id, generation)] = digest
    elif existing != ref:
        issues.append(
            ("CONFLICTING_PRESTATE",
             "operations imply different pre-existing records for file %r: "
             "%r (op %r) vs %r" % (file_id, existing, op.get("opId"), ref)))


# ---------------------------------------------------------------------------
# Event application (one atomic event, pure function)
# ---------------------------------------------------------------------------

def apply_event(db, blob, op, event_kind, op_ctx):
    """Apply one atomic event of ``op`` to copies of (db, blob).

    ``op_ctx`` is a per-path scratch dict (opId -> dict) holding values
    resolved while the operation runs: for DELETE the reference removed by
    DB_UNLINK (so BLOB_DELETE knows which generation to delete); for UPDATE
    the old/new generations resolved by BLOB_PUT_NEW.

    Returns (new_db, new_blob, new_op_ctx) on success, or None when the
    event's precondition fails in this state (the event simply cannot
    execute in this interleaving; the caller skips it as a candidate).
    """
    op_id = op["opId"]
    file_id = op["fileId"]
    ctx = dict(op_ctx.get(op_id, {}))
    new_db = dict(db)
    new_blob = dict(blob)

    if event_kind == "BLOB_PUT":  # UPLOAD step 1: write object, gen 1.
        new_blob[(op["objectId"], 1)] = op["digest"]
    elif event_kind == "DB_LINK":  # UPLOAD step 2: create DB record.
        new_db[file_id] = (op["objectId"], 1, op["digest"])
    elif event_kind == "DB_UNLINK":  # DELETE step 1: remove DB reference.
        ref = new_db.pop(file_id, None)
        if ref is None:
            return None
        ctx["removed_ref"] = ref
    elif event_kind == "BLOB_DELETE":  # DELETE step 2: delete the Blob.
        ref = ctx.get("removed_ref")
        if ref is None:
            return None
        if (ref[0], ref[1]) not in new_blob:
            return None
        del new_blob[(ref[0], ref[1])]
    elif event_kind == "BLOB_PUT_NEW":  # UPDATE step 1: write new version.
        current = new_db.get(file_id)
        if current is None:
            return None
        old_object_id, old_generation = current[0], current[1]
        new_generation = old_generation + 1
        ctx["old_object_id"] = old_object_id
        ctx["old_generation"] = old_generation
        ctx["new_generation"] = new_generation
        new_blob[(op["objectId"], new_generation)] = op["digest"]
    elif event_kind == "DB_REPOINT":  # UPDATE step 2: repoint DB reference.
        if "new_generation" not in ctx:
            return None
        new_db[file_id] = (op["objectId"], ctx["new_generation"], op["digest"])
    elif event_kind == "BLOB_DELETE_OLD":  # UPDATE step 3: delete old version.
        key = (ctx.get("old_object_id"), ctx.get("old_generation"))
        if key[0] is None or key not in new_blob:
            return None
        del new_blob[key]
    else:
        return None

    new_ctx = dict(op_ctx)
    new_ctx[op_id] = ctx
    return new_db, new_blob, new_ctx


# ---------------------------------------------------------------------------
# Operation boundaries (PROJECT_BOOK SS4.2)
# ---------------------------------------------------------------------------

def operation_event_ids(op):
    """Ordered data-event IDs of one logical operation."""
    return [event_id(op["opId"], kind) for kind in OPERATION_TEMPLATES[op["kind"]]]


def all_event_ids(operations):
    """Every event ID in the scenario: data events + the two snapshots."""
    ids = []
    for op in operations:
        ids.extend(operation_event_ids(op))
    ids.extend(SNAPSHOT_EVENTS)
    return ids


def compute_boundaries(operations, initial_db, initial_blob):
    """All legal operation boundaries as a set of frozen (D, B) pairs.

    A boundary is reachable by completing any subset of the operations (in
    any order), each applied as a whole, starting from the initial state.
    Computed by depth-first expansion over subsets -- independent of any
    search order, snapshot placement or strategy.
    """
    by_id = {op["opId"]: op for op in operations}
    boundaries = set()
    stack = [(dict(initial_db), dict(initial_blob), frozenset())]
    seen = set()
    while stack:
        db, blob, done = stack.pop()
        key = (freeze_pair(db, blob), done)
        if key in seen:
            continue
        seen.add(key)
        boundaries.add(freeze_pair(db, blob))
        for op in operations:
            op_id = op["opId"]
            if op_id in done:
                continue
            cur_db, cur_blob, ctx = dict(db), dict(blob), {}
            ok = True
            for kind in OPERATION_TEMPLATES[op["kind"]]:
                applied = apply_event(cur_db, cur_blob, op, kind, ctx)
                if applied is None:
                    ok = False
                    break
                cur_db, cur_blob, ctx = applied
            if ok:
                stack.append((cur_db, cur_blob, done | {op_id}))
    return boundaries


# ---------------------------------------------------------------------------
# Value-first consistency (PROJECT_BOOK SS4.3 + ADR-002)
# ---------------------------------------------------------------------------

def is_consistent(db_snapshot, blob_snapshot, boundaries):
    """True IFF the pair equals some legal operation boundary (value-first).

    Takes only values -- no timing, no in-flight information.  This is the
    authoritative verdict rule; ADR-002.
    """
    return freeze_pair(db_snapshot, blob_snapshot) in boundaries


def diagnose(db_snapshot, blob_snapshot, boundaries, in_flight_op_ids=()):
    """Diagnostics for a snapshot pair, value-first (ADR-002).

    Returns [] when the pair is value-consistent -- even when a snapshot
    was captured mid-operation.  Only for a value-INCONSISTENT pair are
    diagnostics emitted, including IN_FLIGHT_OPERATION as an explanatory
    diagnostic when an operation was in flight at a capture moment, and
    NO_COMMON_BOUNDARY (which is exactly the value-inconsistency itself).
    Codes are returned sorted for stable output.
    """
    if is_consistent(db_snapshot, blob_snapshot, boundaries):
        return []
    codes = set()
    referenced = set()
    for _fid, ref in db_snapshot.items():
        oid, gen, digest = ref
        referenced.add((oid, gen))
        if (oid, gen) not in blob_snapshot:
            codes.add("DANGLING_REFERENCE")
            if any(o == oid and g != gen for (o, g) in blob_snapshot):
                codes.add("GENERATION_MISMATCH")
        elif blob_snapshot[(oid, gen)] != digest:
            codes.add("DIGEST_MISMATCH")
    for key in blob_snapshot:
        if key not in referenced:
            codes.add("ORPHAN_BLOB")
    if in_flight_op_ids:
        codes.add("IN_FLIGHT_OPERATION")
    codes.add("NO_COMMON_BOUNDARY")
    return sorted(codes)


# ---------------------------------------------------------------------------
# Event dependency DAG (PROJECT_BOOK SS8.6: dependencies must form a legal DAG)
# ---------------------------------------------------------------------------

def validate_event_dag(nodes, edges):
    """Check a dependency graph (nodes, directed edges) is acyclic.

    Returns a list of issues (empty == legal DAG).  A cycle or a self-loop
    is an illegal DAG.  The Oracle builds its own DAG from the operation
    templates plus the strategy snapshot order; this validator is also
    exercised directly by the unit tests with a hand-built cyclic graph.
    """
    issues = []
    adjacency = {n: [] for n in nodes}
    for src, dst in edges:
        if src not in adjacency or dst not in adjacency:
            issues.append(("UNKNOWN_DAG_NODE",
                           "edge %r -> %r references an unknown event" % (src, dst)))
            continue
        if src == dst:
            issues.append(("CYCLIC_DEPENDENCY",
                           "self-loop on event %r" % (src,)))
        adjacency[src].append(dst)
    # Iterative DFS colouring: 0 = unvisited, 1 = on stack, 2 = done.
    colour = {n: 0 for n in nodes}
    for start in nodes:
        if colour[start] != 0:
            continue
        stack = [(start, iter(adjacency[start]))]
        colour[start] = 1
        while stack:
            node, neighbours = stack[-1]
            advanced = False
            for nxt in neighbours:
                if colour[nxt] == 1:
                    issues.append(("CYCLIC_DEPENDENCY",
                                   "cycle through events %r -> %r" % (node, nxt)))
                    return issues
                if colour[nxt] == 0:
                    colour[nxt] = 1
                    stack.append((nxt, iter(adjacency[nxt])))
                    advanced = True
                    break
            if not advanced:
                colour[node] = 2
                stack.pop()
    return issues


def scenario_dag_edges(operations, strategy):
    """Dependency edges implied by a scenario: template order within each
    operation, plus the strategy snapshot order (ADR-001 placement is a
    candidate filter, not a DAG edge, and is handled by the driver)."""
    edges = []
    for op in operations:
        ids = operation_event_ids(op)
        edges.extend(zip(ids, ids[1:]))
    if strategy == "DB_FIRST":
        edges.append((DB_SNAPSHOT, BLOB_SNAPSHOT))
    elif strategy == "FILE_FIRST":
        edges.append((BLOB_SNAPSHOT, DB_SNAPSHOT))
    return edges


# ---------------------------------------------------------------------------
# Standalone self-check
# ---------------------------------------------------------------------------

def _self_check():
    checks = []
    assert OPERATION_TEMPLATES["UPLOAD"] == ("BLOB_PUT", "DB_LINK")
    assert OPERATION_TEMPLATES["DELETE"] == ("DB_UNLINK", "BLOB_DELETE")
    assert OPERATION_TEMPLATES["UPDATE"] == (
        "BLOB_PUT_NEW", "DB_REPOINT", "BLOB_DELETE_OLD")
    checks.append("templates frozen per PROJECT_BOOK SS3.2")

    ops = [{"opId": "upload-A", "kind": "UPLOAD", "fileId": "A",
            "objectId": "A-v1", "digest": "fixture-digest-A"},
           {"opId": "delete-C", "kind": "DELETE", "fileId": "C",
            "objectId": "C-v1"}]
    db0, blob0, issues = derive_initial_state(ops)
    assert issues == [], issues
    assert db0 == {"C": ("C-v1", 1, derived_digest("C"))}
    assert blob0 == {("C-v1", 1): derived_digest("C")}
    checks.append("I-02 implied pre-state: DELETE pre-exists, UPLOAD does not")

    bounds = compute_boundaries(ops, db0, blob0)
    assert len(bounds) == 4, len(bounds)  # 2 ops -> 4 subsets
    assert freeze_pair({}, {}) in bounds  # both completed
    assert freeze_pair(db0, blob0) in bounds  # initial boundary
    checks.append("boundaries: 2 ops -> 4 subset boundaries")

    # Value-first (ADR-002): the all-empty pair is consistent even though a
    # snapshot was taken mid-upload -- it equals the initial boundary.
    assert is_consistent({}, {}, bounds)
    assert diagnose({}, {}, bounds, in_flight_op_ids=("upload-A",)) == []
    checks.append("ADR-002: value-consistent pair carries zero diagnostics")

    # A mid-upload pair is inconsistent, with the explanatory diagnostic.
    mid_blob = {("C-v1", 1): derived_digest("C"),
                ("A-v1", 1): "fixture-digest-A"}
    assert not is_consistent({}, mid_blob, bounds)
    assert diagnose({}, mid_blob, bounds,
                    in_flight_op_ids=("upload-A",)) == [
        "IN_FLIGHT_OPERATION", "NO_COMMON_BOUNDARY", "ORPHAN_BLOB"]
    checks.append("inconsistent pair: ORPHAN_BLOB + IN_FLIGHT + NO_COMMON_BOUNDARY")

    dag_issues = validate_event_dag(["a", "b"], [("a", "b"), ("b", "a")])
    assert dag_issues and dag_issues[0][0] == "CYCLIC_DEPENDENCY"
    checks.append("cyclic DAG rejected")

    print("independent-model self-check: %d/%d passed" % (len(checks), len(checks)))
    for c in checks:
        print("  OK  " + c)
    print("model: MAX_EVENTS=%d, strategies=%s" % (MAX_EVENTS, ", ".join(STRATEGIES)))


if __name__ == "__main__":
    _self_check()
