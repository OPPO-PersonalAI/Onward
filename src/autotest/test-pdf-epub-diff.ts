/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Exercises Git Diff + Git History compare views for PDF and EPUB files.
 *
 * User-facing flow being validated:
 *   1. User edits a PDF / EPUB in a git repo.
 *   2. User opens Git Diff (terminal → subpage).
 *   3. User clicks the PDF file in the diff list. They see a side-by-side
 *      PDF viewer comparing the base and modified versions.
 *   4. User clicks the EPUB file. They see a chapter list with badges for
 *      unchanged / modified / added chapters. Clicking a modified chapter
 *      shows line-level additions / deletions highlighted in the panes.
 *   5. User commits the changes and opens Git History. The same compare
 *      views should render for the two selected commits.
 *
 * Each assertion in this suite corresponds to something the user would
 * actually perceive: the component being visible, a status badge having the
 * expected color/text, diff lines showing up, etc.
 */

import type { AutotestContext, TestResult } from './types'
import { buildChangeDirectoryCommand } from '../utils/terminal-command'

/**
 * Fixtures live on disk under `test/autotest/fixtures/pdf-epub/`. The throwaway
 * git repo is built DETERMINISTICALLY before the app launches by
 * `test/autotest/create-pdf-epub-diff-fixture.mjs` (Node, execFileSync, no PTY,
 * `core.autocrlf=false`) into a runner-owned temp dir; its manifest path is
 * handed in via `ONWARD_AUTOTEST_FIXTURE_EXTRA`.
 *
 * WHY: the previous version built the repo by writing a multi-step
 * PowerShell/bash mega-command into the live PTY (`git init` + config + copies +
 * commit). On an EDR-throttled Windows host each git spawn pays a 1-3 s
 * process-creation tax and the shell could be at a cold-start prompt, so the
 * fixture `.git` was never created inside the renderer's wait window — round-5
 * log line 851: `repo-ready:setup:timeout { attempts: 109, isGitRepo: false,
 * files: [] }`. Building the repo in Node removes that entire failure class.
 * This is a test-harness robustness fix: the product's `getDiff` is fine; the
 * PTY fixture build was not robust under EDR.
 */

const PDF_NAME = 'book.pdf'
const EPUB_NAME = 'book.epub'
// Base PDF fixture copied into the repo at runtime to create the later "added"
// (fresh.pdf) single-pane scenario. Resolved against the manifest's absolute
// fixtureSrcDir so it never depends on rootPath.
const PDF_BASE_FIXTURE = 'onward-autotest.pdf'

interface PdfEpubFixtureManifest {
  repoPath: string
  pdfName: string
  epubName: string
  fixtureSrcDir: string
}

const dirOf = (p: string): string => p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '')
const baseOf = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p

async function loadManifest(extraPath: string | null): Promise<PdfEpubFixtureManifest | null> {
  if (!extraPath) return null
  const result = await window.electronAPI.project.readFile(dirOf(extraPath), baseOf(extraPath))
  if (!result.success || typeof result.content !== 'string') return null
  try {
    return JSON.parse(result.content) as PdfEpubFixtureManifest
  } catch {
    return null
  }
}

function windowsPath(p: string): string {
  return p.replace(/\//g, '\\')
}

function buildRepoCommitCommand(platform: string, repoPath: string, message: string): string {
  if (platform === 'win32') {
    const repo = windowsPath(repoPath)
    return `powershell -Command "git -C '${repo}' add -A; git -C '${repo}' commit -m '${message}' | Out-Null"`
  }
  return `git -C '${repoPath}' add -A && git -C '${repoPath}' commit -m '${message}' >/dev/null`
}

function buildCdCommand(platform: string, repoPath: string): string {
  // Delegate to the production helper so the win32 branch emits a PowerShell-correct
  // `Set-Location -LiteralPath '<path>'` (the app's default Windows shell rejects
  // `cd /d` and mishandles single quotes). The helper appends a trailing CR which
  // termExec also adds, so strip it here to avoid a doubled carriage return.
  return buildChangeDirectoryCommand(platform, repoPath).replace(/\r$/, '')
}

/**
 * Build the raw OSC 7 byte sequence that reports `repoPath` as the terminal's
 * current working directory. We inject this directly via the autotest
 * `injectPtyData` hook instead of relying on the shell's prompt to emit an
 * OSC 7 / OSC 9;9 cwd report after the `cd` command.
 *
 * Why: under EDR-instrumented Windows the shell's post-command cwd report is
 * racy or absent, so the renderer/main `getTerminalCwd(terminalId)` still
 * resolves to the PARENT repo (the main checkout), and Git Diff then opens
 * against the wrong repo (no `book.pdf` / `book.epub` in the file list). The
 * synthetic OSC 7 drives the terminal's tracked cwd deterministically: it flows
 * through the exact `xterm.write` -> OSC parser -> `installOscCwdAddon` ->
 * `electronAPI.git.pushCwd` path real PTY output uses, so main's
 * `terminalCwdAuthorityResolver` (and therefore `getTerminalCwd`) returns the
 * fixture repo before `gitdiff:view:start` reads it.
 *
 * Path format mirrors `parseOsc7Cwd` in `src/utils/terminal-cwd-osc.ts` and the
 * sequence used by `test-terminal-title-rename.ts` (`\x1b]7;file://...\x07`):
 *   - POSIX:   file://localhost/abs/path        -> parsed cwd `/abs/path`
 *   - Windows: file:///D:/Users/.../repo        -> parsed cwd `D:/Users/.../repo`
 * `repoPath` is already '/'-separated (manifest path is normalized), which is exactly what
 * the OSC 7 URI path component expects on all platforms.
 */
function buildOsc7CwdSequence(platform: string, repoPath: string): string {
  const posixPath = repoPath.replace(/\\/g, '/')
  // Windows drive-absolute paths (`D:/...`) carry no host and need a third
  // slash so the URI reads `file:///D:/...`; POSIX paths keep an explicit host.
  const uri = platform === 'win32'
    ? `file:///${posixPath}`
    : `file://localhost${posixPath.startsWith('/') ? '' : '/'}${posixPath}`
  return `\x1b]7;${uri}\x07`
}

function buildCleanupCommand(platform: string, repoPath: string): string {
  if (platform === 'win32') {
    return `powershell -Command "if (Test-Path '${windowsPath(repoPath)}') { Remove-Item -Recurse -Force '${windowsPath(repoPath)}' }"`
  }
  return `rm -rf '${repoPath}'`
}

export async function testPdfEpubDiff(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, terminalId, rootPath } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const platform = window.electronAPI.platform
  const getGitDiffApi = () => window.__onwardGitDiffDebug
  const getGitHistoryApi = () => window.__onwardGitHistoryDebug

  // The fixture repo is pre-built deterministically by
  // create-pdf-epub-diff-fixture.mjs (no PTY). Its '/'-normalized path comes
  // from the manifest handed in via ONWARD_AUTOTEST_FIXTURE_EXTRA.
  const manifest = await loadManifest(window.electronAPI.debug.autotestFixtureExtra)
  if (!manifest) {
    record('git-diff-repo-ready', false, {
      reason: 'fixture-manifest-missing',
      extraPath: window.electronAPI.debug.autotestFixtureExtra ?? null
    })
    log('pdf-epub-diff:done', {
      pass: results.filter(r => r.ok).length,
      fail: results.filter(r => !r.ok).length
    })
    return results
  }
  const repoPath = manifest.repoPath.replace(/\\/g, '/')
  const fixtureSrcDir = manifest.fixtureSrcDir

  const termExec = async (command: string, label: string, waitMs = 1200) => {
    await window.electronAPI.terminal.write(terminalId, `${command}\r`)
    await sleep(waitMs)
    log(`exec:${label}`)
  }

  // Deterministically pin the terminal's tracked cwd to the fixture repo. The
  // shell's own OSC cwd report after `cd` is racy/absent under EDR, so without
  // this Git Diff would open against the parent (main) repo. Injecting the OSC 7
  // sequence drives main's `terminalCwdAuthorityResolver` directly so
  // `getTerminalCwd(terminalId)` -> `gitdiff:view:start` sees the fixture repo.
  const pinTrackedCwd = async (targetPath: string, label: string) => {
    const debug = window.__onwardTerminalDebug
    const seq = buildOsc7CwdSequence(platform, targetPath)
    const injected = Boolean(debug?.injectPtyData?.(seq, terminalId))
    log(`osc7-pin:${label}`, { injected, targetPath })
    // pushCwd -> router -> getTerminalCwd is a fast IPC round-trip; a short
    // settle keeps it ahead of the subsequent git-diff:open read.
    await sleep(300)
    await window.electronAPI.git.notifyTerminalActivity(terminalId)
    await sleep(300)
  }

  // Deterministically wait until the fixture repo on disk is a real git repo
  // whose working tree already carries the expected changes, by polling the
  // PRODUCTION `git.getDiff(repoPath)` IPC directly (the same call GitDiffViewer
  // makes). This replaces the previous "fire the setup command, sleep a fixed
  // 3 s, then open the diff and hope" approach, which was the round-1..3 failure
  // mode under EDR: the fixture setup runs through a racy/slow PTY (powershell
  // cold start + `git init` + 2×config + 2×copy + add + commit + 2×copy, each
  // git spawn paying a 1-3 s EDR process-creation tax), so the `.git` repo and
  // the alt-file overwrites frequently did NOT exist yet when `git-diff:open`
  // fired — `getDiff` then returned `success:false / files:[]` and the diff's
  // own 12 s retry window expired before setup finished, leaving fileList empty.
  // Polling getDiff bypasses the PTY race entirely: we only proceed once git
  // itself reports the repo + the expected files. Ceiling is generous (EDR
  // process tax is multiplicative) and the loop is adaptive — it returns the
  // instant the predicate passes, so a fast (non-EDR) machine pays ~nothing.
  const waitForRepoReady = async (
    label: string,
    predicate: (files: Array<{ filename: string; status?: string }>) => boolean,
    timeoutMs = 60000,
    intervalMs = 500
  ): Promise<boolean> => {
    const deadline = performance.now() + timeoutMs
    let lastFiles: string[] = []
    let lastIsGitRepo = false
    let lastSuccess = false
    let attempts = 0
    while (performance.now() < deadline) {
      if (cancelled()) return false
      attempts += 1
      try {
        // force:true so we never read a stale cached "not-a-repo" snapshot taken
        // before the PTY setup finished writing `.git`.
        const result = await window.electronAPI.git.getDiff(repoPath, { force: true })
        lastIsGitRepo = Boolean(result?.isGitRepo)
        lastSuccess = Boolean(result?.success)
        const files = (result?.files ?? []).map(f => ({ filename: f.filename, status: f.status }))
        lastFiles = files.map(f => f.filename)
        if (result?.success && result?.isGitRepo && predicate(files)) {
          log(`repo-ready:${label}`, { attempts, fileCount: files.length, files: lastFiles })
          return true
        }
      } catch (error) {
        log(`repo-ready:${label}:error`, { attempts, error: String(error) })
      }
      await sleep(intervalMs)
    }
    log(`repo-ready:${label}:timeout`, {
      attempts,
      isGitRepo: lastIsGitRepo,
      success: lastSuccess,
      files: lastFiles
    })
    return false
  }

  // ---------- Setup: temp repo with a base commit + unstaged modifications ----------

  log('pdf-epub-diff:start', { repoPath })
  // The repo already exists on disk (the Node builder ran before the app
  // launched) with both files modified in the working tree. We only need to wait
  // for the product's own `getDiff` to observe it: `getGitRepoMeta` caches a
  // NEGATIVE "not a repo" result with a short TTL, so a first probe issued before
  // that TTL window can still miss. Poll getDiff (force:true to skip the stale
  // negative snapshot) until git reports the inner repo + both modified files.
  // NOTE the EXACT (not endsWith) filename match: `repoPath` is a temp dir, but
  // getDiff could in theory resolve UP to a parent repo before the inner `.git`
  // is recognised; requiring the top-level `book.pdf` / `book.epub` guarantees we
  // only pass once getDiff has resolved to the fixture repo itself.
  const repoReady = await waitForRepoReady(
    'setup',
    (files) =>
      files.some(f => f.filename === PDF_NAME) &&
      files.some(f => f.filename === EPUB_NAME)
  )
  record('git-diff-repo-ready', repoReady, { repoPath })
  if (!repoReady) {
    log('pdf-epub-diff:done', {
      pass: results.filter(r => r.ok).length,
      fail: results.filter(r => !r.ok).length
    })
    return results
  }

  // Switch the terminal into the repo so Git Diff / Git History see it. The
  // `cd` is kept for realism, but the tracked cwd is pinned deterministically
  // via the injected OSC 7 below rather than the shell's racy post-cd report.
  await termExec(buildCdCommand(platform, repoPath), 'cd-repo', 1200)
  await pinTrackedCwd(repoPath, 'cd-repo')
  await sleep(300)

  // ---------- Git Diff: click the PDF ----------

  // Pass the fixture repo as an explicit `cwd` in the open event. This is the
  // deterministic gate: `handleViewGitDiff` honours `detail.cwd` verbatim and
  // bypasses terminalInfo / persisted / OSC cwd resolution, which under EDR all
  // still pointed at the PARENT (main) repo even after the `cd` + OSC 7 pin
  // (the renderer's `terminalInfos[id].cwd` only updates from a git-recognised
  // cwd, and the real shell keeps re-reporting the main repo). Without this the
  // diff opened against the main checkout where book.pdf / book.epub don't exist.
  window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId, cwd: repoPath, source: 'debug' } }))
  const diffOpened = await waitFor(
    'git-diff-open',
    () => Boolean(getGitDiffApi()?.isOpen?.()),
    10000
  )
  record('git-diff-opened', diffOpened)
  if (!diffOpened || cancelled()) return results

  const filesLoaded = await waitFor(
    'git-diff-files-loaded',
    () => {
      const list = getGitDiffApi()?.getFileList?.() || []
      return list.some(f => f.filename.endsWith(PDF_NAME)) &&
        list.some(f => f.filename.endsWith(EPUB_NAME))
    },
    12000
  )
  record('git-diff-files-loaded', filesLoaded, {
    fileList: getGitDiffApi()?.getFileList?.().map(f => f.filename) ?? []
  })
  if (!filesLoaded) return results

  const fileList = getGitDiffApi()?.getFileList?.() ?? []
  const pdfIndex = fileList.findIndex(f => f.filename.endsWith(PDF_NAME))
  const epubIndex = fileList.findIndex(f => f.filename.endsWith(EPUB_NAME))

  // Click the PDF: user action.
  getGitDiffApi()?.selectFileByIndex(pdfIndex)
  const pdfCompareVisible = await waitFor(
    'git-diff-pdf-compare',
    () => Boolean(getGitDiffApi()?.getPdfCompareState?.()?.visible),
    12000
  )
  record('git-diff-pdf-compare-visible', pdfCompareVisible, {
    state: getGitDiffApi()?.getPdfCompareState?.() ?? null
  })
  const pdfState = getGitDiffApi()?.getPdfCompareState?.() ?? null
  record('git-diff-pdf-status-modified', pdfState?.status === 'modified', { state: pdfState })
  record('git-diff-pdf-both-sides-populated',
    Boolean(pdfState?.originalSrc && pdfState?.modifiedSrc && !pdfState?.originalHasEmpty && !pdfState?.modifiedHasEmpty),
    { state: pdfState }
  )
  record('git-diff-pdf-sides-differ',
    Boolean(pdfState?.originalSrc && pdfState?.modifiedSrc && pdfState.originalSrc !== pdfState.modifiedSrc),
    { original: pdfState?.originalSrc?.slice(0, 80), modified: pdfState?.modifiedSrc?.slice(0, 80) }
  )
  // 'modified' status must always render two panes side-by-side (the
  // single-pane collapse only applies to 'added' / 'deleted').
  record('git-diff-pdf-modified-two-panes',
    pdfState?.paneCount === 2 && pdfState?.isSinglePane === false,
    { state: pdfState }
  )

  // ---------- Git Diff: click the EPUB ----------

  getGitDiffApi()?.selectFileByIndex(epubIndex)
  const epubCompareVisible = await waitFor(
    'git-diff-epub-compare',
    () => Boolean(getGitDiffApi()?.getEpubCompareState?.()?.visible),
    20000
  )
  record('git-diff-epub-compare-visible', epubCompareVisible, {
    state: getGitDiffApi()?.getEpubCompareState?.() ?? null
  })

  const epubState = await (async () => {
    // The chapter list is populated after epubjs finishes opening both books.
    await waitFor(
      'git-diff-epub-chapters-listed',
      () => (getGitDiffApi()?.getEpubCompareState?.()?.chapterCount ?? 0) >= 2,
      20000,
      200
    )
    return getGitDiffApi()?.getEpubCompareState?.() ?? null
  })()
  record('git-diff-epub-chapters-populated', (epubState?.chapterCount ?? 0) >= 2, { state: epubState })
  record('git-diff-epub-status-modified', epubState?.status === 'modified', { state: epubState })
  record('git-diff-epub-has-modified-chapter',
    (epubState?.chapterBadges ?? []).some(c => c.kind === 'modified'),
    { badges: epubState?.chapterBadges }
  )
  record('git-diff-epub-has-unchanged-chapter',
    (epubState?.chapterBadges ?? []).some(c => c.kind === 'unchanged'),
    { badges: epubState?.chapterBadges }
  )

  // Click the modified chapter: user action. Verify diff lines highlight.
  const modifiedChapter = (epubState?.chapterBadges ?? []).find(c => c.kind === 'modified')
  if (modifiedChapter) {
    const btn = Array.from(
      document.querySelectorAll('.git-epub-compare-chapter-item')
    ).find(el => (el as HTMLElement).dataset?.href === modifiedChapter.href) as HTMLElement | undefined
    btn?.click()
    await sleep(400)
    const afterClick = getGitDiffApi()?.getEpubCompareState?.() ?? null
    record('git-diff-epub-modified-chapter-selected',
      afterClick?.selectedHref === modifiedChapter.href,
      { afterClick }
    )
    record('git-diff-epub-modified-chapter-has-add-lines',
      (afterClick?.diffCounts?.add ?? 0) > 0,
      { diffCounts: afterClick?.diffCounts }
    )
  } else {
    record('git-diff-epub-modified-chapter-selected', false, { reason: 'no-modified-chapter' })
  }

  // Close Git Diff with ESC (user action) so the next step starts clean.
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await waitFor('git-diff-close', () => !getGitDiffApi()?.isOpen?.(), 5000)

  if (cancelled()) return results

  // ---------- Git History: commit the modification + open history ----------

  await termExec(buildRepoCommitCommand(platform, repoPath, 'updated PDF/EPUB'), 'commit-alt', 2500)
  // Gate on the commit actually landing: `git add -A && git commit` clears the
  // working tree, so once getDiff reports a clean tree the second commit exists.
  // Under EDR the commit PTY command can outlast the fixed 2.5 s wait, so this
  // deterministic poll keeps Git History from opening against a one-commit repo.
  await waitForRepoReady('commit-alt', (files) => files.length === 0, 30000)
  await window.electronAPI.git.notifyTerminalActivity(terminalId)
  await sleep(500)

  window.dispatchEvent(new CustomEvent('git-history:open', { detail: { terminalId } }))
  const historyOpened = await waitFor(
    'git-history-open',
    () => Boolean(getGitHistoryApi()?.isOpen?.()),
    10000
  )
  record('git-history-opened', historyOpened)
  if (!historyOpened || cancelled()) return results

  getGitHistoryApi()?.switchRepo?.(repoPath)
  const repoSwitched = await waitFor(
    'git-history-switch-repo',
    () => {
      const active = getGitHistoryApi()?.getActiveCwd?.() ?? ''
      return active.replace(/\\/g, '/') === repoPath.replace(/\\/g, '/')
    },
    10000
  )
  record('git-history-repo-switched', repoSwitched, {
    activeCwd: getGitHistoryApi()?.getActiveCwd?.() ?? null
  })

  const commitsReady = await waitFor(
    'git-history-commits-ready',
    () => (getGitHistoryApi()?.getCommitCount?.() ?? 0) >= 2,
    10000
  )
  record('git-history-commits-ready', commitsReady, {
    commits: getGitHistoryApi()?.getCommitCount?.()
  })
  if (!commitsReady) return results

  // Select the latest commit (index 0): user action (click first row).
  getGitHistoryApi()?.selectCommitByIndex(0)
  const historyFilesLoaded = await waitFor(
    'git-history-files-loaded',
    () => {
      const files = getGitHistoryApi()?.getFiles?.() ?? []
      return files.some(f => f.filename.endsWith(PDF_NAME)) && files.some(f => f.filename.endsWith(EPUB_NAME))
    },
    10000
  )
  record('git-history-files-loaded', historyFilesLoaded)

  // Select PDF in history viewer.
  const historyFiles = getGitHistoryApi()?.getFiles?.() ?? []
  const hPdfIdx = historyFiles.findIndex(f => f.filename.endsWith(PDF_NAME))
  const hEpubIdx = historyFiles.findIndex(f => f.filename.endsWith(EPUB_NAME))
  getGitHistoryApi()?.selectFileByIndex?.(hPdfIdx)
  // First wait for the compare component to mount, THEN wait for its iframes
  // to get their src attribute (depends on pdfViewerUrl being resolved via IPC).
  const historyPdfVisible = await waitFor(
    'git-history-pdf-compare',
    () => Boolean(getGitHistoryApi()?.getPdfCompareState?.()?.visible),
    20000,
    200
  )
  record('git-history-pdf-compare-visible', historyPdfVisible, {
    state: getGitHistoryApi()?.getPdfCompareState?.() ?? null,
    selectedFileName: getGitHistoryApi()?.getSelectedFile?.()?.filename ?? null
  })
  await waitFor(
    'git-history-pdf-iframes-src',
    () => {
      const s = getGitHistoryApi()?.getPdfCompareState?.()
      return Boolean(s?.originalSrc && s?.modifiedSrc)
    },
    10000,
    200
  )
  const historyPdfState = getGitHistoryApi()?.getPdfCompareState?.() ?? null
  record('git-history-pdf-status-modified', historyPdfState?.status === 'modified', { state: historyPdfState })
  record('git-history-pdf-both-sides-populated',
    Boolean(historyPdfState?.originalSrc && historyPdfState?.modifiedSrc && !historyPdfState?.originalHasEmpty && !historyPdfState?.modifiedHasEmpty),
    { state: historyPdfState }
  )
  record('git-history-pdf-modified-two-panes',
    historyPdfState?.paneCount === 2 && historyPdfState?.isSinglePane === false,
    { state: historyPdfState }
  )

  // Select EPUB in history viewer.
  getGitHistoryApi()?.selectFileByIndex?.(hEpubIdx)
  const historyEpubVisible = await waitFor(
    'git-history-epub-compare',
    () => Boolean(getGitHistoryApi()?.getEpubCompareState?.()?.visible),
    20000
  )
  record('git-history-epub-compare-visible', historyEpubVisible)
  await waitFor(
    'git-history-epub-chapters',
    () => (getGitHistoryApi()?.getEpubCompareState?.()?.chapterCount ?? 0) >= 2,
    20000,
    200
  )
  const historyEpubState = getGitHistoryApi()?.getEpubCompareState?.() ?? null
  record('git-history-epub-chapters-populated', (historyEpubState?.chapterCount ?? 0) >= 2, { state: historyEpubState })
  record('git-history-epub-has-modified-chapter',
    (historyEpubState?.chapterBadges ?? []).some(c => c.kind === 'modified'),
    { badges: historyEpubState?.chapterBadges }
  )

  // Close Git History.
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await waitFor('git-history-close', () => !getGitHistoryApi()?.isOpen?.(), 5000)

  // ---------- PDF compare single-pane for added / deleted ----------
  // Mutate the working tree to create one 'added' (untracked new PDF) and
  // one 'deleted' (removed tracked PDF) scenario, then open Git Diff and
  // verify each renders as a SINGLE pane (not two half-width panes with
  // one empty side).

  const FRESH_PDF = 'fresh.pdf'
  const fixturesDir = fixtureSrcDir.replace(/\\/g, '/')
  const addPdfCmd = platform === 'win32'
    ? `powershell -Command "Copy-Item -LiteralPath '${windowsPath(fixturesDir)}\\${PDF_BASE_FIXTURE}' -Destination (Join-Path '${windowsPath(repoPath)}' '${FRESH_PDF}') -Force"`
    : `cp "${fixturesDir}/${PDF_BASE_FIXTURE}" '${repoPath}/${FRESH_PDF}'`
  await termExec(addPdfCmd, 'fresh-pdf:create', 1500)

  const delPdfCmd = platform === 'win32'
    ? `powershell -Command "Remove-Item -LiteralPath '${windowsPath(repoPath)}\\${PDF_NAME}' -Force"`
    : `rm -f '${repoPath}/${PDF_NAME}'`
  await termExec(delPdfCmd, 'pdf:delete', 1500)

  // Gate on git itself observing the added/deleted mutations before reopening
  // the diff. The create/delete PTY commands can outlast their fixed waits under
  // EDR; polling getDiff makes the single-pane reopen deterministic.
  await waitForRepoReady(
    'single-pane-mutate',
    (files) =>
      files.some(f => f.filename === FRESH_PDF) &&
      files.some(f => f.filename === PDF_NAME && f.status === 'D'),
    30000
  )

  // Same operation class as the first Git Diff open: this reopen also reads the
  // tracked cwd via `getTerminalCwd`. Re-pin the fixture repo deterministically
  // so the single-pane reopen never falls back to the parent repo under EDR.
  await pinTrackedCwd(repoPath, 'single-pane-reopen')
  await sleep(500)

  window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId, cwd: repoPath, source: 'debug' } }))
  await waitFor('git-diff-reopen-single-pane', () => Boolean(getGitDiffApi()?.isOpen?.()), 8000)
  // The diff panel was already open against the same cwd, so re-dispatching the
  // open event does not change `gitDiffCwd` and therefore won't auto-reload to
  // pick up the just-created fresh.pdf / deleted book.pdf. Force a refresh so
  // the file list reflects the on-disk changes deterministically.
  await getGitDiffApi()?.refreshChanges?.()
  const singlePaneFilesLoaded = await waitFor(
    'git-diff-single-pane-files-loaded',
    () => {
      const list = getGitDiffApi()?.getFileList?.() || []
      return list.some(f => f.filename === FRESH_PDF) && list.some(f => f.filename === PDF_NAME && f.status === 'D')
    },
    10000
  )
  record('git-diff-single-pane-files-loaded', singlePaneFilesLoaded, {
    fileList: getGitDiffApi()?.getFileList?.().map(f => ({ name: f.filename, status: f.status })) ?? []
  })

  if (singlePaneFilesLoaded) {
    // Added scenario: select fresh.pdf
    const freshIdx = (getGitDiffApi()?.getFileList?.() ?? []).findIndex(f => f.filename === FRESH_PDF)
    getGitDiffApi()?.selectFileByIndex(freshIdx)
    await waitFor(
      'git-diff-pdf-added-visible',
      () => {
        const s = getGitDiffApi()?.getPdfCompareState?.()
        return Boolean(s?.visible) && s?.status === 'added'
      },
      10000,
      200
    )
    const addedState = getGitDiffApi()?.getPdfCompareState?.() ?? null
    record('git-diff-pdf-added-single-pane',
      addedState?.paneCount === 1
        && addedState?.isSinglePane === true
        && Boolean(addedState?.modifiedSrc)
        && !addedState?.originalSrc,
      { state: addedState }
    )

    // Deleted scenario: select book.pdf (now status='D')
    const delIdx = (getGitDiffApi()?.getFileList?.() ?? []).findIndex(f => f.filename === PDF_NAME && f.status === 'D')
    getGitDiffApi()?.selectFileByIndex(delIdx)
    await waitFor(
      'git-diff-pdf-deleted-visible',
      () => {
        const s = getGitDiffApi()?.getPdfCompareState?.()
        return Boolean(s?.visible) && s?.status === 'deleted'
      },
      10000,
      200
    )
    const deletedState = getGitDiffApi()?.getPdfCompareState?.() ?? null
    record('git-diff-pdf-deleted-single-pane',
      deletedState?.paneCount === 1
        && deletedState?.isSinglePane === true
        && Boolean(deletedState?.originalSrc)
        && !deletedState?.modifiedSrc,
      { state: deletedState }
    )
  } else {
    record('git-diff-pdf-added-single-pane', false, { reason: 'files-not-loaded' })
    record('git-diff-pdf-deleted-single-pane', false, { reason: 'files-not-loaded' })
  }

  // Close Git Diff before cleanup.
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await waitFor('git-diff-close-single-pane', () => !getGitDiffApi()?.isOpen?.(), 5000)

  // ---------- Cleanup ----------
  // Step out of the test repo before nuking it so subsequent suites inherit a
  // sane working directory.
  await termExec(buildCdCommand(platform, rootPath), 'cd-back', 800)
  await termExec(buildCleanupCommand(platform, repoPath), 'cleanup-repo', 1500)

  log('pdf-epub-diff:done', {
    pass: results.filter(r => r.ok).length,
    fail: results.filter(r => !r.ok).length
  })
  return results
}
