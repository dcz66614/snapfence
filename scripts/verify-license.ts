/**
 * P030-T013 verify:license — licence assertions for SnapFence.
 *
 * Checks (all must pass; any failure exits 1):
 *  1. LICENSE contains the MIT licence text and the SnapFence copyright line.
 *  2. Every dependency and devDependency named in package.json appears in
 *     THIRD_PARTY_NOTICES.md (section 1 table).
 *  3. The version recorded for each direct dependency in
 *     THIRD_PARTY_NOTICES.md equals the installed version in node_modules
 *     (read from that package's own package.json — never guessed).
 *
 * This script is a deterministic text/parse check. It does not re-audit
 * transitive dependencies (their licences were read from each package's own
 * package.json when THIRD_PARTY_NOTICES.md was written; re-run that
 * enumeration after any dependency change — see L-T013-02).
 */

import * as fs from "node:fs";
import * as path from "node:path";
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

const ROOT = findRoot();

const failures: string[] = [];
const passes: string[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passes.push(name);
  } else {
    failures.push(detail ? `${name}: ${detail}` : name);
  }
}

const pkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const licenseText = fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8");
const notices = fs.readFileSync(
  path.join(ROOT, "THIRD_PARTY_NOTICES.md"),
  "utf8",
);

// 1. LICENSE is the MIT text with the SnapFence copyright line.
check(
  'LICENSE contains "MIT License"',
  licenseText.includes("MIT License"),
  "LICENSE is missing the MIT License heading",
);
check(
  'LICENSE contains "Permission is hereby granted, free of charge"',
  licenseText.includes("Permission is hereby granted, free of charge"),
  "LICENSE is missing the MIT grant clause",
);
check(
  'LICENSE contains "Copyright (c) 2026 SnapFence Contributors"',
  licenseText.includes("Copyright (c) 2026 SnapFence Contributors"),
  "LICENSE is missing the SnapFence copyright line",
);

// 2 + 3. Every direct dependency is listed with the installed version.
const directDeps: string[] = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
];
check(
  "package.json has direct dependencies to check",
  directDeps.length > 0,
  "no dependencies or devDependencies in package.json",
);

// Parse the section-1 table rows: "| name | version | licence | use |".
const rowRe = /^\| ([^|]+) \| ([^|]+) \| ([^|]+) \|/gm;
const recorded = new Map<string, string>();
for (const m of notices.matchAll(rowRe)) {
  const name = m[1].trim();
  const version = m[2].trim();
  if (name === "Package") continue;
  recorded.set(name, version);
}

for (const dep of directDeps.sort()) {
  const present = recorded.has(dep);
  check(
    `THIRD_PARTY_NOTICES.md lists "${dep}"`,
    present,
    `"${dep}" is missing from THIRD_PARTY_NOTICES.md`,
  );
  if (!present) continue;
  const installedPkg = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, "node_modules", dep, "package.json"),
      "utf8",
    ),
  ) as { version: string };
  const recordedVersion = recorded.get(dep) as string;
  check(
    `"${dep}" recorded version ${recordedVersion} matches installed ${installedPkg.version}`,
    recordedVersion === installedPkg.version,
    `recorded ${recordedVersion} != installed ${installedPkg.version}`,
  );
}

console.log(
  `verify:license: ${passes.length} checks passed, ${failures.length} failed`,
);
for (const p of passes) console.log(`  PASS ${p}`);
for (const f of failures) console.log(`  FAIL ${f}`);
if (failures.length > 0) {
  process.exit(1);
}
console.log("verify:license: RESULT=PASS");
