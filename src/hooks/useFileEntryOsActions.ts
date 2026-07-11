/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useRef, useState } from 'react'
import type { TranslationKey } from '../i18n/core'
import { perfTraceDiagnostic } from '../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../utils/perf-trace-names'
import { isWindowsStyleRoot, normalizeEntryRelativePath, revealLabelKey } from '../utils/file-entry-path'

export type FileEntryOsSurface =
  | 'tree'
  | 'quick-pin'
  | 'quick-recent'
  | 'search'
  | 'outline'
  | 'monaco'
  | 'git-diff'
  | 'git-history'

type TranslatorFn = (key: TranslationKey, params?: Record<string, string>) => string

/**
 * Shared state + actions for the "Open with Default Application" /
 * "Reveal in Finder|File Explorer|File Manager" context-menu items.
 *
 * Existence-check contract (per the disable-when-missing decision): every menu open
 * calls checkEntryOnDisk; the two items stay disabled while the check is
 * pending (`entryOnDisk === null`) or negative, and enable only on a
 * confirmed on-disk entry. Git-status `deleted` entries skip the IPC and
 * stay disabled.
 */
export function useFileEntryOsActions(t: TranslatorFn, showError: (text: string) => void) {
  const [entryOnDisk, setEntryOnDisk] = useState<boolean | null>(null)
  // Monotonic sequence so a slow filesExist response for a previous menu
  // open can never overwrite the state of the currently open menu.
  const checkSeqRef = useRef(0)

  const revealLabel = t(revealLabelKey(window.electronAPI?.platform))

  const checkEntryOnDisk = useCallback(
    (
      surface: FileEntryOsSurface,
      root: string | null | undefined,
      relativePath: string | null | undefined,
      options?: { skip?: boolean }
    ) => {
      const seq = ++checkSeqRef.current
      if (options?.skip) {
        setEntryOnDisk(false)
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_FILE_ENTRY_EXIST_CHECK, {
          surface,
          exists: false,
          skipped: true,
          durationMs: 0
        })
        return
      }
      setEntryOnDisk(null)
      if (!root || relativePath == null) {
        setEntryOnDisk(false)
        return
      }
      const startedAt = performance.now()
      window.electronAPI?.project
        // Same canonical form as resolveEntryAbsolutePath (leading-separator
        // strip, backslash a separator only under Windows-style roots) so the
        // enable gate and the open target cannot diverge.
        ?.filesExist(root, [normalizeEntryRelativePath(relativePath, isWindowsStyleRoot(root))])
        .then((result) => {
          if (checkSeqRef.current !== seq) return
          const exists = Array.isArray(result) && result[0] === true
          setEntryOnDisk(exists)
          perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_FILE_ENTRY_EXIST_CHECK, {
            surface,
            exists,
            skipped: false,
            durationMs: Math.round(performance.now() - startedAt)
          })
        })
        .catch(() => {
          if (checkSeqRef.current === seq) setEntryOnDisk(false)
        })
    },
    []
  )

  const runOsAction = useCallback(
    async (
      surface: FileEntryOsSurface,
      action: 'open-default' | 'reveal',
      absolutePath: string | null
    ) => {
      if (!absolutePath) {
        showError(t('common.openEntryFailed', { error: 'path unavailable' }))
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_FILE_ENTRY_OS_ACTION, {
          surface,
          action,
          ok: false,
          error: 'path unavailable'
        })
        return false
      }
      const invoke =
        action === 'open-default'
          ? window.electronAPI?.shell?.openPath
          : window.electronAPI?.shell?.showItemInFolder
      let ok = false
      let error: string | undefined
      try {
        const result = await invoke?.(absolutePath)
        ok = result?.success === true
        if (!ok) error = result?.error ?? 'unavailable'
      } catch (err) {
        error = String(err)
      }
      if (!ok) {
        showError(t('common.openEntryFailed', { error: error ?? 'unknown' }))
      }
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_FILE_ENTRY_OS_ACTION, {
        surface,
        action,
        ok,
        ...(error ? { error: error.slice(0, 256) } : {})
      })
      return ok
    },
    [t, showError]
  )

  const openWithDefaultApp = useCallback(
    (surface: FileEntryOsSurface, absolutePath: string | null) =>
      runOsAction(surface, 'open-default', absolutePath),
    [runOsAction]
  )

  const revealInFileManager = useCallback(
    (surface: FileEntryOsSurface, absolutePath: string | null) =>
      runOsAction(surface, 'reveal', absolutePath),
    [runOsAction]
  )

  return { entryOnDisk, checkEntryOnDisk, openWithDefaultApp, revealInFileManager, revealLabel }
}
