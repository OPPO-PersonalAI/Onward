#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0

// Builds the PDF/EPUB Git Diff + Git History fixture: a throwaway git repo with
// ONE base commit carrying `book.pdf` + `book.epub`, then the working tree is
// overwritten with the "alt" variants of each so the repo opens in the exact
// state the suite's first assertion expects — two UNSTAGED, MODIFIED binary
// files (book.pdf, book.epub) on top of a single base commit.
//
//   commit 1 "base PDF/EPUB"  -> onward-autotest.pdf      + onward-autotest.epub
//   working tree (uncommitted) -> onward-autotest.alt.pdf  + onward-autotest.alt.epub
//
// WHY a Node builder instead of writing the repo from the autotest's PTY:
// the previous version fired a multi-step PowerShell/bash mega-command into the
// live terminal via terminal.write() (`git init` + 2×config + 2×copy + add +
// commit + 2×copy). On an EDR-throttled Windows host each git spawn pays a 1-3 s
// process-creation tax, and the shell could be sitting at a cold-start prompt
// (round-5 log line 662: a `watchman` startup command failed with "'watchman'
// is not recognized as an internal or external command", garbling the
// terminal). The fixture `.git` was therefore
// NEVER created inside the renderer's wait window: round-5 log line 851 shows
// `repo-ready:setup:timeout { attempts: 109, isGitRepo: false, files: [] }` —
// `waitForRepoReady` polled `git.getDiff` 109 times over 60 s and the inner repo
// did not exist a single time. Building the repo here — deterministically, with
// execFileSync, no PTY, no shell init — removes that entire failure class. This
// is a test-harness robustness fix: the product's `getDiff` is fine; the PTY
// fixture build is not robust under EDR.
//
// Cross-platform: `core.autocrlf=false` + `core.safecrlf=false` are pinned in
// the repo's LOCAL config right after `git init` (CLAUDE.md autotest
// cross-platform hard rule). The PDF/EPUB blobs are binary, but pinning keeps
// the build identical on every platform regardless of the contributor's global
// autocrlf. Reusable fixture sources live under test/autotest/fixtures/pdf-epub/
// (committed); they are copied (not base64-inlined) so the flow mirrors a real
// user editing a binary file in a repo.

import { execFileSync } from 'child_process'
import { mkdirSync, copyFileSync, writeFileSync, rmSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtureSrcDir = resolve(__dirname, 'fixtures', 'pdf-epub')
const annotationFixtureDir = resolve(__dirname, 'fixtures', 'pdf-annotation-diff')
const fixtureRoot = resolve(__dirname, 'fixtures', 'pdf-epub', 'runtime')

// Allow the runner to override the runtime root (e.g. a per-run mktemp dir) so
// concurrent runs / fresh user-data isolation never collide on disk.
const repoRoot = process.argv[2] ? resolve(process.argv[2]) : join(fixtureRoot, 'pdf-epub-repo')

// Committed fixture source files (real binaries, copied — never base64-inlined).
const PDF_BASE_FIXTURE = 'onward-autotest.pdf'
const PDF_ALT_FIXTURE = 'onward-autotest.alt.pdf'
const EPUB_BASE_FIXTURE = 'onward-autotest.epub'
const EPUB_ALT_FIXTURE = 'onward-autotest.alt.epub'

// In-repo committed names the suite asserts against (exact, top-level).
const PDF_NAME = 'book.pdf'
const EPUB_NAME = 'book.epub'
// Annotated pair (fixtures/pdf-annotation-diff): same three pages of text,
// versions differ in CYY_MARK annotations only — powers the annotation-diff
// panel assertions.
const ANNOTATED_BASE_FIXTURE = 'annotated-base.pdf'
const ANNOTATED_MODIFIED_FIXTURE = 'annotated-modified.pdf'
const ANNOTATED_PDF_NAME = 'annotated.pdf'

function git(cwd, args) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
}

function commit(repo, message) {
  git(repo, [
    '-c', 'user.name=Onward AutoTest',
    '-c', 'user.email=autotest@example.com',
    'commit', '-m', message
  ])
}

function copyFixture(name, destName) {
  copyFileSync(join(fixtureSrcDir, name), join(repoRoot, destName))
}

// Wipe-and-recreate so a half-baked previous run can't leak state.
mkdirSync(dirname(repoRoot), { recursive: true })
rmSync(repoRoot, { recursive: true, force: true })
mkdirSync(repoRoot, { recursive: true })

git(repoRoot, ['init', '-b', 'main'])
// Pin line-ending behavior so the fixture is byte-stable across platforms.
git(repoRoot, ['config', 'core.autocrlf', 'false'])
git(repoRoot, ['config', 'core.safecrlf', 'false'])

// Commit 1: base PDF/EPUB + the annotated base.
copyFixture(PDF_BASE_FIXTURE, PDF_NAME)
copyFixture(EPUB_BASE_FIXTURE, EPUB_NAME)
copyFileSync(join(annotationFixtureDir, ANNOTATED_BASE_FIXTURE), join(repoRoot, ANNOTATED_PDF_NAME))
git(repoRoot, ['add', PDF_NAME, EPUB_NAME, ANNOTATED_PDF_NAME])
commit(repoRoot, 'base PDF/EPUB')

// Working tree: overwrite with the alt variants -> three UNSTAGED, MODIFIED
// files. annotated.pdf differs from its committed base in annotations ONLY.
copyFixture(PDF_ALT_FIXTURE, PDF_NAME)
copyFixture(EPUB_ALT_FIXTURE, EPUB_NAME)
copyFileSync(join(annotationFixtureDir, ANNOTATED_MODIFIED_FIXTURE), join(repoRoot, ANNOTATED_PDF_NAME))

const manifest = {
  repoPath: repoRoot,
  pdfName: PDF_NAME,
  epubName: EPUB_NAME,
  annotatedPdfName: ANNOTATED_PDF_NAME,
  // Absolute path to the committed fixture source dir, so the TS can copy the
  // base PDF into the repo to create the later "added" (fresh.pdf) scenario
  // without re-deriving the path from rootPath.
  fixtureSrcDir
}

// Write the manifest OUTSIDE the repo working tree (in its parent dir) so it
// never shows up as an untracked file in `git.getDiff` and pollutes the suite's
// exact-filename assertions (the "added" scenario asserts fresh.pdf is the only
// untracked file).
const manifestPath = join(dirname(repoRoot), 'pdf-epub-manifest.json')
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

process.stdout.write(JSON.stringify({ ...manifest, manifestPath }))
