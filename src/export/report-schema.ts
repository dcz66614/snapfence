/**
 * SnapFence (P030) — report schema `snapfence.report/v1`. T009.
 *
 * Authority: PROJECT_BOOK.md §8.4 (SearchResult fields, schemaVersion
 * "snapfence.report/v1"), §4.4 (six diagnostic codes, verbatim), §4.7
 * (four verdict literals, verbatim), §8.5 (Diagnostic fields), §11.2
 * (exported HTML must be self-contained and correctly escaped).
 *
 * This module is the single source of truth for the report shape:
 * - the frozen literal vocabularies (diagnostic codes, verdicts, severities);
 * - a JSON Schema (draft 2020-12 style, plain data — no validator
 *   dependency) describing a valid `snapfence.report/v1` document;
 * - a dependency-free, deterministic `validateReport` that checks an
 *   unknown value against that schema, including the cross-field rules
 *   the JSON Schema alone cannot express (`counterexampleLength` must
 *   equal `counterexample.length`; each diagnostic's severity must be
 *   the frozen severity for its code).
 *
 * Rules for this file:
 * - TypeScript strict mode; `any` is forbidden.
 * - Pure deterministic functions only; no randomness, no wall-clock, no I/O.
 * - No dependency on `src/core/` semantics: the schema validates the
 *   report shape only. `runSearch` / `SearchResult` contracts are reused
 *   by the exporters, never redefined here.
 */

/** The fixed report schema version (PROJECT_BOOK.md §8.4, verbatim). */
export const REPORT_SCHEMA_VERSION = "snapfence.report/v1" as const;

/** Schema identifier carried in exported JSON documents. */
export const REPORT_SCHEMA_ID = "https://snapfence.local/schemas/report/v1.json";

/** All six diagnostic codes (PROJECT_BOOK.md §4.4, verbatim, no others). */
export const DIAGNOSTIC_CODES = [
  "DANGLING_REFERENCE",
  "ORPHAN_BLOB",
  "GENERATION_MISMATCH",
  "DIGEST_MISMATCH",
  "IN_FLIGHT_OPERATION",
  "NO_COMMON_BOUNDARY",
] as const;

/** Diagnostic code type, re-exported from the frozen vocabulary. */
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

/** All four search verdict literals (PROJECT_BOOK.md §4.7, verbatim). */
export const SEARCH_VERDICTS = [
  "SAFE_WITHIN_BOUND",
  "UNSAFE_WITHIN_BOUND",
  "INCONCLUSIVE_LIMIT",
  "INVALID_INPUT",
] as const;

/** Search verdict type, re-exported from the frozen vocabulary. */
export type SearchVerdict = (typeof SEARCH_VERDICTS)[number];

/** Backup strategies (PROJECT_BOOK.md §8.2, verbatim). */
export const BACKUP_STRATEGIES = ["DB_FIRST", "FILE_FIRST", "PAUSE_WRITES"] as const;

/** Diagnostic severities (PROJECT_BOOK.md §8.5). */
export const DIAGNOSTIC_SEVERITIES = ["CRITICAL", "WARNING"] as const;

/**
 * Frozen severity for each diagnostic code (PROJECT_BOOK.md §4.4).
 * Mirrors `DIAGNOSTIC_SEVERITY` in src/core/search/search-result.ts;
 * duplicated here deliberately so the schema module has no runtime
 * dependency on the search module — a report must be validatable
 * without importing the search engine.
 */
export const DIAGNOSTIC_SEVERITY: Readonly<Record<DiagnosticCode, "CRITICAL" | "WARNING">> = {
  DANGLING_REFERENCE: "CRITICAL",
  ORPHAN_BLOB: "WARNING",
  GENERATION_MISMATCH: "CRITICAL",
  DIGEST_MISMATCH: "CRITICAL",
  IN_FLIGHT_OPERATION: "WARNING",
  NO_COMMON_BOUNDARY: "CRITICAL",
} as const;

// ---------------------------------------------------------------------------
// JSON Schema for snapfence.report/v1
// ---------------------------------------------------------------------------

/**
 * JSON Schema (draft 2020-12) for a `snapfence.report/v1` document.
 * Plain JSON data: it is embedded verbatim in exported JSON reports
 * (under no key — it describes the document) and is also returned by
 * `getReportJsonSchema()` for tooling. Field order follows
 * PROJECT_BOOK.md §8.4. `additionalProperties: false` is set at the
 * top level and inside every nested object so a report cannot silently
 * carry undeclared fields.
 */
export const REPORT_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: REPORT_SCHEMA_ID,
  title: "SnapFence report",
  description:
    "Machine-readable SnapFence search report (PROJECT_BOOK.md §8.4). " +
    "SAFE_WITHIN_BOUND is bounded only: it does not prove the real production system is safe (§4.7, §6).",
  type: "object",
  required: [
    "schemaVersion",
    "scenarioId",
    "strategy",
    "verdict",
    "eventCount",
    "counterexample",
    "counterexampleLength",
    "diagnostics",
    "databaseSnapshot",
    "blobSnapshot",
    "assumptions",
    "limitations",
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: REPORT_SCHEMA_VERSION },
    scenarioId: { type: "string", minLength: 1 },
    strategy: { type: "string", enum: [...BACKUP_STRATEGIES] },
    verdict: { type: "string", enum: [...SEARCH_VERDICTS] },
    eventCount: { type: "integer", minimum: 0 },
    counterexample: {
      type: "array",
      items: { type: "string" },
    },
    counterexampleLength: { type: "integer", minimum: 0 },
    diagnostics: {
      type: "array",
      items: {
        type: "object",
        required: ["code", "severity", "message"],
        additionalProperties: false,
        properties: {
          code: { type: "string", enum: [...DIAGNOSTIC_CODES] },
          severity: { type: "string", enum: [...DIAGNOSTIC_SEVERITIES] },
          fileId: { type: "string" },
          objectId: { type: "string" },
          message: { type: "string" },
        },
      },
    },
    databaseSnapshot: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["objectId", "generation", "digest"],
        additionalProperties: false,
        properties: {
          objectId: { type: "string" },
          generation: { type: "integer", minimum: 1 },
          digest: { type: "string" },
        },
      },
    },
    blobSnapshot: {
      type: "object",
      additionalProperties: { type: "string" },
    },
    assumptions: {
      type: "array",
      items: { type: "string" },
    },
    limitations: {
      type: "array",
      items: { type: "string" },
    },
  },
} as const;

/** Return a deep copy of the JSON Schema (callers must not mutate it). */
export function getReportJsonSchema(): unknown {
  return JSON.parse(JSON.stringify(REPORT_JSON_SCHEMA)) as unknown;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Result of `validateReport`. `errors` is empty exactly when valid. */
export interface ReportValidationResult {
  valid: boolean;
  errors: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDiagnosticCode(value: unknown): value is DiagnosticCode {
  return (
    typeof value === "string" &&
    (DIAGNOSTIC_CODES as readonly string[]).includes(value)
  );
}

/**
 * Validate an unknown value against `snapfence.report/v1`.
 *
 * Checks, in order: the value is an object with exactly the twelve §8.4
 * fields (no missing, no extra); `schemaVersion` is the fixed literal;
 * `scenarioId` is a non-empty string; `strategy` / `verdict` are frozen
 * literals; `eventCount` / `counterexampleLength` are non-negative
 * integers; `counterexample` is a string array whose length equals
 * `counterexampleLength`; every diagnostic carries a frozen code, the
 * frozen severity for that code, a string message, and only string
 * `fileId` / `objectId` when present; every database record carries
 * `objectId` / `generation` (>= 1) / `digest` and nothing else; every
 * Blob entry maps a version key to a digest string; `assumptions` and
 * `limitations` are string arrays.
 *
 * The validator never throws on malformed input: every failure is
 * reported as an entry in `errors`.
 */
export function validateReport(value: unknown): ReportValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { valid: false, errors: ["report must be a JSON object"] };
  }

  const required = [
    "schemaVersion",
    "scenarioId",
    "strategy",
    "verdict",
    "eventCount",
    "counterexample",
    "counterexampleLength",
    "diagnostics",
    "databaseSnapshot",
    "blobSnapshot",
    "assumptions",
    "limitations",
  ] as const;
  for (const field of required) {
    if (!(field in value)) {
      errors.push(`missing required field: ${field}`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!(required as readonly string[]).includes(key)) {
      errors.push(`unexpected field: ${key}`);
    }
  }
  if (errors.length > 0) {
    return { valid: false, errors };
  }

  if (value.schemaVersion !== REPORT_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion must be ${JSON.stringify(REPORT_SCHEMA_VERSION)}, got ${JSON.stringify(value.schemaVersion)}`,
    );
  }
  if (typeof value.scenarioId !== "string" || value.scenarioId.length === 0) {
    errors.push("scenarioId must be a non-empty string");
  }
  if (
    typeof value.strategy !== "string" ||
    !(BACKUP_STRATEGIES as readonly string[]).includes(value.strategy)
  ) {
    errors.push(`strategy must be one of ${BACKUP_STRATEGIES.join(", ")}`);
  }
  if (
    typeof value.verdict !== "string" ||
    !(SEARCH_VERDICTS as readonly string[]).includes(value.verdict)
  ) {
    errors.push(`verdict must be one of ${SEARCH_VERDICTS.join(", ")}`);
  }
  if (
    typeof value.eventCount !== "number" ||
    !Number.isInteger(value.eventCount) ||
    value.eventCount < 0
  ) {
    errors.push("eventCount must be a non-negative integer");
  }
  if (!Array.isArray(value.counterexample)) {
    errors.push("counterexample must be an array of strings");
  } else {
    for (const [index, eventId] of value.counterexample.entries()) {
      if (typeof eventId !== "string") {
        errors.push(`counterexample[${index}] must be a string`);
      }
    }
  }
  if (
    typeof value.counterexampleLength !== "number" ||
    !Number.isInteger(value.counterexampleLength) ||
    value.counterexampleLength < 0
  ) {
    errors.push("counterexampleLength must be a non-negative integer");
  } else if (
    Array.isArray(value.counterexample) &&
    value.counterexampleLength !== value.counterexample.length
  ) {
    errors.push(
      `counterexampleLength (${value.counterexampleLength}) must equal counterexample.length (${value.counterexample.length})`,
    );
  }

  if (!Array.isArray(value.diagnostics)) {
    errors.push("diagnostics must be an array");
  } else {
    for (const [index, diagnostic] of value.diagnostics.entries()) {
      const label = `diagnostics[${index}]`;
      if (!isRecord(diagnostic)) {
        errors.push(`${label} must be an object`);
        continue;
      }
      for (const key of Object.keys(diagnostic)) {
        if (!["code", "severity", "fileId", "objectId", "message"].includes(key)) {
          errors.push(`${label} has unexpected field: ${key}`);
        }
      }
      if (!isDiagnosticCode(diagnostic.code)) {
        errors.push(
          `${label}.code must be one of ${DIAGNOSTIC_CODES.join(", ")}`,
        );
        continue;
      }
      if (diagnostic.severity !== DIAGNOSTIC_SEVERITY[diagnostic.code]) {
        errors.push(
          `${label}.severity must be ${DIAGNOSTIC_SEVERITY[diagnostic.code]} for code ${diagnostic.code}`,
        );
      }
      if (typeof diagnostic.message !== "string") {
        errors.push(`${label}.message must be a string`);
      }
      if (diagnostic.fileId !== undefined && typeof diagnostic.fileId !== "string") {
        errors.push(`${label}.fileId must be a string when present`);
      }
      if (diagnostic.objectId !== undefined && typeof diagnostic.objectId !== "string") {
        errors.push(`${label}.objectId must be a string when present`);
      }
    }
  }

  if (!isRecord(value.databaseSnapshot)) {
    errors.push("databaseSnapshot must be an object");
  } else {
    for (const [fileId, reference] of Object.entries(value.databaseSnapshot)) {
      const label = `databaseSnapshot[${JSON.stringify(fileId)}]`;
      if (!isRecord(reference)) {
        errors.push(`${label} must be an object`);
        continue;
      }
      for (const key of Object.keys(reference)) {
        if (!["objectId", "generation", "digest"].includes(key)) {
          errors.push(`${label} has unexpected field: ${key}`);
        }
      }
      if (typeof reference.objectId !== "string") {
        errors.push(`${label}.objectId must be a string`);
      }
      if (
        typeof reference.generation !== "number" ||
        !Number.isInteger(reference.generation) ||
        reference.generation < 1
      ) {
        errors.push(`${label}.generation must be an integer >= 1`);
      }
      if (typeof reference.digest !== "string") {
        errors.push(`${label}.digest must be a string`);
      }
    }
  }

  if (!isRecord(value.blobSnapshot)) {
    errors.push("blobSnapshot must be an object");
  } else {
    for (const [key, digest] of Object.entries(value.blobSnapshot)) {
      if (typeof digest !== "string") {
        errors.push(`blobSnapshot[${JSON.stringify(key)}] must be a string digest`);
      }
    }
  }

  for (const field of ["assumptions", "limitations"] as const) {
    const list = value[field];
    if (!Array.isArray(list)) {
      errors.push(`${field} must be an array of strings`);
    } else {
      for (const [index, entry] of list.entries()) {
        if (typeof entry !== "string") {
          errors.push(`${field}[${index}] must be a string`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
