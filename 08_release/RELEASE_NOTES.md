# SnapFence 0.1.0 — Release Notes

- PROJECT_ID: P030 SnapFence（快照栅）
- SPEC_VERSION: 1.0.1
- RELEASE DATE: 2026-11-23 (freeze commit
  `bbbcc1f876b57225c320c96583712a7be7710c01`)
- STATUS: **release candidate for GPT final review R3 — NOT accepted yet.**
  Construction T001–T014 is complete and the source was re-frozen at
  `bbbcc1f` after the first final-review round's findings were fixed.
  Per plan §13.4, no completion may be announced and no completion
  notice issued before GPT-6 gives an explicit FINAL_VERDICT: PASS in
  the establishment conversation.

## Contents

- `04_source/source-release.zip` — 126 files, 336,117 bytes,
  SHA-256 `e342dba4f87effedabe4bcfe75c8982fcdd401bfaaafe3d7ccda8447285d824d`
  (deterministic build: rebuilding from the same frozen commit produces
  a byte-identical ZIP — fixed timestamps + sorted entries; see
  HOW_TO_REPRODUCE §6).
- `04_source/SOURCE_MANIFEST.csv` — 126 rows, every file's SHA-256 and
  byte count, each matching the git blob at the frozen commit.
- `04_source/SHA256SUMS.txt` — 126 lines, standard `sha256sum` format;
  `sha256sum -c 04_source/SHA256SUMS.txt` exits 0 from the repo root.

## Measured results

Re-verification runs, 2026-11-23 ~04:22–04:31 UTC (independent extract;
logs in `00_control/`). Performance numbers are the T012 artifact — see
the note below the table; they are **not** a fresh re-run.

| Check | Result |
|---|---|
| vitest (`npm test`) | **467 passed / 0 failed**, 33 files |
| Oracle unittest | **39 passed, OK** (2.083 s) |
| Oracle parity | **24/24 MATCH** |
| S0 gate (`npm run s0:gate`) | **RESULT=PASS, 14/14** (G12 max 14.0 ms < 1000 ms) |
| Performance (`bench:10-events`, T012) | **24/24 < 1000 ms**; G12 pure max 8.187 ms, median 5.609 ms; Worker steady max 8.239 ms, first run 13.430 ms |
| `verify:docs` | 23/23 PASS |
| `verify:license` | 20/20 PASS |
| `verify:release` | **40/40 checks PASS** (run with `SNAPFENCE_FREEZE_COMMIT=bbbcc1f876b57225c320c96583712a7be7710c01`) |
| `typecheck` / `build` | exit 0 / exit 0 (Worker chunk `dist/assets/snapfence.worker-*.js` present) |
| Independent extract test | `npm ci` + build + test + s0:gate + Oracle, all exit 0 in a fresh directory |

**Performance honesty note:** `05_tests/benchmark/performance.json` is
the T012 artifact, generated 2026-11-23 03:08:48–03:08:49 UTC. It was
**not** re-run during the re-verification; the G12 numbers in the table
above are the T012 measurements, labelled as such. Do not re-run
`bench:10-events` — it rewrites the frozen evidence file.

## What changed in this release (construction summary)

- T001–T004: frozen state model, event state machine, deterministic BFS
  bounded search (≤ 10 events), consistency invariants + shortest
  counterexample (lexicographic tie-break).
- T005: 24 Golden scenarios (12 UNSAFE / 12 SAFE), hand-derived.
- T006: independent Python Oracle (stdlib only, DFS-based), parity 24/24.
- T007: S0 hard gate, RESULT=PASS 14/14 (two gate-only parsing bugs
  found and fixed on the way; never a product failure).
- T008–T010: dual-track timeline UI, JSON + standalone HTML export,
  Web Worker integration, 24/24 end-to-end.
- T011: full regression + independent review (different model session),
  GO-WITH-FINDINGS (no P0/P1; one P2 F-01 + minors F-02–F-06).
- FIX-V-01: F-01 truly fixed (root cause + re-shot `fix-v01-*.png`).
- T012: 10-event performance test, 24/24 < 1 s.
- T013: docs, MIT license, third-party notices (95 packages, no copyleft).
- T014: freeze + release packaging (TEST_PLAN.md created, closing
  L-T011-05/L-T013-03; `verify:release` wired; review packs written).
- Re-freeze at `bbbcc1f`: after the first final-review round, four
  findings were fixed — INVALID_INPUT report normalization
  (unknown/invalid scenario and strategy values normalized, JSON Schema
  unchanged), spec version aligned to v1.0.1, freeze identity made
  explicit in `verify-release.ts` (no HEAD fallback), and test/UI
  evidence completed. The source was re-frozen at `bbbcc1f`, the release
  ZIP rebuilt (126 files), and every suite re-run in an independent
  extract on 2026-11-23 ~04:22–04:31 UTC.

## Known limitations (full list: `04_source/source/docs/LIMITATIONS.md`)

- Performance numbers are machine-relative; re-measure on other machines.
- Worker round-trips measured in Node via `LocalWorkerTransport`, not a
  real browser Worker thread (T010 Chrome CDP evidence ≤ 10 ms covers
  the real thread at the same order of magnitude).
- Oracle parity covers the 24 Golden scenarios only.
- Windows: **NOT_TESTED** (no Windows machine available).
- The 0-external-API assertion is a lexical scan of `src/core/**`.
- The release ZIP is source-only: run `npm ci` (network to the npm
  registry) before building; the lockfile pins exact versions.
- Model checking proves consistency only within the given model /
  templates / bound; it does not back up real data (PROJECT_BOOK.md §6).

## Review pointers

- Review packs: `07_evidence/REVIEW_PACKS/REVIEW_INDEX_R2.md`
  (Pack 01: correctness case; Pack 02: delivery case).
- Independent review: `06_reviews/TASK_REVIEWS/T011_REVIEW.md`;
  coverage: `06_reviews/REVIEW_COVERAGE.csv` (92 lines).
- Test plan: `05_tests/TEST_PLAN.md`.
- Reproduction: `08_release/HOW_TO_REPRODUCE.md`.
