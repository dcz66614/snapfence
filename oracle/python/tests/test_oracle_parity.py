"""Parity tests (P030-T006): the independent Oracle vs the 24 Golden fixtures.

The fixtures' ``expected*`` fields are the test oracle inputs here: the
Oracle itself never reads them (see test_oracle_never_reads_expected_values
in test_oracle_units.py, and the independence test below).  The production
verdict for each scenario equals its fixture's expectedVerdict -- that
equality is established by the T005 golden suite (``npm run test:golden``,
29/29), which is re-run as a regression in this task; this file compares
the Oracle against the same expected values.

For every scenario this suite asserts, independently of the Oracle's
search: verdict, counterexample length, the exact counterexample event
sequence, and the diagnostic-code set.  It additionally replays each
reported counterexample through the model primitives to prove it is a
legal topological order whose snapshot pair is genuinely inconsistent.
"""

import time
import unittest

import support

MODEL, ORACLE = support.load_oracle()


def replay_counterexample(model, scenario, sequence):
    """Replay an event sequence with the model primitives only.

    Returns (legal, db_snapshot, blob_snapshot, in_flight_at_captures).
    Legality is checked directly: template order, strategy snapshot order,
    ADR-001 snapshotsAfter, and the PAUSE_WRITES pause rule.  This is an
    independent re-verification of the Oracle's claimed counterexample --
    it does not call the Oracle's search.
    """
    ops = {op["opId"]: op for op in scenario["operations"]}
    templates = {op_id: model.OPERATION_TEMPLATES[op["kind"]]
                 for op_id, op in ops.items()}
    db, blob, _ = model.derive_initial_state(scenario["operations"])
    executed = set()
    op_ctx = {}
    captures = {}
    capture_in_flight = {}
    strategy = scenario["strategy"]
    snapshots_after = scenario.get("snapshotsAfter") or []

    def status(op_id):
        ids = model.operation_event_ids(ops[op_id])
        done = sum(1 for eid in ids if eid in executed)
        return ("COMPLETED" if done == len(ids)
                else "IN_FLIGHT" if done > 0 else "NOT_STARTED")

    for pos, eid in enumerate(sequence):
        if eid in model.SNAPSHOT_EVENTS:
            if eid in executed:
                return False, None, None, None
            if any(status(op_id) != "COMPLETED" for op_id in snapshots_after):
                return False, None, None, None
            if strategy == "PAUSE_WRITES" and any(
                    status(op_id) == "IN_FLIGHT" for op_id in ops):
                return False, None, None, None
            if strategy == "DB_FIRST" and eid == model.BLOB_SNAPSHOT \
                    and model.DB_SNAPSHOT not in executed:
                return False, None, None, None
            if strategy == "FILE_FIRST" and eid == model.DB_SNAPSHOT \
                    and model.BLOB_SNAPSHOT not in executed:
                return False, None, None, None
            captures[eid] = (dict(db) if eid == model.DB_SNAPSHOT else dict(blob))
            capture_in_flight[eid] = [op_id for op_id in ops
                                      if status(op_id) == "IN_FLIGHT"]
            executed.add(eid)
            continue
        # Data event.
        if strategy == "PAUSE_WRITES" and len(captures) == 1:
            return False, None, None, None
        op_id, kind = eid.split(":", 1)
        if op_id not in ops:
            return False, None, None, None
        template = templates[op_id]
        if kind not in template:
            return False, None, None, None
        idx = template.index(kind)
        for earlier in template[:idx]:
            if model.event_id(op_id, earlier) not in executed:
                return False, None, None, None
        if eid in executed:
            return False, None, None, None
        applied = model.apply_event(db, blob, ops[op_id], kind, op_ctx)
        if applied is None:
            return False, None, None, None
        db, blob, op_ctx = applied
        executed.add(eid)
    if set(captures) != set(model.SNAPSHOT_EVENTS):
        return False, None, None, None
    in_flight = sorted(set(capture_in_flight[model.DB_SNAPSHOT])
                       | set(capture_in_flight[model.BLOB_SNAPSHOT]))
    return True, captures[model.DB_SNAPSHOT], captures[model.BLOB_SNAPSHOT], in_flight


class ParityTest(unittest.TestCase):
    def test_all_24_parity(self):
        """Verdict + counterexample length + exact sequence + diagnostics."""
        for fixture_id in support.fixture_ids():
            with self.subTest(fixture=fixture_id):
                fixture = support.load_fixture(fixture_id)
                start = time.monotonic()
                result = ORACLE.run_oracle(fixture["scenario"])
                elapsed = time.monotonic() - start
                self.assertLess(elapsed, 2.0,
                                "%s took %.2fs (limit 2s)" % (fixture_id, elapsed))
                self.assertEqual(result["verdict"], fixture["expectedVerdict"],
                                 "%s verdict" % fixture_id)
                self.assertEqual(result["counterexampleLength"],
                                 fixture["expectedCounterexampleLength"],
                                 "%s counterexample length" % fixture_id)
                self.assertEqual(result["counterexample"],
                                 fixture["expectedCounterexample"],
                                 "%s counterexample sequence" % fixture_id)
                self.assertEqual(sorted(result["diagnostics"]),
                                 sorted(fixture["expectedDiagnostics"]),
                                 "%s diagnostics" % fixture_id)

    def test_counts_12_unsafe_12_safe(self):
        unsafe = safe = 0
        for fixture_id in support.fixture_ids():
            fixture = support.load_fixture(fixture_id)
            result = ORACLE.run_oracle(fixture["scenario"])
            if result["verdict"] == "UNSAFE_WITHIN_BOUND":
                unsafe += 1
            elif result["verdict"] == "SAFE_WITHIN_BOUND":
                safe += 1
            else:
                self.fail("%s: unexpected verdict %s" % (fixture_id, result["verdict"]))
        self.assertEqual(unsafe, 12, "all 12 UNSAFE cases detected")
        self.assertEqual(safe, 12, "all 12 SAFE cases, zero false positives")

    def test_counterexamples_replay_as_legal_and_inconsistent(self):
        """Each reported U counterexample, replayed with model primitives
        only, must be a legal order whose snapshot pair is inconsistent."""
        for fixture_id in ["U%02d" % i for i in range(1, 13)]:
            with self.subTest(fixture=fixture_id):
                fixture = support.load_fixture(fixture_id)
                result = ORACLE.run_oracle(fixture["scenario"])
                legal, db_snap, blob_snap, in_flight = replay_counterexample(
                    MODEL, fixture["scenario"], result["counterexample"])
                self.assertTrue(legal, "%s: counterexample is not a legal order"
                                % fixture_id)
                db0, blob0, _ = MODEL.derive_initial_state(fixture["scenario"]["operations"])
                boundaries = MODEL.compute_boundaries(
                    fixture["scenario"]["operations"], db0, blob0)
                self.assertFalse(MODEL.is_consistent(db_snap, blob_snap, boundaries),
                                 "%s: replayed pair is actually consistent" % fixture_id)
                # The replayed pair must reproduce the reported diagnostics.
                self.assertEqual(
                    MODEL.diagnose(db_snap, blob_snap, boundaries, in_flight),
                    sorted(result["diagnostics"]))

    def test_safe_scenarios_have_zero_diagnostics(self):
        for fixture_id in ["G%02d" % i for i in range(1, 13)]:
            with self.subTest(fixture=fixture_id):
                fixture = support.load_fixture(fixture_id)
                result = ORACLE.run_oracle(fixture["scenario"])
                self.assertEqual(result["diagnostics"], [])
                self.assertEqual(result["counterexample"], [])

    def test_determinism(self):
        """Same input, same full result, twice (no randomness, no clock)."""
        for fixture_id in support.fixture_ids():
            with self.subTest(fixture=fixture_id):
                fixture = support.load_fixture(fixture_id)
                first = ORACLE.run_oracle(fixture["scenario"])
                second = ORACLE.run_oracle(fixture["scenario"])
                self.assertEqual(first, second, "%s is not deterministic" % fixture_id)


if __name__ == "__main__":
    unittest.main()
