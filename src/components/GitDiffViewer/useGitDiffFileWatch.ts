/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react'
import type { GitFileStatus } from '../../types/electron'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import { perfTraceDiagnostic } from '../../utils/perf-trace'
import { expectedWatchPath, watchPathsEqual } from '../ProjectEditor/watchPathMatch'

interface UseGitDiffFileWatchOptions {
  /** Whether the diff viewer is currently open / visible. */
  isOpen: boolean
  /** The file currently selected in the diff file list. */
  selectedFile: GitFileStatus | null
  /** Repo root for the selected file (submodule root or activeCwd). */
  repoRoot: string | null
  /** Called when the watched file changes on disk. */
  onFileChanged: (changeType: 'changed' | 'deleted') => void
}

/**
 * Watches the working-tree copy of the currently selected diff file for
 * external changes, reusing the existing FileWatchManager infrastructure
 * (same IPC channels as the Markdown preview live-refresh).
 *
 * Only one file is watched at a time — the currently selected file.
 * The watcher is automatically cleaned up when the file changes, the
 * viewer closes, or the component unmounts.
 */
export function useGitDiffFileWatch({
  isOpen,
  selectedFile,
  repoRoot,
  onFileChanged
}: UseGitDiffFileWatchOptions): void {
  const onFileChangedRef = useRef(onFileChanged)
  useEffect(() => {
    onFileChangedRef.current = onFileChanged
  }, [onFileChanged])

  useEffect(() => {
    // Only watch when the viewer is open, a non-deleted file is selected,
    // and we have a valid repo root.
    if (!isOpen || !selectedFile || !repoRoot || selectedFile.status === 'D') {
      return
    }

    const filename = selectedFile.filename
    const root = selectedFile.repoRoot || repoRoot

    // Start watching the working-tree file. Binary formats get the watcher's
    // binary mode: a UTF-8 content read of a PDF/EPUB is both lossy and
    // expensive, and the diff refresh only needs "it changed", not content.
    const watchMode = /\.(pdf|epub)$/i.test(filename) ? 'binary' as const : 'text' as const
    void window.electronAPI.project.watchFile(root, filename, watchMode)

    // Same shared matcher as the Project Editor's subscriber (watchPathMatch):
    // hand-rolled root+sep+path comparisons silently dropped events for
    // doubled-separator roots and absolute file paths — twice.
    const expectedPath = expectedWatchPath(root, filename)

    const unsubscribe = window.electronAPI.project.onFileChanged(
      (fullPath, changeType) => {
        if (changeType !== 'changed' && changeType !== 'deleted') return
        const matched = watchPathsEqual(fullPath, expectedPath)
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_FILE_CHANGE_RECEIVED, {
          matched,
          changeType,
          mode: watchMode
        })
        if (!matched) return
        onFileChangedRef.current(changeType)
      }
    )

    return () => {
      unsubscribe()
      void window.electronAPI.project.unwatchFile(root, filename)
    }
  }, [isOpen, selectedFile, repoRoot])
}
