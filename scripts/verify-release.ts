/**
 * P030-T014 verify:release — release-package assertions for SnapFence.
 *
 * Checks (all must pass; any failure exits 1). This script is a
 * deterministic structural check. It does NOT re-run any test suite,
 * re-measure performance, or re-execute the Oracle (see L-T013-02 and
 * L-T014-02); the suites are re-run separately and their logs are
 * asserted to exist and show PASS (checks 11–13).
 *
 *  1. source-release.zip exists and passes `unzip -t`.
 *  2. SOURCE_MANIFEST.csv parses (path,sha256,bytes,source); hashes are
 *     64 hex chars; byte counts are non-negative integers.
 *  3. Manifest set == ZIP entry set (no extras, no omissions).
 *  4. Per-file SHA-256 and byte count in the manifest match the ZIP entry.
 *  5. Every manifest row with source=git matches the SHA-256 of the
 *     blob CONTENT at the PINNED freeze commit (`git show
 *     <FREEZE_COMMIT>:<path>` hashed with SHA-256) — the release
 *     corresponds item-by-item to the frozen git version. The freeze
 *     commit is recorded explicitly (FREEZE_COMMIT_DEFAULT, overridable
 *     with the SNAPFENCE_FREEZE_COMMIT env var); it is NEVER silently
 *     taken from HEAD, so the check stays valid after later commits
 *     move HEAD. (A git blob id is a SHA-1 over
 *     "blob <size>\0<content>" and can never equal a file SHA-256;
 *     the comparison must hash the blob content, not the blob id.)
 *  6. package.json + package-lock.json are in the ZIP; name/version match
 *     the lockfile.
 *  7. Golden complete: 24 fixtures + manifest.json in the ZIP.
 *  8. Oracle complete: snapfence_oracle.py, independent-model.py,
 *     README.md, all 3 test files in the ZIP.
 *  9. No node_modules/, dist/, .git/, .vite/, __pycache__ in the ZIP;
 *     no .env / .pem / .key / credentials file names.
 * 10. No secret assignments in ZIP text contents (api_key / access_token
 *     assignments, PRIVATE KEY blocks, password="..." assignments).
 *     `process.env` is NOT flagged — only literal secret values are.
 * 11. Recorded test evidence exists and shows PASS: full-regression.log
 *     (455 passed), s0-gate.log + s0-gate-t014.log (RESULT=PASS, 14/14),
 *     test-oracle.log (Ran 39 tests, OK), performance.json (RESULT=PASS,
 *     24/24, threshold 1000 ms).
 * 12. Delivery evidence exists: TEST_PLAN.md, REVIEW_COVERAGE.csv,
 *     REVIEW_PACKS/REVIEW_INDEX.md + REVIEW_PACK_01.md +
 *     REVIEW_PACK_02.md, 08_release/README.md + RELEASE_NOTES.md +
 *     HOW_TO_REPRODUCE.md.
 * 13. SHA256SUMS.txt (standard `sha256sum` format, repo-relative paths)
 *     agrees with the manifest hashes for every file, and
 *     `sha256sum -c` on it exits 0.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function findRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate project root (package.json)");
}

const ROOT = findRoot(); // 04_source/source
const WORKDIR = path.resolve(ROOT, "..", ".."); // p030-snapfence
const ZIP_PATH = path.join(WORKDIR, "04_source", "source-release.zip");
const MANIFEST_PATH = path.join(WORKDIR, "04_source", "SOURCE_MANIFEST.csv");
const SUMS_PATH = path.join(WORKDIR, "04_source", "SHA256SUMS.txt");
const ZIP_PREFIX = "snapfence-0.1.0/";

const failures: string[] = [];
const passes: string[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passes.push(name);
  } else {
    failures.push(detail ? `${name}: ${detail}` : name);
  }
}

function run(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    cwd: cwd ?? WORKDIR,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
}

/* ---- 1. ZIP exists and is intact ---- */
check("source-release.zip exists", fs.existsSync(ZIP_PATH));
let zipOk = false;
if (fs.existsSync(ZIP_PATH)) {
  try {
    run("unzip", ["-t", "-q", ZIP_PATH]);
    zipOk = true;
  } catch {
    zipOk = false;
  }
}
check("source-release.zip passes unzip -t", zipOk);

/* ---- ZIP inventory via python zipfile (one call) ---- */
interface ZipEntry {
  name: string;
  sha256: string;
  size: number;
}
let zipEntries: ZipEntry[] = [];
if (zipOk) {
  const py =
    "import json, sys, zipfile, hashlib\n" +
    "z = zipfile.ZipFile(sys.argv[1])\n" +
    "out = []\n" +
    "for i in z.infolist():\n" +
    "    if i.is_dir():\n" +
    "        continue\n" +
    "    data = z.read(i.filename)\n" +
    "    out.append({'name': i.filename, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)})\n" +
    "print(json.dumps(out))\n";
  try {
    zipEntries = JSON.parse(
      run("python3", ["-c", py, ZIP_PATH]),
    ) as ZipEntry[];
  } catch (e) {
    failures.push(`zip inventory failed: ${String(e)}`);
  }
}
const zipByName = new Map(zipEntries.map((e) => [e.name, e]));
check("zip inventory read", zipEntries.length > 0, `entries=${zipEntries.length}`);

/* ---- 2. Manifest parses ---- */
interface ManifestRow {
  zipPath: string;
  sha256: string;
  bytes: number;
  source: string;
}
let rows: ManifestRow[] = [];
if (fs.existsSync(MANIFEST_PATH)) {
  const lines = fs
    .readFileSync(MANIFEST_PATH, "utf8")
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.length > 0);
  check(
    "manifest has header path,sha256,bytes,source",
    lines[0] === "path,sha256,bytes,source",
    `header=${JSON.stringify(lines[0])}`,
  );
  for (const line of lines.slice(1)) {
    const parts = line.split(",");
    if (parts.length !== 4) {
      failures.push(`manifest malformed line: ${line}`);
      continue;
    }
    const [zipPath, sha256, bytesStr, source] = parts;
    const bytes = Number(bytesStr);
    rows.push({ zipPath, sha256, bytes, source });
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      failures.push(`manifest bad sha256 for ${zipPath}: ${sha256}`);
    }
    if (!Number.isInteger(bytes) || bytes < 0) {
      failures.push(`manifest bad bytes for ${zipPath}: ${bytesStr}`);
    }
  }
} else {
  failures.push("SOURCE_MANIFEST.csv missing");
}
check("manifest rows parsed", rows.length > 0, `rows=${rows.length}`);

/* ---- 3+4. Manifest set == ZIP set; hashes and sizes match ---- */
if (rows.length > 0 && zipEntries.length > 0) {
  const manifestNames = new Set(rows.map((r) => r.zipPath));
  const zipNames = new Set(zipEntries.map((e) => e.name));
  const missingInZip = [...manifestNames].filter((n) => !zipNames.has(n));
  const extraInZip = [...zipNames].filter((n) => !manifestNames.has(n));
  check(
    "manifest set == zip set",
    missingInZip.length === 0 && extraInZip.length === 0,
    `missing in zip: ${missingInZip.join("; ")}; extra in zip: ${extraInZip.join("; ")}`,
  );
  let hashMismatch = 0;
  let sizeMismatch = 0;
  for (const r of rows) {
    const e = zipByName.get(r.zipPath);
    if (!e) continue;
    if (e.sha256 !== r.sha256) hashMismatch++;
    if (e.size !== r.bytes) sizeMismatch++;
  }
  check(
    "manifest sha256 matches zip entries",
    hashMismatch === 0,
    `${hashMismatch} mismatches`,
  );
  check(
    "manifest bytes match zip entries",
    sizeMismatch === 0,
    `${sizeMismatch} mismatches`,
  );
  check(
    "all zip paths under snapfence-0.1.0/",
    zipEntries.every((e) => e.name.startsWith(ZIP_PREFIX)),
    "found entry outside prefix",
  );
}

/* ---- 5. Git correspondence at the PINNED freeze commit ---- */
// R1-03 (P1-R1-03): the freeze commit is pinned explicitly. The default
// is the current freeze f553a91; pass SNAPFENCE_FREEZE_COMMIT to verify
// a newer freeze candidate — a freeze commit's own script cannot name
// itself, so the freeze-time run MUST set the env var to the new freeze
// hash. There is deliberately NO fallback to HEAD: HEAD moves with every
// handoff commit, so resolving the freeze from HEAD would silently
// verify the wrong commit.
const FREEZE_COMMIT_DEFAULT = "f553a916b9d6ec6c8aa72f31f245f825e44934e3"; // f553a91
const freezeCommit =
  (process.env.SNAPFENCE_FREEZE_COMMIT ?? "").trim() || FREEZE_COMMIT_DEFAULT;
let freezeCommitValid = false;
try {
  run("git", ["cat-file", "-e", `${freezeCommit}^{commit}`]);
  freezeCommitValid = true;
} catch {
  freezeCommitValid = false;
}
check("pinned freeze commit exists", freezeCommitValid, freezeCommit);
if (freezeCommitValid && rows.length > 0) {
  let gitMismatch = 0;
  let gitMissing = 0;
  const gitRows = rows.filter((r) => r.source === "git");
  check("manifest has git-sourced rows", gitRows.length > 0, `git rows=${gitRows.length}`);
  // NOTE: a git blob id is a SHA-1 over "blob <size>\0<content>", NOT the
  // file's SHA-256. Comparing manifest hashes against `git rev-parse
  // <freeze>:path` can never match. The correct comparison is: take the blob
  // CONTENT at the pinned freeze commit (`git show <freeze>:path`) and SHA-256 it.
  for (const r of gitRows) {
    // zip path snapfence-0.1.0/04_source/source/... -> repo path 04_source/source/...
    // zip path snapfence-0.1.0/oracle/... -> repo path oracle/...
    const repoPath = r.zipPath.slice(ZIP_PREFIX.length);
    let content: Buffer | null = null;
    try {
      content = execFileSync("git", ["show", `${freezeCommit}:${repoPath}`], {
        cwd: WORKDIR,
        stdio: ["ignore", "pipe", "pipe"],
      }) as Buffer;
    } catch {
      content = null;
    }
    if (!content) {
      gitMissing++;
    } else if (
      createHash("sha256").update(content).digest("hex") !== r.sha256
    ) {
      gitMismatch++;
    }
  }
  check(
    "manifest sha256 matches pinned freeze blobs",
    gitMismatch === 0 && gitMissing === 0,
    `${gitMismatch} mismatches, ${gitMissing} missing from freeze commit`,
  );
  console.log(`  (pinned freeze commit: ${freezeCommit})`);
}

/* ---- 6. package.json + lockfile in ZIP, name/version match ---- */
const pkgEntry = zipByName.get(`${ZIP_PREFIX}04_source/source/package.json`);
const lockEntry = zipByName.get(`${ZIP_PREFIX}04_source/source/package-lock.json`);
check("package.json in zip", !!pkgEntry);
check("package-lock.json in zip", !!lockEntry);
if (pkgEntry && lockEntry) {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
  ) as { name: string; version: string };
  const lock = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"),
  ) as { name: string; version: string };
  check(
    "package.json name snapfence / version 0.1.0",
    pkg.name === "snapfence" && pkg.version === "0.1.0",
    `name=${pkg.name} version=${pkg.version}`,
  );
  check(
    "lockfile name/version match package.json",
    lock.name === pkg.name && lock.version === pkg.version,
    `lock name=${lock.name} version=${lock.version}`,
  );
}

/* ---- 7. Golden complete ---- */
const goldenNames: string[] = [];
for (let i = 1; i <= 12; i++) {
  goldenNames.push(`U${String(i).padStart(2, "0")}.json`, `G${String(i).padStart(2, "0")}.json`);
}
const goldenMissing = goldenNames.filter(
  (f) => !zipByName.has(`${ZIP_PREFIX}04_source/source/fixtures/golden/${f}`),
);
check("24 golden fixtures in zip", goldenMissing.length === 0, `missing: ${goldenMissing.join(", ")}`);
check(
  "golden manifest.json in zip",
  zipByName.has(`${ZIP_PREFIX}04_source/source/fixtures/golden/manifest.json`),
);

/* ---- 8. Oracle complete ---- */
const oracleFiles = [
  "oracle/python/snapfence_oracle.py",
  "oracle/python/independent-model.py",
  "oracle/python/README.md",
  "oracle/python/tests/__init__.py",
  "oracle/python/tests/support.py",
  "oracle/python/tests/test_oracle_cli.py",
  "oracle/python/tests/test_oracle_parity.py",
  "oracle/python/tests/test_oracle_units.py",
];
const oracleMissing = oracleFiles.filter((f) => !zipByName.has(`${ZIP_PREFIX}${f}`));
check("oracle complete (8 files) in zip", oracleMissing.length === 0, `missing: ${oracleMissing.join(", ")}`);

/* ---- 9. Forbidden entries ---- */
const forbiddenSegments = ["node_modules", "dist", ".git", ".vite", "__pycache__"];
const forbiddenFound = zipEntries.filter((e) =>
  e.name.split("/").some((seg) => forbiddenSegments.includes(seg)),
);
check("no node_modules/dist/.git/.vite/__pycache__ in zip", forbiddenFound.length === 0, forbiddenFound.map((e) => e.name).join("; "));
const badNames = zipEntries.filter((e) => {
  const base = e.name.split("/").pop() ?? "";
  return (
    base.startsWith(".env") ||
    base.endsWith(".pem") ||
    base.endsWith(".key") ||
    /credentials/i.test(base)
  );
});
check("no .env/.pem/.key/credentials file names in zip", badNames.length === 0, badNames.map((e) => e.name).join("; "));

/* ---- 10. Secret assignments in ZIP text contents ---- */
if (zipOk) {
  const pyScan =
    "import sys, zipfile, re\n" +
    "z = zipfile.ZipFile(sys.argv[1])\n" +
    "pats = [re.compile(r'api[_-]?key\\s*[:=]\\s*[\\'\"][^\\'\"]{4,}'), re.compile(r'access[_-]?token\\s*[:=]\\s*[\\'\"][^\\'\"]{4,}'), re.compile(r'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY'), re.compile(r'password\\s*=\\s*[\\'\"][^\\'\"]{4,}')]\n" +
    "hits = []\n" +
    "for i in z.infolist():\n" +
    "    if i.is_dir():\n" +
    "        continue\n" +
    "    if not i.filename.endswith(('.ts', '.tsx', '.js', '.mjs', '.json', '.md', '.html', '.css', '.py')):\n" +
    "        continue\n" +
    "    try:\n" +
    "        text = z.read(i.filename).decode('utf-8')\n" +
    "    except Exception:\n" +
    "        continue\n" +
    "    for p in pats:\n" +
    "        if p.search(text):\n" +
    "            hits.append(i.filename)\n" +
    "            break\n" +
    "print('\\n'.join(hits))\n";
  let scanHits = "";
  try {
    scanHits = run("python3", ["-c", pyScan, ZIP_PATH]).trim();
  } catch (e) {
    failures.push(`secret content scan failed: ${String(e)}`);
  }
  check("no secret assignments in zip text contents", scanHits === "", scanHits);
}

/* ---- 11. Recorded test evidence shows PASS ---- */
function mustContainFile(rel: string, needle: string, label: string): void {
  const p = path.join(WORKDIR, rel);
  if (!fs.existsSync(p)) {
    failures.push(`${label} missing: ${rel}`);
    return;
  }
  const text = fs.readFileSync(p, "utf8");
  check(`${label} contains "${needle}"`, text.includes(needle), `${rel} missing "${needle}"`);
}
mustContainFile("05_tests/test-results/full-regression.log", "455 passed", "full-regression.log");
mustContainFile("05_tests/test-results/s0-gate.log", "RESULT=PASS", "s0-gate.log (T007)");
mustContainFile("05_tests/test-results/s0-gate-t014.log", "RESULT=PASS", "s0-gate-t014.log (T014)");
mustContainFile("05_tests/test-results/s0-gate-t014.log", "14/14", "s0-gate-t014.log 14/14");
mustContainFile("05_tests/test-results/test-oracle.log", "Ran 39 tests", "test-oracle.log");
mustContainFile("05_tests/test-results/test-oracle.log", "OK", "test-oracle.log OK");
const perfPath = path.join(WORKDIR, "05_tests", "benchmark", "performance.json");
if (fs.existsSync(perfPath)) {
  const perf = JSON.parse(fs.readFileSync(perfPath, "utf8")) as {
    summary: { result: string; scenarios: number; scenariosPassed: number };
    thresholdMs: number;
  };
  check(
    "performance.json RESULT=PASS 24/24 threshold 1000",
    perf.summary.result === "PASS" &&
      perf.summary.scenarios === 24 &&
      perf.summary.scenariosPassed === 24 &&
      perf.thresholdMs === 1000,
    `result=${perf.summary.result} ${perf.summary.scenariosPassed}/${perf.summary.scenarios} threshold=${perf.thresholdMs}`,
  );
} else {
  failures.push("performance.json missing");
}

/* ---- 12. Delivery evidence exists ---- */
for (const rel of [
  "05_tests/TEST_PLAN.md",
  "06_reviews/REVIEW_COVERAGE.csv",
  "07_evidence/REVIEW_PACKS/REVIEW_INDEX.md",
  "07_evidence/REVIEW_PACKS/REVIEW_PACK_01.md",
  "07_evidence/REVIEW_PACKS/REVIEW_PACK_02.md",
  "08_release/README.md",
  "08_release/RELEASE_NOTES.md",
  "08_release/HOW_TO_REPRODUCE.md",
]) {
  check(`delivery file exists: ${rel}`, fs.existsSync(path.join(WORKDIR, rel)));
}

/* ---- 13. SHA256SUMS.txt agrees with manifest; sha256sum -c passes ---- */
if (fs.existsSync(SUMS_PATH) && rows.length > 0) {
  const sumsLines = fs
    .readFileSync(SUMS_PATH, "utf8")
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.length > 0);
  const sumsByRepo = new Map<string, string>();
  let malformed = 0;
  for (const line of sumsLines) {
    const m = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!m) {
      malformed++;
      continue;
    }
    sumsByRepo.set(m[2], m[1]);
  }
  check("SHA256SUMS.txt lines well-formed", malformed === 0, `${malformed} malformed`);
  let sumsMismatch = 0;
  for (const r of rows) {
    const repoPath = r.zipPath.slice(ZIP_PREFIX.length);
    if (sumsByRepo.get(repoPath) !== r.sha256) sumsMismatch++;
  }
  check(
    "SHA256SUMS.txt agrees with manifest",
    sumsMismatch === 0 && sumsByRepo.size === rows.length,
    `${sumsMismatch} mismatches, sums=${sumsByRepo.size} rows=${rows.length}`,
  );
  try {
    run("sha256sum", ["-c", SUMS_PATH]);
    check("sha256sum -c SHA256SUMS.txt exits 0", true);
  } catch {
    check("sha256sum -c SHA256SUMS.txt exits 0", false, "sha256sum -c failed (run from repo root)");
  }
} else {
  failures.push("SHA256SUMS.txt missing");
}

console.log(`verify:release: ${passes.length} checks passed, ${failures.length} failed`);
for (const p of passes) console.log(`  PASS ${p}`);
for (const f of failures) console.log(`  FAIL ${f}`);
if (failures.length > 0) {
  process.exit(1);
}
console.log("verify:release: RESULT=PASS");
