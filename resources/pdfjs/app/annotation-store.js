/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Annotation store: owns the highlight records for the open document and
 * decides when they get written back into the PDF file.
 *
 * The storage strategy was confirmed with the user on 2026-07-28: annotations
 * are written into the PDF itself (so they travel with the file), and saving
 * is automatic with Cmd/Ctrl+S as a manual override. That combination has one
 * sharp edge — pdf-lib has no incremental write, so every save rewrites the
 * whole document. On a 100 MB scanned book that is a second-scale operation
 * routed through iframe -> postMessage -> IPC -> fs. Everything below exists
 * to keep that from being felt, or from destroying the source file:
 *
 *   R1  Quiet window + content fingerprint. A save only starts once editing
 *       has stopped, and only if the records actually changed. Colouring ten
 *       passages in a row produces one write, not ten.
 *   R2  Atomic replace, implemented on the host side: write a sibling temp
 *       file, fsync, then rename over the original. A crash mid-write leaves
 *       the user's PDF untouched rather than truncated.
 *   R3  Signature detection. A full rewrite invalidates any digital signature,
 *       so the first write to a signed document asks instead of silently
 *       breaking it.
 *   R4  Silent degradation. A read-only file or a lock (common on Windows)
 *       must not interrupt reading with a dialog; automatic saves fail quietly
 *       and surface state, while an explicit Cmd+S reports the real error.
 *   R5  Size-adaptive cadence. Past the large-file threshold the quiet window
 *       stretches so automatic saves cannot queue up behind each other.
 *   R6  Self-write marking. Our own write is announced to the host so the file
 *       watcher does not treat it as an external modification and trigger a
 *       reload/recompute loop.
 *
 * The store never touches the filesystem directly — it produces bytes and asks
 * the host to persist them. That keeps "are the records right" and "did they
 * reach the disk" independently testable.
 */

"use strict";

(function () {
  // Confirmed with the user: 800 ms of quiet before an automatic save, matching
  // the reference project's field-proven value.
  const AUTOSAVE_QUIET_MS = 800;
  // Confirmed with the user: past 20 MB a document is "large". Ordinary papers
  // are 1-5 MB; scanned books run 20-200 MB.
  const LARGE_FILE_BYTES = 20 * 1024 * 1024;
  // Multiplier applied to the quiet window for large documents (R5).
  const LARGE_FILE_QUIET_FACTOR = 5;
  // After a failed automatic save, wait this long before trying again, so a
  // read-only file does not produce a write attempt every quiet window (R4).
  const FAILURE_BACKOFF_MS = 15000;

  const NOOP = function () {};

  function create(deps) {
    const file = deps.file;                 // annotation-file.js instance
    const requestSave = deps.requestSave;   // (bytes, meta) => Promise<result>
    const trace = deps.trace || NOOP;
    const onDirtyChange = deps.onDirtyChange || NOOP;
    const onSaveResult = deps.onSaveResult || NOOP;
    const onAnnotationsReplaced = deps.onAnnotationsReplaced || NOOP;
    // annotation-merge-core.js instance; injected so the store stays
    // constructible under plain Node in unit tests.
    const mergeCore = deps.mergeCore || null;

    /** @type {Array<object>} live annotation records for the open document */
    let annotations = [];
    let revision = 0;
    let labels = [];
    let dirty = false;
    let quietTimer = null;
    let saveInFlight = false;
    let lastFailureAt = 0;
    let documentBytes = 0;
    let documentHasSignature = false;
    let signatureAcknowledged = false;
    // Fingerprint of the record set as last written. Comparing against it is
    // what makes a redundant save free (R1).
    let savedFingerprint = "";
    // Snapshot of the records as of the last adopt/successful save — the
    // common ancestor for the external-change rebase merge.
    let baseAnnotations = [];
    let openToken = 0;

    function fingerprint() {
      // Only the fields that end up in the file. Deliberately not JSON of the
      // whole record: paletteAnchor and transient UI fields change without
      // changing what would be written, and a save triggered by those would be
      // pure cost.
      return JSON.stringify(
        annotations.map(a => [
          a.id, a.labelId, a.color, a.page, a.note || "", a.quads, a.rectUnion
        ])
      );
    }

    function quietWindowMs() {
      return documentBytes >= LARGE_FILE_BYTES
        ? AUTOSAVE_QUIET_MS * LARGE_FILE_QUIET_FACTOR
        : AUTOSAVE_QUIET_MS;
    }

    function setDirty(next) {
      if (dirty === next) return;
      dirty = next;
      onDirtyChange(dirty);
    }

    function markChanged(reason) {
      revision += 1;
      setDirty(true);
      trace("annotation.changed", { reason: String(reason || ""), count: annotations.length });
    }

    function cancelQuietTimer() {
      if (quietTimer !== null) {
        clearTimeout(quietTimer);
        quietTimer = null;
      }
    }

    function scheduleSave() {
      cancelQuietTimer();
      const wait = quietWindowMs();
      quietTimer = setTimeout(() => {
        quietTimer = null;
        void save({ mode: "auto" });
      }, wait);
    }

    /**
     * @param {{mode: 'auto'|'manual', force?: boolean}} options
     * @returns {Promise<{ok: boolean, reason?: string}>}
     */
    async function save(options) {
      const mode = options && options.mode === "manual" ? "manual" : "auto";
      const isAuto = mode === "auto";

      if (saveInFlight) {
        // A save is already running. Leaving the record dirty means the change
        // that arrived mid-write gets picked up by the next scheduled save
        // rather than racing this one.
        return { ok: false, reason: "in-flight" };
      }
      if (!file || !dirty) {
        return { ok: false, reason: dirty ? "no-writer" : "clean" };
      }

      const current = fingerprint();
      if (current === savedFingerprint) {
        // Records round-tripped back to what is already on disk (create then
        // delete, say). Nothing to write (R1).
        setDirty(false);
        return { ok: false, reason: "unchanged" };
      }

      if (isAuto && lastFailureAt && Date.now() - lastFailureAt < FAILURE_BACKOFF_MS) {
        return { ok: false, reason: "backoff" };
      }

      // R3: a full rewrite drops any signature, so ask before the first one.
      if (documentHasSignature && !signatureAcknowledged) {
        trace("annotation.save-blocked-signature", { mode });
        onSaveResult({ ok: false, reason: "signature", mode });
        return { ok: false, reason: "signature" };
      }

      const token = openToken;
      saveInFlight = true;
      const startedAt = Date.now();
      // Captured alongside `current`: if records mutate while the write is in
      // flight, the base must still describe the bytes that actually landed.
      const baseSnapshotAtWrite = mergeCore ? mergeCore.snapshotRecords(annotations) : null;
      trace("annotation.save-start", { mode, count: annotations.length, revision });

      try {
        const bytes = await file.buildAnnotatedPdfBytes({
          annotations: annotations,
          labels: labels,
          revision: revision
        });
        if (token !== openToken) {
          // The user opened a different PDF while we were serialising. Writing
          // now would put this document's annotations into that one's path.
          trace("annotation.save-cancelled", { mode, reason: "document-changed" });
          return { ok: false, reason: "document-changed" };
        }

        const result = await requestSave(bytes, { mode, bytes: bytes.length });
        if (token !== openToken) {
          trace("annotation.save-cancelled", { mode, reason: "document-changed-after-write" });
          return { ok: false, reason: "document-changed" };
        }

        if (result && result.ok) {
          savedFingerprint = current;
          if (baseSnapshotAtWrite) {
            baseAnnotations = baseSnapshotAtWrite;
          }
          lastFailureAt = 0;
          // Only clear dirty if no edit landed while the write was in
          // flight; otherwise the already-armed quiet timer must still find
          // the store dirty, or that edit would wait for the NEXT edit to be
          // written.
          if (fingerprint() === current) {
            setDirty(false);
          }
          trace("annotation.save-done", {
            mode,
            count: annotations.length,
            bytes: bytes.length,
            durationMs: Date.now() - startedAt
          });
          onSaveResult({ ok: true, mode });
          return { ok: true };
        }

        const reason = (result && result.reason) || "write-failed";
        // 'external-modified' is not a failure of the write machinery — the
        // host reacts by reloading + rebase-merging and the merge re-arms the
        // save. Entering the 15 s backoff here would delay that retry for no
        // reason.
        if (reason !== "external-modified") {
          lastFailureAt = Date.now();
        }
        // R4: an automatic save that fails must not interrupt reading. The
        // host decides how to surface it; a manual save always reports.
        trace("annotation.save-failed", { mode, reason });
        onSaveResult({ ok: false, reason, mode });
        return { ok: false, reason };
      } catch (error) {
        lastFailureAt = Date.now();
        const reason = String((error && error.message) || error).slice(0, 160);
        trace("annotation.save-failed", { mode, reason });
        onSaveResult({ ok: false, reason, mode });
        return { ok: false, reason };
      } finally {
        saveInFlight = false;
      }
    }

    return {
      /** Live record array. The highlight layer mutates it in place. */
      get annotations() {
        return annotations;
      },

      markChanged: markChanged,
      scheduleSave: scheduleSave,

      /** Force an immediate write, bypassing the quiet window (Cmd/Ctrl+S). */
      saveNow: function () {
        cancelQuietTimer();
        return save({ mode: "manual" });
      },

      /** Called when the user has accepted that saving drops the signature. */
      acknowledgeSignature: function () {
        signatureAcknowledged = true;
      },

      isDirty: function () { return dirty; },
      getRevision: function () { return revision; },
      getLabels: function () { return labels; },
      setLabels: function (next) { labels = Array.isArray(next) ? next : []; },

      /**
       * Adopt the annotation set read out of a freshly opened document.
       * Establishes the saved fingerprint so merely opening a file never
       * counts as a change.
       */
      adopt: function (state) {
        openToken += 1;
        cancelQuietTimer();
        annotations = Array.isArray(state && state.annotations) ? state.annotations : [];
        revision = Number((state && state.revision) || 0);
        documentBytes = Number((state && state.documentBytes) || 0);
        documentHasSignature = Boolean(state && state.hasSignature);
        signatureAcknowledged = false;
        lastFailureAt = 0;
        savedFingerprint = fingerprint();
        baseAnnotations = mergeCore ? mergeCore.snapshotRecords(annotations) : [];
        setDirty(false);
        trace("annotation.adopted", {
          count: annotations.length,
          documentBytes: documentBytes,
          hasSignature: documentHasSignature,
          large: documentBytes >= LARGE_FILE_BYTES
        });
        onAnnotationsReplaced();
      },

      /**
       * The document was replaced on disk by an external writer and the
       * viewer has swapped to the new bytes. Adopt the external record set as
       * the new base, then replay whatever the user changed locally since the
       * last save on top of it (three-way rebase, local wins on conflicts —
       * strategy confirmed with the user). A clean store degenerates to a
       * plain adopt.
       *
       * @returns merge stats, or null when merge support is unavailable.
       */
      rebaseOnExternal: function (state) {
        const externalRecords = Array.isArray(state && state.annotations)
          ? state.annotations
          : [];
        if (!mergeCore) {
          this.adopt(state);
          return null;
        }
        const rebase = mergeCore.rebaseAnnotations({
          base: baseAnnotations,
          local: annotations,
          external: externalRecords
        });

        openToken += 1;
        cancelQuietTimer();
        annotations = rebase.merged;
        revision = Number((state && state.revision) || 0) + 1;
        documentBytes = Number((state && state.documentBytes) || 0);
        documentHasSignature = Boolean(state && state.hasSignature);
        signatureAcknowledged = false;
        lastFailureAt = 0;
        // The file on disk contains the EXTERNAL set — that is what "saved"
        // means now. The base moves with it.
        const liveRecords = annotations;
        annotations = externalRecords;
        savedFingerprint = fingerprint();
        annotations = liveRecords;
        baseAnnotations = mergeCore.snapshotRecords(externalRecords);

        trace("annotation.rebase-merged", {
          adds: rebase.stats.localAdds,
          mods: rebase.stats.localMods,
          dels: rebase.stats.localDels,
          conflicts: rebase.stats.conflicts,
          externalCount: rebase.stats.externalCount
        });

        const survivingLocalEdits =
          rebase.stats.localAdds + rebase.stats.localMods + rebase.stats.localDels > 0;
        if (survivingLocalEdits && fingerprint() !== savedFingerprint) {
          setDirty(true);
          scheduleSave();
        } else {
          setDirty(false);
        }
        onAnnotationsReplaced();
        return rebase.stats;
      },

      /** Drop everything before another document loads. */
      reset: function () {
        openToken += 1;
        cancelQuietTimer();
        annotations = [];
        revision = 0;
        savedFingerprint = "";
        baseAnnotations = [];
        documentBytes = 0;
        documentHasSignature = false;
        signatureAcknowledged = false;
        lastFailureAt = 0;
        setDirty(false);
      },

      /** Flush before the viewer goes away, so nothing is lost on close. */
      flushBeforeUnload: function () {
        if (!dirty) return Promise.resolve({ ok: false, reason: "clean" });
        cancelQuietTimer();
        return save({ mode: "manual" });
      }
    };
  }

  window.OnwardPdfAnnotationStore = {
    create: create,
    AUTOSAVE_QUIET_MS: AUTOSAVE_QUIET_MS,
    LARGE_FILE_BYTES: LARGE_FILE_BYTES,
    LARGE_FILE_QUIET_FACTOR: LARGE_FILE_QUIET_FACTOR,
    FAILURE_BACKOFF_MS: FAILURE_BACKOFF_MS
  };
})();
