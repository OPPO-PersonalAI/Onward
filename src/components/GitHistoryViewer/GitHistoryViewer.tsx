/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import { PatchDiff, MultiFileDiff } from '@pierre/diffs/react'
import { parsePatchFiles, getFiletypeFromFileName } from '@pierre/diffs'
import type {
  GitHistoryResult,
  GitCommitInfo,
  GitHistoryFile,
  GitHistoryDiffResult,
  GitHistoryFileContentResult,
  GitRepoContext
} from '../../types/electron'
import { useSettings } from '../../contexts/SettingsContext'
import { DEFAULT_GIT_DIFF_FONT_SIZE } from '../../constants/gitDiff'
import { useSubpageEscape } from '../../hooks/useSubpageEscape'
import { useI18n } from '../../i18n/useI18n'
import { useAppState } from '../../hooks/useAppState'
import type { ProjectEditorOpenEventDetail, SubpageId, SubpageNavigateEventDetail } from '../../types/subpage'
import { SubpagePanelButton, SubpagePanelShell, SubpageSwitcher, type SubpagePanelShellState } from '../SubpageSwitcher'
import {
  GitImagePreview,
  IMAGE_COMPARE_MODE_STORAGE_KEY,
  IMAGE_DISPLAY_MODE_STORAGE_KEY,
  type GitImagePreviewFileState,
  type ImageCompareMode,
  type ImageDisplayMode,
  type SvgViewMode
} from '../GitImagePreview/GitImagePreview'
import { GitPdfCompare, type GitPdfStatus } from '../GitPdfCompare/GitPdfCompare'
import { GitEpubCompare, type GitEpubStatus } from '../GitEpubCompare/GitEpubCompare'
import { inspectPdfCompareDom, inspectEpubCompareDom } from '../GitDiffViewer/GitDiffViewer'
import { usePathCopy } from '../../hooks/usePathCopy'
import { useCwdCopyHandler } from '../../hooks/useCwdCopyHandler'
import { LargeFileConfirmDialog } from '../LargeFileConfirmDialog/LargeFileConfirmDialog'
import {
  coerceGitHistoryDiffDisplayMode,
  resolveGitHistoryDiffDisplayMode,
  toGitHistoryPatchDiffStyle,
  type GitHistoryDiffDisplayMode,
  type GitHistoryPatchDiffStyle
} from './diffDisplayMode'
import '../../styles/path-copy-toast.css'
import './GitHistoryViewer.css'

const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const HISTORY_PAGE_SIZE = 50

const STORAGE_KEY_FILE_LIST_WIDTH = 'git-history-file-list-width'
const STORAGE_KEY_HIDE_WHITESPACE = 'git-history-hide-whitespace'
const STORAGE_KEY_DIFF_STYLE = 'git-history-diff-style'
const STORAGE_KEY_STATE_PREFIX = 'git-history-state'

const DEFAULT_FILE_LIST_WIDTH = 260
const MIN_FILE_LIST_WIDTH = 180
const MAX_FILE_LIST_WIDTH = 520
const DIFF_INLINE_BREAKPOINT = 900

const STORAGE_KEY_SUMMARY_HEIGHT = 'git-history-summary-height'
const DEFAULT_SUMMARY_HEIGHT = 120
const MIN_SUMMARY_HEIGHT = 48
const MIN_DETAIL_BODY_HEIGHT = 120

type LargeFileConfirmState = {
  filename: string
  sizeBytes: number
  sizeLabel: string
  resolve: (confirmed: boolean) => void
}

function formatLargeFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}

interface GitHistoryViewerProps {
  isOpen: boolean
  onClose: () => void
  terminalId: string
  cwd: string | null
  displayMode?: 'modal' | 'panel'
  panelShellMode?: 'internal' | 'external'
  onPanelShellStateChange?: (state: SubpagePanelShellState | null) => void
  taskTitle?: string
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function formatRelativeTime(dateText: string, locale: string) {
  const date = new Date(dateText)
  if (Number.isNaN(date.getTime())) return dateText
  const diffMs = Date.now() - date.getTime()
  const seconds = Math.round(diffMs / 1000)
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const absSeconds = Math.abs(seconds)
  let relative: string
  if (absSeconds < 60) {
    relative = rtf.format(-seconds, 'second')
  } else {
    const minutes = Math.round(seconds / 60)
    if (Math.abs(minutes) < 60) {
      relative = rtf.format(-minutes, 'minute')
    } else {
      const hours = Math.round(minutes / 60)
      if (Math.abs(hours) < 24) {
        relative = rtf.format(-hours, 'hour')
      } else {
        const days = Math.round(hours / 24)
        if (Math.abs(days) < 30) {
          relative = rtf.format(-days, 'day')
        } else {
          const months = Math.round(days / 30)
          if (Math.abs(months) < 12) {
            relative = rtf.format(-months, 'month')
          } else {
            relative = rtf.format(-Math.round(months / 12), 'year')
          }
        }
      }
    }
  }
  const wrappedRelative = locale.startsWith('zh')
    ? `（${relative}）`
    : ` (${relative})`
  return `${formatAbsoluteTime(dateText, locale)}${wrappedRelative}`
}

function formatAbsoluteTime(dateText: string, locale: string) {
  const date = new Date(dateText)
  if (Number.isNaN(date.getTime())) return dateText
  return date.toLocaleString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

interface RefBadge {
  label: string
  type: 'head' | 'local-branch' | 'remote-branch' | 'tag'
}

interface RepoTreeItem extends GitRepoContext {
  treeDepth: number
  hasChildren: boolean
  expanded: boolean
  isCurrent: boolean
  displayLabel: string
}

function normalizeRepoRoot(root: string | null | undefined): string {
  return (root ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

function getRepoTreeDepth(repo: GitRepoContext): number {
  return repo.isSubmodule ? repo.depth + 1 : 0
}

function getRepoLeafLabel(label: string): string {
  const normalized = label.replace(/\\/g, '/')
  return normalized.split('/').filter(Boolean).pop() || label
}

function buildRepoTreeItems(
  repos: GitRepoContext[] | undefined,
  expandedRoots: Set<string>,
  currentRoot: string | null,
  currentLabel: string,
  query = ''
): RepoTreeItem[] {
  if (!repos || repos.length === 0) return []
  const normalizedCurrent = normalizeRepoRoot(currentRoot)
  const normalizedQuery = query.trim().toLowerCase()
  const childrenByParent = new Map<string, GitRepoContext[]>()
  const rootRepos: GitRepoContext[] = []

  for (const repo of repos) {
    const parentRoot = normalizeRepoRoot(repo.parentRoot)
    if (repo.isSubmodule && parentRoot) {
      const existing = childrenByParent.get(parentRoot) ?? []
      existing.push(repo)
      childrenByParent.set(parentRoot, existing)
    } else {
      rootRepos.push(repo)
    }
  }

  const sortRepos = (a: GitRepoContext, b: GitRepoContext) => {
    if (a.isSubmodule !== b.isSubmodule) return a.isSubmodule ? 1 : -1
    if (a.depth !== b.depth) return a.depth - b.depth
    return a.label.localeCompare(b.label)
  }

  const output: RepoTreeItem[] = []
  const visit = (repo: GitRepoContext) => {
    const root = normalizeRepoRoot(repo.root)
    const children = [...(childrenByParent.get(root) ?? [])].sort(sortRepos)
    const hasChildren = children.length > 0
    const expanded = expandedRoots.has(root)
    const isCurrent = root === normalizedCurrent
    const displayLabel = repo.isSubmodule ? getRepoLeafLabel(repo.label) : currentLabel
    const searchable = `${displayLabel} ${repo.label} ${repo.root}`.toLowerCase()
    const matches = !normalizedQuery || searchable.includes(normalizedQuery)
    if (matches) {
      output.push({
        ...repo,
        treeDepth: getRepoTreeDepth(repo),
        hasChildren,
        expanded,
        isCurrent,
        displayLabel
      })
    }
    if (normalizedQuery || expanded) {
      children.forEach(visit)
    }
  }

  rootRepos.sort(sortRepos).forEach(visit)
  return output
}

function parseRefs(refs?: string): RefBadge[] {
  if (!refs || !refs.trim()) return []
  return refs.split(',').map(r => r.trim()).filter(Boolean).map(ref => {
    if (ref === 'HEAD') {
      return { label: 'HEAD', type: 'head' as const }
    }
    if (ref.startsWith('HEAD -> ')) {
      return { label: ref.replace('HEAD -> ', ''), type: 'head' as const }
    }
    if (ref.startsWith('tag: ')) {
      return { label: ref.replace('tag: ', ''), type: 'tag' as const }
    }
    if (ref.includes('/')) {
      return { label: ref, type: 'remote-branch' as const }
    }
    return { label: ref, type: 'local-branch' as const }
  })
}

function buildRangeKey(base: string, head: string, hideWhitespace: boolean) {
  return `${base}..${head}::${hideWhitespace ? 'w' : 'n'}`
}

function buildPatchKey(base: string, head: string, filePath: string, hideWhitespace: boolean) {
  return `${base}..${head}::${filePath}::${hideWhitespace ? 'w' : 'n'}`
}

function buildFileContentKey(base: string, head: string, file: GitHistoryFile) {
  return `${base}..${head}::${file.status}::${file.originalFilename ?? ''}::${file.filename}`
}

export function GitHistoryViewer({
  isOpen,
  onClose,
  terminalId: _terminalId,
  cwd,
  displayMode = 'modal',
  panelShellMode = 'internal',
  onPanelShellStateChange,
  taskTitle
}: GitHistoryViewerProps) {
  const isPanel = displayMode === 'panel'
  const { settings } = useSettings()
  const { locale, t } = useI18n()
  const { getUIPreferences, updateUIPreferences } = useAppState()

  const [loading, setLoading] = useState(false)
  const [historyResult, setHistoryResult] = useState<GitHistoryResult | null>(null)
  const [commits, setCommits] = useState<GitCommitInfo[]>([])
  const [hasMore, setHasMore] = useState(true)
  const [selectedShas, setSelectedShas] = useState<string[]>([])
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null)
  const [files, setFiles] = useState<GitHistoryFile[]>([])
  const [selectedFile, setSelectedFile] = useState<GitHistoryFile | null>(null)
  const [diffPatch, setDiffPatch] = useState('')
  const [selectedFileContent, setSelectedFileContent] = useState<GitHistoryFileContentResult | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [filesLoading, setFilesLoading] = useState(false)
  const [largeFileConfirmState, setLargeFileConfirmState] = useState<LargeFileConfirmState | null>(null)

  const [hideWhitespace, setHideWhitespace] = useState(() => {
    const prefs = getUIPreferences()
    if (prefs.gitHistoryHideWhitespace !== undefined) return prefs.gitHistoryHideWhitespace
    const saved = localStorage.getItem(STORAGE_KEY_HIDE_WHITESPACE)
    return saved === 'true'
  })
  const [diffDisplayMode, setDiffDisplayMode] = useState<GitHistoryDiffDisplayMode>(() => {
    const prefs = getUIPreferences()
    const saved = localStorage.getItem(STORAGE_KEY_DIFF_STYLE)
    return resolveGitHistoryDiffDisplayMode(prefs.gitHistoryDiffStyle, saved)
  })
  const [imageDisplayMode, setImageDisplayMode] = useState<ImageDisplayMode>(() => {
    const prefs = getUIPreferences()
    const p = prefs.gitDiffImageDisplayMode
    if (p === 'original' || p === 'fit') return p
    const saved = localStorage.getItem(IMAGE_DISPLAY_MODE_STORAGE_KEY)
    return saved === 'original' || saved === 'fit' ? saved : 'fit'
  })
  const [imageCompareMode, setImageCompareMode] = useState<ImageCompareMode>(() => {
    const prefs = getUIPreferences()
    const p = prefs.gitDiffImageCompareMode
    if (p === '2up' || p === 'swipe' || p === 'onion') return p
    const saved = localStorage.getItem(IMAGE_COMPARE_MODE_STORAGE_KEY)
    return saved === '2up' || saved === 'swipe' || saved === 'onion' ? saved : '2up'
  })
  const [svgViewMode, setSvgViewMode] = useState<SvgViewMode>('visual')
  const [pdfViewerUrl, setPdfViewerUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const url = await window.electronAPI.appInfo?.getPdfViewerUrl?.()
        if (!cancelled && typeof url === 'string') setPdfViewerUrl(url)
      } catch {
        /* ignore — GitPdfCompare shows a fallback if URL unavailable */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])
  const [diffOptionsOpen, setDiffOptionsOpen] = useState(false)
  const diffOptionsRef = useRef<HTMLDivElement | null>(null)
  const [fileContextMenu, setFileContextMenu] = useState<{ x: number; y: number; targetFile: GitHistoryFile } | null>(null)

  const [fileListWidth, setFileListWidth] = useState(() => {
    const prefs = getUIPreferences()
    if (prefs.gitHistoryFileListWidth !== undefined) return prefs.gitHistoryFileListWidth
    const saved = localStorage.getItem(STORAGE_KEY_FILE_LIST_WIDTH)
    return saved ? parseInt(saved, 10) : DEFAULT_FILE_LIST_WIDTH
  })
  const fileListWidthRef = useRef(fileListWidth)
  const isDraggingRef = useRef(false)
  const dragStartXRef = useRef(0)
  const dragStartWidthRef = useRef(0)

  // Summary / detail-body vertical resizer
  const [summaryHeight, setSummaryHeight] = useState(() => {
    const prefs = getUIPreferences()
    if (prefs.gitHistorySummaryHeight !== undefined) return prefs.gitHistorySummaryHeight
    const saved = localStorage.getItem(STORAGE_KEY_SUMMARY_HEIGHT)
    return saved ? parseInt(saved, 10) : DEFAULT_SUMMARY_HEIGHT
  })
  const summaryHeightRef = useRef(summaryHeight)
  const isVDraggingRef = useRef(false)
  const vDragStartYRef = useRef(0)
  const vDragStartHeightRef = useRef(0)
  const detailContainerRef = useRef<HTMLDivElement | null>(null)

  const loadTokenRef = useRef(0)
  const filesTokenRef = useRef(0)
  const patchTokenRef = useRef(0)
  const fileCacheRef = useRef(new Map<string, GitHistoryFile[]>())
  const patchCacheRef = useRef(new Map<string, string>())
  const fileContentCacheRef = useRef(new Map<string, GitHistoryFileContentResult>())
  const largeFileConfirmRef = useRef<LargeFileConfirmState | null>(null)
  const allowedLargeFileKeysRef = useRef<Set<string>>(new Set())
  const commitsRef = useRef<GitCommitInfo[]>([])
  const filesRef = useRef<GitHistoryFile[]>([])
  const selectedFileRef = useRef<GitHistoryFile | null>(null)
  const selectedFileContentRef = useRef<GitHistoryFileContentResult | null>(null)
  const selectedShasRef = useRef<string[]>([])
  const selectionAnchorRef = useRef<string | null>(null)
  const visibleRepoItemsRef = useRef<RepoTreeItem[]>([])
  const loadingStateRef = useRef({ loading: false, filesLoading: false, diffLoading: false })
  const loadingRef = useRef(false)
  const fileContentTokenRef = useRef(0)
  const didRestoreRef = useRef(false)
  const pendingScrollRef = useRef<{ commit: number; file: number; diff: number } | null>(null)
  const commitListRef = useRef<HTMLDivElement | null>(null)
  const fileListRef = useRef<HTMLDivElement | null>(null)
  const diffScrollRef = useRef<HTMLDivElement | null>(null)
  const commitScrollTopRef = useRef(0)
  const fileScrollTopRef = useRef(0)
  const diffScrollTopRef = useRef(0)
  const selectionRef = useRef<{ selectedShas: string[]; selectionAnchor: string | null; selectedFile: string | null }>({
    selectedShas: [],
    selectionAnchor: null,
    selectedFile: null
  })
  const persistTimerRef = useRef<number | null>(null)
  const [selectedRepoRoot, setSelectedRepoRoot] = useState<string | null>(null)
  const selectedRepoRootRef = useRef<string | null>(selectedRepoRoot)
  const skipRepoReloadRef = useRef(true)
  const [repoSearch, setRepoSearch] = useState('')
  const [cachedRepos, setCachedRepos] = useState<GitHistoryResult['repos']>(undefined)
  const [cachedParentCwd, setCachedParentCwd] = useState<string | null>(null)
  const [expandedRepoRoots, setExpandedRepoRoots] = useState<Set<string>>(() => new Set())
  const cachedParentCwdRef = useRef<string | null>(cachedParentCwd)
  const lastOpenScopeRef = useRef<{ terminalId: string; cwd: string | null } | null>(null)
  const activeCwd = selectedRepoRoot || historyResult?.cwd || cachedParentCwd || cwd
  const activeCwdRef = useRef(activeCwd)
  const cwdRef = useRef(cwd)
  useEffect(() => {
    activeCwdRef.current = activeCwd
  }, [activeCwd])
  useEffect(() => {
    cwdRef.current = cwd
  }, [cwd])
  const terminalId = _terminalId
  const historyStateKey = activeCwd ? `${STORAGE_KEY_STATE_PREFIX}:${activeCwd}` : null
  const historyStateKeyRef = useRef(historyStateKey)
  useEffect(() => {
    historyStateKeyRef.current = historyStateKey
  }, [historyStateKey])
  const isSwitchingRepoRef = useRef(false)
  useEffect(() => {
    selectedRepoRootRef.current = selectedRepoRoot
  }, [selectedRepoRoot])
  useEffect(() => {
    cachedParentCwdRef.current = cachedParentCwd
  }, [cachedParentCwd])

  useEffect(() => {
    if (!cachedRepos || cachedRepos.length === 0) return
    setExpandedRepoRoots((prev) => {
      const next = new Set(prev)
      for (const repo of cachedRepos) {
        next.add(normalizeRepoRoot(repo.root))
        if (repo.parentRoot) {
          next.add(normalizeRepoRoot(repo.parentRoot))
        }
      }
      return next
    })
  }, [cachedRepos])

  const repoTreeParentCwd = cachedParentCwd || historyResult?.cwd || ''
  const visibleRepoItems = useMemo(() => buildRepoTreeItems(
    cachedRepos,
    expandedRepoRoots,
    selectedRepoRoot || repoTreeParentCwd,
    t('gitHistory.repo.current'),
    repoSearch
  ), [cachedRepos, expandedRepoRoots, repoTreeParentCwd, repoSearch, selectedRepoRoot, t])
  const toggleRepoExpanded = useCallback((repoRoot: string) => {
    const key = normalizeRepoRoot(repoRoot)
    if (!key) return
    setExpandedRepoRoots((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])
  const setRepoExpanded = useCallback((repoRoot: string, expanded: boolean) => {
    const key = normalizeRepoRoot(repoRoot)
    if (!key) return false
    setExpandedRepoRoots((prev) => {
      const next = new Set(prev)
      if (expanded) {
        next.add(key)
      } else {
        next.delete(key)
      }
      return next
    })
    return true
  }, [])

  const commitIndexMap = useMemo(() => {
    const map = new Map<string, number>()
    commits.forEach((commit, index) => {
      map.set(commit.sha, index)
    })
    return map
  }, [commits])

  useEffect(() => {
    fileListWidthRef.current = fileListWidth
  }, [fileListWidth])

  useEffect(() => {
    commitsRef.current = commits
  }, [commits])

  useEffect(() => {
    filesRef.current = files
  }, [files])

  useEffect(() => {
    selectedFileRef.current = selectedFile
  }, [selectedFile])

  useEffect(() => {
    selectedFileContentRef.current = selectedFileContent
  }, [selectedFileContent])

  useEffect(() => {
    visibleRepoItemsRef.current = visibleRepoItems
  }, [visibleRepoItems])

  useEffect(() => {
    loadingRef.current = loading
    loadingStateRef.current = { loading, filesLoading, diffLoading }
  }, [diffLoading, filesLoading, loading])

  useEffect(() => {
    selectedShasRef.current = selectedShas
    selectionAnchorRef.current = selectionAnchor
    selectionRef.current = {
      selectedShas,
      selectionAnchor,
      selectedFile: selectedFile?.filename ?? null
    }
  }, [selectedShas, selectionAnchor, selectedFile])

  const selectionInfo = useMemo(() => {
    if (selectedShas.length === 0) {
      return {
        isContiguous: false,
        head: null as string | null,
        base: null as string | null,
        selectedCommits: [] as GitCommitInfo[]
      }
    }
    const indices = selectedShas
      .map(sha => commitIndexMap.get(sha))
      .filter((index): index is number => typeof index === 'number')
      .sort((a, b) => a - b)
    if (indices.length === 0) {
      return {
        isContiguous: false,
        head: null,
        base: null,
        selectedCommits: [] as GitCommitInfo[]
      }
    }
    const minIndex = indices[0]
    const maxIndex = indices[indices.length - 1]
    const isContiguous = maxIndex - minIndex + 1 === indices.length
    const head = commits[minIndex]?.sha ?? null
    const base = commits[maxIndex]?.parents?.[0] ?? EMPTY_TREE_HASH
    const selectedCommits = indices
      .map(index => commits[index])
      .filter(Boolean)
    return {
      isContiguous,
      head,
      base,
      selectedCommits
    }
  }, [selectedShas, commitIndexMap, commits])

  const selectedCommit = selectionInfo.selectedCommits[0] ?? null
  const oldestCommit = selectionInfo.selectedCommits[selectionInfo.selectedCommits.length - 1] ?? null

  // --- Path copy (shared hook) ---
  const { copyMessage, copyToClipboard, flashCopyFeedback } = usePathCopy(t, 'gitHistory.copyFailed')

  const handleFilenameDblClick = useCallback(async (e: React.MouseEvent) => {
    if (!selectedFile) return
    const target = e.currentTarget as HTMLElement
    const rootCwd = activeCwd || ''
    const isAbsolute = e.altKey
    const relativePath = selectedFile.filename
    const pathToCopy = isAbsolute ? `${rootCwd}/${relativePath}` : relativePath
    const label = isAbsolute ? t('common.absolutePath') : t('common.relativePath')
    const ok = await copyToClipboard(pathToCopy, label)
    if (ok) flashCopyFeedback(target)
  }, [selectedFile, activeCwd, copyToClipboard, flashCopyFeedback, t])

  const handleFileContextMenu = useCallback((e: React.MouseEvent, file: GitHistoryFile) => {
    e.preventDefault()
    e.stopPropagation()
    setFileContextMenu({ x: e.clientX, y: e.clientY, targetFile: file })
  }, [])

  const closeFileContextMenu = useCallback(() => {
    setFileContextMenu(null)
  }, [])

  const copyContextMenuPath = useCallback(async (file: GitHistoryFile, kind: 'name' | 'relative' | 'absolute') => {
    const rootCwd = activeCwd || ''
    if (kind === 'name') {
      const name = file.filename.split('/').pop() || file.filename
      await copyToClipboard(name, t('common.name'))
    } else if (kind === 'relative') {
      await copyToClipboard(file.filename, t('common.relativePath'))
    } else {
      await copyToClipboard(`${rootCwd}/${file.filename}`, t('common.absolutePath'))
    }
    closeFileContextMenu()
  }, [activeCwd, closeFileContextMenu, copyToClipboard, t])

  useEffect(() => {
    if (!fileContextMenu) return
    const handleMouseDown = () => setFileContextMenu(null)
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [fileContextMenu])

  const diffFontSize = settings?.gitDiffFontSize ?? DEFAULT_GIT_DIFF_FONT_SIZE
  const diffStyle = toGitHistoryPatchDiffStyle(diffDisplayMode)
  const diffOptions = useMemo(() => ({
    diffStyle,
    diffIndicators: 'classic' as const,
    lineDiffType: 'word' as const,
    overflow: 'wrap' as const,
    disableFileHeader: true,
    theme: 'pierre-dark' as const,
    themeType: 'dark' as const
  }), [diffStyle])
  const multiFileDiffOptions = useMemo(() => ({
    diffStyle,
    diffIndicators: 'classic' as const,
    lineDiffType: 'word' as const,
    overflow: 'wrap' as const,
    disableFileHeader: true,
    theme: 'pierre-dark' as const,
    themeType: 'dark' as const,
    expandUnchanged: false,
  }), [diffStyle])
  const imageTextDiffOptions = useMemo(() => ({
    renderSideBySide: true,
    renderSideBySideInlineBreakpoint: DIFF_INLINE_BREAKPOINT,
    useInlineViewWhenSpaceIsLimited: true,
    readOnly: true,
    originalEditable: false,
    minimap: { enabled: false },
    wordWrap: 'on' as const,
    diffWordWrap: 'on' as const,
    fontSize: diffFontSize,
    lineHeight: Math.round(diffFontSize * 1.5),
    automaticLayout: true,
    scrollBeyondLastLine: false,
    hideUnchangedRegions: {
      enabled: true,
      minimumLineCount: 3,
      contextLineCount: 3,
      revealLineCount: 20
    }
  }), [diffFontSize])
  const toggleImageDisplayMode = useCallback((mode: ImageDisplayMode) => {
    setImageDisplayMode(mode)
    localStorage.setItem(IMAGE_DISPLAY_MODE_STORAGE_KEY, mode)
    updateUIPreferences({ gitDiffImageDisplayMode: mode })
  }, [updateUIPreferences])
  const toggleImageCompareMode = useCallback((mode: ImageCompareMode) => {
    setImageCompareMode(mode)
    localStorage.setItem(IMAGE_COMPARE_MODE_STORAGE_KEY, mode)
    updateUIPreferences({ gitDiffImageCompareMode: mode })
  }, [])

  const resetState = useCallback(() => {
    setHistoryResult(null)
    setCommits([])
    commitsRef.current = []
    setHasMore(true)
    setSelectedShas([])
    selectedShasRef.current = []
    setSelectionAnchor(null)
    selectionAnchorRef.current = null
    setFiles([])
    filesRef.current = []
    setSelectedFile(null)
    selectedFileRef.current = null
    setDiffPatch('')
    setSelectedFileContent(null)
    setDiffError(null)
    setDiffLoading(false)
    setFilesLoading(false)
    fileCacheRef.current.clear()
    patchCacheRef.current.clear()
    fileContentCacheRef.current.clear()
    ++filesTokenRef.current
    ++patchTokenRef.current
    ++fileContentTokenRef.current
    didRestoreRef.current = false
    pendingScrollRef.current = null
    selectedRepoRootRef.current = null
    cachedParentCwdRef.current = null
    selectionRef.current = {
      selectedShas: [],
      selectionAnchor: null,
      selectedFile: null
    }
    setSelectedRepoRoot(null)
    setCachedRepos(undefined)
    setCachedParentCwd(null)
    setRepoSearch('')
    setExpandedRepoRoots(new Set())
    skipRepoReloadRef.current = true
  }, [])

  const loadHistory = useCallback(async (reset = false) => {
    const targetRepoRoot = selectedRepoRootRef.current
    const targetParentCwd = cachedParentCwdRef.current
    const targetCwd = targetRepoRoot || targetParentCwd || cwdRef.current
    if (!targetCwd) return
    if (loadingRef.current) return
    loadingRef.current = true
    const isSwitching = isSwitchingRepoRef.current
    setLoading(true)
    const token = ++loadTokenRef.current
    const skip = reset ? 0 : commitsRef.current.length
    try {
      const result = await window.electronAPI.git.getHistory(targetCwd, {
        limit: HISTORY_PAGE_SIZE,
        skip
      })
      if (token !== loadTokenRef.current) return
      setHistoryResult(result)
      if (!targetRepoRoot && result.repos && result.repos.length > 1) {
        cachedParentCwdRef.current = result.cwd
        setCachedRepos(result.repos)
        setCachedParentCwd(result.cwd)
      }
      if (!result.success) {
        setCommits([])
        setHasMore(false)
        return
      }
      const nextCommits = reset ? result.commits : [...commitsRef.current, ...result.commits]
      commitsRef.current = nextCommits
      setCommits(nextCommits)
      const total = result.totalCount ?? null
      const nextCount = nextCommits.length
      const hasMoreNext = total === null
        ? result.commits.length >= HISTORY_PAGE_SIZE
        : nextCount < total
      setHasMore(hasMoreNext)
      if (isSwitching) {
        setSelectedShas([])
        selectedShasRef.current = []
        setSelectionAnchor(null)
        selectionAnchorRef.current = null
        setFiles([])
        filesRef.current = []
        setSelectedFile(null)
        selectedFileRef.current = null
        setDiffPatch('')
        setDiffError(null)
      }
    } finally {
      isSwitchingRepoRef.current = false
      if (token === loadTokenRef.current) {
        setLoading(false)
        loadingRef.current = false
      }
    }
  }, [])

  const loadFilesForRange = useCallback(async (base: string, head: string) => {
    const cwdToUse = activeCwdRef.current
    if (!cwdToUse) return
    const cacheKey = buildRangeKey(base, head, hideWhitespace)
    if (fileCacheRef.current.has(cacheKey)) {
      const cached = fileCacheRef.current.get(cacheKey) || []
      filesRef.current = cached
      setFiles(cached)
      return
    }
    const token = ++filesTokenRef.current
    setFilesLoading(true)
    setDiffError(null)
    try {
      const result = await window.electronAPI.git.getHistoryDiff(cwdToUse, {
        base,
        head,
        includeFiles: true,
        hideWhitespace
      })
      if (token !== filesTokenRef.current) return
      if (!result.success) {
        setDiffError(result.error || t('gitHistory.error.loadDiff'))
        filesRef.current = []
        setFiles([])
        return
      }
      fileCacheRef.current.set(cacheKey, result.files)
      filesRef.current = result.files
      setFiles(result.files)
    } finally {
      if (token === filesTokenRef.current) {
        setFilesLoading(false)
      }
    }
  }, [hideWhitespace, t])

  const requestLargeFileConfirmation = useCallback((filename: string, sizeBytes: number) => {
    return new Promise<boolean>((resolve) => {
      const nextState: LargeFileConfirmState = {
        filename,
        sizeBytes,
        sizeLabel: formatLargeFileSize(sizeBytes),
        resolve
      }
      largeFileConfirmRef.current = nextState
      setLargeFileConfirmState(nextState)
    })
  }, [])

  const settleLargeFileConfirmation = useCallback((confirmed: boolean) => {
    const current = largeFileConfirmRef.current
    if (!current) return
    largeFileConfirmRef.current = null
    setLargeFileConfirmState(null)
    current.resolve(confirmed)
  }, [])

  useEffect(() => {
    return () => {
      settleLargeFileConfirmation(false)
    }
  }, [settleLargeFileConfirmation])

  useEffect(() => {
    if (!isOpen) {
      settleLargeFileConfirmation(false)
    }
  }, [isOpen, settleLargeFileConfirmation])

  useEffect(() => {
    settleLargeFileConfirmation(false)
  }, [activeCwd, settleLargeFileConfirmation])

  const resolveLargeFileHistoryContent = useCallback(async (
    cwdToUse: string,
    base: string,
    head: string,
    file: GitHistoryFile,
    cacheKey: string
  ): Promise<GitHistoryFileContentResult> => {
    let result: GitHistoryFileContentResult = await window.electronAPI.git.getHistoryFileContent(cwdToUse, {
      base,
      head,
      file: {
        filename: file.filename,
        originalFilename: file.originalFilename,
        status: file.status
      },
      allowLargeFile: allowedLargeFileKeysRef.current.has(cacheKey)
    })
    if (!result.requiresLargeFileConfirmation) return result

    const sizeBytes = result.largeFileSizeBytes ?? result.largeFileThresholdBytes ?? 0
    const confirmed = await requestLargeFileConfirmation(file.filename, sizeBytes)
    if (!confirmed) {
      allowedLargeFileKeysRef.current.delete(cacheKey)
      return {
        ...result,
        success: false,
        error: t('gitDiff.largeFile.cancelled', { size: formatLargeFileSize(sizeBytes) })
      }
    }

    allowedLargeFileKeysRef.current.add(cacheKey)
    result = await window.electronAPI.git.getHistoryFileContent(cwdToUse, {
      base,
      head,
      file: {
        filename: file.filename,
        originalFilename: file.originalFilename,
        status: file.status
      },
      allowLargeFile: true
    })
    return result
  }, [requestLargeFileConfirmation, t])

  const loadPatchForFile = useCallback(async (base: string, head: string, file: GitHistoryFile) => {
    const cwdToUse = activeCwdRef.current
    if (!cwdToUse) return
    const cacheKey = buildPatchKey(base, head, file.filename, hideWhitespace)
    if (patchCacheRef.current.has(cacheKey)) {
      setDiffPatch(patchCacheRef.current.get(cacheKey) || '')
      return
    }
    const token = ++patchTokenRef.current
    setDiffLoading(true)
    setDiffError(null)
    try {
      const contentKey = buildFileContentKey(base, head, file)
      const guard = await resolveLargeFileHistoryContent(cwdToUse, base, head, file, contentKey)
      if (token !== patchTokenRef.current) return
      if (!guard.success) {
        setDiffError(guard.error || t('gitHistory.error.loadDiff'))
        setDiffPatch('')
        return
      }
      fileContentCacheRef.current.set(contentKey, guard)

      const result: GitHistoryDiffResult = await window.electronAPI.git.getHistoryDiff(cwdToUse, {
        base,
        head,
        filePath: file.filename,
        includeFiles: false,
        hideWhitespace
      })
      if (token !== patchTokenRef.current) return
      if (!result.success) {
        setDiffError(result.error || t('gitHistory.error.loadDiff'))
        setDiffPatch('')
        return
      }
      patchCacheRef.current.set(cacheKey, result.patch)
      setDiffPatch(result.patch)
    } finally {
      if (token === patchTokenRef.current) {
        setDiffLoading(false)
      }
    }
  }, [hideWhitespace, resolveLargeFileHistoryContent, t])

  const loadFileContentForHistory = useCallback(async (base: string, head: string, file: GitHistoryFile) => {
    const cwdToUse = activeCwdRef.current
    if (!cwdToUse) return
    const cacheKey = buildFileContentKey(base, head, file)
    if (fileContentCacheRef.current.has(cacheKey)) {
      setSelectedFileContent(fileContentCacheRef.current.get(cacheKey) || null)
      return
    }
    const token = ++fileContentTokenRef.current
    setDiffLoading(true)
    setDiffError(null)
    try {
      const result = await resolveLargeFileHistoryContent(cwdToUse, base, head, file, cacheKey)
      if (token !== fileContentTokenRef.current) return
      if (!result.success) {
        setDiffError(result.error || t('gitHistory.error.loadDiff'))
        setSelectedFileContent(null)
        return
      }
      fileContentCacheRef.current.set(cacheKey, result)
      setSelectedFileContent(result)
    } finally {
      if (token === fileContentTokenRef.current) {
        setDiffLoading(false)
      }
    }
  }, [resolveLargeFileHistoryContent, t])

  // Try file content first (for MultiFileDiff with expand support),
  // silently fall back to patch-based diff for large or binary files
  const loadTextFileDiffContent = useCallback(async (base: string, head: string, file: GitHistoryFile) => {
    const cwdToUse = activeCwdRef.current
    if (!cwdToUse) return
    const cacheKey = buildFileContentKey(base, head, file)
    if (fileContentCacheRef.current.has(cacheKey)) {
      const cached = fileContentCacheRef.current.get(cacheKey)
      if (cached && cached.success && !cached.isBinary) {
        setSelectedFileContent(cached)
        return
      }
      void loadPatchForFile(base, head, file)
      return
    }
    const token = ++fileContentTokenRef.current
    setDiffLoading(true)
    setDiffError(null)
    let loaded = false
    try {
      const result = await resolveLargeFileHistoryContent(cwdToUse, base, head, file, cacheKey)
      if (token !== fileContentTokenRef.current) return
      if (result.requiresLargeFileConfirmation || !result.success) {
        setDiffError(result.error || t('gitHistory.error.loadDiff'))
        setSelectedFileContent(null)
        loaded = true
        return
      }
      if (result.success && !result.isBinary) {
        fileContentCacheRef.current.set(cacheKey, result)
        setSelectedFileContent(result)
        loaded = true
        return
      }
      fileContentCacheRef.current.set(cacheKey, result)
    } catch {
      if (token !== fileContentTokenRef.current) return
    } finally {
      if (token === fileContentTokenRef.current && loaded) {
        setDiffLoading(false)
      }
    }
    if (token === fileContentTokenRef.current) {
      setDiffLoading(false)
      void loadPatchForFile(base, head, file)
    }
  }, [t, loadPatchForFile, resolveLargeFileHistoryContent])

  const switchRepo = useCallback((repoRoot: string | null) => {
    settleLargeFileConfirmation(false)
    isSwitchingRepoRef.current = true
    skipRepoReloadRef.current = true
    ++loadTokenRef.current
    loadingRef.current = false
    fileCacheRef.current.clear()
    patchCacheRef.current.clear()
    fileContentCacheRef.current.clear()
    ++patchTokenRef.current
    ++fileContentTokenRef.current
    commitsRef.current = []
    setCommits([])
    setHasMore(true)
    setFiles([])
    setSelectedShas([])
    setSelectionAnchor(null)
    setSelectedFile(null)
    setDiffPatch('')
    setDiffError(null)
    setSelectedFileContent(null)
    didRestoreRef.current = false
    selectedRepoRootRef.current = repoRoot
    setSelectedRepoRoot(repoRoot)
    void loadHistory(true)
  }, [loadHistory, settleLargeFileConfirmation])

  const persistState = useCallback(() => {
    if (!historyStateKey) return
    const payload = {
      selectedShas: selectionRef.current.selectedShas,
      selectionAnchor: selectionRef.current.selectionAnchor,
      selectedFile: selectionRef.current.selectedFile,
      commitScrollTop: commitScrollTopRef.current,
      fileScrollTop: fileScrollTopRef.current,
      diffScrollTop: diffScrollTopRef.current
    }
    localStorage.setItem(historyStateKey, JSON.stringify(payload))
    updateUIPreferences({
      gitHistoryStates: { ...(getUIPreferences().gitHistoryStates ?? {}), [historyStateKey]: payload }
    })
  }, [historyStateKey, getUIPreferences, updateUIPreferences])

  const persistStateRef = useRef(persistState)
  useEffect(() => {
    persistStateRef.current = persistState
  }, [persistState])

  const schedulePersist = useCallback(() => {
    if (!historyStateKeyRef.current) return
    if (persistTimerRef.current) {
      window.clearTimeout(persistTimerRef.current)
    }
    persistTimerRef.current = window.setTimeout(() => {
      persistStateRef.current()
    }, 200)
  }, [])

  useEffect(() => {
    if (!isOpen) {
      persistStateRef.current()
      return
    }
    const nextScope = { terminalId, cwd: cwd ?? null }
    const previousScope = lastOpenScopeRef.current
    const shouldReset = !previousScope ||
      previousScope.terminalId !== nextScope.terminalId ||
      previousScope.cwd !== nextScope.cwd
    lastOpenScopeRef.current = nextScope
    if (shouldReset) {
      resetState()
    }
    void loadHistory(true)
  }, [cwd, isOpen, loadHistory, resetState, terminalId])

  useEffect(() => {
    if (!isOpen) return
    if (skipRepoReloadRef.current) {
      skipRepoReloadRef.current = false
      return
    }
    void loadHistory(true)
  }, [isOpen, loadHistory, selectedRepoRoot])

  useEffect(() => {
    return () => {
      if (persistTimerRef.current) {
        window.clearTimeout(persistTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!isOpen) return
    schedulePersist()
  }, [isOpen, selectedShas, selectionAnchor, selectedFile, schedulePersist])

  useEffect(() => {
    if (!isOpen) return
    const hasValidSelection = selectedShas.some(sha => commitIndexMap.has(sha))
    if (commits.length > 0 && (selectedShas.length === 0 || !hasValidSelection)) {
      const nextSelected = [commits[0].sha]
      selectedShasRef.current = nextSelected
      selectionAnchorRef.current = commits[0].sha
      setSelectedShas(nextSelected)
      setSelectionAnchor(commits[0].sha)
    }
  }, [commitIndexMap, commits, isOpen, selectedShas])

  useEffect(() => {
    if (!isOpen) return
    if (!historyStateKey) return
    if (didRestoreRef.current) return
    if (!historyResult || !historyResult.success) return
    if (commits.length === 0) return

    didRestoreRef.current = true
    const prefs = getUIPreferences()
    const raw = localStorage.getItem(historyStateKey)
      || (prefs.gitHistoryStates?.[historyStateKey] ? JSON.stringify(prefs.gitHistoryStates[historyStateKey]) : null)
    if (!raw) return
    try {
      const stored = JSON.parse(raw) as {
        selectedShas?: string[]
        selectionAnchor?: string | null
        selectedFile?: string | null
        commitScrollTop?: number
        fileScrollTop?: number
        diffScrollTop?: number
      }
      const available = new Set(commits.map(commit => commit.sha))
      const nextSelected = (stored.selectedShas ?? []).filter(sha => available.has(sha))
      if (nextSelected.length > 0) {
        selectedShasRef.current = nextSelected
        setSelectedShas(nextSelected)
        const nextAnchor = stored.selectionAnchor && available.has(stored.selectionAnchor) ? stored.selectionAnchor : nextSelected[0]
        selectionAnchorRef.current = nextAnchor
        setSelectionAnchor(nextAnchor)
      }
      pendingScrollRef.current = {
        commit: stored.commitScrollTop ?? 0,
        file: stored.fileScrollTop ?? 0,
        diff: stored.diffScrollTop ?? 0
      }
      requestAnimationFrame(() => {
        if (commitListRef.current && pendingScrollRef.current) {
          commitListRef.current.scrollTop = pendingScrollRef.current.commit
          commitScrollTopRef.current = pendingScrollRef.current.commit
        }
      })
    } catch {
      // ignore corrupted storage
    }
  }, [isOpen, historyStateKey, historyResult, commits])

  useEffect(() => {
    if (!isOpen) return
    if (!selectionInfo.head || !selectionInfo.base) {
      ++patchTokenRef.current
      ++fileContentTokenRef.current
      filesRef.current = []
      setFiles([])
      selectedFileRef.current = null
      setSelectedFile(null)
      setDiffPatch('')
      setSelectedFileContent(null)
      return
    }
    if (!selectionInfo.isContiguous) {
      ++patchTokenRef.current
      ++fileContentTokenRef.current
      filesRef.current = []
      setFiles([])
      selectedFileRef.current = null
      setSelectedFile(null)
      setDiffPatch('')
      setSelectedFileContent(null)
      return
    }
    void loadFilesForRange(selectionInfo.base, selectionInfo.head)
  }, [isOpen, selectionInfo.head, selectionInfo.base, selectionInfo.isContiguous, loadFilesForRange])

  useEffect(() => {
    if (!isOpen) return
    if (!selectionInfo.isContiguous || !selectionInfo.head || !selectionInfo.base) return
    if (files.length === 0) {
      selectedFileRef.current = null
      setSelectedFile(null)
      setDiffPatch('')
      return
    }
    setSelectedFile((prev) => {
      if (prev && files.some(file => file.filename === prev.filename)) {
        selectedFileRef.current = prev
        return prev
      }
      const storedFile = selectionRef.current.selectedFile
      if (storedFile) {
        const match = files.find(file => file.filename === storedFile)
        if (match) {
          selectedFileRef.current = match
          return match
        }
      }
      selectedFileRef.current = files[0]
      return files[0]
    })
  }, [files, selectionInfo.isContiguous, selectionInfo.head, selectionInfo.base, isOpen])

  useEffect(() => {
    if (!isOpen) return
    if (!selectionInfo.isContiguous || !selectionInfo.head || !selectionInfo.base) return
    if (!selectedFile) {
      ++patchTokenRef.current
      ++fileContentTokenRef.current
      setDiffPatch('')
      setSelectedFileContent(null)
      return
    }
    if (selectedFile.isImage || selectedFile.isPdf || selectedFile.isEpub) {
      ++patchTokenRef.current
      ++fileContentTokenRef.current
      setDiffPatch('')
      setSelectedFileContent(null)
      void loadFileContentForHistory(selectionInfo.base, selectionInfo.head, selectedFile)
      return
    }
    ++patchTokenRef.current
    ++fileContentTokenRef.current
    setDiffPatch('')
    setSelectedFileContent(null)
    if (hideWhitespace) {
      void loadPatchForFile(selectionInfo.base, selectionInfo.head, selectedFile)
    } else {
      void loadTextFileDiffContent(selectionInfo.base, selectionInfo.head, selectedFile)
    }
  }, [selectedFile, selectionInfo.isContiguous, selectionInfo.base, selectionInfo.head, loadFileContentForHistory, loadPatchForFile, loadTextFileDiffContent, isOpen, hideWhitespace])

  useEffect(() => {
    if (!isOpen) return
    if (!pendingScrollRef.current) return
    if (fileListRef.current) {
      fileListRef.current.scrollTop = pendingScrollRef.current.file
      fileScrollTopRef.current = pendingScrollRef.current.file
    }
    if (diffScrollRef.current) {
      diffScrollRef.current.scrollTop = pendingScrollRef.current.diff
      diffScrollTopRef.current = pendingScrollRef.current.diff
    }
    pendingScrollRef.current = null
  }, [files.length, diffPatch, selectedFileContent?.filename, isOpen])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (diffOptionsRef.current && !diffOptionsRef.current.contains(event.target as Node)) {
        setDiffOptionsOpen(false)
      }
    }
    if (diffOptionsOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => {
        document.removeEventListener('mousedown', handleClickOutside)
      }
    }
  }, [diffOptionsOpen])

  const isOpenRef = useRef(isOpen)
  useEffect(() => {
    isOpenRef.current = isOpen
  }, [isOpen])

  // Debug API (only exposed in automated testing mode)
  useEffect(() => {
    if (!window.electronAPI?.debug?.autotest) return
    if (!isOpen) {
      if ((window as any).__onwardGitHistoryDebugTerminalId === terminalId) {
        delete (window as any).__onwardGitHistoryDebug
        delete (window as any).__onwardGitHistoryDebugTerminalId
      }
      return
    }
    const mapInjectedRepos = (repos?: Array<{
      root: string
      label: string
      isSubmodule?: boolean
      depth?: number
      changeCount?: number
      parentRoot?: string
    }>): GitRepoContext[] | undefined => {
      if (!repos) return undefined
      return repos.map(repo => ({
        root: repo.root,
        label: repo.label,
        isSubmodule: repo.isSubmodule ?? true,
        depth: repo.depth ?? 1,
        parentRoot: repo.parentRoot,
        changeCount: repo.changeCount ?? 0
      }))
    }
    const api = {
      isOpen: () => isOpenRef.current,
      getCommitCount: () => commitsRef.current.length,
      getCommits: () => commitsRef.current.map((commit) => ({ sha: commit.sha, summary: commit.summary, refs: commit.refs })),
      getSelectedShas: () => selectedShasRef.current,
      getFiles: () => filesRef.current.map(f => ({
        filename: f.filename,
        status: f.status,
        isImage: f.isImage,
        isPdf: f.isPdf,
        isEpub: f.isEpub
      })),
      getSelectedFile: () => {
        const file = selectedFileRef.current
        return file ? {
          filename: file.filename,
          status: file.status,
          isImage: file.isImage,
          isPdf: file.isPdf,
          isEpub: file.isEpub
        } : null
      },
      getSelectedFileContent: () => {
        const content = selectedFileContentRef.current
        if (!content) return null
        return {
          originalContent: content.originalContent ?? null,
          modifiedContent: content.modifiedContent ?? null,
          isBinary: Boolean(content.isBinary),
          loading: diffLoading,
          error: content.error ?? null
        }
      },
      getDiffError: () => diffError,
      getImagePreviewState: () => {
        if (!selectedFile?.isImage) return null
        return {
          isImage: true,
          isSvg: Boolean(selectedFileContent?.isSvg),
          hasOriginalUrl: Boolean(selectedFileContent?.originalImageUrl),
          hasModifiedUrl: Boolean(selectedFileContent?.modifiedImageUrl),
          compareMode: imageCompareMode,
          displayMode: imageDisplayMode,
          svgViewMode,
          loading: diffLoading
        }
      },
      setImageCompareMode: (mode: ImageCompareMode) => {
        toggleImageCompareMode(mode)
      },
      setImageDisplayMode: (mode: ImageDisplayMode) => {
        toggleImageDisplayMode(mode)
      },
      setSvgViewMode: (mode: SvgViewMode) => {
        setSvgViewMode(mode)
      },
      isLoading: () => {
        const state = loadingStateRef.current
        return state.loading || state.filesLoading || state.diffLoading
      },
      getActiveCwd: () => activeCwdRef.current ?? null,
      getRepoState: () => ({
        selectedRepoRoot,
        cachedParentCwd,
        repoSearch,
        cachedRepoCount: cachedRepos?.length ?? 0
      }),
      getVisibleRepoItems: () => visibleRepoItemsRef.current.map((repo) => ({
        root: repo.root,
        label: repo.displayLabel,
        isSubmodule: repo.isSubmodule,
        depth: repo.depth,
        treeDepth: repo.treeDepth,
        changeCount: repo.changeCount,
        parentRoot: repo.parentRoot,
        loading: repo.loading,
        hasChildren: repo.hasChildren,
        expanded: repo.expanded,
        isCurrent: repo.isCurrent
      })),
      setRepoExpanded,
      switchRepo: (repoRoot: string | null) => {
        switchRepo(repoRoot)
      },
      injectRepoState: (state: {
        selectedRepoRoot: string | null
        cachedParentCwd: string | null
        repoSearch?: string
        cachedRepos?: Array<{
          root: string
          label: string
          isSubmodule?: boolean
          depth?: number
          changeCount?: number
          parentRoot?: string
        }>
      }) => {
        skipRepoReloadRef.current = true
        selectedRepoRootRef.current = state.selectedRepoRoot
        cachedParentCwdRef.current = state.cachedParentCwd
        setSelectedRepoRoot(state.selectedRepoRoot)
        setCachedParentCwd(state.cachedParentCwd)
        setRepoSearch(state.repoSearch ?? '')
        setCachedRepos(mapInjectedRepos(state.cachedRepos))
        return true
      },
      selectCommitByIndex: (index: number) => {
        const currentCommits = commitsRef.current
        if (index < 0 || index >= currentCommits.length) return false
        const commit = currentCommits[index]
        const nextSelected = [commit.sha]
        selectedShasRef.current = nextSelected
        selectionAnchorRef.current = commit.sha
        selectionRef.current = {
          ...selectionRef.current,
          selectedShas: nextSelected,
          selectionAnchor: commit.sha
        }
        setSelectedShas(nextSelected)
        setSelectionAnchor(commit.sha)
        // Direct dispatch: programmatic callers (autotest, keyboard nav,
        // external nav) expect the file list to reflect the new commit
        // before this method returns. The selection-watching useEffect at
        // line ~1063 is too lazy for that contract — its dispatch can
        // miss a frame after a close/reopen cycle. Triggering the load
        // here makes `getFiles()` observe the new range synchronously
        // (cache-hit) or as soon as the IPC returns (cache-miss). The
        // effect remains in place for non-API selection paths and is
        // idempotent for an already-loaded range.
        const head = commit.sha
        const base = commit.parents?.[0] ?? EMPTY_TREE_HASH
        void loadFilesForRange(base, head)
        return true
      },
      selectFileByIndex: (index: number) => {
        const currentFiles = filesRef.current
        if (index < 0 || index >= currentFiles.length) return false
        const file = currentFiles[index]
        selectedFileRef.current = file
        selectionRef.current = {
          ...selectionRef.current,
          selectedFile: file.filename
        }
        setSelectedFile(file)
        return true
      },
      selectFileByPath: (path: string) => {
        const currentFiles = filesRef.current
        const file = currentFiles.find((entry) => entry.filename === path || entry.originalFilename === path)
        if (!file) return false
        selectedFileRef.current = file
        selectionRef.current = {
          ...selectionRef.current,
          selectedFile: file.filename
        }
        setSelectedFile(file)
        return true
      },
      getDiffStyle: () => diffStyle,
      getDiffDisplayMode: () => diffDisplayMode,
      setDiffStyle: (style: GitHistoryPatchDiffStyle | GitHistoryDiffDisplayMode) => {
        const mode = coerceGitHistoryDiffDisplayMode(style)
        if (!mode) return
        setDiffDisplayMode(mode)
        localStorage.setItem(STORAGE_KEY_DIFF_STYLE, mode)
        updateUIPreferences({ gitHistoryDiffStyle: mode })
      },
      setDiffDisplayMode: (mode: GitHistoryDiffDisplayMode) => {
        setDiffDisplayMode(mode)
        localStorage.setItem(STORAGE_KEY_DIFF_STYLE, mode)
        updateUIPreferences({ gitHistoryDiffStyle: mode })
      },
      getHideWhitespace: () => hideWhitespace,
      setHideWhitespace: (value: boolean) => {
        setHideWhitespace(value)
        localStorage.setItem(STORAGE_KEY_HIDE_WHITESPACE, String(value))
        updateUIPreferences({ gitHistoryHideWhitespace: value })
      },
      reloadSelectedFileContent: () => {
        const file = selectedFileRef.current
        if (!file || !selectionInfo.isContiguous || !selectionInfo.head || !selectionInfo.base) return false
        ++patchTokenRef.current
        ++fileContentTokenRef.current
        setDiffPatch('')
        setSelectedFileContent(null)
        if (file.isImage || file.isPdf || file.isEpub) {
          void loadFileContentForHistory(selectionInfo.base, selectionInfo.head, file)
        } else {
          void loadTextFileDiffContent(selectionInfo.base, selectionInfo.head, file)
        }
        return true
      },
      getLargeFileConfirmState: () => {
        const state = largeFileConfirmRef.current
        return state ? {
          visible: true,
          filename: state.filename,
          sizeBytes: state.sizeBytes,
          sizeLabel: state.sizeLabel
        } : { visible: false, filename: null, sizeBytes: null, sizeLabel: null }
      },
      confirmLargeFile: () => {
        settleLargeFileConfirmation(true)
      },
      cancelLargeFile: () => {
        settleLargeFileConfirmation(false)
      },
      getPdfCompareState: () => inspectPdfCompareDom(),
      getEpubCompareState: () => inspectEpubCompareDom()
    }
    ;(window as any).__onwardGitHistoryDebug = api
    ;(window as any).__onwardGitHistoryDebugTerminalId = terminalId
    return () => {
      if ((window as any).__onwardGitHistoryDebug === api) {
        delete (window as any).__onwardGitHistoryDebug
        delete (window as any).__onwardGitHistoryDebugTerminalId
      }
    }
  }, [isOpen, commits, selectedShas, files, selectedFile, selectedFileContent, loading, filesLoading, diffLoading, diffError, diffStyle, diffDisplayMode, hideWhitespace, imageCompareMode, imageDisplayMode, svgViewMode, selectedRepoRoot, cachedParentCwd, repoSearch, cachedRepos, visibleRepoItems, setRepoExpanded, selectionInfo.isContiguous, selectionInfo.base, selectionInfo.head, loadFileContentForHistory, loadTextFileDiffContent, settleLargeFileConfirmation, toggleImageCompareMode, toggleImageDisplayMode, switchRepo])

  useSubpageEscape({ isOpen, onEscape: onClose })

  const handleCommitClick = useCallback((commit: GitCommitInfo, event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    const index = commitIndexMap.get(commit.sha)
    if (index === undefined) return
    if (event.shiftKey && selectionAnchor) {
      const anchorIndex = commitIndexMap.get(selectionAnchor)
      if (anchorIndex === undefined) {
        setSelectedShas([commit.sha])
        setSelectionAnchor(commit.sha)
        return
      }
      const start = Math.min(anchorIndex, index)
      const end = Math.max(anchorIndex, index)
      const range = commits.slice(start, end + 1).map(item => item.sha)
      setSelectedShas(range)
      return
    }
    const isMeta = event.metaKey || event.ctrlKey
    if (isMeta) {
      setSelectedShas((prev) => {
        if (prev.includes(commit.sha)) {
          return prev.filter(sha => sha !== commit.sha)
        }
        return [...prev, commit.sha]
      })
      setSelectionAnchor(commit.sha)
      return
    }
    setSelectedShas([commit.sha])
    setSelectionAnchor(commit.sha)
  }, [commitIndexMap, selectionAnchor, commits])

  const handleCommitListScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget
    commitScrollTopRef.current = target.scrollTop
    schedulePersist()
    if (!hasMore || loading) return
    if (target.scrollHeight - target.scrollTop - target.clientHeight < 120) {
      void loadHistory(false)
    }
  }, [hasMore, loading, loadHistory, schedulePersist])

  const handleFileListScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    fileScrollTopRef.current = event.currentTarget.scrollTop
    schedulePersist()
  }, [schedulePersist])

  const handleDiffScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    diffScrollTopRef.current = event.currentTarget.scrollTop
    schedulePersist()
  }, [schedulePersist])

  // Sync summary height ref
  useEffect(() => {
    summaryHeightRef.current = summaryHeight
  }, [summaryHeight])

  // Vertical resizer between summary and detail-body
  const handleSummaryResizerMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    isVDraggingRef.current = true
    vDragStartYRef.current = event.clientY
    vDragStartHeightRef.current = summaryHeightRef.current
    document.body.classList.add('git-history-v-resizing')

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isVDraggingRef.current) return
      const delta = moveEvent.clientY - vDragStartYRef.current
      const containerHeight = detailContainerRef.current?.clientHeight ?? 600
      const maxHeight = containerHeight - MIN_DETAIL_BODY_HEIGHT
      const nextHeight = clamp(vDragStartHeightRef.current + delta, MIN_SUMMARY_HEIGHT, maxHeight)
      setSummaryHeight(nextHeight)
    }

    const handleMouseUp = () => {
      isVDraggingRef.current = false
      document.body.classList.remove('git-history-v-resizing')
      localStorage.setItem(STORAGE_KEY_SUMMARY_HEIGHT, `${summaryHeightRef.current}`)
      updateUIPreferences({ gitHistorySummaryHeight: summaryHeightRef.current })
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [updateUIPreferences])

  const handleFileResizerMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    isDraggingRef.current = true
    dragStartXRef.current = event.clientX
    dragStartWidthRef.current = fileListWidth
    document.body.classList.add('git-history-resizing')

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isDraggingRef.current) return
      const delta = moveEvent.clientX - dragStartXRef.current
      const nextWidth = clamp(dragStartWidthRef.current + delta, MIN_FILE_LIST_WIDTH, MAX_FILE_LIST_WIDTH)
      setFileListWidth(nextWidth)
    }

    const handleMouseUp = () => {
      isDraggingRef.current = false
      document.body.classList.remove('git-history-resizing')
      localStorage.setItem(STORAGE_KEY_FILE_LIST_WIDTH, `${fileListWidthRef.current}`)
      updateUIPreferences({ gitHistoryFileListWidth: fileListWidthRef.current })
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [fileListWidth])

  const handleToggleWhitespace = useCallback((value: boolean) => {
    setHideWhitespace(value)
    localStorage.setItem(STORAGE_KEY_HIDE_WHITESPACE, value ? 'true' : 'false')
    updateUIPreferences({ gitHistoryHideWhitespace: value })
  }, [updateUIPreferences])

  const handleDiffDisplayModeChange = useCallback((mode: GitHistoryDiffDisplayMode) => {
    setDiffDisplayMode(mode)
    localStorage.setItem(STORAGE_KEY_DIFF_STYLE, mode)
    updateUIPreferences({ gitHistoryDiffStyle: mode })
  }, [updateUIPreferences])

  const handleJumpToDiff = useCallback(() => {
    if (!terminalId) return
    const detail: SubpageNavigateEventDetail = {
      terminalId,
      target: 'diff',
      from: 'history',
      intent: 'switch',
      entryPoint: 'subpage-switcher'
    }
    window.dispatchEvent(new CustomEvent('subpage:navigate', { detail }))
  }, [terminalId])

  const handleOpenEditor = useCallback(() => {
    if (!terminalId) return
    const detail: ProjectEditorOpenEventDetail = {
      terminalId,
      filePath: selectedFile?.filename ?? null,
      repoRoot: activeCwd || null
    }
    window.dispatchEvent(new CustomEvent<SubpageNavigateEventDetail>('subpage:navigate', {
      detail: {
        terminalId: detail.terminalId,
        target: 'editor',
        from: 'history',
        intent: 'jump',
        entryPoint: 'deep-link',
        filePath: detail.filePath,
        repoRoot: detail.repoRoot
      }
    }))
  }, [activeCwd, selectedFile, terminalId])

  const handleSelectSubpage = useCallback((target: SubpageId) => {
    if (target === 'diff') {
      handleJumpToDiff()
      return
    }
    if (target === 'editor') {
      // SubpageSwitcher is a view switch — let Editor restore its own state
      // rather than overriding it with History's selected file.
      if (!terminalId) return
      window.dispatchEvent(new CustomEvent<SubpageNavigateEventDetail>('subpage:navigate', {
        detail: {
          terminalId,
          target: 'editor',
          from: 'history',
          intent: 'switch',
          entryPoint: 'subpage-switcher'
        }
      }))
    }
  }, [handleJumpToDiff, terminalId])

  const renderCommitSummary = () => {
    if (selectionInfo.selectedCommits.length === 0) {
      return (
        <div className="git-history-summary empty">
          {t('gitHistory.summary.noneSelected')}
        </div>
      )
    }
    if (selectionInfo.selectedCommits.length > 1) {
      const count = selectionInfo.selectedCommits.length
      return (
        <div className="git-history-summary">
          <div className="git-history-summary-title">
            {t('gitHistory.summary.selectedCount', { count })}
          </div>
          <div className="git-history-summary-meta">
            <span>{t('gitHistory.summary.range')}</span>
            <span className="git-history-summary-meta-value">
              {oldestCommit?.shortSha} → {selectedCommit?.shortSha}
            </span>
          </div>
          <div className="git-history-summary-meta">
            <span>{t('gitHistory.summary.time')}</span>
            <span className="git-history-summary-meta-value">
              {oldestCommit ? formatAbsoluteTime(oldestCommit.authorDate, locale) : '-'}
              {' '}~{' '}
              {selectedCommit ? formatAbsoluteTime(selectedCommit.authorDate, locale) : '-'}
            </span>
          </div>
        </div>
      )
    }
    if (!selectedCommit) return null
    return (
      <div className="git-history-summary">
        <div className={`git-history-summary-title ${selectedCommit.summary ? '' : 'empty'}`}>
          {selectedCommit.summary || t('gitHistory.summary.emptyMessage')}
        </div>
        {selectedCommit.body && (
          <div className="git-history-summary-body">
            {selectedCommit.body}
          </div>
        )}
        <div className="git-history-summary-meta">
          <span>{t('gitHistory.summary.author')}</span>
          <span className="git-history-summary-meta-value">{selectedCommit.authorName}</span>
        </div>
        <div className="git-history-summary-meta">
          <span>{t('gitHistory.summary.time')}</span>
          <span className="git-history-summary-meta-value">{formatAbsoluteTime(selectedCommit.authorDate, locale)}</span>
        </div>
        <div className="git-history-summary-meta">
          <span>{t('gitHistory.summary.commit')}</span>
          <span className="git-history-summary-meta-value">{selectedCommit.sha}</span>
        </div>
      </div>
    )
  }

  const renderCommitList = () => {
    if (!historyResult) {
      return (
        <div className="git-history-loading">
          <div className="git-history-spinner" />
        </div>
      )
    }
    if (loading && commits.length === 0) {
      return (
        <div className="git-history-loading">
          <div className="git-history-spinner" />
        </div>
      )
    }
    if (!historyResult.gitInstalled) {
      return (
        <div className="git-history-warning">
          <div className="git-history-warning-title">{t('gitHistory.warning.gitMissing.title')}</div>
          <div className="git-history-warning-text">{t('gitHistory.warning.gitMissing.message')}</div>
        </div>
      )
    }
    if (!historyResult.isGitRepo) {
      return (
        <div className="git-history-warning">
          <div className="git-history-warning-title">{t('gitHistory.warning.notRepo.title')}</div>
          <div className="git-history-warning-text">{historyResult.error || t('gitHistory.warning.notRepo.message')}</div>
        </div>
      )
    }
    if (!historyResult.success || commits.length === 0) {
      return (
        <div className="git-history-warning">
          <div className="git-history-warning-title">{t('gitHistory.warning.noHistory.title')}</div>
          <div className="git-history-warning-text">{t('gitHistory.warning.noHistory.message')}</div>
        </div>
      )
    }
    return (
      <div
        className="git-history-commit-list-content"
        onScroll={handleCommitListScroll}
        ref={commitListRef}
      >
        {commits.map((commit) => {
          const isSelected = selectedShas.includes(commit.sha)
          return (
            <div
              key={commit.sha}
              className={`git-history-commit-item ${isSelected ? 'selected' : ''}`}
              onClick={(event) => handleCommitClick(commit, event)}
              title={`${commit.summary || t('gitHistory.summary.emptyMessage')} · ${commit.authorName}`}
            >
              <div className="git-history-commit-info">
                {(() => {
                  const badges = parseRefs(commit.refs)
                  if (badges.length === 0) return null
                  return (
                    <div className="git-history-ref-badges">
                      {badges.map((badge, i) => (
                        <span key={i} className={`git-history-ref-badge ${badge.type}`} title={badge.label}>
                          {badge.label}
                        </span>
                      ))}
                    </div>
                  )
                })()}
                <div className={`git-history-commit-summary ${commit.summary ? '' : 'empty'}`}>
                  {commit.summary || t('gitHistory.summary.emptyMessage')}
                </div>
                <div className="git-history-commit-meta">
                  <span className="git-history-commit-author">{commit.authorName}</span>
                  <span className="git-history-commit-time">{formatRelativeTime(commit.authorDate, locale)}</span>
                </div>
              </div>
              <div className="git-history-commit-sha">{commit.shortSha}</div>
            </div>
          )
        })}
        {loading && (
          <div className="git-history-loading-more">{t('gitHistory.loading')}</div>
        )}
        {!hasMore && commits.length > 0 && (
          <div className="git-history-loading-more done">{t('gitHistory.endReached')}</div>
        )}
      </div>
    )
  }

  const renderFileList = () => {
    if (!selectionInfo.isContiguous && selectionInfo.selectedCommits.length > 1) {
      return (
        <div className="git-history-no-selection">
          {t('gitHistory.diff.nonContiguous')}
        </div>
      )
    }
    if (filesLoading) {
      return (
        <div className="git-history-loading">
          <div className="git-history-spinner" />
        </div>
      )
    }
    if (files.length === 0) {
      return (
        <div className="git-history-no-selection">
          {t('gitHistory.files.empty')}
        </div>
      )
    }
    return (
      <div
        className="git-history-file-list-content"
        onScroll={handleFileListScroll}
        ref={fileListRef}
      >
        {files.map((file) => {
          const isSelected = selectedFile?.filename === file.filename
          const statusClass = `status-${file.status}`
          const renameText = file.originalFilename
            ? `${file.originalFilename} → ${file.filename}`
            : file.filename
          return (
            <div
              key={`${file.filename}-${file.status}`}
              className={`git-history-file-item ${isSelected ? 'selected' : ''}`}
              onClick={() => setSelectedFile(file)}
              onContextMenu={(e) => handleFileContextMenu(e, file)}
              title={renameText}
            >
              <span className={`git-history-file-status ${statusClass}`}>
                {file.status}
              </span>
              <span className="git-history-file-name">
                {renameText}
              </span>
              <span className="git-history-file-stats">
                <span className="git-history-file-add">+{file.additions}</span>
                <span className="git-history-file-del">-{file.deletions}</span>
              </span>
            </div>
          )
        })}
      </div>
    )
  }

  const renderSvgDiffEditor = useCallback((fileState: GitHistoryFileContentResult) => {
    const originalPath = (selectedFile?.originalFilename || fileState.filename)
      .split('/')
      .map(encodeURIComponent)
      .join('/')
    const modifiedPath = fileState.filename
      .split('/')
      .map(encodeURIComponent)
      .join('/')
    const baseSegment = encodeURIComponent(selectionInfo.base || 'base')
    const headSegment = encodeURIComponent(selectionInfo.head || 'head')
    return (
      <div className="git-diff-editor-container">
        <DiffEditor
          key={`git-history-svg-text-${selectionInfo.base}-${selectionInfo.head}-${fileState.filename}`}
          original={fileState.originalContent}
          modified={fileState.modifiedContent}
          language="xml"
          originalModelPath={`inmemory://model/onward-git-history/${baseSegment}/original/${originalPath}`}
          modifiedModelPath={`inmemory://model/onward-git-history/${headSegment}/modified/${modifiedPath}`}
          keepCurrentOriginalModel={true}
          keepCurrentModifiedModel={true}
          theme="vs-dark"
          options={imageTextDiffOptions}
          className="git-diff-monaco"
          height="100%"
        />
      </div>
    )
  }, [imageTextDiffOptions, selectedFile, selectionInfo.base, selectionInfo.head])

  const renderImagePreview = useCallback((fileState: GitHistoryFileContentResult, file: GitHistoryFile) => {
    const status = file.status === 'A' || file.status === '?'
      ? 'added'
      : file.status === 'D'
        ? 'deleted'
        : 'modified'
    return (
      <GitImagePreview
        fileState={fileState as GitImagePreviewFileState}
        status={status}
        labels={{
          statusAdded: t('gitDiff.image.status.added'),
          statusDeleted: t('gitDiff.image.status.deleted'),
          statusModified: t('gitDiff.image.status.modified'),
          svg: t('gitDiff.image.svg'),
          viewVisual: t('gitDiff.image.view.visual'),
          viewText: t('gitDiff.image.view.text'),
          compareTwoUp: t('gitDiff.image.compare.twoUp'),
          compareSwipe: t('gitDiff.image.compare.swipe'),
          compareOnion: t('gitDiff.image.compare.onion'),
          displayOriginal: t('gitDiff.image.display.original'),
          displayFit: t('gitDiff.image.display.fit'),
          labelOriginal: t('gitDiff.image.label.original'),
          labelAdded: t('gitDiff.image.label.added'),
          labelModified: t('gitDiff.image.label.modified'),
          opacity: t('gitDiff.image.opacity')
        }}
        imageDisplayMode={imageDisplayMode}
        imageCompareMode={imageCompareMode}
        svgViewMode={svgViewMode}
        onImageDisplayModeChange={toggleImageDisplayMode}
        onImageCompareModeChange={toggleImageCompareMode}
        onSvgViewModeChange={setSvgViewMode}
        renderSvgDiffEditor={(state) => renderSvgDiffEditor(state as GitHistoryFileContentResult)}
      />
    )
  }, [imageCompareMode, imageDisplayMode, renderSvgDiffEditor, svgViewMode, t, toggleImageCompareMode, toggleImageDisplayMode])

  const renderDiffOptions = () => {
    return (
      <div className="git-history-diff-options" ref={diffOptionsRef}>
        <button
          className="git-history-diff-options-trigger"
          onClick={() => setDiffOptionsOpen(prev => !prev)}
          title={t('gitHistory.options.title')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.14,12.94a7.43,7.43,0,0,0,.05-.94,7.43,7.43,0,0,0-.05-.94l2.11-1.65a.5.5,0,0,0,.12-.64l-2-3.46a.5.5,0,0,0-.6-.22l-2.49,1a7.28,7.28,0,0,0-1.63-.94l-.38-2.65A.5.5,0,0,0,13.8,1H10.2a.5.5,0,0,0-.49.41L9.33,4.06a7.28,7.28,0,0,0-1.63.94l-2.49-1a.5.5,0,0,0-.6.22l-2,3.46a.5.5,0,0,0,.12.64L4.86,11.06a7.43,7.43,0,0,0-.05.94,7.43,7.43,0,0,0,.05.94L2.75,14.59a.5.5,0,0,0-.12.64l2,3.46a.5.5,0,0,0,.6.22l2.49-1a7.28,7.28,0,0,0,1.63.94l.38,2.65a.5.5,0,0,0,.49.41h3.6a.5.5,0,0,0,.49-.41l.38-2.65a7.28,7.28,0,0,0,1.63-.94l2.49,1a.5.5,0,0,0,.6-.22l2-3.46a.5.5,0,0,0-.12-.64ZM12,15.5A3.5,3.5,0,1,1,15.5,12,3.5,3.5,0,0,1,12,15.5Z" />
          </svg>
          <span>{t('gitHistory.options.title')}</span>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
            <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {diffOptionsOpen && (
          <div className="git-history-diff-options-popover">
            <div className="git-history-diff-options-title">{t('gitHistory.options.title')}</div>
            <div className="git-history-diff-options-group">
              <div className="git-history-diff-options-label">{t('gitHistory.options.displayMode')}</div>
              <div className="git-history-diff-options-buttons">
                <button
                  className={`git-history-option-btn ${diffDisplayMode === 'side-by-side' ? 'active' : ''}`}
                  onClick={() => handleDiffDisplayModeChange('side-by-side')}
                  data-mode="side-by-side"
                >
                  {t('gitDiff.viewMode.split')}
                </button>
                <button
                  className={`git-history-option-btn ${diffDisplayMode === 'inline' ? 'active' : ''}`}
                  onClick={() => handleDiffDisplayModeChange('inline')}
                  data-mode="inline"
                >
                  {t('gitDiff.viewMode.inline')}
                </button>
              </div>
            </div>
            <div className="git-history-diff-options-group">
              <div className="git-history-diff-options-label">{t('gitHistory.options.whitespace')}</div>
              <label className="git-history-checkbox">
                <input
                  type="checkbox"
                  checked={hideWhitespace}
                  onChange={(e) => handleToggleWhitespace(e.target.checked)}
                />
                <span>{t('gitHistory.options.hideWhitespace')}</span>
              </label>
            </div>
          </div>
        )}
      </div>
    )
  }

  const renderDiff = () => {
    if (!selectionInfo.isContiguous && selectionInfo.selectedCommits.length > 1) {
      return (
        <div className="git-history-no-selection">
          {t('gitHistory.diff.nonContiguous')}
        </div>
      )
    }
    if (!selectedFile) {
      return (
        <div className="git-history-no-selection">
          {t('gitHistory.diff.noFileSelected')}
        </div>
      )
    }
    if (diffError) {
      return (
        <div className="git-history-no-selection">
          {diffError}
        </div>
      )
    }
    if (diffLoading) {
      return (
        <div className="git-history-loading">
          <div className="git-history-spinner" />
        </div>
      )
    }
    if (selectedFile.isImage) {
      if (!selectedFileContent) {
        return (
          <div className="git-history-no-selection">
            {t('gitHistory.diff.empty')}
          </div>
        )
      }
      return renderImagePreview(selectedFileContent, selectedFile)
    }
    if (selectedFile.isPdf) {
      if (!selectedFileContent) {
        return <div className="git-history-no-selection">{t('gitHistory.diff.empty')}</div>
      }
      const status: GitPdfStatus = selectedFile.status === 'A' || selectedFile.status === '?'
        ? 'added'
        : selectedFile.status === 'D'
          ? 'deleted'
          : 'modified'
      return (
        <GitPdfCompare
          status={status}
          originalPreviewData={selectedFileContent.originalPreviewData}
          modifiedPreviewData={selectedFileContent.modifiedPreviewData}
          originalSize={selectedFileContent.originalPreviewSize}
          modifiedSize={selectedFileContent.modifiedPreviewSize}
          filename={selectedFile.filename}
          viewerUrl={pdfViewerUrl}
          labels={{
            statusAdded: t('gitDiff.pdfCompare.statusAdded'),
            statusDeleted: t('gitDiff.pdfCompare.statusDeleted'),
            statusModified: t('gitDiff.pdfCompare.statusModified'),
            labelOriginal: t('gitDiff.pdfCompare.labelOriginal'),
            labelAdded: t('gitDiff.pdfCompare.labelAdded'),
            labelModified: t('gitDiff.pdfCompare.labelModified'),
            noOriginal: t('gitDiff.pdfCompare.noOriginal'),
            noModified: t('gitDiff.pdfCompare.noModified')
          }}
        />
      )
    }
    if (selectedFile.isEpub) {
      if (!selectedFileContent) {
        return <div className="git-history-no-selection">{t('gitHistory.diff.empty')}</div>
      }
      const status: GitEpubStatus = selectedFile.status === 'A' || selectedFile.status === '?'
        ? 'added'
        : selectedFile.status === 'D'
          ? 'deleted'
          : 'modified'
      return (
        <GitEpubCompare
          status={status}
          originalPreviewData={selectedFileContent.originalPreviewData}
          modifiedPreviewData={selectedFileContent.modifiedPreviewData}
          originalSize={selectedFileContent.originalPreviewSize}
          modifiedSize={selectedFileContent.modifiedPreviewSize}
          filename={selectedFile.filename}
          labels={{
            statusAdded: t('gitDiff.epubCompare.statusAdded'),
            statusDeleted: t('gitDiff.epubCompare.statusDeleted'),
            statusModified: t('gitDiff.epubCompare.statusModified'),
            chapterAdded: t('gitDiff.epubCompare.chapterAdded'),
            chapterDeleted: t('gitDiff.epubCompare.chapterDeleted'),
            chapterModified: t('gitDiff.epubCompare.chapterModified'),
            chapterUnchanged: t('gitDiff.epubCompare.chapterUnchanged'),
            labelOriginal: t('gitDiff.epubCompare.labelOriginal'),
            labelModified: t('gitDiff.epubCompare.labelModified'),
            noOriginal: t('gitDiff.epubCompare.noOriginal'),
            noModified: t('gitDiff.epubCompare.noModified'),
            loading: t('gitDiff.epubCompare.loading'),
            error: t('gitDiff.epubCompare.error'),
            chapters: t('gitDiff.epubCompare.chapters'),
            resources: t('gitDiff.epubCompare.resources'),
            noResourceChanges: t('gitDiff.epubCompare.noResourceChanges'),
            resourceAdded: t('gitDiff.epubCompare.resourceAdded'),
            resourceDeleted: t('gitDiff.epubCompare.resourceDeleted'),
            resourceModified: t('gitDiff.epubCompare.resourceModified')
          }}
        />
      )
    }
    if (!hideWhitespace && selectedFileContent && !selectedFileContent.isBinary) {
      const lang = getFiletypeFromFileName(selectedFileContent.filename)
      const oldFile = {
        name: selectedFile.originalFilename || selectedFileContent.filename,
        contents: selectedFileContent.originalContent,
        lang,
      }
      const newFile = {
        name: selectedFileContent.filename,
        contents: selectedFileContent.modifiedContent,
        lang,
      }
      return (
        <div className="git-history-diff-view" style={{ fontSize: `${diffFontSize}px` }}>
          <div className="git-history-diff-scroll" onScroll={handleDiffScroll} ref={diffScrollRef}>
            <MultiFileDiff
              oldFile={oldFile}
              newFile={newFile}
              options={multiFileDiffOptions}
              className="git-history-patch"
              style={{
                fontSize: `${diffFontSize}px`,
                lineHeight: `${Math.round(diffFontSize * 1.5)}px`
              }}
            />
          </div>
        </div>
      )
    }
    if (!diffPatch) {
      return (
        <div className="git-history-no-selection">
          {t('gitHistory.diff.empty')}
        </div>
      )
    }
    try {
      const parsed = parsePatchFiles(diffPatch)
      if (parsed.length === 0 || parsed[0].files.length === 0) {
        return (
          <div className="git-history-no-selection">
            {t('gitHistory.diff.empty')}
          </div>
        )
      }
    } catch {
      return (
        <div className="git-history-no-selection">
          {t('gitHistory.diff.parseError')}
        </div>
      )
    }
    return (
      <div className="git-history-diff-view" style={{ fontSize: `${diffFontSize}px` }}>
        <div className="git-history-diff-scroll" onScroll={handleDiffScroll} ref={diffScrollRef}>
          <PatchDiff
            patch={diffPatch}
            options={diffOptions}
            className="git-history-patch"
            style={{
              fontSize: `${diffFontSize}px`,
              lineHeight: `${Math.round(diffFontSize * 1.5)}px`
            }}
          />
        </div>
      </div>
    )
  }

  const overlayClassName = `git-history-overlay ${isPanel ? 'panel' : ''}`
  const modalClassName = `git-history-modal ${isPanel ? 'panel' : ''}`
  const useSharedPanelHeader = isPanel && panelShellMode === 'internal'
  const keepMountedInPanel = isPanel
  const historyWorkingDirectory = historyResult?.cwd && historyResult.isGitRepo
    ? historyResult.cwd
    : null
  const {
    title: cwdTitle,
    onDoubleClick: handleCwdDblClick,
    feedback: cwdFeedback
  } = useCwdCopyHandler(historyWorkingDirectory, t, 'gitHistory.copyFailed')
  const externalPanelActions = useMemo(() => (
    <SubpagePanelButton className="git-history-close" onClick={onClose} title={t('gitHistory.returnToTerminal')}>
      {t('gitHistory.returnToTerminal')}
    </SubpagePanelButton>
  ), [onClose, t])
  const externalPanelShellState = useMemo<SubpagePanelShellState>(() => ({
    current: 'history',
    onSelect: handleSelectSubpage,
    lifecycle: {
      beforeLeave: () => {
        persistStateRef.current()
        return {
          subpage: 'history',
          selectedShas: [...selectedShasRef.current],
          selectionAnchor: selectionAnchorRef.current,
          selectedFilePath: selectedFileRef.current?.filename ?? selectionRef.current.selectedFile,
          commitScrollTop: commitScrollTopRef.current,
          fileScrollTop: fileScrollTopRef.current,
          diffScrollTop: diffScrollTopRef.current
        }
      }
    },
    workingDirectoryLabel: t('gitHistory.cwd'),
    workingDirectoryPath: historyWorkingDirectory,
    workingDirectoryTitle: cwdTitle,
    onWorkingDirectoryDoubleClick: handleCwdDblClick,
    workingDirectoryFeedback: cwdFeedback,
    actions: externalPanelActions,
    taskTitle
  }), [cwdFeedback, cwdTitle, externalPanelActions, handleCwdDblClick, handleSelectSubpage, historyWorkingDirectory, t, taskTitle])
  const superprojectRoot = historyResult?.superprojectRoot ?? null
  const displayedHistoryRoot = normalizeRepoRoot(historyResult?.cwd)
  const selectedHistoryRoot = normalizeRepoRoot(selectedRepoRoot || cachedParentCwd || historyResult?.cwd || cwd)
  const showSuperprojectHint = Boolean(
    superprojectRoot &&
    !selectedRepoRoot &&
    displayedHistoryRoot &&
    displayedHistoryRoot === selectedHistoryRoot
  )
  const historyBody = (
    <>
      {showSuperprojectHint && (
        <div
          className="git-history-superproject-hint"
          onClick={() => {
            if (superprojectRoot) switchRepo(superprojectRoot)
          }}
        >
          <span>{t('gitHistory.repo.inSubmodule')}</span>
          <span style={{ color: 'var(--accent)', cursor: 'pointer' }}>{t('gitHistory.repo.viewParent')}</span>
        </div>
      )}
      <div className="git-history-body">
        {cachedRepos && cachedRepos.length > 1 && (() => {
          const sorted = cachedRepos
          return (
            <div className="git-history-repo-sidebar">
              <div className="git-history-repo-sidebar-header">{t('gitHistory.repo.title')}</div>
              {sorted.length > 6 && (
                <div className="git-history-repo-search-wrap">
                  <input
                    className="git-history-repo-search"
                    type="text"
                    placeholder={t('gitHistory.repo.search')}
                    value={repoSearch}
                    onChange={(event) => setRepoSearch(event.target.value)}
                    onKeyDown={(event) => event.stopPropagation()}
                  />
                  {repoSearch && (
                    <span
                      className="git-history-repo-search-clear"
                      onClick={() => setRepoSearch('')}
                    >×</span>
                  )}
                </div>
              )}
              <div className="git-history-repo-list">
                {visibleRepoItems.map((repo) => {
                  const repoRoot = normalizeRepoRoot(repo.root)
                  const parentRoot = normalizeRepoRoot(repoTreeParentCwd)
                  const isActive = repoRoot === normalizeRepoRoot(selectedRepoRoot || parentRoot)
                  const targetRoot = repoRoot === parentRoot ? null : repo.root
                  return (
                    <div
                      key={repo.root}
                      className={`git-history-repo-item${isActive ? ' active' : ''}`}
                      style={{ paddingLeft: `${8 + (repo.treeDepth * 14)}px` }}
                      onClick={() => switchRepo(targetRoot)}
                      title={repo.root}
                    >
                      <button
                        type="button"
                        className={`git-history-repo-toggle${repo.hasChildren ? '' : ' hidden'}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          toggleRepoExpanded(repo.root)
                        }}
                        aria-label={repo.expanded ? t('gitHistory.repo.collapse') : t('gitHistory.repo.expand')}
                      >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                          <path d={repo.expanded ? 'M4 6l4 4 4-4H4z' : 'M6 4l4 4-4 4V4z'} />
                        </svg>
                      </button>
                      <span className="git-history-repo-item-icon" aria-hidden="true">
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5V5.5A1.5 1.5 0 0 0 14.5 4H7.71L6.85 2.57A1.5 1.5 0 0 0 5.57 2H1.5z" />
                        </svg>
                      </span>
                      <span className="git-history-repo-item-label">{repo.displayLabel}</span>
                    </div>
                  )
                })}
                {visibleRepoItems.length === 0 && (
                  <div className="git-history-repo-empty">{t('gitHistory.repo.noMatch')}</div>
                )}
              </div>
            </div>
          )
        })()}
        <div className="git-history-main">
          <div className="git-history-commit-list">
            <div className="git-history-commit-list-header">
              {t('gitHistory.commitList.title')} {historyResult?.totalCount ? `(${historyResult.totalCount})` : ''}
            </div>
            {renderCommitList()}
          </div>
          <div className="git-history-detail" ref={detailContainerRef}>
            <div className="git-history-summary-wrapper" style={{ height: summaryHeight }}>
              {renderCommitSummary()}
            </div>
            <div
              className="git-history-summary-resizer"
              onMouseDown={handleSummaryResizerMouseDown}
            />
            <div className="git-history-detail-body">
              <div className="git-history-file-list" style={{ width: fileListWidth }}>
                <div className="git-history-file-list-header">
                  {t('gitHistory.fileList.title')} {files.length ? `(${files.length})` : ''}
                </div>
                {renderFileList()}
              </div>
              <div
                className="git-history-file-resizer"
                onMouseDown={handleFileResizerMouseDown}
              />
              <div className="git-history-diff">
                <div className="git-history-diff-header">
                  <div className="git-history-diff-file">
                    {selectedFile && (
                      <>
                        <span className={`git-history-file-status status-${selectedFile.status}`}>
                          {selectedFile.status}
                        </span>
                        <span
                          className="git-history-diff-file-name"
                          title={t('gitHistory.filenameCopyHint')}
                          onDoubleClick={handleFilenameDblClick}
                        >
                          {selectedFile.originalFilename
                            ? `${selectedFile.originalFilename} → ${selectedFile.filename}`
                            : selectedFile.filename}
                        </span>
                        {copyMessage && (
                          <span className={`path-copy-toast ${copyMessage.type}`}>
                            {copyMessage.text}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                  {!selectedFile?.isImage && !selectedFile?.isPdf && !selectedFile?.isEpub && renderDiffOptions()}
                </div>
                <div className="git-history-diff-content">
                  {renderDiff()}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {fileContextMenu && (
        <div
          className="git-history-context-menu"
          style={{ position: 'fixed', left: fileContextMenu.x, top: fileContextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="git-history-context-item"
            onClick={() => void copyContextMenuPath(fileContextMenu.targetFile, 'name')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 2a.5.5 0 0 0 0 1h11a.5.5 0 0 0 0-1h-11zM5 5.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1H8.5v7a.5.5 0 0 1-1 0V6H5.5a.5.5 0 0 1-.5-.5z" /></svg>
            <span>{t('common.copyName')}</span>
          </button>
          <button
            className="git-history-context-item"
            onClick={() => void copyContextMenuPath(fileContextMenu.targetFile, 'relative')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9 1H3.5A1.5 1.5 0 0 0 2 2.5v11A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5V6h-4a1 1 0 0 1-1-1V1zm1 0v4h4L10 1z" /><circle cx="5" cy="11.5" r="1" /><path d="M7 10a.5.5 0 0 1 .354.146l2 2a.5.5 0 0 1-.708.708L7 11.207l-1.646 1.647a.5.5 0 0 1-.708-.708l2-2A.5.5 0 0 1 7 10z" /></svg>
            <span>{t('common.copyRelativePath')}</span>
          </button>
          <button
            className="git-history-context-item"
            onClick={() => void copyContextMenuPath(fileContextMenu.targetFile, 'absolute')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9 1H3.5A1.5 1.5 0 0 0 2 2.5v11A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5V6h-4a1 1 0 0 1-1-1V1zm1 0v4h4L10 1z" /><path d="M8.5 9a.5.5 0 0 0-.894-.447l-2 4a.5.5 0 1 0 .894.447l2-4z" /></svg>
            <span>{t('common.copyAbsolutePath')}</span>
          </button>
        </div>
      )}
    </>
  )

  useLayoutEffect(() => {
    if (!isPanel || panelShellMode !== 'external' || !onPanelShellStateChange) return
    if (!isOpen) {
      onPanelShellStateChange(null)
      return
    }
    onPanelShellStateChange(externalPanelShellState)
    return () => {
      onPanelShellStateChange(null)
    }
  }, [
    externalPanelActions,
    externalPanelShellState,
    isOpen,
    isPanel,
    onPanelShellStateChange,
    panelShellMode
  ])

  if (!isOpen && !keepMountedInPanel) return null

  return (
    <div className={`${overlayClassName} ${isOpen ? 'is-open' : 'is-hidden'}`} aria-hidden={!isOpen}>
      <div className={modalClassName}>
        {useSharedPanelHeader ? (
          <SubpagePanelShell
            current="history"
            onSelect={handleSelectSubpage}
            workingDirectoryLabel={t('gitHistory.cwd')}
            workingDirectoryPath={historyWorkingDirectory}
            workingDirectoryTitle={cwdTitle}
            onWorkingDirectoryDoubleClick={handleCwdDblClick}
            workingDirectoryFeedback={cwdFeedback}
            taskTitle={taskTitle}
            actions={(
              <>
                <SubpagePanelButton className="git-history-close" onClick={onClose} title={t('gitHistory.returnToTerminal')}>
                  {t('gitHistory.returnToTerminal')}
                </SubpagePanelButton>
              </>
            )}
          >
            {historyBody}
          </SubpagePanelShell>
        ) : panelShellMode === 'external' && isPanel ? (
          historyBody
        ) : (
          <>
            <div className="git-history-header">
              <div className="git-history-header-main">
                <h2 className="git-history-title">
                  <span className="git-history-title-main">{t('gitHistory.title')}</span>
                  {taskTitle ? (
                    <span className="git-history-task-label subpage-task-source" title={taskTitle}>
                      <span className="subpage-task-source-name">{taskTitle}</span>
                    </span>
                  ) : null}
                </h2>
                <SubpageSwitcher current="history" onSelect={handleSelectSubpage} />
              </div>
              <div className="git-history-header-actions">
                <SubpagePanelButton className="git-history-close" onClick={onClose} title={t('gitHistory.returnToTerminal')}>
                  {t('gitHistory.returnToTerminal')}
                </SubpagePanelButton>
              </div>
            </div>
            {historyWorkingDirectory && (
              <div
                className="git-history-cwd-bar"
                onDoubleClick={handleCwdDblClick}
                title={cwdTitle}
              >
                <span className="git-history-cwd-label">{t('gitHistory.cwd')}</span>
                <span className="git-history-cwd-path">{historyWorkingDirectory}</span>
                {cwdFeedback}
              </div>
            )}
            {historyBody}
          </>
        )}
        {largeFileConfirmState && (
          <LargeFileConfirmDialog
            title={t('gitDiff.largeFile.confirmTitle')}
            message={t('gitDiff.largeFile.confirmMessage', { size: largeFileConfirmState.sizeLabel })}
            confirmText={t('gitDiff.largeFile.continue')}
            cancelText={t('common.cancel')}
            onConfirm={() => settleLargeFileConfirmation(true)}
            onCancel={() => settleLargeFileConfirmation(false)}
          />
        )}
      </div>
    </div>
  )
}
