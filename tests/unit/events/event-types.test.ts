/**
 * SnapFence (P030) — T002 unit tests: event type definitions & expansion.
 * Covers: operation templates, deterministic event IDs, generation rules
 * (R-GEN-1 / R-GEN-2), implied pre-existing records (I-02) and their
 * deterministic derived digests, template prerequisites.
 */
import { describe, expect, it } from "vitest";
import type { Scenario } from "../../../src/core/model/types";
import {
  BLOB_SNAPSHOT_EVENT_ID,
  DB_SNAPSHOT_EVENT_ID,
  deriveImpliedDigest,
  eventBlobVersionKey,
  eventIdFor,
  expandOperation,
  expandScenario,
  templatePrerequisites,
} from "../../../src/core/events/event-types";

const uploadScenario: Scenario = {
  scenarioId: "U01_DB_FIRST_UPLOAD_ORPHAN",
  strategy: "DB_FIRST",
  maxEvents: 10,
  operations: [
    { opId: "upload-A", kind: "UPLOAD", fileId: "A", objectId: "A-v1", digest: "fixture-digest-A" },
  ],
};

const deleteScenario: Scenario = {
  scenarioId: "U02_DB_FIRST_DELETE_DANGLING",
  strategy: "DB_FIRST",
  maxEvents: 10,
  operations: [{ opId: "delete-C", kind: "DELETE", fileId: "C", objectId: "C-v1" }],
};

const updateScenario: Scenario = {
  scenarioId: "UPDATE_SAMPLE",
  strategy: "FILE_FIRST",
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

describe("event IDs", () => {
  it("builds deterministic operation event IDs as <opId>:<KIND>", () => {
    expect(eventIdFor("upload-A", "BLOB_PUT")).toBe("upload-A:BLOB_PUT");
    expect(eventIdFor("update-A", "BLOB_DELETE_OLD")).toBe("update-A:BLOB_DELETE_OLD");
  });

  it("uses the fixed snapshot event IDs", () => {
    expect(DB_SNAPSHOT_EVENT_ID).toBe("DB_SNAPSHOT");
    expect(BLOB_SNAPSHOT_EVENT_ID).toBe("BLOB_SNAPSHOT");
  });
});

describe("expandScenario — UPLOAD", () => {
  it("expands UPLOAD to BLOB_PUT -> DB_LINK in template order", () => {
    const expansion = expandScenario(uploadScenario);
    expect(expansion.dataEvents.map((e) => e.kind)).toEqual(["BLOB_PUT", "DB_LINK"]);
    expect(expansion.dataEvents.map((e) => e.eventId)).toEqual([
      "upload-A:BLOB_PUT",
      "upload-A:DB_LINK",
    ]);
    expect(expansion.snapshotEvents.map((e) => e.eventId)).toEqual([
      "DB_SNAPSHOT",
      "BLOB_SNAPSHOT",
    ]);
    expect(expansion.allEvents).toHaveLength(4);
  });

  it("creates the uploaded version at generation 1 (R-GEN-1)", () => {
    const expansion = expandScenario(uploadScenario);
    const put = expansion.dataEvents[0];
    expect(put !== undefined && "generation" in put ? put.generation : undefined).toBe(1);
    const link = expansion.dataEvents[1];
    expect(link !== undefined && "generation" in link ? link.generation : undefined).toBe(1);
    expect(link !== undefined && "digest" in link ? link.digest : undefined).toBe("fixture-digest-A");
  });

  it("implies no pre-existing record for an upload", () => {
    const expansion = expandScenario(uploadScenario);
    expect(expansion.impliedRecords).toEqual({});
  });
});

describe("expandScenario — DELETE", () => {
  it("expands DELETE to DB_UNLINK -> BLOB_DELETE in template order", () => {
    const expansion = expandScenario(deleteScenario);
    expect(expansion.dataEvents.map((e) => e.kind)).toEqual(["DB_UNLINK", "BLOB_DELETE"]);
    expect(expansion.dataEvents.map((e) => e.eventId)).toEqual([
      "delete-C:DB_UNLINK",
      "delete-C:BLOB_DELETE",
    ]);
  });

  it("implies a generation-1 pre-existing record with a derived digest (I-02)", () => {
    const expansion = expandScenario(deleteScenario);
    expect(expansion.impliedRecords["C"]).toEqual({
      objectId: "C-v1",
      generation: 1,
      digest: "fixture-digest-C-C-v1",
    });
    expect(deriveImpliedDigest("C", "C-v1")).toBe("fixture-digest-C-C-v1");
  });

  it("uses the pinned digest when the operation gives one", () => {
    const scenario: Scenario = {
      scenarioId: "DELETE_PINNED",
      strategy: "DB_FIRST",
      maxEvents: 10,
      operations: [
        { opId: "del", kind: "DELETE", fileId: "C", objectId: "C-v1", digest: "pinned-digest" },
      ],
    };
    expect(expandScenario(scenario).impliedRecords["C"]?.digest).toBe("pinned-digest");
  });
});

describe("expandScenario — UPDATE", () => {
  it("expands UPDATE to BLOB_PUT_NEW -> DB_REPOINT -> BLOB_DELETE_OLD", () => {
    const expansion = expandScenario(updateScenario);
    expect(expansion.dataEvents.map((e) => e.kind)).toEqual([
      "BLOB_PUT_NEW",
      "DB_REPOINT",
      "BLOB_DELETE_OLD",
    ]);
  });

  it("creates the new version at old generation + 1 (R-GEN-2)", () => {
    const expansion = expandScenario(updateScenario);
    const putNew = expansion.dataEvents[0];
    expect(putNew !== undefined && "generation" in putNew ? putNew.generation : undefined).toBe(2);
    expect(putNew !== undefined && "oldGeneration" in putNew ? putNew.oldGeneration : undefined).toBe(1);
    const deleteOld = expansion.dataEvents[2];
    expect(
      deleteOld !== undefined && "oldObjectId" in deleteOld ? deleteOld.oldObjectId : undefined,
    ).toBe("A-v1");
    expect(
      deleteOld !== undefined && "oldGeneration" in deleteOld ? deleteOld.oldGeneration : undefined,
    ).toBe(1);
  });

  it("implies the old pre-existing record for an update (I-02)", () => {
    const expansion = expandScenario(updateScenario);
    expect(expansion.impliedRecords["A"]).toEqual({
      objectId: "A-v1",
      generation: 1,
      digest: "fixture-digest-A-A-v1",
    });
  });
});

describe("expandOperation — chained operations on one file", () => {
  it("an UPDATE after an UPLOAD of the same file builds on generation 1", () => {
    const scenario: Scenario = {
      scenarioId: "CHAIN_UPLOAD_UPDATE",
      strategy: "DB_FIRST",
      maxEvents: 10,
      operations: [
        { opId: "up", kind: "UPLOAD", fileId: "A", objectId: "A-v1", digest: "digest-v1" },
        {
          opId: "upd",
          kind: "UPDATE",
          fileId: "A",
          objectId: "A-v2",
          oldObjectId: "A-v1",
          digest: "digest-v2",
        },
      ],
    };
    const expansion = expandScenario(scenario);
    // No implied record: the update operates on the uploaded version.
    expect(expansion.impliedRecords).toEqual({});
    const putNew = expansion.dataEvents[2];
    expect(putNew !== undefined && "generation" in putNew ? putNew.generation : undefined).toBe(2);
    expect(expansion.liveRecords["A"]).toEqual({
      objectId: "A-v2",
      generation: 2,
      digest: "digest-v2",
    });
  });

  it("expandOperation reports the live record after each operation", () => {
    const { liveAfter } = expandOperation(
      { opId: "del", kind: "DELETE", fileId: "C", objectId: "C-v1" },
      null,
    );
    expect(liveAfter).toBeNull();
  });
});

describe("templatePrerequisites", () => {
  it("returns earlier template events of the same operation, in order", () => {
    const expansion = expandScenario(updateScenario);
    const [putNew, repoint, deleteOld] = expansion.dataEvents;
    expect(putNew !== undefined ? templatePrerequisites(putNew) : []).toEqual([]);
    expect(repoint !== undefined ? templatePrerequisites(repoint) : []).toEqual([
      "update-A:BLOB_PUT_NEW",
    ]);
    expect(deleteOld !== undefined ? templatePrerequisites(deleteOld) : []).toEqual([
      "update-A:BLOB_PUT_NEW",
      "update-A:DB_REPOINT",
    ]);
  });

  it("returns no prerequisites for snapshot events", () => {
    const expansion = expandScenario(uploadScenario);
    for (const snapshot of expansion.snapshotEvents) {
      expect(templatePrerequisites(snapshot)).toEqual([]);
    }
  });
});

describe("eventBlobVersionKey", () => {
  it("maps data events to <objectId>@<generation> and snapshots to null", () => {
    const expansion = expandScenario(updateScenario);
    const putNew = expansion.dataEvents[0];
    expect(putNew !== undefined ? eventBlobVersionKey(putNew) : null).toBe("A-v2@2");
    const deleteOld = expansion.dataEvents[2];
    expect(deleteOld !== undefined ? eventBlobVersionKey(deleteOld) : null).toBe("A-v1@1");
    expect(eventBlobVersionKey(expansion.snapshotEvents[0])).toBeNull();
  });
});
