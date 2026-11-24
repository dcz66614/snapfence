# SnapFence 0.1.0 — How to Reproduce

Status: release candidate for GPT final review R3. This document
reproduces the frozen release at commit
`bbbcc1f876b57225c320c96583712a7be7710c01` — nothing else.

Reproduce the frozen release from scratch. Everything below was
executed in an independent-extract test; all steps exited 0. Logs of
the re-verification run (2026-11-23 ~04:22–04:31 UTC) are in
`00_control/` — the VERIFY_RELEASE, THREEWAY_BBBCC1F, TEST, S0_GATE,
TEMP_EXTRACT and TEST_ORACLE logs.

## Prerequisites

- Linux (tested on Ubuntu 24.04.5 LTS, kernel Linux 7.0.0-44-generic,
  x86_64; AMD EPYC 9D25, 4 vCPU, 7934 MB RAM). Windows is NOT_TESTED.
- Node.js v24.22.1, npm 10.9.4 (exact versions in
  `00_control/ENVIRONMENT.md`; other recent Node 24 / npm 10 should
  work, but re-measure performance on your machine).
- Python 3.12.3 (`python3`; bare `python` does NOT exist on the probe VM).
- `unzip`, `sha256sum`, `git` (for the freeze-correspondence check).
- Network access to the npm registry (`https://registry.npmjs.org/`)
  for `npm ci` — the release ZIP is source-only and ships no
  `node_modules`. No other network access is needed; the product itself
  never calls any external API.

## 1. Verify the release files (from the repo root)

```sh
cd ~/workspace/p030-snapfence
git cat-file -t bbbcc1f876b57225c320c96583712a7be7710c01  # commit
sha256sum -c 04_source/SHA256SUMS.txt   # all 126 files OK
sha256sum 04_source/source-release.zip
# expect e342dba4f87effedabe4bcfe75c8982fcdd401bfaaafe3d7ccda8447285d824d
```

The freeze is identified by the explicit commit above — never by HEAD.
HEAD has moved past the freeze (handoff commits after the freeze), so
do **not** require `git rev-parse HEAD` to equal the freeze commit.

## 2. Extract to a fresh directory and install

```sh
rm -rf /tmp/snapfence-extract && mkdir -p /tmp/snapfence-extract
unzip -q 04_source/source-release.zip -d /tmp/snapfence-extract
cd /tmp/snapfence-extract/snapfence-0.1.0/04_source/source
npm ci            # installs exact lockfile versions
```

ZIP layout: 118 product source files under `04_source/source/` + 8
Oracle files under `oracle/python/` = 126 files total (see
`04_source/SOURCE_MANIFEST.csv`).

## 3. Build and test (all must exit 0)

```sh
npm run build     # tsc + vite; dist/assets/snapfence.worker-*.js present
npm test          # 467 passed / 0 failed, 33 files
npm run s0:gate   # RESULT=PASS, 14/14
npm run verify:docs      # 23/23, RESULT=PASS
npm run verify:license   # 20/20, RESULT=PASS
```

### The release check (`verify:release`) — run from the repo, with the freeze commit explicit

```sh
cd ~/workspace/p030-snapfence
SNAPFENCE_FREEZE_COMMIT=bbbcc1f876b57225c320c96583712a7be7710c01 npm run verify:release
# 40 checks passed, 0 failed
```

`verify:release` is a repo-side check: it reads
`04_source/source-release.zip`, `SOURCE_MANIFEST.csv`, `SHA256SUMS.txt`
and the git objects from the repo workdir. Do **not** run it inside the
extracted copy — none of those exist there (the ZIP ships only the 126
files listed in the manifest). In the extract you verify the ZIP itself
instead: its SHA-256 must equal the published
`e342dba4f87effedabe4bcfe75c8982fcdd401bfaaafe3d7ccda8447285d824d`
(step 1), and the suites above must all pass.

**Why the environment variable is required.** `verify-release.ts`
(`04_source/source/scripts/verify-release.ts`) defaults to freeze
commit `f553a91` and deliberately has **no fallback to HEAD**: HEAD
moves with every handoff commit, so resolving the freeze from HEAD
would silently verify the wrong commit. This fail-closed design is
intentional, not a bug — always pass `SNAPFENCE_FREEZE_COMMIT`
explicitly for the current freeze. Running `verify:release` without it
checks the `f553a91` default, not this release.

## 4. Oracle (from the extract root)

```sh
cd /tmp/snapfence-extract/snapfence-0.1.0
python3 -m unittest discover -s oracle/python/tests -v   # 39 tests, OK
```

## 5. Run the product

```sh
cd /tmp/snapfence-extract/snapfence-0.1.0/04_source/source
npm run dev       # Vite dev server; open the printed URL
npm run preview   # serve the production build instead
```

## 6. Rebuild the release ZIP (determinism check)

```sh
cd ~/workspace/p030-snapfence
git worktree add /tmp/snapfence-freeze-check bbbcc1f876b57225c320c96583712a7be7710c01
cd /tmp/snapfence-freeze-check
python3 00_control/T014_BUILD_RELEASE.py
sha256sum 04_source/source-release.zip
# must print e342dba4f87effedabe4bcfe75c8982fcdd401bfaaafe3d7ccda8447285d824d
# (byte-identical when rebuilt from the same frozen commit; fixed timestamps + sorted entries)
```

Note: the build script reads the working tree (`git ls-files` + files
on disk), so it must be run on a checkout of the frozen commit — not on
the current workdir, whose HEAD has moved past the freeze. Clean up the
worktree afterwards (`git worktree remove /tmp/snapfence-freeze-check`).

## What NOT to run

- `npm run bench:10-events` — it rewrites
  `05_tests/benchmark/performance.json` / `performance.log`. The frozen
  benchmark evidence is the T012 artifact, generated 2026-11-23
  03:08:48–03:08:49 UTC; do not overwrite it.
