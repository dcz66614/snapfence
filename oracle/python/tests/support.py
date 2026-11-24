"""Shared support for the P030-T006 Oracle test suite.

Locates the work-dir root from this file's own path (no cwd dependence),
loads the Oracle modules, and loads Golden fixtures.  The test suite --
not the Oracle -- is allowed to read the fixtures' ``expected*`` fields.
"""

import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
ORACLE_DIR = ROOT / "oracle" / "python"
GOLDEN_DIR = ROOT / "04_source" / "source" / "fixtures" / "golden"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_oracle():
    model = load_module("snapfence_independent_model",
                        ORACLE_DIR / "independent-model.py")
    oracle = load_module("snapfence_oracle",
                         ORACLE_DIR / "snapfence_oracle.py")
    return model, oracle


def load_fixture(fixture_id):
    """Full fixture JSON (scenario + expected values) -- test-side only."""
    with open(GOLDEN_DIR / ("%s.json" % fixture_id), encoding="utf-8") as fh:
        return json.load(fh)


def fixture_ids():
    return ["U%02d" % i for i in range(1, 13)] + ["G%02d" % i for i in range(1, 13)]
