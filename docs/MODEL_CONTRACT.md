# SnapFence — Model Contract (T001, frozen)

- Project: P030 SnapFence, SPEC_VERSION 1.0.1 (ADR-001: Scenario.snapshotsAfter added; see I-06)
- Authority: `01_project_book/PROJECT_BOOK.md` §3–§4, §8–§9
- Code: `04_source/source/src/core/model/` — `types.ts`, `scenario.ts`, `contracts.ts`
- Status: FROZEN by T001. Any change to the rules below needs an ADR and a
  SPEC_VERSION bump (IMPLEMENTATION_PLAN.md §14.2).

## 1. The two state components (§3.1, §4.1)

The system state is `S = (D, B, Q)` (`SystemState` in `types.ts`).

### Component A — Database state (`DatabaseState`)

```
fileId -> BlobReference { objectId, generation, digest }
```

- One record per file. Each record references exactly one Blob object version.
- Expressed as a plain `Record<string, BlobReference>` so it serialises to JSON
  unchanged inside `SearchResult`.
- Independently expressible from the Blob state: a `DatabaseState` value is
  meaningful on its own (it is what a DB snapshot captures).

### Component B — Blob state (`BlobState`)

```
(objectId, generation) -> digest
```

- One entry per object version. The composite key is the frozen string format
  `"<objectId>@<generation>"` (`BlobVersionKey`, built only via `blobVersionKey()`
  in `types.ts`). Synthetic fixture objectIds must not contain `"@"`.
- Expressed as a plain `Record<BlobVersionKey, string>` so it serialises to JSON
  unchanged inside `SearchResult`.
- Independently expressible from the database state: a `BlobState` value is
  meaningful on its own (it is what a Blob snapshot captures).

### MVP limits (§3.1)

Each file record references an independent object version. The model does NOT
implement shared Blobs, cross-file deduplication, or object reference counting.

## 2. Logical operations and operation boundaries (§3.2, §4.2)

Every logical operation expands to a fixed, ordered list of atomic events.
No step may be skipped or reordered. A logical operation counts as complete
only when ALL of its events have executed.

| Operation | Template (frozen, `OPERATION_TEMPLATES` in `scenario.ts`) |
|---|---|
| UPLOAD | `BLOB_PUT -> DB_LINK` |
| DELETE | `DB_UNLINK -> BLOB_DELETE` |
| UPDATE | `BLOB_PUT_NEW -> DB_REPOINT -> BLOB_DELETE_OLD` |

- UPLOAD: write the file object, then create the DB record + reference. Before
  `DB_LINK`, the intermediate state is NOT a committed application state.
- DELETE: remove the DB reference first, then delete the Blob object. This is
  this project's synthetic immediate-delete template; it does not claim Immich,
  Paperless-ngx, or any other application uses this internal order. Delayed
  garbage collection, trash/recycle bins, and retention windows are out of MVP.
- UPDATE: write the new object version, repoint the DB reference to it, then
  delete the old object. Until all three steps finish, the operation is in flight.

### Operation boundary (§4.2)

A state is a legal operation boundary only when EVERY logical operation is
either not started or fully completed. Any partially completed operation makes
the state in-flight — even if both snapshots happen to capture that same
intermediate state, it must never be judged a complete committed state.
Boundaries are represented by `OperationBoundary` (`boundaryIndex` 0 = initial
state, plus the database/blob states and the completed / not-started op ids).

## 3. Backup strategies (§3.3)

| Strategy | Constraint (frozen, `STRATEGY_SNAPSHOT_ORDER` in `scenario.ts`) |
|---|---|
| `DB_FIRST` | `DB_SNAPSHOT < BLOB_SNAPSHOT`; writes may continue between the snapshots |
| `FILE_FIRST` | `BLOB_SNAPSHOT < DB_SNAPSHOT`; writes may continue between the snapshots |
| `PAUSE_WRITES` | All started operations must finish first; NO data-modifying event may occur between the two snapshots; writes resume only after both snapshots |

- The three strategies are separate literal values of `BackupStrategy`; they are
  scheduling constraints in the model, not automatic detection of how a real
  application behaves.
- `PAUSE_WRITES` imposes no fixed order between the two snapshots (its order
  entry is `null`); its constraint is the pause itself. If the pause conditions
  cannot be proven, the strategy must NOT be judged safe.
- The fixed orders for `DB_FIRST` / `FILE_FIRST` are about snapshot events only;
  data events may interleave around them subject to the operation templates
  and the event dependency DAG (T002/T003).

## 4. Snapshot consistency invariant (§4.3)

Let `D_s` = database snapshot, `B_s` = Blob snapshot. The snapshot pair is
consistent **iff** there exists a legal operation boundary `k` with
`D_s = D(k)` AND `B_s = B(k)` — both snapshots must correspond to the SAME
complete operation boundary. At that boundary it must also hold that:

- every database reference resolves to an existing Blob object version;
- object generation and digest agree between the two components;
- no committed Blob exists that no database record references;
- no logical operation is unfinished.

This is stricter than checking references or file hashes alone.

## 5. Diagnostic codes (§4.4) and verdicts (§4.7)

### Diagnostic codes — exactly these six (`DiagnosticCode`)

| Code | Meaning | Severity |
|---|---|---|
| `DANGLING_REFERENCE` | DB references an object that does not exist | CRITICAL |
| `ORPHAN_BLOB` | Blob snapshot holds an object no DB record references | WARNING |
| `GENERATION_MISMATCH` | DB-referenced generation differs from Blob generation | CRITICAL |
| `DIGEST_MISMATCH` | Object digest differs from the DB record | CRITICAL |
| `IN_FLIGHT_OPERATION` | Captured state contains an unfinished operation | WARNING |
| `NO_COMMON_BOUNDARY` | No legal operation boundary matches both snapshots | CRITICAL |

Severity is user impact only, not the verdict driver: an orphan Blob is NOT
necessarily lost user data (§4.4 — it may be re-importable or cleanable residue),
while a dangling reference means the DB points at a missing object. Multiple
diagnostics may coexist (e.g. scenario A yields `ORPHAN_BLOB` +
`NO_COMMON_BOUNDARY`); the verdict is driven by whether an inconsistent path
exists / no common boundary exists (§4.7), not by any single severity.

### Verdicts — exactly these four (`SearchVerdict`)

| Verdict | Meaning |
|---|---|
| `SAFE_WITHIN_BOUND` | All legal paths within the bound satisfy snapshot consistency. Bounded only — it does NOT mean the real production system is safe. |
| `UNSAFE_WITHIN_BOUND` | At least one inconsistent path exists; a counterexample is produced. |
| `INCONCLUSIVE_LIMIT` | Input exceeds the supported bounded search size. Must never be silently downgraded to SAFE. |
| `INVALID_INPUT` | Event DAG, operation dependencies, or strategy input is illegal. Invalid input is reported, never silently ignored (§8.6). |

## 6. Search contract (§4.5, §4.6)

- Deterministic BFS over bounded interleavings; no randomness, no wall-clock
  time, no object traversal order may influence results.
- Candidates are processed in fixed event-ID order; state dedup keys include
  the executed event set, current DB state, current Blob state, both snapshot
  captures, and per-operation completion status.
- The first inconsistent path BFS finds has minimal event length. Ties are
  broken by fixed lexicographic order of event IDs, so identical input always
  yields the identical counterexample.
- A counterexample carries: the event order, each event's input/output state,
  the database and Blob snapshot contents, the diagnostic(s), the first
  operation that caused the integrity failure, and the length
  (`Counterexample` in `types.ts`; `SearchResult.counterexample` is the event
  ID list and `counterexampleLength` its length, 0 when none).

## 7. Scenario input contract (§8.1, §8.6, §9 samples)

```ts
interface Scenario {
  scenarioId: string;
  strategy: BackupStrategy;
  operations: LogicalOperation[];
  maxEvents: number;
  snapshotsAfter?: string[]; // ADR-001 (SPEC_VERSION 1.0.1), see I-06
}
```

- `snapshotsAfter` (ADR-001, SPEC_VERSION 1.0.1, see I-06): the opIds that
  must all be COMPLETED before either snapshot event may execute. Absent
  (or empty) means no placement constraint (full interleaving, as in
  U01–U12); every listed opId must exist in `operations`, otherwise
  INVALID_INPUT.

- `maxEvents` counts atomic events INCLUDING the two snapshot events (§10.3;
  G12: 8 modifying events + 2 snapshot events = 10). The frozen bound is
  `MAX_EVENTS = 10` (`scenario.ts`); `exceedsEventBound()` reports overflow.
- Operation shapes follow the §9 samples exactly:
  - UPLOAD: `{ opId, kind: "UPLOAD", fileId, objectId, digest }`
  - DELETE: `{ opId, kind: "DELETE", fileId, objectId }` (no digest in the sample)
  - UPDATE: `{ opId, kind: "UPDATE", fileId, objectId (new), oldObjectId, digest (new) }`
- §8.6 constraints (enforced by `validateScenario`, T002): IDs explicit; event
  dependencies form a legal DAG; no cycles; no reference to a nonexistent
  object version; no duplicate event ID; no exceeding the bounded event count;
  no silently ignored invalid input.

## 8. Frozen interfaces (§9.1 of IMPLEMENTATION_PLAN.md)

Declared as types only in `src/core/model/contracts.ts` (no implementations,
no runtime stubs — implementations land in T002/T003/T004/T009 and must
satisfy these types):

```ts
validateScenario(scenario: Scenario): ValidationResult
runSearch(scenario: Scenario): SearchResult
checkConsistency(databaseSnapshot: DatabaseState, blobSnapshot: BlobState,
                 boundaries: readonly OperationBoundary[]): ConsistencyResult
extractCounterexample(searchTrace: SearchTrace): Counterexample
exportJson(result: SearchResult): string
exportHtml(result: SearchResult): string
```

Also available as the single `SnapFenceCore` interface. No module may rename a
method, change a parameter, or add a required parameter.

Supporting result types frozen by T001 (referenced by §9.1 but not spelled out
in PROJECT_BOOK.md §8): `ValidationResult` / `ValidationIssue`
(`ValidationIssueCode` derived from the §8.6 constraints), `ConsistencyResult`,
`SearchTrace` / `SearchTraceStep`, `Counterexample`, `OperationBoundary`,
`SystemState`, `OperationStatus`. All live in `types.ts`.

## 9. T001 interpretations (not in the book — frozen here, flagged for review)

The book leaves the following points unspecified; T001 freezes them as stated
so that T002/T003/T005 have a deterministic basis. None of them changes any
book rule; each is marked here so the final review can confirm or revise it
via ADR.

- **I-01 — No `initialState` field.** `Scenario` (§8.1) carries no initial
  state. The initial state is therefore derived from the operations (see I-02).
- **I-02 — Implied pre-existing records.** A DELETE or UPDATE operation
  implies its referenced file already exists before the scenario starts: the
  initial `DatabaseState` contains `fileId -> { objectId, generation: 1, digest }`
  and the initial `BlobState` contains `(objectId, 1) -> digest`. The digest is
  taken from the operation when given (`DeleteOperation.digest`,
  `UpdateOperation.oldDigest` — both optional, so the §9 samples stay valid
  as written); when omitted, T002 derives it deterministically (same value in
  both components, so the implied pre-state is consistent by construction).
  The pre-existing generation is 1 by convention.
- **R-GEN-1 — Upload generation.** An UPLOAD creates its object version at
  generation 1.
- **R-GEN-2 — Update generation.** An UPDATE creates its new object version at
  old generation + 1, where the old generation is the generation of the
  pre-existing reference (1 for an implied pre-existing record per I-02, or
  the generation created by an earlier UPLOAD of the same file in the same
  scenario). The old version is deleted by `BLOB_DELETE_OLD`.
- **I-03 — `BlobState` key format.** `(objectId, generation)` is encoded as
  the string `"<objectId>@<generation>"`. Fixture objectIds must not contain
  `"@"`. This keeps both state components plain JSON-serialisable records,
  matching the `SearchResult` JSON export (§8.4).
- **I-04 — `PAUSE_WRITES` snapshot order.** No fixed order between the two
  snapshot events (order entry `null`); the pause constraint is enforced
  separately by the search (T003), never by assuming an order.
- **I-05 — Placeholder npm scripts.** `test:events`, `test:search`,
  `test:invariants`, `test:golden`, `test:export`, `test:ui`,
  `test:integration`, `s0:gate`, `bench:10-events`, `verify:release` exist in
  `package.json` but currently print `NOT_IMPLEMENTED: <owning task>` and exit
  1, so they can never be mistaken for passing. Only `typecheck` is real in
  T001. Each owning task replaces its placeholder with the real command.
- **I-06 — `snapshotsAfter` snapshot-placement constraint (ADR-001,
  SPEC_VERSION 1.0.1).** `Scenario.snapshotsAfter` is an optional list of
  opIds. When present and non-empty, a snapshot event (`DB_SNAPSHOT` /
  `BLOB_SNAPSHOT`) is eligible as a BFS candidate ONLY when every listed
  operation is COMPLETED in the current state (`operationStatus`); the
  constraint only tightens the candidate set (§4.5) and changes nothing
  else — not the §4.5 BFS order, not the §4.6 shortest-counterexample
  rule, not the §4.7 verdict literals, and not the dependency DAG. When
  absent (or empty), there is no constraint: snapshots may appear at any
  legal position (full interleaving; U01–U12 behaviour unchanged). Every
  listed opId must exist in `operations`; a scenario listing an unknown
  opId is INVALID_INPUT (rejected by `validateScenario` with the existing
  unknown-reference code `UNKNOWN_OBJECT_VERSION`, naming the unknown
  opId). Purpose: G02–G04 / G06–G08 express "backup after this single
  operation completes" and are SAFE; U01–U12 omit the field and stay
  UNSAFE under full interleaving. This resolves the T003 L-08 tension.
  The concrete-sequence checker (`validateEventSequence`) enforces the
  same rule with issue code `SNAPSHOT_PLACEMENT_VIOLATED`, so a sequence
  and the BFS enumeration can never disagree about placement.

## 10. Honest boundary (§6 — restated, not weakened)

Within the given synthetic model, event templates, and search bound, SnapFence
can deterministically enumerate legal interleavings, judge whether two snapshots
share one complete operation boundary, identify dangling references / orphan
Blobs / generation and digest mismatches, and find the shortest inconsistent
event sequence with repeatable results. It CANNOT prove that a real
application's transactions are correct, that a real backup program executed
the snapshots as modelled, that a real write-pause drained all background work,
or that behaviour beyond the 10-event bound is safe. `SAFE_WITHIN_BOUND` means
"no inconsistent path was found inside this bound", never "this application
cannot suffer backup inconsistency in real operation".
