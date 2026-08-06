/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  FILE_INDEX_MAX_CACHED_PROJECTS,
  FILE_INDEX_SEARCH_PAGE_SIZE,
  FILE_INDEX_SEARCH_MAX_PAGE_SIZE,
  clampSearchOffset,
  clampSearchPageSize
} from '../../src/utils/file-index-constants.ts'
import { isIgnoredRel } from '../../electron/main/project-tree-watch-ignore.ts'
import { applyFileIndexPatch, normalizeIndexRel } from '../../src/utils/file-index-patch.ts'
import {
  ensureIndex,
  getIndexSnapshot,
  isIndexReady,
  recordAuthoritativeCount,
  invalidate,
  dispose
} from '../../src/components/ProjectEditor/GlobalSearch/fileIndexCache.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * These tests pin the FOUR properties that made the file index a source of
 * user-visible defects, each of which was invisible from any single file:
 *
 *   1. The build walk and the watcher must agree on what to ignore. They lived
 *      in different processes and only the watcher consulted the ignore list,
 *      so writes under `node_modules` were filtered out incrementally while any
 *      rebuild pulled the whole tree back in (~93% noise on a repo with
 *      dependencies installed).
 *   2. `applyFsEvent` must report whether the file SET actually moved. The
 *      watcher reports a plain save as a non-empty `added` array, so a caller
 *      gating on `added.length` treats every Cmd+S as a structural change — the
 *      exact path that made an ordinary save cost a full re-walk.
 *   3. Paging inputs arriving over IPC are untrusted and must be clamped.
 *   4. Both caches must agree on capacity, or a project evicted from one
 *      lingers in the other.
 */

describe('FIC-U-1 the index honours .gitignore, with a guarded fallback', () => {
  const workerSource = readFileSync(
    path.join(repoRoot, 'electron/main/project-fs-worker-entry.ts'),
    'utf8'
  )

  it('lists files through ripgrep, which applies real gitignore semantics', () => {
    assert.match(
      workerSource,
      /'--files'/,
      'the primary lister must be `rg --files`; a hand-written gitignore matcher would be a second, divergent implementation'
    )
  })

  it("keeps dotfiles, or .github/** and .claude/** silently vanish from Cmd+P", () => {
    assert.match(
      workerSource,
      /'--hidden'/,
      'ripgrep skips dotfiles by default; without --hidden real project files disappear'
    )
    assert.match(
      workerSource,
      /'--glob',\s*'!\.git\/'/,
      '--hidden lets .git internals back in; they must be re-excluded'
    )
  })

  it('parses NUL-delimited output so paths containing newlines survive', () => {
    assert.match(workerSource, /'--null'/)
    assert.match(workerSource, /stdout\.split\('\\0'\)/)
  })

  it('treats ripgrep exit code 1 as an empty project, not a failure', () => {
    assert.match(
      workerSource,
      /exitCode !== 1/,
      'rg exits 1 when nothing matched; that is a legitimately empty project'
    )
  })

  it('falls back to a filesystem walk that still applies the coarse ignore list', () => {
    assert.match(
      workerSource,
      /import\s*\{[^}]*isIgnoredRel[^}]*\}\s*from\s*'\.\/project-tree-watch-ignore'/,
      'the fallback must consult the SAME ignore module the watcher uses'
    )
    assert.match(
      workerSource,
      /if \(isIndexPathIgnored\(entry\.path\)\) continue/,
      'the walk fallback must skip ignored paths'
    )
  })

  it('reports which strategy produced the index so a trace can prove it', () => {
    assert.match(
      workerSource,
      /strategy: viaRipgrep \? 'ripgrep' : 'walk-fallback'/,
      "a trace showing 'walk-fallback' is how we learn .gitignore was NOT applied"
    )
  })

  it('classifies the noise directories that dominated the index', () => {
    for (const noisy of [
      '.git/index.lock',
      '.git/objects/ab/cdef',
      'node_modules/react/index.js',
      'node_modules/.cache/x.js',
      '.next/build/x.js',
      '.turbo/x',
      '.parcel-cache/x',
      'src/.DS_Store'
    ]) {
      assert.equal(isIgnoredRel(noisy), true, `${noisy} must stay out of the index`)
    }
  })

  it('does not over-match real project files', () => {
    for (const real of [
      'src/index.ts',
      'src/components/node_modules_helper.ts',
      'docs/.gitkeep-notes.md',
      'packages/app/.nextconfig.ts'
    ]) {
      assert.equal(isIgnoredRel(real), false, `${real} must remain searchable`)
    }
  })
})

describe('FIC-U-2 the single shared patch implementation', () => {
  // These used to test the renderer mirror's own copy of this logic. The mirror
  // no longer HAS a copy — the rules live here once, and both the worker index
  // and any future consumer import them. One implementation, one test target.

  it('reports no change when a watcher event re-adds an already-indexed file', () => {
    // Exactly the shape a plain Cmd+S produces: the watcher emits `update`, the
    // manager stats it as a file, and it lands in `added`.
    const outcome = applyFileIndexPatch(['src/foo.ts', 'src/bar.ts'], { added: ['src/foo.ts'] })
    assert.equal(outcome.changed, false, 'a save of a known file must not read as a set change')
    assert.deepEqual(outcome.files.sort(), ['src/bar.ts', 'src/foo.ts'])
  })

  it('reports a change for a genuine addition', () => {
    const outcome = applyFileIndexPatch(['src/foo.ts'], { added: ['src/new.ts'] })
    assert.equal(outcome.changed, true)
    assert.deepEqual(outcome.files.sort(), ['src/foo.ts', 'src/new.ts'])
  })

  it('cascades directory prefixes on removal', () => {
    const outcome = applyFileIndexPatch(
      ['src/a/one.ts', 'src/a/two.ts', 'src/b/three.ts'],
      { removed: ['src/a'] }
    )
    assert.equal(outcome.changed, true)
    assert.deepEqual(outcome.files, ['src/b/three.ts'])
  })

  it('cascades directory prefixes on rename', () => {
    const outcome = applyFileIndexPatch(
      ['src/a/one.ts', 'src/a/two.ts', 'src/b/three.ts'],
      { renamed: [{ from: 'src/a', to: 'src/z' }] }
    )
    assert.equal(outcome.changed, true)
    assert.deepEqual(outcome.files.sort(), ['src/b/three.ts', 'src/z/one.ts', 'src/z/two.ts'])
  })

  it('reports no change when a removal targets a path that was never indexed', () => {
    const outcome = applyFileIndexPatch(['src/foo.ts'], { removed: ['src/never-existed.ts'] })
    assert.equal(outcome.changed, false)
  })

  it('reports no change for an empty diff', () => {
    assert.equal(applyFileIndexPatch(['src/foo.ts'], {}).changed, false)
    assert.equal(applyFileIndexPatch(['src/foo.ts'], { added: [], removed: [] }).changed, false)
  })

  it('gates additions through the ignore predicate', () => {
    const outcome = applyFileIndexPatch(
      ['src/foo.ts'],
      { added: ['node_modules/react/index.js', 'src/ok.ts'] },
      isIgnoredRel
    )
    assert.deepEqual(outcome.files.sort(), ['src/foo.ts', 'src/ok.ts'])
  })

  it('settles a delete-then-recreate batch as present', () => {
    // Additions are applied last on purpose: a coalesced delete+create batch
    // must end up matching what the filesystem actually looks like.
    const outcome = applyFileIndexPatch(
      ['src/foo.ts'],
      { removed: ['src/foo.ts'], added: ['src/foo.ts'] }
    )
    assert.deepEqual(outcome.files, ['src/foo.ts'])
  })

  it('normalises Windows separators so membership checks do not miss', () => {
    assert.equal(normalizeIndexRel('src\\components\\App.tsx'), 'src/components/App.tsx')
    assert.equal(normalizeIndexRel('./src/foo.ts'), 'src/foo.ts')
    assert.equal(normalizeIndexRel('/src/foo.ts'), 'src/foo.ts')
    assert.equal(normalizeIndexRel('src/dir/'), 'src/dir')
    assert.equal(normalizeIndexRel(''), null)
    assert.equal(normalizeIndexRel(42), null)

    // A Windows-shaped duplicate of an indexed file must not double-insert.
    const outcome = applyFileIndexPatch(['src/foo.ts'], { added: ['src\\foo.ts'] })
    assert.equal(outcome.changed, false)
    assert.deepEqual(outcome.files, ['src/foo.ts'])
  })

  it('does not mutate the caller\'s input array', () => {
    const original = ['src/foo.ts']
    applyFileIndexPatch(original, { added: ['src/new.ts'], removed: ['src/foo.ts'] })
    assert.deepEqual(original, ['src/foo.ts'], 'input must be treated as readonly')
  })
})

describe('FIC-U-2b the renderer mirror holds metadata only', () => {
  const cwd = '/tmp/onward-fic-unit-mirror'

  it('stores a count, never a path list, and takes that count from the authority', async () => {
    invalidate(cwd)
    await ensureIndex(cwd, async () => ['a.ts', 'b.ts', 'c.ts'])

    const snapshot = getIndexSnapshot(cwd)
    assert.equal(snapshot.status, 'ready')
    assert.equal(snapshot.fileCount, 3)
    assert.ok(
      !('files' in (snapshot as Record<string, unknown>)),
      'the mirror must not expose a path list; the worker index is the authority'
    )
    assert.equal(isIndexReady(cwd), true)

    // The authority reports the post-patch count; the mirror records it verbatim
    // rather than recomputing one from a local copy that could disagree.
    recordAuthoritativeCount(cwd, 7)
    assert.equal(getIndexSnapshot(cwd).fileCount, 7)

    dispose(cwd)
    assert.equal(isIndexReady(cwd), false)
  })

  it('ignores an authoritative count for a root that is not ready', () => {
    invalidate(cwd)
    recordAuthoritativeCount(cwd, 99)
    assert.equal(getIndexSnapshot(cwd).fileCount, 0)
    dispose(cwd)
  })
})

describe('FIC-U-3 the bootstrap gates on changed, never on array length', () => {
  const bootstrapSource = readFileSync(
    path.join(repoRoot, 'src/components/ProjectEditor/GlobalSearch/fileIndexCacheBootstrap.ts'),
    'utf8'
  )

  it('no longer invalidates the worker index on any non-empty event', () => {
    assert.ok(
      !/added\.length\s*>\s*0\s*\|\|\s*removed\.length\s*>\s*0[\s\S]{0,120}invalidateFileIndex/.test(
        bootstrapSource
      ),
      'the length-based invalidation is back; an ordinary save will re-walk the whole project again'
    )
  })

  it('sends an incremental patch for known diffs', () => {
    assert.match(
      bootstrapSource,
      /patchFileIndex\?\.\(event\.cwd,\s*\{\s*added,\s*removed\s*\}\)/,
      'known diffs must be patched into the authoritative index, not thrown away'
    )
  })

  it('mirrors the authority\'s file count instead of recomputing one', () => {
    assert.match(
      bootstrapSource,
      /recordAuthoritativeCount\(event\.cwd,\s*result\.fileCount\)/,
      'the renderer must record what the worker reports, not derive its own count'
    )
    assert.ok(
      !/applyFsEvent/.test(bootstrapSource),
      'the renderer-side patch implementation is back; that is the drift source R3 removed'
    )
  })

  it('still invalidates on resync, where the diff is genuinely unknown', () => {
    const resyncBlock = bootstrapSource.slice(
      bootstrapSource.indexOf('if (resync)'),
      bootstrapSource.indexOf('if (added.length === 0')
    )
    assert.match(resyncBlock, /invalidateFileIndex/, 'resync must still force a rebuild')
  })
})

describe('FIC-U-4 untrusted paging inputs are clamped at the IPC boundary', () => {
  it('falls back to the default page size for junk', () => {
    for (const junk of [undefined, null, NaN, 0, -5, 'abc', {}]) {
      assert.equal(clampSearchPageSize(junk), FILE_INDEX_SEARCH_PAGE_SIZE, `junk: ${String(junk)}`)
    }
  })

  it('caps an oversized page so one request cannot serialise the whole index', () => {
    assert.equal(clampSearchPageSize(1_000_000), FILE_INDEX_SEARCH_MAX_PAGE_SIZE)
    assert.equal(clampSearchPageSize(FILE_INDEX_SEARCH_MAX_PAGE_SIZE), FILE_INDEX_SEARCH_MAX_PAGE_SIZE)
  })

  it('passes through a sane page size, flooring fractions', () => {
    assert.equal(clampSearchPageSize(120), 120)
    assert.equal(clampSearchPageSize(120.9), 120)
  })

  it('clamps offset to a non-negative integer', () => {
    assert.equal(clampSearchOffset(undefined), 0)
    assert.equal(clampSearchOffset(-10), 0)
    assert.equal(clampSearchOffset(NaN), 0)
    assert.equal(clampSearchOffset(50), 50)
    assert.equal(clampSearchOffset(50.7), 50)
  })
})

describe('FIC-U-5 both caches share one capacity constant', () => {
  it('the renderer mirror derives MAX_ENTRIES from the shared constant', () => {
    const mirrorSource = readFileSync(
      path.join(repoRoot, 'src/components/ProjectEditor/GlobalSearch/fileIndexCache.ts'),
      'utf8'
    )
    assert.match(mirrorSource, /const MAX_ENTRIES = FILE_INDEX_MAX_CACHED_PROJECTS/)
  })

  it('the authoritative worker store is bounded by the same constant', () => {
    const workerSource = readFileSync(
      path.join(repoRoot, 'electron/main/project-fs-worker-entry.ts'),
      'utf8'
    )
    assert.match(
      workerSource,
      /fileIndexCache\.size > FILE_INDEX_MAX_CACHED_PROJECTS/,
      'the worker index must evict; it previously grew without bound across projects'
    )
    assert.ok(
      FILE_INDEX_MAX_CACHED_PROJECTS > 0 && Number.isInteger(FILE_INDEX_MAX_CACHED_PROJECTS),
      'capacity must be a positive integer'
    )
  })
})
