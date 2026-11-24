"""CLI tests for the P030-T006 independent Oracle.

These tests invoke the Oracle as a subprocess -- that is allowed here
because the subprocess IS the Oracle itself (pure Python); the Oracle
never spawns a subprocess of its own.  No Node, no production code.
"""

import json
import subprocess
import sys
import unittest

import support

ORACLE = support.ORACLE_DIR / "snapfence_oracle.py"
MODEL = support.ORACLE_DIR / "independent-model.py"


def run_cli(*args):
    return subprocess.run([sys.executable, str(ORACLE), *[str(a) for a in args]],
                          capture_output=True, text=True, timeout=60)


class CliTest(unittest.TestCase):
    def test_single_fixture(self):
        proc = run_cli(support.GOLDEN_DIR / "U01.json")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        results = json.loads(proc.stdout)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["fixture"], "U01")
        self.assertEqual(results[0]["verdict"], "UNSAFE_WITHIN_BOUND")
        self.assertEqual(results[0]["counterexampleLength"], 3)
        self.assertEqual(results[0]["counterexample"],
                         ["DB_SNAPSHOT", "upload-A:BLOB_PUT", "BLOB_SNAPSHOT"])

    def test_golden_dir(self):
        proc = run_cli("--golden-dir", support.GOLDEN_DIR)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        results = json.loads(proc.stdout)
        self.assertEqual(len(results), 24)
        unsafe = sum(1 for r in results if r["verdict"] == "UNSAFE_WITHIN_BOUND")
        safe = sum(1 for r in results if r["verdict"] == "SAFE_WITHIN_BOUND")
        self.assertEqual(unsafe, 12)
        self.assertEqual(safe, 12)

    def test_missing_file_fails(self):
        proc = run_cli(support.GOLDEN_DIR / "NOPE.json")
        self.assertNotEqual(proc.returncode, 0)

    def test_no_args_fails(self):
        proc = run_cli()
        self.assertNotEqual(proc.returncode, 0)

    def test_model_self_check(self):
        proc = subprocess.run([sys.executable, str(MODEL)],
                              capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("self-check: 6/6 passed", proc.stdout)

    def test_cli_runs_from_any_cwd(self):
        """The Oracle resolves its model file from its own path, not cwd."""
        proc = subprocess.run(
            [sys.executable, str(ORACLE), str(support.GOLDEN_DIR / "G12.json")],
            capture_output=True, text=True, timeout=60, cwd="/tmp")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        results = json.loads(proc.stdout)
        self.assertEqual(results[0]["verdict"], "SAFE_WITHIN_BOUND")


if __name__ == "__main__":
    unittest.main()
