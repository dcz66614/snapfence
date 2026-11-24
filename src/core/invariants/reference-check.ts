/**
 * SnapFence (P030) — reference integrity checks. T004.
 *
 * Authority: PROJECT_BOOK.md §4.3 (snapshot consistency invariant: every
 * database reference must find its Blob object version, generations and
 * digests must match, no unreferenced committed Blob may exist) and §4.4
 * (diagnostic codes DANGLING_REFERENCE, GENERATION_MISMATCH,
 * DIGEST_MISMATCH, ORPHAN_BLOB). Inputs (frozen, read-only): T001 model
 * (types.ts); T003 diagnostic construction (search-result.ts:
 * makeDiagnostic / sortDiagnostics — reused, not re-implemented).
 *
 * Rules for this file:
 * - TypeScript strict mode; `any` is forbidden.
 * - Pure deterministic functions only: no randomness, no wall-clock, no
 *   mutation of inputs. Diagnostics are returned in the frozen
 *   deterministic order (sortDiagnostics: code, fileId, objectId, message).
 * - Fail-closed completeness: every database reference is checked, and
 *   every Blob version is checked for a referencing record. A missed
 *   dangling reference or a missed orphan Blob is a P0 defect (plan §12),
 *   so the checks below never early-exit: all references and all Blob
 *   versions are examined, and every failure produces its own diagnostic.
 *
 * Scope: this module judges the reference relationship between ONE
 * database snapshot and ONE Blob snapshot. It does not judge whether the
 * pair corresponds to a common legal operation boundary (that is
 * consistency.ts, which reuses this module) and it does not judge
 * capture-time in-flight status (that needs trace information; see
 * counterexample/extract.ts).
 */

import type {
  BlobReference,
  BlobState,
  DatabaseState,
  Diagnostic,
} from "../model/types";
import { blobVersionKey, type BlobVersionKey } from "../model/types";
import { makeDiagnostic, sortDiagnostics } from "../search/search-result";

// ---------------------------------------------------------------------------
// Single-reference check
// ---------------------------------------------------------------------------

/**
 * Check one database reference against a Blob snapshot.
 *
 * Exactly one diagnostic is produced when the reference is broken, and
 * none when it is intact:
 * - the Blob snapshot holds no version of the referenced objectId at all
 *   → DANGLING_REFERENCE (CRITICAL);
 * - the Blob snapshot holds the objectId at a different generation
 *   → GENERATION_MISMATCH (CRITICAL), never also reported as dangling;
 * - the Blob snapshot holds the referenced version but with a different
 *   digest → DIGEST_MISMATCH (CRITICAL).
 *
 * The precedence above is total: a reference falls into exactly one of
 * the four cases (intact / dangling / generation / digest), so a broken
 * reference is never double-counted and never missed.
 */
export function checkDatabaseReference(
  fileId: string,
  reference: BlobReference,
  blobSnapshot: BlobState,
): readonly Diagnostic[] {
  const key = blobVersionKey(reference.objectId, reference.generation);
  const heldDigest = blobSnapshot[key];
  if (heldDigest === undefined) {
    const otherGenerationHeld = Object.keys(blobSnapshot).some((blobKey) => {
      const at = blobKey.lastIndexOf("@");
      return at > 0 && blobKey.slice(0, at) === reference.objectId;
    });
    if (otherGenerationHeld) {
      return [
        makeDiagnostic(
          "GENERATION_MISMATCH",
          `Database record for file ${fileId} references ${reference.objectId}@${reference.generation}, but the Blob snapshot holds ${reference.objectId} at a different generation.`,
          fileId,
          reference.objectId,
        ),
      ];
    }
    return [
      makeDiagnostic(
        "DANGLING_REFERENCE",
        `Database record for file ${fileId} references ${reference.objectId}@${reference.generation}, which the Blob snapshot does not contain.`,
        fileId,
        reference.objectId,
      ),
    ];
  }
  if (heldDigest !== reference.digest) {
    return [
      makeDiagnostic(
        "DIGEST_MISMATCH",
        `Database record for file ${fileId} references ${reference.objectId}@${reference.generation} with digest ${reference.digest}, but the Blob snapshot holds digest ${heldDigest}.`,
        fileId,
        reference.objectId,
      ),
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Orphan Blob discovery
// ---------------------------------------------------------------------------

/** One unreferenced Blob object version found in a Blob snapshot. */
export interface OrphanBlob {
  objectId: string;
  generation: number;
  digest: string;
}

/**
 * Every Blob version in the snapshot that no database record references
 * (exact objectId + generation match required). Sorted by
 * (objectId, generation); empty when the snapshot holds no orphans.
 * A Blob version referenced by ANY record is not an orphan, even when
 * other records are broken.
 */
export function findOrphanBlobs(
  databaseSnapshot: DatabaseState,
  blobSnapshot: BlobState,
): readonly OrphanBlob[] {
  const referencedKeys = new Set<string>();
  for (const fileId of Object.keys(databaseSnapshot)) {
    const ref = databaseSnapshot[fileId];
    if (ref !== undefined) {
      referencedKeys.add(blobVersionKey(ref.objectId, ref.generation));
    }
  }
  const orphans: OrphanBlob[] = [];
  for (const blobKey of Object.keys(blobSnapshot).sort()) {
    if (referencedKeys.has(blobKey)) {
      continue;
    }
    const at = blobKey.lastIndexOf("@");
    if (at <= 0) {
      continue;
    }
    const digest = blobSnapshot[blobKey as BlobVersionKey];
    if (digest === undefined) {
      continue;
    }
    orphans.push({
      objectId: blobKey.slice(0, at),
      generation: Number(blobKey.slice(at + 1)),
      digest,
    });
  }
  orphans.sort((a, b) =>
    a.objectId !== b.objectId
      ? a.objectId < b.objectId
        ? -1
        : 1
      : a.generation - b.generation,
  );
  return orphans;
}

/**
 * File IDs whose database reference has no matching Blob object version
 * at all (dangling) or matches only at a different generation. Sorted.
 * Digest-only mismatches are NOT dangling: the object version exists.
 */
export function findDanglingReferences(
  databaseSnapshot: DatabaseState,
  blobSnapshot: BlobState,
): readonly string[] {
  const dangling: string[] = [];
  for (const fileId of Object.keys(databaseSnapshot).sort()) {
    const ref = databaseSnapshot[fileId];
    if (ref === undefined) {
      continue;
    }
    if (blobSnapshot[blobVersionKey(ref.objectId, ref.generation)] === undefined) {
      dangling.push(fileId);
    }
  }
  return dangling;
}

// ---------------------------------------------------------------------------
// Whole-pair reference check (§4.3 reference half, §4.4)
// ---------------------------------------------------------------------------

/**
 * Check every database reference in a snapshot pair, then every Blob
 * version for orphans. Returns the §4.4 reference diagnostics:
 * DANGLING_REFERENCE / GENERATION_MISMATCH / DIGEST_MISMATCH (one per
 * broken reference, in fileId order) and ORPHAN_BLOB (one per unreferenced
 * Blob version, in version-key order), all in the frozen deterministic
 * diagnostic order.
 *
 * Completeness guarantees (tested exhaustively in
 * tests/unit/invariants/reference-check.test.ts):
 * - no dangling reference is missed: every record is examined;
 * - no orphan Blob is missed: every Blob version is examined;
 * - a broken reference produces exactly one of the three reference codes.
 *
 * An empty result means the pair is reference-clean. It does NOT by
 * itself mean the pair corresponds to a common legal operation boundary:
 * two snapshots can be reference-clean yet taken at different boundaries
 * only if they also agree on the boundary values — that judgement is
 * consistency.ts (which reuses this function and adds the boundary test).
 * In this model a reference-clean reachable pair always value-matches
 * some boundary (the live file/version set determines the completed-op
 * set); consistency.ts verifies the match directly instead of relying on
 * that argument.
 */
export function checkReferences(
  databaseSnapshot: DatabaseState,
  blobSnapshot: BlobState,
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const fileId of Object.keys(databaseSnapshot).sort()) {
    const ref = databaseSnapshot[fileId];
    if (ref !== undefined) {
      diagnostics.push(...checkDatabaseReference(fileId, ref, blobSnapshot));
    }
  }
  for (const orphan of findOrphanBlobs(databaseSnapshot, blobSnapshot)) {
    diagnostics.push(
      makeDiagnostic(
        "ORPHAN_BLOB",
        `Blob snapshot holds ${orphan.objectId}@${orphan.generation}, which no database record references.`,
        undefined,
        orphan.objectId,
      ),
    );
  }
  return sortDiagnostics(diagnostics);
}

/** True when the snapshot pair has no broken reference and no orphan Blob. */
export function isReferenceClean(
  databaseSnapshot: DatabaseState,
  blobSnapshot: BlobState,
): boolean {
  return checkReferences(databaseSnapshot, blobSnapshot).length === 0;
}
