# SnapFence 0.1.0 — Release README

SnapFence（快照栅）is an application-level backup snapshot consistency
model checker. When a database and file/Blob storage are backed up
separately while the application may still be writing, SnapFence
enumerates snapshot cut points and concurrent event interleavings and
finds the **shortest counterexample** that makes a restore inconsistent
(orphan blob / dangling reference).

- **Status:** release candidate for GPT final review R3. Construction
  (T001–T014) is complete and the source was re-frozen after the first
  final-review round's findings were fixed; the project is **NOT** yet
  accepted — final review PASS is still required (plan §13.4). Do not
  present this as a finished/accepted product.
- **Version:** 0.1.0 (`snapfence`, MIT license)
- **Freeze commit:** `bbbcc1f876b57225c320c96583712a7be7710c01`
- **Spec:** PROJECT_BOOK.md v1.0.1 / IMPLEMENTATION_PLAN.md (frozen)
- **Release ZIP:** `04_source/source-release.zip` — 126 files,
  336,117 bytes,
  SHA-256 `e342dba4f87effedabe4bcfe75c8982fcdd401bfaaafe3d7ccda8447285d824d`
- **Manifest:** `04_source/SOURCE_MANIFEST.csv` (126 rows);
  **hashes:** `04_source/SHA256SUMS.txt` (`sha256sum -c` from repo root)

## What is inside

- `source/` — the product: TypeScript + React + Vite app (BFS bounded
  search, dual-track timeline UI, JSON + standalone HTML export, Web
  Worker). Run it with `npm ci && npm run dev`.
- `oracle/` — the independent Python Oracle (standard library only,
  DFS-based), used to cross-check every Golden scenario.

ZIP layout (verified against the manifest): 118 product source files
under `04_source/source/` + 8 Oracle files under `oracle/python/` =
126 files total.

## Quick start

```sh
unzip source-release.zip
cd snapfence-0.1.0/04_source/source
npm ci
npm run build     # or: npm run dev
npm test          # 467 passed, 33 files
npm run s0:gate   # RESULT=PASS, 14/14
python3 -m unittest discover -s ../../oracle/python/tests   # 39 passed, OK
```

Full reproduction steps: `08_release/HOW_TO_REPRODUCE.md`.
Measured results and known limitations: `08_release/RELEASE_NOTES.md`.
Review evidence: `07_evidence/REVIEW_PACKS/REVIEW_INDEX_R2.md`.

## Honest boundary (PROJECT_BOOK.md §6)

Model checking proves consistency only within the given model, templates
and bound. It does NOT prove real application transactions correct, does
not back up real data, and does not promise industrial-grade backup
correctness. All inputs are synthetic; zero humans participated.
