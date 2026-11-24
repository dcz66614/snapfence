/**
 * SnapFence (P030) — T003 unit-test scenario helpers (not a test file).
 * Synthetic scenarios only; every digest is a fixed fixture string.
 */
import type { BackupStrategy, Scenario } from "../../../src/core/model/types";

/** §9.1 scenario A: one upload, DB_FIRST. */
export function uploadScenarioA(strategy: BackupStrategy = "DB_FIRST"): Scenario {
  return {
    scenarioId: "U01_DB_FIRST_UPLOAD_ORPHAN",
    strategy,
    maxEvents: 10,
    operations: [
      { opId: "upload-A", kind: "UPLOAD", fileId: "A", objectId: "A-v1", digest: "fixture-digest-A" },
    ],
  };
}

/** §9.2 scenario B: one upload, FILE_FIRST. */
export function uploadScenarioB(strategy: BackupStrategy = "FILE_FIRST"): Scenario {
  return {
    scenarioId: "U07_FILE_FIRST_UPLOAD_DANGLING",
    strategy,
    maxEvents: 10,
    operations: [
      { opId: "upload-B", kind: "UPLOAD", fileId: "B", objectId: "B-v1", digest: "fixture-digest-B" },
    ],
  };
}

/** §9.3 scenario C: one delete, DB_FIRST. */
export function deleteScenarioC(strategy: BackupStrategy = "DB_FIRST"): Scenario {
  return {
    scenarioId: "U02_DB_FIRST_DELETE_DANGLING",
    strategy,
    maxEvents: 10,
    operations: [{ opId: "delete-C", kind: "DELETE", fileId: "C", objectId: "C-v1" }],
  };
}

/** One update of file A (implied pre-existing A-v1), any strategy. */
export function updateScenario(strategy: BackupStrategy): Scenario {
  return {
    scenarioId: `UPDATE_A_${strategy}`,
    strategy,
    maxEvents: 10,
    operations: [
      {
        opId: "update-A",
        kind: "UPDATE",
        fileId: "A",
        objectId: "A-v2",
        oldObjectId: "A-v1",
        digest: "fixture-digest-A-v2",
      },
    ],
  };
}

/** Two independent uploads (different files), any strategy. */
export function twoUploadScenario(strategy: BackupStrategy): Scenario {
  return {
    scenarioId: `TWO_UPLOADS_${strategy}`,
    strategy,
    maxEvents: 10,
    operations: [
      { opId: "upload-A", kind: "UPLOAD", fileId: "A", objectId: "A-v1", digest: "fixture-digest-A" },
      { opId: "upload-B", kind: "UPLOAD", fileId: "B", objectId: "B-v1", digest: "fixture-digest-B" },
    ],
  };
}

/** G12 shape: four independent uploads = 8 data events + 2 snapshots = 10. */
export function fourUploadScenario(strategy: BackupStrategy): Scenario {
  return {
    scenarioId: `G12_FOUR_UPLOADS_${strategy}`,
    strategy,
    maxEvents: 10,
    operations: ["A", "B", "C", "D"].map((fileId) => ({
      opId: `upload-${fileId}`,
      kind: "UPLOAD" as const,
      fileId,
      objectId: `${fileId}-v1`,
      digest: `fixture-digest-${fileId}`,
    })),
  };
}

/** Idle scenario: no operations, only the two snapshot events. */
export function idleScenario(strategy: BackupStrategy): Scenario {
  return { scenarioId: `IDLE_${strategy}`, strategy, maxEvents: 10, operations: [] };
}

/** Five independent uploads = 10 data events + 2 snapshots = 12 > 10. */
export function fiveUploadScenario(strategy: BackupStrategy = "DB_FIRST"): Scenario {
  return {
    scenarioId: `OVER_LIMIT_FIVE_UPLOADS_${strategy}`,
    strategy,
    maxEvents: 10,
    operations: ["A", "B", "C", "D", "E"].map((fileId) => ({
      opId: `upload-${fileId}`,
      kind: "UPLOAD" as const,
      fileId,
      objectId: `${fileId}-v1`,
      digest: `fixture-digest-${fileId}`,
    })),
  };
}
