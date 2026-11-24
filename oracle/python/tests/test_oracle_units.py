"""Unit tests for the P030-T006 independent Oracle (model + driver).

These tests use hand-built scenarios and synthetic state pairs -- never
the production implementation and never the fixtures' expected values
(except the parity file, which owns that comparison).  They pin down the
model rules one by one: templates, initial-state derivation, event
application, boundary enumeration, value-first consistency (ADR-002),
diagnostics, snapshot placement (ADR-001), the PAUSE_WRITES pause rule,
illegal-DAG rejection, and the INCONCLUSIVE_LIMIT bound.
"""

import ast
import sys
import unittest

import support

MODEL, ORACLE = support.load_oracle()
ORACLE_DIR = support.ORACLE_DIR


def scenario(scenario_id, strategy, operations, **extra):
    base = {"scenarioId": scenario_id, "strategy": strategy,
            "maxEvents": 10, "operations": operations}
    base.update(extra)
    return base


def upload(op_id, file_id, digest=None):
    return {"opId": op_id, "kind": "UPLOAD", "fileId": file_id,
            "objectId": "%s-v1" % file_id,
            "digest": digest or "fixture-digest-%s" % file_id}


def delete(op_id, file_id):
    return {"opId": op_id, "kind": "DELETE", "fileId": file_id,
            "objectId": "%s-v1" % file_id}


def update(op_id, file_id):
    return {"opId": op_id, "kind": "UPDATE", "fileId": file_id,
            "objectId": "%s-v2" % file_id, "oldObjectId": "%s-v1" % file_id,
            "digest": "fixture-digest-%s-v2" % file_id}


class ModelTest(unittest.TestCase):
    def test_templates_frozen(self):
        self.assertEqual(MODEL.OPERATION_TEMPLATES["UPLOAD"], ("BLOB_PUT", "DB_LINK"))
        self.assertEqual(MODEL.OPERATION_TEMPLATES["DELETE"],
                         ("DB_UNLINK", "BLOB_DELETE"))
        self.assertEqual(MODEL.OPERATION_TEMPLATES["UPDATE"],
                         ("BLOB_PUT_NEW", "DB_REPOINT", "BLOB_DELETE_OLD"))

    def test_initial_state_implied_records(self):
        db, blob, issues = MODEL.derive_initial_state(
            [delete("delete-C", "C"), update("update-A", "A"), upload("upload-B", "B")])
        self.assertEqual(issues, [])
        # DELETE and UPDATE imply a pre-existing generation-1 record; the
        # derived digest is identical in D and in B (I-02).
        self.assertEqual(db["C"], ("C-v1", 1, MODEL.derived_digest("C")))
        self.assertEqual(blob[("C-v1", 1)], MODEL.derived_digest("C"))
        self.assertEqual(db["A"], ("A-v1", 1, MODEL.derived_digest("A")))
        self.assertEqual(blob[("A-v1", 1)], MODEL.derived_digest("A"))
        # UPLOAD implies nothing.
        self.assertNotIn("B", db)
        self.assertNotIn(("B-v1", 1), blob)

    def test_upload_event_application(self):
        op = upload("upload-A", "A")
        db, blob, ctx = {}, {}, {}
        db, blob, ctx = MODEL.apply_event(db, blob, op, "BLOB_PUT", ctx)
        self.assertEqual(blob, {("A-v1", 1): "fixture-digest-A"})
        self.assertEqual(db, {})
        db, blob, ctx = MODEL.apply_event(db, blob, op, "DB_LINK", ctx)
        self.assertEqual(db, {"A": ("A-v1", 1, "fixture-digest-A")})

    def test_delete_event_application(self):
        op = delete("delete-C", "C")
        db, blob, _ = MODEL.derive_initial_state([op])
        db, blob, ctx = MODEL.apply_event(db, blob, op, "DB_UNLINK", {})
        self.assertEqual(db, {})
        self.assertEqual(blob, {("C-v1", 1): MODEL.derived_digest("C")})
        db, blob, ctx = MODEL.apply_event(db, blob, op, "BLOB_DELETE", ctx)
        self.assertEqual(blob, {})

    def test_update_event_application_generations(self):
        op = update("update-A", "A")
        db, blob, _ = MODEL.derive_initial_state([op])
        db, blob, ctx = MODEL.apply_event(db, blob, op, "BLOB_PUT_NEW", {})
        # R-GEN-2: new version at old generation + 1 = 2.
        self.assertEqual(blob[("A-v2", 2)], "fixture-digest-A-v2")
        self.assertIn(("A-v1", 1), blob)
        db, blob, ctx = MODEL.apply_event(db, blob, op, "DB_REPOINT", ctx)
        self.assertEqual(db, {"A": ("A-v2", 2, "fixture-digest-A-v2")})
        db, blob, ctx = MODEL.apply_event(db, blob, op, "BLOB_DELETE_OLD", ctx)
        self.assertEqual(blob, {("A-v2", 2): "fixture-digest-A-v2"})

    def test_event_precondition_failure(self):
        # BLOB_PUT_NEW cannot run when the file has no DB record.
        op = update("update-A", "A")
        self.assertIsNone(MODEL.apply_event({}, {}, op, "BLOB_PUT_NEW", {}))
        # DB_UNLINK cannot run when the record is already gone.
        self.assertIsNone(MODEL.apply_event({}, {}, delete("delete-C", "C"),
                                            "DB_UNLINK", {}))

    def test_boundaries_subset_count(self):
        ops = [upload("upload-A", "A"), delete("delete-C", "C")]
        db0, blob0, _ = MODEL.derive_initial_state(ops)
        bounds = MODEL.compute_boundaries(ops, db0, blob0)
        self.assertEqual(len(bounds), 4)  # 2 ops -> 4 subsets
        self.assertIn(MODEL.freeze_pair(db0, blob0), bounds)
        self.assertIn(MODEL.freeze_pair({}, {}), bounds)  # both completed

    def test_boundaries_four_uploads(self):
        ops = [upload("upload-%s" % c, c) for c in "ABCD"]
        db0, blob0, _ = MODEL.derive_initial_state(ops)
        self.assertEqual(len(MODEL.compute_boundaries(ops, db0, blob0)), 16)


class ValueFirstTest(unittest.TestCase):
    def _bounds(self, ops):
        db0, blob0, _ = MODEL.derive_initial_state(ops)
        return MODEL.compute_boundaries(ops, db0, blob0)

    def test_all_empty_pair_consistent_despite_in_flight(self):
        """ADR-002: the all-empty pair equals the initial boundary, so it
        is consistent even though a snapshot was taken mid-upload."""
        bounds = self._bounds([upload("upload-A", "A")])
        self.assertTrue(MODEL.is_consistent({}, {}, bounds))
        self.assertEqual(MODEL.diagnose({}, {}, bounds,
                                        in_flight_op_ids=("upload-A",)), [])

    def test_orphan_pair_inconsistent_with_explanatory_in_flight(self):
        bounds = self._bounds([upload("upload-A", "A")])
        blob = {("A-v1", 1): "fixture-digest-A"}
        self.assertFalse(MODEL.is_consistent({}, blob, bounds))
        self.assertEqual(MODEL.diagnose({}, blob, bounds,
                                        in_flight_op_ids=("upload-A",)),
                         ["IN_FLIGHT_OPERATION", "NO_COMMON_BOUNDARY", "ORPHAN_BLOB"])
        # Same pair, no in-flight information: no IN_FLIGHT diagnostic.
        self.assertEqual(MODEL.diagnose({}, blob, bounds),
                         ["NO_COMMON_BOUNDARY", "ORPHAN_BLOB"])

    def test_dangling_reference(self):
        bounds = {MODEL.freeze_pair({}, {})}
        db = {"A": ("A-v1", 1, "fixture-digest-A")}
        self.assertEqual(MODEL.diagnose(db, {}, bounds),
                         ["DANGLING_REFERENCE", "NO_COMMON_BOUNDARY"])

    def test_generation_mismatch(self):
        bounds = {MODEL.freeze_pair({}, {})}
        db = {"A": ("A-v1", 2, "fixture-digest-A")}
        blob = {("A-v1", 1): "fixture-digest-A"}
        # (A-v1,2) is referenced but missing -> DANGLING; (A-v1,1) exists
        # with a different generation -> GENERATION_MISMATCH; and (A-v1,1)
        # is itself referenced by no DB record -> ORPHAN_BLOB.
        self.assertEqual(MODEL.diagnose(db, blob, bounds),
                         ["DANGLING_REFERENCE", "GENERATION_MISMATCH",
                          "NO_COMMON_BOUNDARY", "ORPHAN_BLOB"])

    def test_digest_mismatch(self):
        bounds = {MODEL.freeze_pair({}, {})}
        db = {"A": ("A-v1", 1, "digest-one")}
        blob = {("A-v1", 1): "digest-two"}
        self.assertEqual(MODEL.diagnose(db, blob, bounds),
                         ["DIGEST_MISMATCH", "NO_COMMON_BOUNDARY"])


class DagTest(unittest.TestCase):
    def test_cyclic_dag_rejected(self):
        issues = MODEL.validate_event_dag(
            ["a", "b", "c"], [("a", "b"), ("b", "c"), ("c", "a")])
        self.assertTrue(any(code == "CYCLIC_DEPENDENCY" for code, _ in issues),
                        issues)

    def test_self_loop_rejected(self):
        issues = MODEL.validate_event_dag(["a"], [("a", "a")])
        self.assertTrue(any(code == "CYCLIC_DEPENDENCY" for code, _ in issues))

    def test_legal_dag_accepted(self):
        issues = MODEL.validate_event_dag(
            ["a", "b", "c"], [("a", "b"), ("b", "c")])
        self.assertEqual(issues, [])

    def test_duplicate_op_id_invalid(self):
        sc = scenario("X", "DB_FIRST", [upload("upload-A", "A"), upload("upload-A", "A")])
        self.assertEqual(ORACLE.run_oracle(sc)["verdict"], "INVALID_INPUT")

    def test_unknown_snapshots_after_invalid(self):
        sc = scenario("X", "DB_FIRST", [upload("upload-A", "A")],
                      snapshotsAfter=["no-such-op"])
        result = ORACLE.run_oracle(sc)
        self.assertEqual(result["verdict"], "INVALID_INPUT")
        self.assertTrue(any("UNKNOWN_SNAPSHOTS_AFTER_OP" in i for i in result["issues"]))

    def test_conflicting_prestate_invalid(self):
        # DELETE implies C pre-exists as C-v1; UPDATE implies C as C-v9.
        ops = [delete("delete-C", "C"),
               {"opId": "update-C", "kind": "UPDATE", "fileId": "C",
                "objectId": "C-v2", "oldObjectId": "C-v9",
                "digest": "fixture-digest-C-v2"}]
        result = ORACLE.run_oracle(scenario("X", "DB_FIRST", ops))
        self.assertEqual(result["verdict"], "INVALID_INPUT")
        self.assertTrue(any("CONFLICTING_PRESTATE" in i for i in result["issues"]))

    def test_unknown_strategy_invalid(self):
        sc = scenario("X", "SIDEWAYS", [upload("upload-A", "A")])
        self.assertEqual(ORACLE.run_oracle(sc)["verdict"], "INVALID_INPUT")

    def test_object_id_with_at_sign_invalid(self):
        op = upload("upload-A", "A")
        op["objectId"] = "A@v1"
        sc = scenario("X", "DB_FIRST", [op])
        self.assertEqual(ORACLE.run_oracle(sc)["verdict"], "INVALID_INPUT")


class SearchRuleTest(unittest.TestCase):
    def test_snapshots_after_changes_verdict(self):
        """Same input shape as U01: without snapshotsAfter it is UNSAFE,
        with snapshotsAfter=[upload-A] it is SAFE (ADR-001)."""
        ops = [upload("upload-A", "A")]
        unsafe = ORACLE.run_oracle(scenario("X", "DB_FIRST", ops))
        self.assertEqual(unsafe["verdict"], "UNSAFE_WITHIN_BOUND")
        self.assertEqual(unsafe["counterexampleLength"], 3)
        safe = ORACLE.run_oracle(scenario("X", "DB_FIRST", ops,
                                          snapshotsAfter=["upload-A"]))
        self.assertEqual(safe["verdict"], "SAFE_WITHIN_BOUND")
        self.assertEqual(safe["counterexample"], [])

    def test_pause_writes_terminals_all_boundaries(self):
        """Under PAUSE_WRITES every terminal snapshot pair is a boundary
        (no snapshot mid-operation, no data event between snapshots)."""
        sc = scenario("X", "PAUSE_WRITES",
                      [upload("upload-A", "A"), delete("delete-C", "C")])
        db0, blob0, _ = MODEL.derive_initial_state(sc["operations"])
        bounds = MODEL.compute_boundaries(sc["operations"], db0, blob0)
        search = ORACLE._Search(sc, db0, blob0, bounds)
        self.assertIsNone(search.run())
        self.assertGreater(search.terminals_checked, 0)

    def test_oversize_is_inconclusive_not_safe(self):
        ops = [upload("upload-%s" % c, c) for c in "ABCDEF"]  # 14 events > 10
        result = ORACLE.run_oracle(scenario("X", "PAUSE_WRITES", ops))
        self.assertEqual(result["verdict"], "INCONCLUSIVE_LIMIT")

    def test_shortest_length_is_minimum_over_all_terminals(self):
        # Single upload, DB_FIRST: length-2 terminal is consistent, so the
        # minimum inconsistent prefix is 3 -- not the length-4 full order.
        result = ORACLE.run_oracle(
            scenario("X", "DB_FIRST", [upload("upload-A", "A")]))
        self.assertEqual(result["counterexample"],
                         ["DB_SNAPSHOT", "upload-A:BLOB_PUT", "BLOB_SNAPSHOT"])
        self.assertEqual(result["counterexampleLength"], 3)


class IndependenceTest(unittest.TestCase):
    def test_oracle_is_pure_stdlib(self):
        """No third-party imports; everything imported is stdlib."""
        for filename in ("snapfence_oracle.py", "independent-model.py"):
            tree = ast.parse((ORACLE_DIR / filename).read_text(encoding="utf-8"))
            imported = set()
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    imported.update(a.name.split(".")[0] for a in node.names)
                elif isinstance(node, ast.ImportFrom) and node.module:
                    imported.add(node.module.split(".")[0])
            extra = imported - set(sys.stdlib_module_names)
            self.assertEqual(extra, set(), "%s imports non-stdlib %s" % (filename, extra))

    def test_oracle_never_reads_expected_values_or_production(self):
        """The Oracle must not read fixture expectations, production code,
        production test output, or spawn any child process.

        Two levels: (a) raw-text scan for tokens that must not appear
        anywhere, prose included (fixture expectation field names,
        production paths, production identifiers); (b) AST scan for
        process-spawning code (imports / attribute access), since prose
        may legitimately *deny* spawning a process in words.
        """
        raw_forbidden = ("runSearch", "expectedVerdict",
                         "expectedCounterexample", "expectedDiagnostics",
                         "src/core", "src\\core", "fixtures/golden",
                         "04_source", "vitest", "node_modules",
                         "test-results", ".test.ts")
        for filename in ("snapfence_oracle.py", "independent-model.py"):
            text = (ORACLE_DIR / filename).read_text(encoding="utf-8")
            for token in raw_forbidden:
                self.assertNotIn(token, text,
                                 "%s contains forbidden token %r" % (filename, token))
            tree = ast.parse(text)
            code_words = set()
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    code_words.update(a.name for a in node.names)
                elif isinstance(node, ast.ImportFrom) and node.module:
                    code_words.add(node.module)
                elif isinstance(node, ast.Attribute):
                    code_words.add(node.attr)
                elif isinstance(node, ast.Name):
                    code_words.add(node.id)
            for token in ("subprocess", "system", "popen", "Popen", "execv",
                          "spawnl", "check_output"):
                self.assertNotIn(token, code_words,
                                 "%s uses forbidden code token %r" % (filename, token))

    def test_oracle_reads_only_the_scenario_key(self):
        """load_fixture returns only data['scenario']; the expected fields
        of a fixture file are never exposed to the search."""
        fixture_path = support.GOLDEN_DIR / "U01.json"
        scenario_dict = ORACLE.load_fixture(fixture_path)
        self.assertEqual(set(scenario_dict),
                         {"scenarioId", "strategy", "maxEvents", "operations"})
        self.assertNotIn("expectedVerdict", scenario_dict)


if __name__ == "__main__":
    unittest.main()
