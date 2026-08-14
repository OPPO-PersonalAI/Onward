/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { perfTrace } from '../../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../../utils/perf-trace-names'
import { FILE_INDEX_SEARCH_PAGE_SIZE } from '../../../utils/file-index-constants'
import { stepActiveIndex } from '../../../utils/list-keyboard-nav'

/**
 * Start fetching the next page once the selection is within this many rows of
 * the end. Roughly one screenful, so the rows are already loaded by the time a
 * held-down arrow key arrives at the boundary.
 */
const PREFETCH_DISTANCE_ROWS = 10

/**
 * Paged filename search, shared by the sidebar Search panel and the Cmd+P
 * modal.
 *
 * Both surfaces used to run their own copy of this logic with different
 * hard-coded page sizes (50 vs 80) and no notion of a total, so the same query
 * produced a different number of rows depending on where the user typed it and
 * neither surface could tell the user that results had been cut off. Owning it
 * in one hook is what makes "identical behaviour in both places" a structural
 * property rather than something to keep re-verifying by hand.
 */
export interface FilenameSearchController {
  query: string
  setQuery: (next: string) => void
  /** Every row fetched so far — page 0 plus whatever `loadMore` appended. */
  results: string[]
  /** Total matches on the worker side, BEFORE paging. */
  total: number
  hasMore: boolean
  isSearching: boolean
  isLoadingMore: boolean
  loadMore: () => void
  activeIndex: number
  setActiveIndex: (next: number | ((previous: number) => number)) => void
  /**
   * Move the selection by `delta`, transparently paging when it runs off the
   * loaded rows. Prefer this over setActiveIndex for keyboard navigation: it is
   * what keeps a keypress at the page boundary from being silently swallowed.
   */
  moveActive: (delta: number) => void
  reset: () => void
}

interface UseFilenameSearchParams {
  rootPath: string | null
  isActive: boolean
  pageSize?: number
}

export function useFilenameSearch({
  rootPath,
  isActive,
  pageSize = FILE_INDEX_SEARCH_PAGE_SIZE
}: UseFilenameSearchParams): FilenameSearchController {
  const [query, setQueryState] = useState('')
  const [results, setResults] = useState<string[]>([])
  const [total, setTotal] = useState(0)
  const [isSearching, setIsSearching] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  // Monotonic token: a page that resolves after the query moved on must be
  // dropped, otherwise a slow page-0 response can overwrite a newer query's
  // results (or a stale "load more" can append rows from the previous query).
  const requestTokenRef = useRef(0)
  const resultsRef = useRef<string[]>([])
  const totalRef = useRef(0)
  const loadingMoreRef = useRef(false)
  // Mirrors activeIndex synchronously. A held-down arrow key delivers many
  // events before React re-renders; reading state would make every one of them
  // compute from the same stale index and collapse into a single row of travel.
  const activeIndexRef = useRef(0)
  const loadMoreRef = useRef<() => void>(() => {})

  useEffect(() => {
    resultsRef.current = results
  }, [results])

  useEffect(() => {
    totalRef.current = total
  }, [total])

  useEffect(() => {
    activeIndexRef.current = activeIndex
  }, [activeIndex])

  const reset = useCallback(() => {
    requestTokenRef.current += 1
    loadingMoreRef.current = false
    pendingAdvanceRef.current = 0
    activeIndexRef.current = 0
    setQueryState('')
    setResults([])
    setTotal(0)
    setActiveIndex(0)
    setIsSearching(false)
    setIsLoadingMore(false)
  }, [])

  // Page 0: refetch whenever the query (or the active root) changes.
  useEffect(() => {
    if (!isActive || !rootPath) return
    const token = ++requestTokenRef.current
    setIsSearching(true)
    let cancelled = false

    void window.electronAPI.project.searchFilenames(rootPath, query, pageSize, 0)
      .then((page) => {
        if (cancelled || token !== requestTokenRef.current) return
        setResults(page.items)
        setTotal(page.total)
        activeIndexRef.current = 0
        setActiveIndex(0)
        setIsSearching(false)
        perfTrace(PERF_TRACE_EVENT.RENDERER_FILE_INDEX_SEARCH_PAGE, {
          queryLen: query.trim().length,
          offset: 0,
          limit: pageSize,
          returned: page.items.length,
          total: page.total,
          hasMore: page.items.length < page.total
        })
      })
      .catch(() => {
        if (cancelled || token !== requestTokenRef.current) return
        setResults([])
        setTotal(0)
        setActiveIndex(0)
        setIsSearching(false)
      })

    return () => {
      cancelled = true
    }
  }, [isActive, pageSize, query, rootPath])

  const loadMore = useCallback(() => {
    if (!isActive || !rootPath) return
    if (loadingMoreRef.current) return
    const offset = resultsRef.current.length
    if (offset >= total) return

    loadingMoreRef.current = true
    setIsLoadingMore(true)
    const token = requestTokenRef.current

    void window.electronAPI.project.searchFilenames(rootPath, query, pageSize, offset)
      .then((page) => {
        // Token check, not just a cancelled flag: the query may have changed
        // while this page was in flight, in which case appending would splice
        // results from two different queries into one list.
        if (token !== requestTokenRef.current) return
        setResults((previous) => {
          // Guard against a duplicated append if two loadMore calls raced.
          if (previous.length !== offset) return previous
          return [...previous, ...page.items]
        })
        setTotal(page.total)
        perfTrace(PERF_TRACE_EVENT.RENDERER_FILE_INDEX_SEARCH_PAGE, {
          queryLen: query.trim().length,
          offset,
          limit: pageSize,
          returned: page.items.length,
          total: page.total,
          hasMore: offset + page.items.length < page.total
        })
      })
      .catch(() => {
        // Leave the already-rendered rows in place; the user can retry by
        // scrolling again.
      })
      .finally(() => {
        loadingMoreRef.current = false
        if (token === requestTokenRef.current) setIsLoadingMore(false)
      })
  }, [isActive, pageSize, query, rootPath, total])

  useEffect(() => {
    loadMoreRef.current = loadMore
  }, [loadMore])

  const setQuery = useCallback((next: string) => {
    setQueryState(next)
  }, [])

  // A step that could not complete because its row was not loaded yet. Applied
  // when the page lands, so the user never has to press the key twice.
  const pendingAdvanceRef = useRef(0)

  const moveActive = useCallback((delta: number) => {
    // Compute from refs rather than inside the state updater: a setState
    // updater must stay pure (React may call it twice), and triggering a fetch
    // from inside one would fire the request twice under StrictMode.
    const step = stepActiveIndex({
      activeIndex: activeIndexRef.current,
      itemCount: resultsRef.current.length,
      hasMore: resultsRef.current.length < totalRef.current,
      delta,
      prefetchDistance: PREFETCH_DISTANCE_ROWS
    })
    activeIndexRef.current = step.nextIndex
    setActiveIndex(step.nextIndex)
    if (step.deferred) pendingAdvanceRef.current += delta
    if (step.shouldLoadMore) loadMoreRef.current()
  }, [])

  // Complete any deferred step once the newly fetched rows are in.
  useEffect(() => {
    if (pendingAdvanceRef.current === 0) return
    if (results.length === 0) {
      pendingAdvanceRef.current = 0
      return
    }
    const pending = pendingAdvanceRef.current
    pendingAdvanceRef.current = 0
    const step = stepActiveIndex({
      activeIndex: activeIndexRef.current,
      itemCount: results.length,
      hasMore: results.length < total,
      delta: pending,
      prefetchDistance: PREFETCH_DISTANCE_ROWS
    })
    activeIndexRef.current = step.nextIndex
    setActiveIndex(step.nextIndex)
  }, [results, total])

  return {
    query,
    setQuery,
    results,
    total,
    hasMore: results.length < total,
    isSearching,
    isLoadingMore,
    loadMore,
    activeIndex,
    setActiveIndex,
    moveActive,
    reset
  }
}
