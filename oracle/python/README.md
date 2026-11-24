# SnapFence independent Python Oracle (P030-T006)

A reference calculator for the 24 Golden scenarios, written independently
from the production TypeScript BFS. It is a **development-time test
oracle only** — it is not a product runtime dependency (PROJECT_BOOK §7.1).

## Files

| File | Role |
|---|---|
| `snapfence_oracle.py` | The Oracle: fixture parsing, scenario validation, DFS enumeration, verdict + shortest counterexample + diagnostics, CLI. |
| `independent-model.py` | The independent model: state components, operation templates, event application, boundary enumeration, value-first consistency, DAG validation. Loaded by the Oracle via `importlib` (the hyphenated name cannot be a normal import). Runnable standalone: `python3 independent-model.py` runs its self-check. |
| `tests/` | `unittest` suite: parity (24/24), units (model rules, ADR-001/002, illegal DAG, bounds), CLI. |
| `README.md` | This file. |

## The model (derived from the spec, not from production code)

Sources, in authority order: `PROJECT_BOOK.md` §3–§4, §8–§10;
`docs/MODEL_CONTRACT.md` (I-01…I-06); `ADR-001` (snapshot placement);
`ADR-002` (value-first consistency); `T005_GOLDEN_DERIVATIONS.md`
(L-10 prefix convention, L-A/L-B lemmas).

- **State**: `D: fileId -> (objectId, generation, digest)`,
  `B: (objectId, generation) -> digest`, plus per-operation status.
- **Templates (frozen)**: UPLOAD `BLOB_PUT -> DB_LINK`;
  DELETE `DB_UNLINK -> BLOB_DELETE`;
  UPDATE `BLOB_PUT_NEW -> DB_REPOINT -> BLOB_DELETE_OLD`.
- **Initial state (I-02)**: a DELETE/UPDATE implies its file pre-exists at
  generation 1. The digest for such an implied record is derived
  deterministically inside the Oracle as `fixture-digest-<fileId>-v1`,
  the *same* value in D and in B, so the implied pre-state is consistent
  by construction. Only the equality matters for any verdict, never the
  literal string. Generations follow R-GEN-1 (upload creates gen 1) and
  R-GEN-2 (update creates old gen + 1).
- **Boundaries (§4.2)**: states reachable by completing any subset of the
  operations, each applied as a whole, from the initial state.
- **Consistency (§4.3 + ADR-002, value-first)**: a snapshot pair is
  consistent **iff** it equals some boundary `(D(k), B(k))`. Timing plays
  no role. `IN_FLIGHT_OPERATION` is an explanatory diagnostic only, for
  value-inconsistent pairs captured mid-operation; value-consistent pairs
  carry zero diagnostics.
- **Search**: depth-first enumeration of legal topological-order prefixes
  (the production implementation uses BFS; this Oracle uses no BFS, no
  queue, no visited-key dedup). A path is terminal once both snapshots
  have executed (L-10 prefix convention — the counterexample ends at the
  second snapshot and is not extended). Candidates are considered in
  fixed lexicographic event-ID order, so results are deterministic.
  Every terminal prefix is visited, so the reported counterexample length
  is the exact minimum over all terminal prefixes.
- **Candidate rules**: per-operation template order; strategy snapshot
  order (DB_FIRST / FILE_FIRST); ADR-001 `snapshotsAfter` (snapshots only
  after the listed operations complete; unknown opId → `INVALID_INPUT`);
  PAUSE_WRITES (snapshots only when no operation is in flight, and no
  data event between the two snapshots — under DB_FIRST/FILE_FIRST writes
  *may* continue between snapshots); each event's own precondition.
- **Verdicts**: `SAFE_WITHIN_BOUND`, `UNSAFE_WITHIN_BOUND`,
  `INCONCLUSIVE_LIMIT` (scenario exceeds the frozen 10-event bound, or
  the DFS node cap — never silently SAFE), `INVALID_INPUT` (unknown
  strategy, duplicate opId, unknown `snapshotsAfter` opId, conflicting
  implied pre-state, illegal DAG, bad operation shape, `@` in objectId).

## Independence guarantees (enforced by tests)

- Pure Python standard library only; no third-party imports.
- No subprocess, no Node, no reading of any production TypeScript module
  or production test output.
- The Oracle reads only the `scenario` key of a fixture file. It never
  reads the `expected*` fields — those are the test suite's comparison
  inputs, not Oracle inputs (`test_oracle_never_reads_expected_values`
  and `test_oracle_reads_only_the_scenario_key` assert this statically
  and behaviourally).
- The search is DFS over topological orders; the production search is
  BFS. The two implementations share no code.

## Running

```sh
# Full suite (from the work-dir root; this is the T006 acceptance command)
cd ~/workspace/p030-snapfence
python3 -m unittest discover -s oracle/python/tests -v

# Same suite via npm (from 04_source/source; wires test:oracle)
cd ~/workspace/p030-snapfence/04_source/source
npm run test:oracle

# Oracle directly on one fixture / the whole Golden set
python3 oracle/python/snapfence_oracle.py 04_source/source/fixtures/golden/U01.json
python3 oracle/python/snapfence_oracle.py --golden-dir 04_source/source/fixtures/golden

# Model self-check
python3 oracle/python/independent-model.py
```

Exit code of the CLI is 0 when every scenario was computed (even
`UNSAFE`); non-zero only for Oracle errors (`INVALID_INPUT`,
`INCONCLUSIVE_LIMIT`, unreadable input).

## Results (this task)

- **Parity 24/24**: Oracle verdict = production verdict on all 24 Golden
  scenarios (12 UNSAFE detected, 12 SAFE with zero false positives).
  Production verdicts equal the fixtures' `expectedVerdict` — established
  by the T005 golden suite (`npm run test:golden`, 29/29, re-run as a
  regression in this task). See `00_control/T006_PARITY.md`.
- **Shortest counterexamples**: length 3 for all 12 U scenarios, 0 for all
  12 G scenarios; the exact event sequences match the fixtures.
- **Diagnostics**: all 12 U counterexamples carry exactly
  `IN_FLIGHT_OPERATION + NO_COMMON_BOUNDARY + ORPHAN_BLOB` (the length-3
  structural property proved in `T005_GOLDEN_DERIVATIONS.md` L-B); all
  12 G scenarios carry zero diagnostics.
- **Runtime**: all 24 scenarios in ~0.3 s total (largest: G12, 19,049 DFS
  nodes, 5,842 terminal prefixes).

## Known limitations

- L-T006-01: the derived digest for implied pre-existing records
  (`fixture-digest-<fileId>-v1`) is an Oracle-local deterministic choice.
  It is invisible to every verdict by construction (same value in D and
  B), but it is not the production implementation's derivation.
- L-T006-02: operations on the *same* fileId (e.g. an UPDATE of a file
  another operation in the same scenario deletes) are handled only by the
  generic event preconditions (an event whose precondition fails in a
  given interleaving is skipped in that interleaving). No Golden fixture
  exercises this; the behaviour is a modelling choice, not a spec rule.
- L-T006-03: tie-breaking among equal-length counterexamples follows the
  Oracle's lexicographic DFS order. On the 24 Golden scenarios this
  reproduces the production BFS's pick exactly (24/24 sequences match),
  but that agreement is empirical for this fixture set, not a proof that
  the two orders coincide in general.
- L-T006-04: the Oracle enumerates every terminal prefix without state
  dedup. That is exact and fast at the frozen 10-event bound (worst
  Golden case: 19,049 nodes), but a much larger scenario would hit the
  200,000-node cap and report `INCONCLUSIVE_LIMIT` instead of finishing.
- L-T006-05 (process note): the task card's acceptance command places the
  Oracle at the work-dir root (`oracle/python/`), while
  IMPLEMENTATION_PLAN §3 sketches it under `04_source/oracle/`. This
  task follows the task card, because its acceptance command
  (`python3 -m unittest discover -s oracle/python/tests -v` from the
  work-dir root) fixes the location. The npm script therefore uses a
  relative path (`../../oracle/python/tests`). Also, `package.json`
  contained no `test:oracle` placeholder line at all, so one line was
  added (alphabetical position) instead of replacing a placeholder.
