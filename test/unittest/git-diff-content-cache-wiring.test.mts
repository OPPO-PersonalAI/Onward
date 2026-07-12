/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-diff-content-cache-wiring.test.mts
 *
 * Covers the cache-state classification chain that the Git Diff Performance
 * Diagnostics panel surfaces. The two halves the panel ties together are:
 *
 *   1. `buildCacheKey` — must be deterministic and identical across the
 *      scheduler-prewarm path and the renderer-click path, otherwise a
 *      prewarmed entry will fail to hit on subsequent click.
 *
 *   2. `fetchFileContentWithCache` — produces the cacheInfo (state, source,
 *      missReason) the panel reads. Each branch — first-load, hit, force-
 *      bypass, worker-error, single-file-too-large, precompute-pending,
 *      project-queue-evicted, recent-invalidation — must produce the right
 *      classification and not pollute the cache with bad data.
 *
 *   3. End-to-end scheduler burst + click — verifies the two halves agree:
 *      every file the scheduler prefetches must be a renderer-click hit,
 *      including renames / copies / staged-and-unstaged variants.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCacheKey,
  parseCacheKey,
  createFetchFileContentWithCache,
  type FetchFileContentDeps,
  type ContentCacheFile,
  type GitDiffContentCacheMissReason,
  type CacheableFetchResult
} from '../../electron/main/git-diff-content-cache-state.ts'
import { GitDiffContentCache } from '../../electron/main/git-diff-content-cache.ts'
import {
  GitDiffPrecomputeScheduler,
  type DiffFile
} from '../../electron/main/git-diff-precompute-scheduler.ts'

interface MockFileContentResult extends CacheableFetchResult {
  filename: string
  modifiedContent: string
  error?: string
}
type GitFileContentResult = MockFileContentResult
type GitFileStatus = ContentCacheFile & { additions: number; deletions: number }

// -----------------------------------------------------------------------------
// Test fixtures: shapes that mirror what `getDiff` returns + what the renderer
// sends through IPC. Keeping them factored so each test reads as "this is the
// file the scheduler sees / this is the file the renderer clicks".
// -----------------------------------------------------------------------------

function untrackedFile(filename: string): ContentCacheFile {
  return { filename, status: '?', changeType: 'untracked', originalFilename: undefined }
}

function stagedAdd(filename: string): ContentCacheFile {
  return { filename, status: 'A', changeType: 'staged', originalFilename: undefined }
}

function stagedModify(filename: string): ContentCacheFile {
  return { filename, status: 'M', changeType: 'staged', originalFilename: undefined }
}

function stagedRename(oldName: string, newName: string): ContentCacheFile {
  return { filename: newName, status: 'R', changeType: 'staged', originalFilename: oldName }
}

function stagedCopy(srcName: string, copyName: string): ContentCacheFile {
  return { filename: copyName, status: 'C', changeType: 'staged', originalFilename: srcName }
}

function unstagedModify(filename: string): ContentCacheFile {
  return { filename, status: 'M', changeType: 'unstaged', originalFilename: undefined }
}

function conflictFile(filename: string): ContentCacheFile {
  return { filename, status: '!', changeType: 'conflict', originalFilename: undefined }
}

function makeWorkerResult(filename: string, modifiedContent = `// ${filename}\n`): MockFileContentResult {
  return {
    success: true,
    filename,
    modifiedContent
  }
}

function failingWorkerResult(): MockFileContentResult {
  return {
    success: false,
    filename: '',
    modifiedContent: '',
    error: 'simulated worker failure'
  }
}

interface MockDeps extends FetchFileContentDeps<MockFileContentResult> {
  workerCalls: Array<{ cwd: string; file: ContentCacheFile; repoRoot?: string; options?: { force?: boolean; missReason?: GitDiffContentCacheMissReason } }>
  hits: Array<{ project: string; filename: string }>
  misses: Array<{ project: string; filename: string; reason: GitDiffContentCacheMissReason; force: boolean }>
  tooLarge: Array<{ project: string; filename: string; bytes: number }>
  staleGenerationSkips: Array<{ project: string; filename: string; changeType: string }>
  pendingProjects: Set<string>
  inFlightProjects: Set<string>
  recentMisses: Map<string, GitDiffContentCacheMissReason>
}

function makeDeps(opts: {
  cache?: GitDiffContentCache<MockFileContentResult>
  fetchFromWorker?: (cwd: string, file: ContentCacheFile, repoRoot?: string, options?: { force?: boolean; missReason?: GitDiffContentCacheMissReason }) => Promise<MockFileContentResult>
} = {}): MockDeps {
  const cache = opts.cache ?? new GitDiffContentCache<MockFileContentResult>({
    projectByteLimit: 10 * 1024,
    maxProjects: 4,
    singleFileByteLimit: 1024
  })
  const workerCalls: MockDeps['workerCalls'] = []
  const hits: MockDeps['hits'] = []
  const misses: MockDeps['misses'] = []
  const tooLarge: MockDeps['tooLarge'] = []
  const staleGenerationSkips: MockDeps['staleGenerationSkips'] = []
  const pendingProjects = new Set<string>()
  const inFlightProjects = new Set<string>()
  const recentMisses = new Map<string, GitDiffContentCacheMissReason>()

  const defaultWorker = async (_cwd: string, file: ContentCacheFile) => makeWorkerResult(file.filename)
  const fetchFromWorker = async (cwd: string, file: ContentCacheFile, repoRoot?: string, options?: { force?: boolean; missReason?: GitDiffContentCacheMissReason }) => {
    workerCalls.push({ cwd, file, repoRoot, options })
    return await (opts.fetchFromWorker ?? defaultWorker)(cwd, file, repoRoot, options)
  }

  return {
    cache,
    fetchFromWorker,
    schedulerPendingProjects: () => Array.from(pendingProjects),
    schedulerInFlightProjects: () => Array.from(inFlightProjects),
    recentMissReason: (project) => recentMisses.get(project) ?? null,
    rememberMissReason: (project, reason) => { recentMisses.set(project, reason) },
    estimateBytes: (result) => (result.modifiedContent ?? '').length,
    recordHit: (info) => { hits.push({ project: info.project, filename: info.filename }) },
    recordMiss: (info) => { misses.push({ project: info.project, filename: info.filename, reason: info.reason, force: info.force }) },
    recordSkipTooLarge: (info) => { tooLarge.push({ project: info.project, filename: info.filename, bytes: info.bytes }) },
    recordSkipStaleGeneration: (info) => {
      staleGenerationSkips.push({ project: info.project, filename: info.filename, changeType: info.changeType })
    },
    workerCalls,
    hits,
    misses,
    tooLarge,
    staleGenerationSkips,
    pendingProjects,
    inFlightProjects,
    recentMisses
  }
}

// =============================================================================
// 1. buildCacheKey: deterministic key shape for every changeType
// =============================================================================

test('buildCacheKey: untracked file uses empty originalFilename', () => {
  assert.equal(buildCacheKey(untrackedFile('new.txt')), 'untracked::?::::new.txt')
})

test('buildCacheKey: staged add', () => {
  assert.equal(buildCacheKey(stagedAdd('feature.ts')), 'staged::A::::feature.ts')
})

test('buildCacheKey: staged modify', () => {
  assert.equal(buildCacheKey(stagedModify('feature.ts')), 'staged::M::::feature.ts')
})

test('buildCacheKey: staged rename keeps originalFilename so the two ends do not collide', () => {
  assert.equal(buildCacheKey(stagedRename('old.ts', 'new.ts')), 'staged::R::old.ts::new.ts')
  // Adding the rename's destination as a separate entry must NOT collide.
  assert.notEqual(
    buildCacheKey(stagedRename('old.ts', 'new.ts')),
    buildCacheKey(stagedAdd('new.ts'))
  )
})

test('buildCacheKey: staged copy preserves source path', () => {
  assert.equal(buildCacheKey(stagedCopy('source.ts', 'copy.ts')), 'staged::C::source.ts::copy.ts')
})

test('buildCacheKey: unstaged variant of same path is a different key from staged', () => {
  assert.notEqual(buildCacheKey(stagedModify('a.ts')), buildCacheKey(unstagedModify('a.ts')))
})

test('buildCacheKey: status M and status D of the same path yield different keys (status transition isolation)', () => {
  // Reported bug class: file was modified (M) and cached, user externally
  // deletes the file → status flips to D → renderer click for D MUST NOT
  // satisfy from the M-key entry, because the underlying content has changed.
  const modified: ContentCacheFile = { filename: 'a.ts', status: 'M', changeType: 'unstaged', originalFilename: undefined }
  const deleted: ContentCacheFile = { filename: 'a.ts', status: 'D', changeType: 'unstaged', originalFilename: undefined }
  assert.notEqual(buildCacheKey(modified), buildCacheKey(deleted))
})

test('buildCacheKey: conflict files use changeType=conflict', () => {
  assert.equal(buildCacheKey(conflictFile('merge.ts')), 'conflict::!::::merge.ts')
})

// =============================================================================
// 2. fetchFileContentWithCache: the cacheInfo state machine
// =============================================================================

test('first click on uncached file: miss / first-load / worker called / result cached', async () => {
  const deps = makeDeps()
  const fetchFn = createFetchFileContentWithCache(deps)
  const file = unstagedModify('a.ts')
  const result = await fetchFn({ cwd: '/p', file })
  assert.equal(result.cacheInfo?.state, 'miss')
  assert.equal(result.cacheInfo?.source, 'worker-rebuild')
  assert.equal(result.cacheInfo?.missReason, 'first-load')
  assert.equal(result.cacheInfo?.stored, true)
  assert.equal(deps.workerCalls.length, 1)
  // Cache now holds the entry, future clicks should hit.
  assert.equal(deps.cache.get('/p', buildCacheKey(file)) !== null, true)
})

test('second click on same file: hit / main-content-cache / worker NOT called', async () => {
  const deps = makeDeps()
  const fetchFn = createFetchFileContentWithCache(deps)
  const file = unstagedModify('a.ts')
  await fetchFn({ cwd: '/p', file })
  deps.workerCalls.length = 0
  const result = await fetchFn({ cwd: '/p', file })
  assert.equal(result.cacheInfo?.state, 'hit')
  assert.equal(result.cacheInfo?.source, 'main-content-cache')
  assert.equal(deps.workerCalls.length, 0, 'cache hit must not touch the worker')
})

test('force=true bypasses cache: miss / worker called / passed-in missReason preserved', async () => {
  const deps = makeDeps()
  const fetchFn = createFetchFileContentWithCache(deps)
  const file = unstagedModify('a.ts')
  await fetchFn({ cwd: '/p', file })
  const result = await fetchFn({ cwd: '/p', file, options: { force: true, missReason: 'renderer-force-refresh' } })
  assert.equal(result.cacheInfo?.state, 'miss')
  assert.equal(result.cacheInfo?.source, 'worker-rebuild')
  assert.equal(result.cacheInfo?.missReason, 'renderer-force-refresh')
  assert.equal(deps.workerCalls.at(-1)?.options?.force, true)
})

test('after invalidateProject + rememberMissReason(invalidated-watch): next click reports invalidated-watch', async () => {
  const deps = makeDeps()
  const fetchFn = createFetchFileContentWithCache(deps)
  const file = unstagedModify('a.ts')
  await fetchFn({ cwd: '/p', file })
  // Mimic the watcher invalidation path: drop the bucket + remember the reason.
  deps.cache.invalidateProject('/p')
  deps.recentMisses.set('/p', 'invalidated-watch')
  const result = await fetchFn({ cwd: '/p', file })
  assert.equal(result.cacheInfo?.state, 'miss')
  assert.equal(result.cacheInfo?.missReason, 'invalidated-watch')
})

test('worker error: miss / worker-error / NOT cached so the next click retries', async () => {
  const deps = makeDeps({
    fetchFromWorker: async () => failingWorkerResult()
  })
  const fetchFn = createFetchFileContentWithCache(deps)
  const file = unstagedModify('a.ts')
  const result = await fetchFn({ cwd: '/p', file })
  assert.equal(result.cacheInfo?.state, 'miss')
  assert.equal(result.cacheInfo?.missReason, 'worker-error')
  assert.equal(result.cacheInfo?.stored, false)
  assert.equal(deps.cache.get('/p', buildCacheKey(file)), null, 'failed fetch must NOT be cached')
})

test('result above singleFileByteLimit: miss / single-file-too-large / not cached', async () => {
  const deps = makeDeps({
    cache: new GitDiffContentCache<GitFileContentResult>({
      projectByteLimit: 10_000,
      maxProjects: 4,
      singleFileByteLimit: 100
    }),
    fetchFromWorker: async (_cwd, file) => makeWorkerResult(file.filename, 'X'.repeat(500))
  })
  const fetchFn = createFetchFileContentWithCache(deps)
  const result = await fetchFn({ cwd: '/p', file: unstagedModify('huge.ts') })
  assert.equal(result.cacheInfo?.state, 'miss')
  assert.equal(result.cacheInfo?.missReason, 'single-file-too-large')
  assert.equal(result.cacheInfo?.stored, false)
  assert.equal(deps.tooLarge.length, 1, 'too-large path must record')
})

test('precompute pending: miss reason is precompute-pending when project is in flight', async () => {
  const deps = makeDeps()
  deps.inFlightProjects.add('/p')
  const fetchFn = createFetchFileContentWithCache(deps)
  const result = await fetchFn({ cwd: '/p', file: unstagedModify('a.ts') })
  assert.equal(result.cacheInfo?.missReason, 'precompute-pending')
})

test('precompute pending: miss reason is precompute-pending when project is queued for debounce', async () => {
  const deps = makeDeps()
  deps.pendingProjects.add('/p')
  const fetchFn = createFetchFileContentWithCache(deps)
  const result = await fetchFn({ cwd: '/p', file: unstagedModify('a.ts') })
  assert.equal(result.cacheInfo?.missReason, 'precompute-pending')
})

test('project-queue-evicted: cache surfaces the eviction flag exactly once', async () => {
  const deps = makeDeps({
    cache: new GitDiffContentCache<GitFileContentResult>({
      projectByteLimit: 10_000,
      maxProjects: 1,
      singleFileByteLimit: 1024
    })
  })
  const fetchFn = createFetchFileContentWithCache(deps)
  // Warm /p1, then add /p2 forcing /p1 out of the queue.
  await fetchFn({ cwd: '/p1', file: unstagedModify('a.ts') })
  await fetchFn({ cwd: '/p2', file: unstagedModify('b.ts') })
  // Now /p1 is evicted; the next click on /p1 must surface the reason.
  const result = await fetchFn({ cwd: '/p1', file: unstagedModify('a.ts') })
  assert.equal(result.cacheInfo?.state, 'miss')
  assert.equal(result.cacheInfo?.missReason, 'project-queue-evicted')
})

test('explicit options.missReason wins over scheduler / recent / queue-evicted state', async () => {
  const deps = makeDeps()
  deps.inFlightProjects.add('/p')
  deps.recentMisses.set('/p', 'invalidated-watch')
  const fetchFn = createFetchFileContentWithCache(deps)
  const result = await fetchFn({
    cwd: '/p',
    file: unstagedModify('a.ts'),
    options: { missReason: 'invalidated-mutation' }
  })
  assert.equal(result.cacheInfo?.missReason, 'invalidated-mutation')
})

test('repoRoot routes to a separate bucket from cwd (submodule case)', async () => {
  const deps = makeDeps()
  const fetchFn = createFetchFileContentWithCache(deps)
  const file = unstagedModify('vendored/lib.ts')
  // Submodule: cwd = parent project, repoRoot = submodule root.
  await fetchFn({ cwd: '/parent', file, repoRoot: '/parent/sub' })
  // The cached entry is under '/parent/sub', NOT '/parent'.
  assert.equal(deps.cache.get('/parent/sub', buildCacheKey(file)) !== null, true)
  assert.equal(deps.cache.get('/parent', buildCacheKey(file)), null)
})

// =============================================================================
// 3. End-to-end: scheduler prewarm + renderer click — keys MUST match.
//    Scheduler runs a real burst against a mock workingSet; renderer clicks
//    each file; every result must come back as a hit.
// =============================================================================

interface FakeTimerHandle { id: number; cb: () => void; ms: number; cancelled: boolean }

class FakeTimer {
  private nextId = 1
  public scheduled: FakeTimerHandle[] = []
  setTimeout(cb: () => void, ms: number): FakeTimerHandle {
    const handle: FakeTimerHandle = { id: this.nextId++, cb, ms, cancelled: false }
    this.scheduled.push(handle)
    return handle
  }
  clearTimeout(handle: unknown): void {
    const h = handle as FakeTimerHandle
    if (h) h.cancelled = true
  }
  flushAll(): void {
    while (true) {
      const next = this.scheduled.find((h) => !h.cancelled)
      if (!next) return
      next.cancelled = true
      next.cb()
    }
  }
}

async function nextTick() {
  // Yield enough times for the bounded-concurrency loop to drain.
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

/**
 * Build a scheduler that mimics how the production wiring connects scheduler.fetchFile
 * back to fetchFileContentWithCache. This is the integration we actually
 * ship, so this is what we want to exercise end-to-end.
 */
function buildSchedulerSuite(workingSet: GitFileStatus[]): {
  scheduler: GitDiffPrecomputeScheduler
  fetchFn: ReturnType<typeof createFetchFileContentWithCache>
  fakeTimer: FakeTimer
  deps: MockDeps
  workerCalls: Array<{ cwd: string; file: ContentCacheFile; repoRoot?: string }>
} {
  const fakeTimer = new FakeTimer()
  const deps = makeDeps()
  const fetchFn = createFetchFileContentWithCache(deps)

  const scheduler = new GitDiffPrecomputeScheduler({
    concurrency: 6,
    debounceMs: 0,
    maxCandidatesPerBurst: 100,
    timer: fakeTimer,
    isEligible: (file) => {
      if (file.isSubmoduleEntry) return false
      if (file.status === 'D' || file.status === '!') return false
      return true
    },
    loadWorkingSet: async () => workingSet.map<DiffFile>((file) => ({
      filename: file.filename,
      additions: file.additions,
      deletions: file.deletions,
      changeType: file.changeType,
      status: file.status,
      isSubmoduleEntry: file.isSubmoduleEntry,
      // Bug fix candidate: scheduler must propagate originalFilename so the
      // renderer-click path (which always sees the original from getDiff)
      // builds the same cache key.
      originalFilename: file.originalFilename,
      repoRoot: undefined
    })),
    fetchFile: async (project, scheduledFile) => {
      // Production wiring shape: cacheFile is built from the scheduledFile.
      // Tests deliberately mirror the actual wiring so a regression in the
      // wiring surfaces here, not just in autotests.
      const cacheFile: ContentCacheFile = {
        filename: scheduledFile.filename,
        status: scheduledFile.status,
        originalFilename: scheduledFile.originalFilename,
        changeType: scheduledFile.changeType,
        isSubmoduleEntry: scheduledFile.isSubmoduleEntry
      }
      await fetchFn({
        cwd: project,
        file: cacheFile,
        repoRoot: project,
        options: { missReason: 'precompute-pending' }
      })
    }
  })

  return { scheduler, fetchFn, fakeTimer, deps, workerCalls: deps.workerCalls }
}

function asGitFileStatus(file: ContentCacheFile, additions = 1, deletions = 0): GitFileStatus {
  return {
    filename: file.filename,
    status: file.status,
    changeType: file.changeType,
    originalFilename: file.originalFilename,
    isSubmoduleEntry: file.isSubmoduleEntry,
    additions,
    deletions
  }
}

test('e2e: scheduler prefetches a working set; every renderer click hits the cache', async () => {
  const ws: GitFileStatus[] = [
    asGitFileStatus(unstagedModify('a.ts')),
    asGitFileStatus(stagedAdd('b.ts')),
    asGitFileStatus(untrackedFile('c.txt'))
  ]
  const { scheduler, fetchFn, fakeTimer, deps } = buildSchedulerSuite(ws)
  scheduler.onProjectInvalidated('/proj')
  fakeTimer.flushAll()
  await nextTick()
  // Scheduler hit each file once.
  assert.equal(deps.workerCalls.length, 3)
  const workerCallsBeforeRenderer = deps.workerCalls.length
  // Now renderer clicks each file. Every click must be a hit (worker not invoked again).
  for (const ccf of [unstagedModify('a.ts'), stagedAdd('b.ts'), untrackedFile('c.txt')]) {
    const result = await fetchFn({ cwd: '/proj', file: ccf, repoRoot: '/proj' })
    assert.equal(result.cacheInfo?.state, 'hit', `${ccf.filename} should be a hit after prewarm`)
  }
  assert.equal(deps.workerCalls.length, workerCallsBeforeRenderer, 'cache hits must not touch the worker')
})

test('e2e: scheduler prefetches a renamed file; renderer click on the rename must hit', async () => {
  const renameFile = stagedRename('old.ts', 'new.ts')
  const ws: GitFileStatus[] = [asGitFileStatus(renameFile)]
  const { scheduler, fetchFn, fakeTimer, deps } = buildSchedulerSuite(ws)
  scheduler.onProjectInvalidated('/proj')
  fakeTimer.flushAll()
  await nextTick()
  assert.equal(deps.workerCalls.length, 1)
  // Renderer click for the rename (with originalFilename propagated by getDiff).
  const result = await fetchFn({ cwd: '/proj', file: renameFile, repoRoot: '/proj' })
  assert.equal(result.cacheInfo?.state, 'hit', 'renamed file must hit after scheduler prewarm — cache key must include originalFilename on both sides')
})

test('e2e: scheduler prefetches a copy; renderer click on the copy must hit', async () => {
  const copyFile = stagedCopy('orig.ts', 'duplicated.ts')
  const ws: GitFileStatus[] = [asGitFileStatus(copyFile)]
  const { scheduler, fetchFn, fakeTimer, deps } = buildSchedulerSuite(ws)
  scheduler.onProjectInvalidated('/proj')
  fakeTimer.flushAll()
  await nextTick()
  const result = await fetchFn({ cwd: '/proj', file: copyFile, repoRoot: '/proj' })
  assert.equal(result.cacheInfo?.state, 'hit', 'copied file must hit after scheduler prewarm')
})

test('e2e: same path with both staged and unstaged variants — each variant gets its own cache entry and hits independently', async () => {
  const ws: GitFileStatus[] = [
    asGitFileStatus(stagedModify('shared.ts')),
    asGitFileStatus(unstagedModify('shared.ts'))
  ]
  const { scheduler, fetchFn, fakeTimer, deps } = buildSchedulerSuite(ws)
  scheduler.onProjectInvalidated('/proj')
  fakeTimer.flushAll()
  await nextTick()
  // Both variants prefetched.
  assert.equal(deps.workerCalls.length, 2)
  const stagedResult = await fetchFn({ cwd: '/proj', file: stagedModify('shared.ts'), repoRoot: '/proj' })
  const unstagedResult = await fetchFn({ cwd: '/proj', file: unstagedModify('shared.ts'), repoRoot: '/proj' })
  assert.equal(stagedResult.cacheInfo?.state, 'hit', 'staged variant must hit')
  assert.equal(unstagedResult.cacheInfo?.state, 'hit', 'unstaged variant must hit')
})

test('e2e: deleted file is filtered out by isEligible — renderer click on a deleted file is a miss (correctly), not a stale hit', async () => {
  const ws: GitFileStatus[] = [asGitFileStatus({ filename: 'gone.ts', status: 'D', changeType: 'staged', originalFilename: undefined })]
  const { scheduler, fetchFn, fakeTimer, deps } = buildSchedulerSuite(ws)
  scheduler.onProjectInvalidated('/proj')
  fakeTimer.flushAll()
  await nextTick()
  // Deleted files are filtered out, scheduler does NOT prefetch them.
  assert.equal(deps.workerCalls.length, 0)
  // First renderer click is a legitimate first-load miss.
  const result = await fetchFn({
    cwd: '/proj',
    file: { filename: 'gone.ts', status: 'D', changeType: 'staged', originalFilename: undefined },
    repoRoot: '/proj'
  })
  assert.equal(result.cacheInfo?.state, 'miss')
  assert.equal(result.cacheInfo?.missReason, 'first-load')
})

test('e2e: conflict file is filtered out — renderer click is a legit miss, not a stale hit', async () => {
  const ws: GitFileStatus[] = [asGitFileStatus(conflictFile('merge.ts'))]
  const { scheduler, fetchFn, fakeTimer, deps } = buildSchedulerSuite(ws)
  scheduler.onProjectInvalidated('/proj')
  fakeTimer.flushAll()
  await nextTick()
  assert.equal(deps.workerCalls.length, 0, 'conflict files must NOT be prefetched')
  const result = await fetchFn({ cwd: '/proj', file: conflictFile('merge.ts'), repoRoot: '/proj' })
  assert.equal(result.cacheInfo?.state, 'miss')
})

test('e2e: M→D status transition — entry cached under M-key does NOT satisfy a click on the D variant', async () => {
  // Reproduces the pattern behind the user-reported "deleted file shows
  // cache hit": the file was M, scheduler/click cached it under
  // unstaged::M::"":a.ts. Then the file is deleted on disk; main-side
  // invalidator fires → bucket cleared. After that, even WITHOUT explicit
  // invalidation, the click on the D variant must use a different key.
  const deps = makeDeps()
  const fetchFn = createFetchFileContentWithCache(deps)
  const modified = unstagedModify('a.ts')
  const deleted: ContentCacheFile = { filename: 'a.ts', status: 'D', changeType: 'unstaged', originalFilename: undefined }
  // Phase 1: warm the M-key entry.
  await fetchFn({ cwd: '/proj', file: modified })
  assert.equal(deps.workerCalls.length, 1)
  // Sanity: M-key now hits.
  const mHit = await fetchFn({ cwd: '/proj', file: modified })
  assert.equal(mHit.cacheInfo?.state, 'hit')
  deps.workerCalls.length = 0
  // Phase 2: simulate watcher invalidation (file deleted). The bucket-wide
  // drop is what production wiring does; we model it directly.
  deps.cache.invalidateProject('/proj')
  deps.recentMisses.set('/proj', 'invalidated-watch')
  // Phase 3: click on the D variant — MUST be a miss, not a stale hit.
  const result = await fetchFn({ cwd: '/proj', file: deleted })
  assert.equal(result.cacheInfo?.state, 'miss', 'D-variant click must NOT hit the M-key entry')
  assert.equal(result.cacheInfo?.missReason, 'invalidated-watch')
  assert.equal(deps.workerCalls.length, 1, 'cache miss must reach the worker')
})

test('e2e: invalidation while precompute is mid-burst — renderer click during the gap reports precompute-pending, not stale hit', async () => {
  const ws: GitFileStatus[] = [asGitFileStatus(unstagedModify('a.ts'))]
  const { scheduler, fetchFn, fakeTimer, deps } = buildSchedulerSuite(ws)
  scheduler.onProjectInvalidated('/proj')
  // Mark project in-flight to model the race: scheduler is mid-burst, user clicks a different file
  // not yet covered by the in-flight burst.
  deps.inFlightProjects.add('/proj')
  const result = await fetchFn({
    cwd: '/proj',
    file: unstagedModify('not-yet-warmed.ts'),
    repoRoot: '/proj'
  })
  assert.equal(result.cacheInfo?.state, 'miss')
  assert.equal(result.cacheInfo?.missReason, 'precompute-pending')
  fakeTimer.flushAll()
  await nextTick()
})

test('e2e: in-flight worker result after invalidation is returned but not stored', async () => {
  let resolveFirst: (() => void) | null = null
  let calls = 0
  const deps = makeDeps({
    fetchFromWorker: async (_cwd, file) => {
      calls += 1
      if (calls === 1) {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve
        })
        return makeWorkerResult(file.filename, 'stale-content')
      }
      return makeWorkerResult(file.filename, 'fresh-content')
    }
  })
  const fetchFn = createFetchFileContentWithCache(deps)
  const file = unstagedModify('a.ts')

  const firstFetch = fetchFn({ cwd: '/proj', file, repoRoot: '/proj' })
  await nextTick()
  assert.equal(deps.workerCalls.length, 1)
  assert.ok(resolveFirst, 'first worker call should be waiting')

  deps.cache.invalidateProject('/proj')
  resolveFirst()
  const firstResult = await firstFetch
  assert.equal(firstResult.modifiedContent, 'stale-content')
  assert.equal(firstResult.cacheInfo?.state, 'miss')
  assert.equal(firstResult.cacheInfo?.stored, false)
  assert.deepEqual(deps.staleGenerationSkips, [
    { project: '/proj', filename: 'a.ts', changeType: 'unstaged' }
  ])

  deps.workerCalls.length = 0
  const secondResult = await fetchFn({ cwd: '/proj', file, repoRoot: '/proj' })
  assert.equal(secondResult.modifiedContent, 'fresh-content')
  assert.equal(secondResult.cacheInfo?.state, 'miss')
  assert.equal(deps.workerCalls.length, 1, 'stale in-flight result must not become a later cache hit')
})

// ---------------------------------------------------------------------------
// parseCacheKey — inverse of buildCacheKey (content-cache revalidation #1)
// ---------------------------------------------------------------------------

test('parseCacheKey round-trips buildCacheKey for every changeType variant', () => {
  const files: ContentCacheFile[] = [
    { filename: 'new.txt', status: '?', originalFilename: undefined, changeType: 'untracked', isSubmoduleEntry: false },
    { filename: 'feature.ts', status: 'A', originalFilename: undefined, changeType: 'staged', isSubmoduleEntry: false },
    { filename: 'src/a.c', status: 'M', originalFilename: undefined, changeType: 'unstaged', isSubmoduleEntry: false },
    { filename: 'to.ts', status: 'R', originalFilename: 'from.ts', changeType: 'staged', isSubmoduleEntry: false }
  ]
  for (const f of files) {
    const parsed = parseCacheKey(buildCacheKey(f))
    assert.equal(parsed.changeType, f.changeType)
    assert.equal(parsed.status, f.status)
    assert.equal(parsed.filename, f.filename)
    assert.equal(parsed.originalFilename, f.originalFilename ?? '')
  }
})

test('parseCacheKey recovers changeType + filename used by revalidation', () => {
  const parsed = parseCacheKey('unstaged::M::::tools/kar_air_control.py')
  assert.equal(parsed.changeType, 'unstaged')
  assert.equal(parsed.filename, 'tools/kar_air_control.py')
})

test('parseCacheKey rejoins a filename that itself contains "::" (defensive)', () => {
  const f: ContentCacheFile = { filename: 'weird::name.txt', status: 'M', originalFilename: undefined, changeType: 'unstaged', isSubmoduleEntry: false }
  assert.equal(parseCacheKey(buildCacheKey(f)).filename, 'weird::name.txt')
})

// ---------------------------------------------------------------------------
// REPRO TOCTOU (2026-07-12 diagnostic bundle, "diff shows stale content until
// manual refresh") — now locking the FIX. The store path used to capture the
// working-tree stat token AFTER `fetchFromWorker` resolved, so an external
// edit landing while the fetch was in flight stored OLD content under the NEW
// stat token; every later read then re-stat'ed the file, saw the token match,
// and served the pre-edit body as a validated hit forever (only a manual
// refresh recovered). The mirror never helps here: its state is CORRECT and
// unchanged after the racing write, so no invalidation is ever pushed.
//
// Contract locked: the freshness token stored with an entry witnesses the
// working-tree state the cached CONTENT was read from — captured at/before
// the worker read — so a mid-fetch edit makes the very next read provably
// stale and re-fetch fresh content.
// ---------------------------------------------------------------------------

test('REPRO TOCTOU: mid-fetch external edit must not poison the cache into serving pre-edit content as a validated hit', async () => {
  // One mutable simulated file: content + its worktree stat token move together.
  let fileContent = 'v1 body\n'
  let fileToken = 'mtime:100:size:8'
  const file = unstagedModify('Notes/study/doc.html')

  const deps = makeDeps({
    fetchFromWorker: async (_cwd, f) => {
      // The worker reads the file NOW (content v1)...
      const readContent = fileContent
      // ...and the external edit lands while the fetch is still in flight,
      // BEFORE the wiring's post-fetch computeStaleToken stat runs.
      fileContent = 'v2 body\n'
      fileToken = 'mtime:200:size:8'
      return { success: true, filename: f.filename, modifiedContent: readContent }
    }
  })
  deps.computeStaleToken = async () => fileToken

  const fetchFileContent = createFetchFileContentWithCache(deps)

  const first = await fetchFileContent({ cwd: '/repo', file })
  // Serving what the worker read at fetch time is fine — the edit raced it.
  assert.equal(first.modifiedContent, 'v1 body\n')

  // A later click re-reads through the cache. On disk the file is v2 with
  // token mtime:200. The entry holds v1 content; if its stored token is also
  // mtime:200 (captured after the fetch), the read revalidation wrongly says
  // "fresh" and v1 is served forever.
  const second = await fetchFileContent({ cwd: '/repo', file })
  assert.equal(
    second.modifiedContent,
    'v2 body\n',
    'read served pre-edit content as a validated hit: staleToken was captured after the fetch (TOCTOU)'
  )
})
