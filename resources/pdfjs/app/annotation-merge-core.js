/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure three-way rebase of highlight-annotation record sets, used when the
 * open PDF is modified on disk by someone else (typically an agent tool)
 * while this viewer holds unsaved local edits.
 *
 * The model: annotations are id-keyed records (CYY_MARK_Id is a stable
 * per-record identifier), so "merge two versions of the PDF's annotations"
 * is record-set reconciliation, not byte reconciliation — the same reduction
 * Zotero and PSPDFKit Instant use. Strategy confirmed with the user on
 * 2026-08-01: automatic rebase, external bytes become the new base, local
 * changes are replayed on top, and on a true same-id conflict the LOCAL side
 * wins (the user is looking at their own edit; silently discarding it is the
 * one unacceptable outcome).
 *
 * base     — records as of the last adopt/successful save (common ancestor).
 * local    — records currently in the store (may contain unsaved edits).
 * external — records read out of the externally modified file.
 *
 * Decision table (per id, "local state" is derived by comparing local to
 * base):
 *
 *   local unchanged                → external outcome stands (modified,
 *                                    deleted, or untouched — all adopted)
 *   local added                    → kept (appended)
 *   local modified, ext untouched  → local version
 *   local modified, ext modified   → local version, conflict counted
 *   local modified, ext deleted    → local version resurrected, conflict
 *   local deleted,  ext untouched  → stays deleted
 *   local deleted,  ext modified   → stays deleted, conflict counted
 *
 * Same contract as the other `-core` modules: no DOM, no state, runs under
 * plain Node in test/unittest/ (AMC-U-*).
 */

"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof window !== "undefined") {
    window.OnwardPdfAnnotationMergeCore = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(this, function () {
  /**
   * Identity of a record's persisted content. Mirrors the annotation store's
   * fingerprint field set on purpose: transient UI fields (paletteAnchor,
   * labelName display copy) must not make two records "different".
   */
  function recordContentKey(record) {
    if (!record || typeof record !== "object") return "";
    return JSON.stringify([
      record.labelId,
      record.color,
      record.page,
      record.note || "",
      record.quads,
      record.rectUnion
    ]);
  }

  function indexById(records) {
    const map = new Map();
    for (const record of Array.isArray(records) ? records : []) {
      if (record && typeof record.id === "string" && record.id) {
        map.set(record.id, record);
      }
    }
    return map;
  }

  /**
   * Per-id local edit state relative to the common ancestor.
   * Returns a Map id -> 'added' | 'modified' | 'deleted'. Unchanged ids are
   * absent, which is what makes the clean-viewer case (no local edits) a
   * pure adoption of the external set.
   */
  function diffAgainstBase(base, local) {
    const baseById = indexById(base);
    const localById = indexById(local);
    const changes = new Map();
    for (const [id, record] of localById) {
      const baseRecord = baseById.get(id);
      if (!baseRecord) {
        changes.set(id, "added");
      } else if (recordContentKey(baseRecord) !== recordContentKey(record)) {
        changes.set(id, "modified");
      }
    }
    for (const id of baseById.keys()) {
      if (!localById.has(id)) {
        changes.set(id, "deleted");
      }
    }
    return changes;
  }

  /**
   * @returns {{ merged: Array<object>, stats: {
   *   localAdds: number, localMods: number, localDels: number,
   *   conflicts: number, externalCount: number
   * } }}
   *
   * Order contract: external record order is preserved (with in-place
   * replacements); locally added records are appended in their local relative
   * order. Deterministic for identical inputs.
   */
  function rebaseAnnotations(input) {
    const base = Array.isArray(input && input.base) ? input.base : [];
    const local = Array.isArray(input && input.local) ? input.local : [];
    const external = Array.isArray(input && input.external) ? input.external : [];

    const baseById = indexById(base);
    const localById = indexById(local);
    const externalById = indexById(external);
    const localChanges = diffAgainstBase(base, local);

    const stats = {
      localAdds: 0,
      localMods: 0,
      localDels: 0,
      conflicts: 0,
      externalCount: external.length
    };

    const merged = [];
    for (const record of external) {
      if (!record || typeof record.id !== "string") continue;
      const change = localChanges.get(record.id);
      if (change === "deleted") {
        // Local deletion wins. If the external side also changed this record,
        // that intent is being discarded — count it.
        const baseRecord = baseById.get(record.id);
        if (!baseRecord || recordContentKey(baseRecord) !== recordContentKey(record)) {
          stats.conflicts += 1;
        }
        stats.localDels += 1;
        continue;
      }
      if (change === "modified" || change === "added") {
        // 'added' with an external record of the same id is an id collision
        // (or a double adoption); treat exactly like a both-sides conflict.
        const baseRecord = baseById.get(record.id);
        const externalChangedToo =
          change === "added" ||
          !baseRecord ||
          recordContentKey(baseRecord) !== recordContentKey(record);
        if (externalChangedToo) stats.conflicts += 1;
        merged.push(localById.get(record.id));
        stats.localMods += 1;
        continue;
      }
      merged.push(record);
    }

    for (const record of local) {
      if (!record || typeof record.id !== "string") continue;
      const change = localChanges.get(record.id);
      if (change === "added" && !externalById.has(record.id)) {
        merged.push(record);
        stats.localAdds += 1;
      } else if (change === "modified" && !externalById.has(record.id)) {
        // Externally deleted while locally modified: resurrect the local
        // version — the user is actively working on it.
        merged.push(record);
        stats.localMods += 1;
        stats.conflicts += 1;
      }
    }

    return { merged, stats };
  }

  /**
   * Snapshot of the persisted shape of a record set, for base tracking.
   * Records are JSON-safe by construction (they round-trip through the PDF),
   * so a structural clone via JSON keeps the base immune to in-place edits
   * of the live records.
   */
  function snapshotRecords(records) {
    return JSON.parse(JSON.stringify(Array.isArray(records) ? records : []));
  }

  return {
    recordContentKey: recordContentKey,
    diffAgainstBase: diffAgainstBase,
    rebaseAnnotations: rebaseAnnotations,
    snapshotRecords: snapshotRecords
  };
});
