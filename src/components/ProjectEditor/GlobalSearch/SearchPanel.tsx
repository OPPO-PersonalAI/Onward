/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useI18n } from '../../../i18n/useI18n'
import { useGlobalSearch, type SearchMatch } from './useGlobalSearch'
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
  getFileIndex: () => string[]
  searchInputRef?: RefObject<HTMLInputElement>
  /** Right-click on a result row (file header or filename item), repo-relative path. */
  onFileContextMenu?: (event: React.MouseEvent, filePath: string) => void
}

function getBaseName(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return separatorIndex === -1 ? path : path.slice(separatorIndex + 1)
}

function fuzzyScore(query: string, target: string): number | null {
  let score = 0
  let cursor = 0
  for (let index = 0; index < query.length; index += 1) {
    const next = target.indexOf(query[index], cursor)
    if (next === -1) return null
    score += next === cursor ? 10 : (next - cursor < 3 ? 5 : 1)
    cursor = next + 1
  }
  return score
}

function buildFuzzyResults(query: string, items: string[], limit = 80): string[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return items.slice(0, limit)

  const scored = items.map((item) => {
    const lower = item.toLowerCase()
    const baseScore = fuzzyScore(normalized, getBaseName(lower))
    const pathScore = fuzzyScore(normalized, lower)
    if (baseScore === null && pathScore === null) return null
    return {
      item,
      score: (baseScore ?? 0) * 2 + (pathScore ?? 0)
    }
  }).filter(Boolean) as Array<{ item: string; score: number }>

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    return left.item.length - right.item.length
  })

  return scored.slice(0, limit).map((entry) => entry.item)
}

export function SearchPanel({
  rootPath,
  isActive,
  initialSearchType = 'content',
  onNavigate,
  onOpenFile,
  onClose,
  buildFileIndex,
  getFileIndex,
  searchInputRef: externalInputRef,
  onFileContextMenu
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

  const [filenameQuery, setFilenameQuery] = useState('')
  const [filenameResults, setFilenameResults] = useState<string[]>([])
  const [filenameActiveIndex, setFilenameActiveIndex] = useState(0)
  const [isIndexing, setIsIndexing] = useState(false)
  const [showGlobs, setShowGlobs] = useState(false)
  const [activeMatch, setActiveMatch] = useState<{ file: string; line: number } | null>(null)

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

  useEffect(() => {
    if (!isActive || searchType !== 'filename' || !rootPath) return
    const existingIndex = getFileIndex()
    if (existingIndex.length > 0) return

    let cancelled = false
    setIsIndexing(true)
    void buildFileIndex().then(async () => {
      const results = await window.electronAPI.project.searchFilenames(rootPath, filenameQuery, 80)
      if (cancelled) return
      setIsIndexing(false)
      setFilenameResults(results)
    }).catch(() => {
      if (cancelled) return
      setIsIndexing(false)
      setFilenameResults([])
    })
    return () => {
      cancelled = true
    }
  }, [buildFileIndex, getFileIndex, isActive, rootPath, searchType])

  useEffect(() => {
    if (!isActive || searchType !== 'filename' || !rootPath) return
    const existingIndex = getFileIndex()
    if (existingIndex.length === 0) {
      setFilenameResults(buildFuzzyResults(filenameQuery, existingIndex))
      return
    }
    let cancelled = false
    void window.electronAPI.project.searchFilenames(rootPath, filenameQuery, 80)
      .then((results) => {
        if (cancelled) return
        setFilenameResults(results)
        setFilenameActiveIndex(0)
      })
      .catch(() => {
        if (cancelled) return
        setFilenameResults([])
        setFilenameActiveIndex(0)
      })
    return () => {
      cancelled = true
    }
  }, [filenameQuery, getFileIndex, isActive, rootPath, searchType])

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
  }, [currentQuery, fileGroups, filenameActiveIndex, filenameResults, handleFilenameSelect, handleMatchClick, onClose, searchType, setCurrentQuery])

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
    if (!filenameQuery.trim()) return t('projectEditor.globalSearchFilenameStart')
    if (filenameResults.length === 0) return t('projectEditor.globalSearchFilenameNoMatches')
    return t('projectEditor.globalSearchFilenameCount', { count: filenameResults.length })
  }, [filenameQuery, filenameResults.length, isIndexing, t])

  return (
    <div className="global-search-panel">
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

      <div className="global-search-results">
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
          </>
        )}
      </div>
    </div>
  )
}
