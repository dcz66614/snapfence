# SnapFence — Third-Party Notices

- Project: P030 SnapFence（快照栅），SPEC_VERSION 1.0.1
- Scope: every third-party package installed for this project, as resolved by
  `package-lock.json` and installed under `04_source/source/node_modules/`.
- Method: each package's `license` field was read from its own
  `node_modules/<package>/package.json` — never guessed. Versions below are
  the **installed** versions (they match `package-lock.json`).
- Totals (measured 2026-11-23): 95 installed packages — MIT 84, Apache-2.0 3,
  ISC 6, BSD-3-Clause 1, CC-BY-4.0 1. All are permissive licences.
  **No copyleft licence is present** (no GPL, LGPL, AGPL, or MPL).
- Product runtime dependencies are only `react` and `react-dom`. Everything
  else is a development-time dependency (build, types, or tests) and is not
  shipped in the product's runtime path.
- The independent Python Oracle uses only the Python standard library
  (see §3) — it has no third-party Python dependencies.

## 1. Direct dependencies (from `package.json`)

| Package | Installed version | Licence | Use |
|---|---|---|---|
| react | 19.3.1 | MIT | Runtime UI |
| react-dom | 19.3.1 | MIT | Runtime UI |
| @types/react | 19.3.0 | MIT | Development types |
| @types/react-dom | 19.3.0 | MIT | Development types |
| @vitejs/plugin-react | 5.2.0 | MIT | Development build (Vite plugin) |
| typescript | 5.9.3 | Apache-2.0 | Development types and build |
| vite | 7.3.8 | MIT | Development build |
| vitest | 4.1.12 | MIT | Development tests |

## 2. Transitive dependencies (installed, from `package-lock.json`)

The following packages are installed only as transitive dependencies of the
direct dependencies above (or of each other). Licence read from each
package's own `package.json`, as for §1.

| Package | Installed version | Licence |
|---|---|---|
| @babel/code-frame | 7.29.7 | MIT |
| @babel/compat-data | 7.29.7 | MIT |
| @babel/core | 7.29.13 | MIT |
| @babel/generator | 7.29.15 | MIT |
| @babel/helper-compilation-targets | 7.29.13 | MIT |
| @babel/helper-globals | 7.29.7 | MIT |
| @babel/helper-module-imports | 7.29.7 | MIT |
| @babel/helper-module-transforms | 7.29.14 | MIT |
| @babel/helper-plugin-utils | 7.29.7 | MIT |
| @babel/helper-string-parser | 7.29.15 | MIT |
| @babel/helper-validator-identifier | 7.29.7 | MIT |
| @babel/helper-validator-option | 7.29.7 | MIT |
| @babel/helpers | 7.29.15 | MIT |
| @babel/parser | 7.29.15 | MIT |
| @babel/plugin-transform-react-jsx-self | 7.29.7 | MIT |
| @babel/plugin-transform-react-jsx-source | 7.29.7 | MIT |
| @babel/template | 7.29.7 | MIT |
| @babel/traverse | 7.29.15 | MIT |
| @babel/types | 7.29.15 | MIT |
| @esbuild/linux-x64 | 0.28.2 | MIT |
| @jridgewell/gen-mapping | 0.3.13 | MIT |
| @jridgewell/remapping | 2.3.5 | MIT |
| @jridgewell/resolve-uri | 3.1.3 | MIT |
| @jridgewell/sourcemap-codec | 1.6.0 | MIT |
| @jridgewell/trace-mapping | 0.3.31 | MIT |
| @rolldown/pluginutils | 1.0.0-rc.3 | MIT |
| @rollup/rollup-linux-x64-gnu | 4.68.8 | MIT |
| @rollup/rollup-linux-x64-musl | 4.68.8 | MIT |
| @standard-schema/spec | 1.1.0 | MIT |
| @types/babel__core | 7.20.5 | MIT |
| @types/babel__generator | 7.27.0 | MIT |
| @types/babel__template | 7.4.4 | MIT |
| @types/babel__traverse | 7.28.0 | MIT |
| @types/chai | 5.2.3 | MIT |
| @types/deep-eql | 4.0.2 | MIT |
| @types/estree | 1.0.10 | MIT |
| @vitest/expect | 4.1.12 | MIT |
| @vitest/mocker | 4.1.12 | MIT |
| @vitest/pretty-format | 4.1.12 | MIT |
| @vitest/runner | 4.1.12 | MIT |
| @vitest/snapshot | 4.1.12 | MIT |
| @vitest/spy | 4.1.12 | MIT |
| @vitest/utils | 4.1.12 | MIT |
| assertion-error | 2.0.1 | MIT |
| baseline-browser-mapping | 2.11.39 | Apache-2.0 |
| browserslist | 4.29.6 | MIT |
| caniuse-lite | 1.0.30001827 | CC-BY-4.0 |
| chai | 6.3.0 | MIT |
| convert-source-map | 2.0.0 | MIT |
| csstype | 3.2.4 | MIT |
| debug | 4.4.3 | MIT |
| electron-to-chromium | 1.5.492 | ISC |
| es-module-lexer | 2.3.2 | MIT |
| esbuild | 0.28.2 | MIT |
| escalade | 3.2.0 | MIT |
| estree-walker | 3.0.3 | MIT |
| expect-type | 1.4.0 | Apache-2.0 |
| fdir | 6.5.0 | MIT |
| gensync | 1.0.0-beta.2 | MIT |
| js-tokens | 4.0.0 | MIT |
| jsesc | 3.1.0 | MIT |
| json5 | 2.2.3 | MIT |
| lru-cache | 5.1.1 | ISC |
| magic-string | 0.30.21 | MIT |
| ms | 2.1.3 | MIT |
| nanoid | 3.3.20 | MIT |
| node-releases | 2.0.65 | MIT |
| obug | 2.2.1 | MIT |
| pathe | 2.0.3 | MIT |
| picocolors | 1.1.1 | ISC |
| picomatch | 4.0.7 | MIT |
| postcss | 8.5.33 | MIT |
| react-refresh | 0.18.0 | MIT |
| rollup | 4.68.8 | MIT |
| scheduler | 0.28.0 | MIT |
| semver | 6.3.2 | ISC |
| siginfo | 2.0.0 | ISC |
| source-map-js | 1.2.4 | BSD-3-Clause |
| stackback | 0.0.2 | MIT |
| std-env | 4.3.0 | MIT |
| tinybench | 2.9.0 | MIT |
| tinyexec | 1.3.1 | MIT |
| tinyglobby | 0.2.17 | MIT |
| tinyrainbow | 3.2.0 | MIT |
| update-browserslist-db | 1.4.0 | MIT |
| why-is-node-running | 2.3.0 | MIT |
| yallist | 3.1.1 | ISC |

## 3. Independent Python Oracle

The Oracle (`oracle/python/snapfence_oracle.py`,
`oracle/python/independent-model.py`, `oracle/python/tests/`) is a
development-time test oracle only — it is not a product runtime dependency
(PROJECT_BOOK.md §7.1).

- The Oracle itself imports only the Python standard library:
  `json`, `sys`, `pathlib`, `importlib.util`
  (`independent-model.py` additionally uses `from __future__ import annotations`).
- The Oracle test suite additionally uses only standard-library modules
  (`unittest`, `ast`, `time`); `subprocess` is imported only by
  `oracle/python/tests/test_oracle_cli.py`, the CLI test harness, which runs
  the Oracle as a subprocess in order to test it — the Oracle itself never
  spawns a child process.
- **No third-party Python package is used anywhere in the Oracle.**

## 4. Licence notes

- `caniuse-lite` (CC-BY-4.0): a data licence covering browser-compatibility
  data used by the build toolchain; it is not a code licence.
- `source-map-js` (BSD-3-Clause), `typescript`, `baseline-browser-mapping`,
  `expect-type` (Apache-2.0), and the six ISC-licensed packages
  (`electron-to-chromium`, `lru-cache`, `picocolors`, `semver`, `siginfo`,
  `yallist`) are all permissive licences compatible with MIT-licensed
  distribution. No attribution beyond the notices in this file is required
  by any of them for this use.
- Full licence texts are available in each package's own directory under
  `node_modules/<package>/` (usually `LICENSE` or `LICENSE.md`).
- Re-verify: re-run the installed-package enumeration
  (read every `node_modules/**/package.json` `license` field) after any
  dependency change; `npm run verify:license` asserts the direct
  dependencies in §1 are present here with matching installed versions.
