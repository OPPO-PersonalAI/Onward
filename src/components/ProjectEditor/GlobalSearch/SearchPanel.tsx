/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useI18n } from '../../../i18n/useI18n'
import { useGlobalSearch, type SearchMatch } from './useGlobalSearch'
import { useFilenameSearch, type FilenameSearchController } from './useFilenameSearch'
import './SearchPanel.css'

type SearchType = 'content' | 'filename'

interface SearchPanelProps {
  rootPath: string | null
  isActive: boolean
  initialSearchType?: SearchType
  onNavigate: (file: string, line: number, column: number, matchLength: number) => void
  onOpenFile: (filePath: string) => void
  onClose: () => void
  buildFileIndex: () => Promise<string[]>
  /** True once an index is warm for the active root — drives the indexing affordance only. */
  isFileIndexReady: () => boolean
  searchInputRef?: RefObject<HTMLInputElement>
  /** Right-click on a result row (file header or filename item), repo-relative path. */
  onFileContextMenu?: (event: React.MouseEvent, filePath: string) => void
  /**
   * Externally-owned filename-search state. The Cmd+P modal passes its own
   * controller so the Project Editor can expose it to the autotest debug API;
   * the sidebar omits it and gets a private one. Either way both surfaces run
   * the SAME hook, which is what makes their behaviour identical by
   * construction rather than by convention.
   */
  filenameController?: FilenameSearchController
  /** Rendered above the type bar — used by the modal for its own chrome. */
  variant?: 'sidebar' | 'modal'
}

function getBaseName(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return separatorIndex === -1 ? path : path.slice(separatorIndex + 1)
}

export function SearchPanel({
  rootPath,
  isActive,
  initialSearchType = 'content',
  onNavigate,
  onOpenFile,
  onClose,
  buildFileIndex,
  isFileIndexReady,
  searchInputRef: externalInputRef,
  onFileContextMenu,
  filenameController,
  variant = 'sidebar'
}: SearchPanelProps) {
  const { t } = useI18n()
  const [searchType, setSearchType] = useState<SearchType>(initialSearchType)
  const {
    query: contentQuery,
    options,
    isSearching,
    fileGroups,
    totalMatchCount,
    totalFileCount,
    durationMs,
    limitReached,
    updateQuery: updateContentQuery,
    toggleOption,
    updateGlob,
    toggleCollapse
  } = useGlobalSearch({ rootPath, isActive: isActive && searchType === 'content' })

  // Private controller for the sidebar; the modal injects its own so the debug
  // API can reach it. The hook must be called unconditionally (rules of hooks),
  // so we always create one and simply prefer the injected instance.
  const ownFilenameController = useFilenameSearch({
    rootPath,
    isActive: isActive && searchType === 'filename' && !filenameController
  })
  const filenameSearch = filenameController ?? ownFilenameController
  const {
    query: filenameQuery,
    setQuery: setFilenameQuery,
    results: filenameResults,
    total: filenameTotal,
    hasMore: filenameHasMore,
    isLoadingMore: filenameLoadingMore,
    loadMore: loadMoreFilenames,
    activeIndex: filenameActiveIndex,
    setActiveIndex: setFilenameActiveIndex
  } = filenameSearch

  const [isIndexing, setIsIndexing] = useState(false)
  const [showGlobs, setShowGlobs] = useState(false)
  const [activeMatch, setActiveMatch] = useState<{ file: string; line: number } | null>(null)
  const resultsScrollRef = useRef<HTMLDivElement>(null)

  const internalInputRef = useRef<HTMLInputElement>(null)
  const inputRef = externalInputRef ?? internalInputRef
  const cmdKey = window.electronAPI.platform === 'darwin' ? 'Command' : 'Ctrl'

  useEffect(() => {
    setSearchType(initialSearchType)
  }, [initialSearchType])

  useEffect(() => {
    if (!isActive) return
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }, [inputRef, isActive, searchType])

  // Warm the renderer mirror so the "indexing…" status is truthful. The actual
  // results come from the authoritative worker index, which builds itself on
  // demand — this effect only drives the progress affordance.
  useEffect(() => {
    if (!isActive || searchType !== 'filename' || !rootPath) return
    if (isFileIndexReady()) return

    let cancelled = false
    setIsIndexing(true)
    void buildFileIndex()
      .catch(() => { /* Surfaced as an empty result list below. */ })
      .finally(() => {
        if (!cancelled) setIsIndexing(false)
      })
    return () => {
      cancelled = true
    }
  }, [buildFileIndex, isFileIndexReady, isActive, rootPath, searchType])

  // Infinite append: pull the next page when the list nears its bottom. The
  // 120px cushion starts the fetch before the user hits the end, so the rows
  // are usually already there by the time the scroll arrives.
  const handleResultsScroll = useCallback(() => {
    if (searchType !== 'filename' || !filenameHasMore || filenameLoadingMore) return
    const element = resultsScrollRef.current
    if (!element) return
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight
    if (remaining <= 120) loadMoreFilenames()
  }, [filenameHasMore, filenameLoadingMore, loadMoreFilenames, searchType])

  const currentQuery = searchType === 'content' ? contentQuery : filenameQuery
  const setCurrentQuery = searchType === 'content' ? updateContentQuery : setFilenameQuery

  const handleFilenameSelect = useCallback((filePath: string) => {
    onOpenFile(filePath)
  }, [onOpenFile])

  const handleMatchClick = useCallback((file: string, match: SearchMatch) => {
    setActiveMatch({ file, line: match.line })
    onNavigate(file, match.line, match.column, match.matchLength)
  }, [onNavigate])

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (currentQuery) {
        setCurrentQuery('')
      } else {
        onClose()
      }
      return
    }

    if (searchType === 'content') {
      if (event.key === 'Enter' && fileGroups.length > 0) {
        event.preventDefault()
        const firstGroup = fileGroups[0]
        const firstMatch = firstGroup.matches[0]
        if (firstGroup && firstMatch) {
          handleMatchClick(firstGroup.file, firstMatch)
        }
      }
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      // Arrowing onto the last loaded row pulls the next page, so keyboard
      // users reach page 2 the same way scrollers do — without this, the
      // keyboard path would silently dead-end at the page boundary.
      if (filenameActiveIndex >= filenameResults.length - 1 && filenameHasMore) {
        loadMoreFilenames()
      }
      setFilenameActiveIndex((previous) => Math.min(previous + 1, filenameResults.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setFilenameActiveIndex((previous) => Math.max(previous - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const target = filenameResults[filenameActiveIndex]
      if (target) {
        handleFilenameSelect(target)
      }
    }
  }, [currentQuery, fileGroups, filenameActiveIndex, filenameHasMore, filenameResults, handleFilenameSelect, handleMatchClick, loadMoreFilenames, onClose, searchType, setCurrentQuery])

  const renderHighlightedLine = useCallback((lineContent: string, match: SearchMatch) => {
    const start = match.column - 1
    const end = start + match.matchLength
    if (start < 0 || start >= lineContent.length || match.matchLength <= 0) {
      return <span>{lineContent}</span>
    }
    const before = lineContent.slice(0, start)
    const highlighted = lineContent.slice(start, Math.min(end, lineContent.length))
    const after = lineContent.slice(Math.min(end, lineContent.length))
    return (
      <>
        {before && <span>{before}</span>}
        <span className="global-search-highlight">{highlighted}</span>
        {after && <span>{after}</span>}
      </>
    )
  }, [])

  const splitPath = useCallback((filePath: string) => {
    const lastSlash = filePath.lastIndexOf('/')
    if (lastSlash === -1) {
      return { name: filePath, dir: '' }
    }
    return {
      name: filePath.slice(lastSlash + 1),
      dir: filePath.slice(0, lastSlash)
    }
  }, [])

  const contentStatusText = useMemo(() => {
    if (isSearching) return t('projectEditor.globalSearchSearching')
    if (!contentQuery.trim()) return null
    if (totalMatchCount === 0 && durationMs !== null) return t('projectEditor.globalSearchNoMatches')
    if (durationMs !== null) {
      const duration = durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`
      return t('projectEditor.globalSearchResultsSummaryTimed', {
        files: totalFileCount,
        matches: totalMatchCount,
        duration
      })
    }
    if (totalMatchCount > 0) {
      return t('projectEditor.globalSearchResultsSummary', {
        files: totalFileCount,
        matches: totalMatchCount
      })
    }
    return null
  }, [contentQuery, durationMs, isSearching, t, totalFileCount, totalMatchCount])

  const filenameStatusText = useMemo(() => {
    if (isIndexing) return t('projectEditor.globalSearchIndexing')
    if (filenameResults.length === 0) {
      return filenameQuery.trim()
        ? t('projectEditor.globalSearchFilenameNoMatches')
        : t('projectEditor.globalSearchFilenameStart')
    }
    // When the list is truncated, say so with real numbers. Reporting only the
    // loaded count made a truncated list indistinguishable from a complete one,
    // so users concluded a file did not exist when it was merely on page 2.
    if (filenameResults.length < filenameTotal) {
      return t('projectEditor.globalSearchFilenameShowingOf', {
        shown: filenameResults.length,
        total: filenameTotal
      })
    }
    return t('projectEditor.globalSearchFilenameCount', { count: filenameResults.length })
  }, [filenameQuery, filenameResults.length, filenameTotal, isIndexing, t])

  return (
    <div className={`global-search-panel global-search-panel-${variant}`}>
      <div className="global-search-type-bar">
        <button
          className={`global-search-type-btn ${searchType === 'content' ? 'active' : ''}`}
          onClick={() => setSearchType('content')}
          title={t('projectEditor.globalSearchContentTitle', { key: `${cmdKey}+Shift+F` })}
          type="button"
        >
          {t('projectEditor.globalSearchContent')}
        </button>
        <button
          className={`global-search-type-btn ${searchType === 'filename' ? 'active' : ''}`}
          onClick={() => setSearchType('filename')}
          title={t('projectEditor.globalSearchFilenameTitle', { key: `${cmdKey}+P` })}
          type="button"
        >
          {t('projectEditor.globalSearchFilename')}
        </button>
      </div>

      <div className="global-search-input-area">
        <div className="global-search-input-row">
          <input
            ref={inputRef}
            className="global-search-input"
            value={currentQuery}
            placeholder={searchType === 'content'
              ? t('projectEditor.globalSearchContentPlaceholder')
              : t('projectEditor.globalSearchFilenamePlaceholder')}
            onChange={(event) => setCurrentQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
          />
          {searchType === 'content' && (
            <>
              <button
                className={`global-search-option-btn ${options.isCaseSensitive ? 'active' : ''}`}
                onClick={() => toggleOption('isCaseSensitive')}
                title={t('projectEditor.globalSearchCaseSensitive')}
                type="button"
              >
                Aa
              </button>
              <button
                className={`global-search-option-btn ${options.isWholeWord ? 'active' : ''}`}
                onClick={() => toggleOption('isWholeWord')}
                title={t('projectEditor.globalSearchWholeWord')}
                type="button"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M2 3.5a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 0 1H4v8h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1H3V4h-.5a.5.5 0 0 1-.5-.5zm9 0a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 0 1H13v8h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1h.5V4h-.5a.5.5 0 0 1-.5-.5zM6.5 4a1.5 1.5 0 0 0-1.414 1H5.5a.5.5 0 0 0 0 1h.25v4H5.5a.5.5 0 0 0 0 1h3a.5.5 0 0 0 0-1h-.25V6h.25a.5.5 0 0 0 0-1h-.414A1.5 1.5 0 0 0 6.5 4z" />
                </svg>
              </button>
              <button
                className={`global-search-option-btn ${options.isRegex ? 'active' : ''}`}
                onClick={() => toggleOption('isRegex')}
                title={t('projectEditor.globalSearchRegex')}
                type="button"
              >
                .*
              </button>
            </>
          )}
        </div>

        {searchType === 'content' && (
          <>
            <button
              className={`global-search-glob-toggle ${showGlobs ? 'expanded' : ''}`}
              onClick={() => setShowGlobs((previous) => !previous)}
              type="button"
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M6 12.796V3.204L11.481 8 6 12.796zm.659.753l5.48-4.796a1 1 0 0 0 0-1.506L6.66 2.451C6.011 1.885 5 2.345 5 3.204v9.592a1 1 0 0 0 1.659.753z" />
              </svg>
              <span>{t('projectEditor.globalSearchFilters')}</span>
            </button>
            {showGlobs && (
              <div className="global-search-glob-row">
                <div>
                  <div className="global-search-glob-label">{t('projectEditor.globalSearchIncludeLabel')}</div>
                  <input
                    className="global-search-glob-input"
                    value={options.includeGlob}
                    onChange={(event) => updateGlob('includeGlob', event.target.value)}
                    placeholder={t('projectEditor.globalSearchIncludePlaceholder')}
                    spellCheck={false}
                  />
                </div>
                <div>
                  <div className="global-search-glob-label">{t('projectEditor.globalSearchExcludeLabel')}</div>
                  <input
                    className="global-search-glob-input"
                    value={options.excludeGlob}
                    onChange={(event) => updateGlob('excludeGlob', event.target.value)}
                    placeholder={t('projectEditor.globalSearchExcludePlaceholder')}
                    spellCheck={false}
                  />
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="global-search-status">
        {(isSearching || isIndexing) && <span className="global-search-status-spinner" aria-hidden="true" />}
        <span>{searchType === 'content' ? contentStatusText : filenameStatusText}</span>
      </div>

      <div className="global-search-results" ref={resultsScrollRef} onScroll={handleResultsScroll}>
        {searchType === 'content' && (
          <>
            {!contentQuery.trim() && (
              <div className="global-search-empty">
                <div>{t('projectEditor.globalSearchStart')}</div>
                <div style={{ marginTop: 4 }}>{t('projectEditor.globalSearchOptionsHint')}</div>
              </div>
            )}

            {contentQuery.trim() && !isSearching && fileGroups.length === 0 && durationMs !== null && (
              <div className="global-search-empty">{t('projectEditor.globalSearchNoMatches')}</div>
            )}

            {fileGroups.map((group, groupIndex) => {
              const { name, dir } = splitPath(group.file)
              return (
                <div key={group.file}>
                  <div
                    className="global-search-file-header"
                    onClick={() => toggleCollapse(groupIndex)}
                    onContextMenu={(event) => onFileContextMenu?.(event, group.file)}
                  >
                    <svg
                      className={`global-search-file-chevron ${group.isCollapsed ? 'collapsed' : ''}`}
                      width="14"
                      height="14"
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path d="M3.646 4.646a.5.5 0 0 1 .708 0L8 8.293l3.646-3.647a.5.5 0 0 1 .708.708l-4 4a.5.5 0 0 1-.708 0l-4-4a.5.5 0 0 1 0-.708z" />
                    </svg>
                    <span className="global-search-file-name">{name}</span>
                    {dir && <span className="global-search-file-dir">{dir}</span>}
                    <span className="global-search-file-count">{group.matches.length}</span>
                  </div>
                  {!group.isCollapsed && group.matches.map((match, matchIndex) => {
                    const isActiveItem = activeMatch?.file === group.file && activeMatch?.line === match.line
                    return (
                      <div
                        key={`${match.line}:${match.column}:${matchIndex}`}
                        className={`global-search-match-line ${isActiveItem ? 'active' : ''}`}
                        onClick={() => handleMatchClick(group.file, match)}
                      >
                        <span className="global-search-line-number">{match.line}</span>
                        <span className="global-search-line-content">{renderHighlightedLine(match.lineContent, match)}</span>
                      </div>
                    )
                  })}
                </div>
              )
            })}

            {limitReached && (
              <div className="global-search-limit-warning">{t('projectEditor.globalSearchLimitReached')}</div>
            )}
          </>
        )}

        {searchType === 'filename' && (
          <>
            {!filenameQuery.trim() && !isIndexing && filenameResults.length === 0 && (
              <div className="global-search-empty">{t('projectEditor.globalSearchFilenameStart')}</div>
            )}

            {filenameResults.map((filePath, index) => {
              const { name, dir } = splitPath(filePath)
              return (
                <div
                  key={filePath}
                  className={`global-search-filename-item ${index === filenameActiveIndex ? 'active' : ''}`}
                  onClick={() => handleFilenameSelect(filePath)}
                  onContextMenu={(event) => onFileContextMenu?.(event, filePath)}
                  onMouseEnter={() => setFilenameActiveIndex(index)}
                >
                  <span className="global-search-filename-name">{name}</span>
                  <span className="global-search-filename-path">{dir}</span>
                </div>
              )
            })}

            {filenameHasMore && (
              <button
                type="button"
                className="global-search-load-more"
                onClick={loadMoreFilenames}
                disabled={filenameLoadingMore}
              >
                {filenameLoadingMore
                  ? t('projectEditor.globalSearchLoadingMore')
                  : t('projectEditor.globalSearchLoadMore', {
                    remaining: filenameTotal - filenameResults.length
                  })}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
