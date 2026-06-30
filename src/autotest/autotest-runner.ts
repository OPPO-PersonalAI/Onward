/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Automated test master orchestrator.
 *
 * Called from the Project Editor autotest effect. All suites run sequentially by phase.
 */
import type { AutotestContext, TestResult, TestSuiteResult } from './types'
import { testTerminalAutofollow } from './test-terminal-autofollow'
import { testTerminalTitleRename } from './test-terminal-title-rename'
import { testTaskLayout } from './test-task-layout'
import { testPromptSender } from './test-prompt-sender'
import { testPromptList } from './test-prompt-list'
import { testPromptEditorContextMenu } from './test-prompt-editor-context-menu'
import { testPromptIntegrity } from './test-prompt-integrity'
import { testPerAgentFont } from './test-per-agent-font'
import { testGitHistory } from './test-git-history'
import { testPromptCleanup } from './test-prompt-cleanup'
import { testSchedule } from './test-schedule'
import { testRegression } from './test-regression'
import { testStress } from './test-stress'
import { testProjectEditorRestore } from './test-project-editor-restore'
import { testProjectEditorRestoreUnit } from './test-project-editor-restore-unit'
import { testProjectEditorOpenPosition } from './test-project-editor-open-position'
import { testProjectEditorLargeFile } from './test-project-editor-large-file'
import { testSubpageNavigation } from './test-subpage-navigation'
import { testWorkingDirectoryCopy } from './test-working-directory-copy'
import { testGitDiffSubdir } from './test-git-diff-subdir'
import { testGitDiffSubmodules } from './test-git-diff-submodules'
import { testGitDiffRecursiveSubmodules } from './test-git-diff-recursive-submodules'
import { testGitDiffStalenessAndSubmodule } from './test-git-diff-staleness-and-submodule'
import { testGitDiffNestedGitlink } from './test-git-diff-nested-gitlink'
import { testGitDiffClickLatency } from './test-git-diff-click-latency'
import { testGitDiffIdenticalBlob } from './test-git-diff-identical-blob'
import { testGitLargeFileConfirmation } from './test-git-large-file-confirmation'
import { testGitStateMirrorLatency } from './test-git-state-mirror-latency'
import { testGitNestedSubmodules } from './test-git-nested-submodules'
import { testGitCrossPlatform } from './test-git-cross-platform'
import { testProjectEditorMultiTerminalScope } from './test-project-editor-multi-terminal-scope'
import { testMarkdownLatexPreview } from './test-markdown-latex-preview'
import { testMermaidPanZoom } from './test-mermaid-panzoom'
import { testProjectEditorSqlite } from './test-project-editor-sqlite'
import { testTerminalPerf } from './test-terminal-perf'
import { testTerminalArchitectureBaseline } from './test-terminal-architecture-baseline'
import { testPromptInputLatency, testPromptInputLongtail } from './test-prompt-input-latency'
import { testTerminalFocusActivation } from './test-terminal-focus-activation'
import { testTerminalStress } from './test-terminal-stress'
import { testRenderCorruptionStress } from './test-render-corruption-stress'
import { testImageDiff } from './test-image-diff'
import { testImageHistoryDiff } from './test-image-history-diff'
import { testPdfEpubPreview } from './test-pdf-epub-preview'
import { testPdfEpubDiff } from './test-pdf-epub-diff'
import { testProjectEditorMarkdownNavigation } from './test-project-editor-markdown-navigation'
import { testProjectEditorHtmlPreview } from './test-project-editor-html-preview'
import { testOpenBrowser } from './test-open-browser'
import { testGlobalSearch } from './test-global-search'
import { testFileIndexCacheUi } from './test-file-index-cache-ui'
import { testSettingsUpdate } from './test-settings-update'
import { testGitHistoryMultiTerminalScope } from './test-git-history-multi-terminal-scope'
import { testGitHistoryRefDecoration } from './test-git-history-ref-decoration'
import { testFileWatch } from './test-file-watch'
import { testPreviewPositionRestore } from './test-preview-position-restore'
import { testPreviewSearch } from './test-preview-search'
import { testTerminalStatePersistence } from './test-terminal-state-persistence'
import { testProjectEditorFileMemory } from './test-project-editor-file-memory'
import { testProjectEditorMarkdownSessionRestore } from './test-project-editor-markdown-session-restore'
import { testMarkdownPreviewLatency } from './test-markdown-preview-latency'
import { testChangeLog } from './test-change-log'
import { testFeedback } from './test-feedback'
import { testFeedbackUi } from './test-feedback-ui'
import { testFeedbackPersistenceSeed, testFeedbackPersistenceVerify } from './test-feedback-persistence'
import { testTerminalRenameRestartSurvivalSeed, testTerminalRenameRestartSurvivalVerify } from './test-terminal-rename-restart-survival'
import { testTelemetry } from './test-telemetry'
import { testPerformanceTrace } from './test-performance-trace'
import { testSubpageViewstateRestore } from './test-subpage-viewstate-restore'
import { testQuickFileUnit } from './test-quick-file-unit'
import { testSidebarAutoscroll } from './test-sidebar-autoscroll'
import { buildChangeDirectoryCommand, type TerminalShellKind } from '../utils/terminal-command'

function normalizeRuntimeMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message || value.name || String(value)
  }
  if (typeof value === 'string') {
    return value
  }
  if (value && typeof value === 'object') {
    const name = 'name' in value ? String((value as { name?: unknown }).name ?? '') : ''
    const message = 'message' in value ? String((value as { message?: unknown }).message ?? '') : ''
    if (name && message) return `${name}: ${message}`
    if (message) return message
    if (name) return name
  }
  return String(value ?? 'unknown error')
}

function normalizeRuntimeStack(value: unknown): string | null {
  if (value instanceof Error && typeof value.stack === 'string') {
    return value.stack
  }
  if (value && typeof value === 'object' && 'stack' in value) {
    const stack = (value as { stack?: unknown }).stack
    return typeof stack === 'string' && stack.trim() ? stack : null
  }
  return null
}

function isIgnorableRuntimeIssue(type: 'error' | 'unhandledrejection', message: string): boolean {
  const normalized = message.trim().toLowerCase()
  if (type === 'error' && normalized.includes('resizeobserver loop completed with undelivered notifications')) {
    return true
  }
  if (type === 'unhandledrejection') {
    if (normalized === 'canceled') return true
    if (normalized === 'canceled: canceled') return true
    if (normalized === 'error: canceled') return true
  }
  return false
}

async function resolveTerminalShellKind(terminalId: string): Promise<TerminalShellKind | undefined> {
  try {
    return (await window.electronAPI.terminal.getInputCapabilities(terminalId)).shellKind
  } catch {
    return undefined
  }
}

export async function runAllTests(ctx: AutotestContext): Promise<void> {
  const { log, sleep } = ctx
  const suiteFilter = (window.electronAPI.debug.autotestSuite || '').trim().toLowerCase()
  const runSingleSuite = suiteFilter.length > 0 && suiteFilter !== 'all'
  // Accept comma-separated suite names (e.g. "pdf-epub-preview,pdf-epub-diff")
  // so a single autotest run can exercise multiple cooperating suites.
  const suiteAllowList = runSingleSuite
    ? new Set(
        suiteFilter
          .split(',')
          .map(s => s.trim().split(';')[0]?.trim() ?? '')
          .filter(Boolean)
      )
    : null
  const shouldRun = (suiteId: string) => !suiteAllowList || suiteAllowList.has(suiteId)
  const runtimeErrors: Array<{ type: 'error' | 'unhandledrejection'; message: string; stack: string | null }> = []
  const handleWindowError = (event: ErrorEvent) => {
    const issue = event.error ?? event.message
    const message = normalizeRuntimeMessage(issue)
    const stack = normalizeRuntimeStack(issue)
    if (isIgnorableRuntimeIssue('error', message)) {
      log('runtime-issue-ignored', { type: 'error', message, stack })
      return
    }
    log('runtime-issue-captured', { type: 'error', message, stack })
    runtimeErrors.push({ type: 'error', message, stack })
  }
  const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    const message = normalizeRuntimeMessage(event.reason)
    const stack = normalizeRuntimeStack(event.reason)
    if (isIgnorableRuntimeIssue('unhandledrejection', message)) {
      log('runtime-issue-ignored', { type: 'unhandledrejection', message, stack })
      return
    }
    log('runtime-issue-captured', { type: 'unhandledrejection', message, stack })
    runtimeErrors.push({ type: 'unhandledrejection', message, stack })
  }

  window.addEventListener('error', handleWindowError)
  window.addEventListener('unhandledrejection', handleUnhandledRejection)

  log('=== Autotest Start ===')
  log('autotest-config', {
    suiteFilter: runSingleSuite ? suiteFilter : 'all'
  })
  const startTime = performance.now()
  const allResults: TestSuiteResult[] = []
  const allTestResults: TestResult[] = []

  const collectSuiteResults = (suite: string, results: TestResult[]) => {
    const passed = results.filter(r => r.ok).length
    const failed = results.filter(r => !r.ok).length
    const skipped = 0
    allResults.push({ suite, results, passed, failed, skipped })
    allTestResults.push(...results)
    log(`suite-done:${suite}`, { passed, failed, total: results.length })
  }

  try {
    // Phase 0: Initialization
    log('phase0:init', { rootPath: ctx.rootPath, terminalId: ctx.terminalId })
    if (ctx.terminalId) {
      const platform = window.electronAPI.platform
      const shellKind = await resolveTerminalShellKind(ctx.terminalId)
      const cdCommand = buildChangeDirectoryCommand(platform, ctx.rootPath, shellKind)
      await window.electronAPI.terminal.write(ctx.terminalId, cdCommand)
      await sleep(600)
      await window.electronAPI.git.notifyTerminalActivity(ctx.terminalId)
      await sleep(600)
    }

    if (!ctx.cancelled() && shouldRun('terminal-autofollow')) {
      log('phase0.1:begin')
      const results = await testTerminalAutofollow(ctx)
      collectSuiteResults('TerminalAutofollow', results)
      await sleep(400)
    }

    if (!ctx.cancelled() && shouldRun('terminal-title-rename')) {
      log('phase0.12:begin')
      const results = await testTerminalTitleRename(ctx)
      collectSuiteResults('TerminalTitleRename', results)
      await sleep(300)
    }

    if (!ctx.cancelled() && shouldRun('task-layout')) {
      log('phase0.13:begin')
      const results = await testTaskLayout(ctx)
      collectSuiteResults('TaskLayout', results)
      await sleep(200)
    }

    if (!ctx.cancelled() && shouldRun('feedback')) {
      log('phase0.15:begin')
      const logicResults = await testFeedback(ctx)
      collectSuiteResults('Feedback', logicResults)
      await sleep(200)
      if (!ctx.cancelled()) {
        const uiResults = await testFeedbackUi(ctx)
        collectSuiteResults('FeedbackUI', uiResults)
        await sleep(200)
      }
    }

    if (!ctx.cancelled() && suiteFilter === 'feedback-persistence-seed') {
      log('phase0.16:begin')
      const results = await testFeedbackPersistenceSeed(ctx)
      collectSuiteResults('FeedbackPersistenceSeed', results)
      await sleep(200)
    }

    if (!ctx.cancelled() && suiteFilter === 'feedback-persistence-verify') {
      log('phase0.17:begin')
      const results = await testFeedbackPersistenceVerify(ctx)
      collectSuiteResults('FeedbackPersistenceVerify', results)
      await sleep(200)
    }

    if (!ctx.cancelled() && suiteFilter === 'terminal-rename-restart-survival-seed') {
      log('phase0.18:begin')
      const results = await testTerminalRenameRestartSurvivalSeed(ctx)
      collectSuiteResults('TerminalRenameRestartSurvivalSeed', results)
      await sleep(200)
    }

    if (!ctx.cancelled() && suiteFilter === 'terminal-rename-restart-survival-verify') {
      log('phase0.19:begin')
      const results = await testTerminalRenameRestartSurvivalVerify(ctx)
      collectSuiteResults('TerminalRenameRestartSurvivalVerify', results)
      await sleep(200)
    }

    // Phase 0.4: Project Editor restore unit tests
    if (!ctx.cancelled() && shouldRun('project-editor-restore-unit')) {
      log('phase0.4:begin')
      const results = await testProjectEditorRestoreUnit(ctx)
      collectSuiteResults('ProjectEditorRestoreUnit', results)
      await sleep(300)
    }

    // Phase 0.4b: Quick-file (Pin/Recent) unit tests
    if (!ctx.cancelled() && shouldRun('quick-file-unit')) {
      log('phase0.4b:begin')
      const results = await testQuickFileUnit(ctx)
      collectSuiteResults('QuickFileUnit', results)
      await sleep(300)
    }

    // Phase 0.4c: Sidebar auto-scroll (Outline + File Browser)
    if (!ctx.cancelled() && shouldRun('sidebar-autoscroll')) {
      log('phase0.4c:begin')
      const results = await testSidebarAutoscroll(ctx)
      collectSuiteResults('SidebarAutoscroll', results)
      await sleep(300)
    }

    // Phase 0.5: Project Editor restore interactive tests
    if (!ctx.cancelled() && shouldRun('project-editor-restore')) {
      log('phase0.5:begin')
      const results = await testProjectEditorRestore(ctx)
      collectSuiteResults('ProjectEditorRestore', results)
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('project-editor-file-memory')) {
      log('phase0.55:begin')
      const results = await testProjectEditorFileMemory(ctx)
      collectSuiteResults('ProjectEditorFileMemory', results)
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('project-editor-large-file')) {
      log('phase0.56:begin')
      const results = await testProjectEditorLargeFile(ctx)
      collectSuiteResults('ProjectEditorLargeFile', results)
      await sleep(500)
    }

    // Phase 0.6: Project Editor open-position tests
    if (!ctx.cancelled() && shouldRun('project-editor-open-position')) {
      log('phase0.6:begin')
      const results = await testProjectEditorOpenPosition(ctx)
      collectSuiteResults('ProjectEditorOpenPosition', results)
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('subpage-navigation')) {
      log('phase0.58:begin')
      const results = await testSubpageNavigation(ctx)
      collectSuiteResults('SubpageNavigation', results)
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('working-directory-copy')) {
      log('phase0.585:begin')
      const results = await testWorkingDirectoryCopy(ctx)
      collectSuiteResults('WorkingDirectoryCopy', results)
      await sleep(300)
    }

    if (!ctx.cancelled() && shouldRun('subpage-viewstate-restore')) {
      log('phase0.59:begin')
      const results = await testSubpageViewstateRestore(ctx)
      collectSuiteResults('SubpageViewstateRestore', results)
      await sleep(500)
    }

    // Phase 0.7: Project Editor multi-terminal scope isolation tests
    if (!ctx.cancelled() && shouldRun('project-editor-multi-terminal-scope')) {
      log('phase0.7:begin')
      const results = await testProjectEditorMultiTerminalScope(ctx)
      collectSuiteResults('ProjectEditorMultiTerminalScope', results)
      await sleep(500)
    }

    // Phase 0.8: Project Editor Markdown LaTeX preview tests
    if (!ctx.cancelled() && shouldRun('markdown-latex-preview')) {
      log('phase0.8:begin')
      const results = await testMarkdownLatexPreview(ctx)
      collectSuiteResults('MarkdownLatexPreview', results)
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('mermaid-panzoom')) {
      log('phase0.82:begin')
      const results = await testMermaidPanZoom(ctx)
      collectSuiteResults('MermaidPanZoom', results)
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('project-editor-markdown-navigation')) {
      log('phase0.85:begin')
      const results = await testProjectEditorMarkdownNavigation(ctx)
      collectSuiteResults('ProjectEditorMarkdownNavigation', results)
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('project-editor-html-preview')) {
      log('phase0.852:begin')
      const results = await testProjectEditorHtmlPreview(ctx)
      collectSuiteResults('ProjectEditorHtmlPreview', results)
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('open-browser')) {
      log('phase0.853:begin')
      const results = await testOpenBrowser(ctx)
      collectSuiteResults('OpenBrowser', results)
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('project-editor-markdown-session-restore')) {
      log('phase0.855:begin')
      const results = await testProjectEditorMarkdownSessionRestore(ctx)
      collectSuiteResults('ProjectEditorMarkdownSessionRestore', results)
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('markdown-preview-latency')) {
      log('phase0.857:begin')
      const results = await testMarkdownPreviewLatency(ctx)
      collectSuiteResults('MarkdownPreviewLatency', results)
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('global-search')) {
      log('phase0.875:begin')
      const results = await testGlobalSearch(ctx)
      collectSuiteResults('GlobalSearch', results)
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('settings-update')) {
      log('phase0.877:begin')
      const results = await testSettingsUpdate(ctx)
      collectSuiteResults('SettingsUpdate', results)
      await sleep(400)
    }

    if (!ctx.cancelled() && shouldRun('change-log')) {
      log('phase0.878:begin')
      const results = await testChangeLog(ctx)
      collectSuiteResults('ChangeLog', results)
      await sleep(300)
    }

    if (!ctx.cancelled() && shouldRun('telemetry')) {
      log('phase0.88:begin')
      const results = await testTelemetry(ctx)
      collectSuiteResults('Telemetry', results)
      await sleep(400)
    }

    if (!ctx.cancelled() && shouldRun('performance-trace')) {
      log('phase0.881:begin')
      const results = await testPerformanceTrace(ctx)
      collectSuiteResults('PerformanceTrace', results)
      await sleep(300)
    }

    if (!ctx.cancelled() && shouldRun('file-watch')) {
      log('phase0.88:begin')
      const results = await testFileWatch(ctx)
      collectSuiteResults('FileWatch', results)
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('preview-position-restore')) {
      log('phase0.89:begin')
      await ctx.reopenProjectEditor('phase0.89-setup')
      await sleep(300)
      const results = await testPreviewPositionRestore(ctx)
      collectSuiteResults('PreviewPositionRestore', results)
      await ctx.reopenProjectEditor('phase0.89-cleanup')
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('preview-search')) {
      log('phase0.895:begin')
      await ctx.reopenProjectEditor('phase0.895-setup')
      await sleep(300)
      const results = await testPreviewSearch(ctx)
      collectSuiteResults('PreviewSearch', results)
      await ctx.reopenProjectEditor('phase0.895-cleanup')
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('file-index-cache-ui')) {
      log('phase0.898:begin')
      const results = await testFileIndexCacheUi(ctx)
      collectSuiteResults('FileIndexCacheUi', results)
      await sleep(300)
    }

    // Phase 0.9: Project Editor SQLite add/delete/update/query tests
    if (!ctx.cancelled() && shouldRun('project-editor-sqlite')) {
      log('phase0.9:begin')
      const results = await testProjectEditorSqlite(ctx)
      collectSuiteResults('ProjectEditorSqlite', results)
      await sleep(500)
    }

    // Phase 1: Prompt sender UI tests
    if (!ctx.cancelled() && shouldRun('prompt-sender')) {
      log('phase1:begin')
      const results = await testPromptSender(ctx)
      collectSuiteResults('PromptSender', results)
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('prompt-list')) {
      log('phase1.05:begin')
      const results = await testPromptList(ctx)
      collectSuiteResults('PromptList', results)
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('prompt-editor-context-menu')) {
      log('phase1.07:begin')
      const results = await testPromptEditorContextMenu(ctx)
      collectSuiteResults('PromptEditorContextMenu', results)
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('prompt-integrity')) {
      log('phase1.1:begin')
      const results = await testPromptIntegrity(ctx)
      collectSuiteResults('PromptIntegrity', results)
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('terminal-state-persistence')) {
      log('phase1.15:begin')
      const results = await testTerminalStatePersistence(ctx)
      collectSuiteResults('TerminalStatePersistence', results)
      await sleep(500)
    }

    // Phase 2: Per-agent font tests
    if (!ctx.cancelled() && shouldRun('per-agent-font')) {
      log('phase2:begin')
      await ctx.reopenProjectEditor('phase2-setup')
      await sleep(300)
      const results = await testPerAgentFont(ctx)
      collectSuiteResults('PerAgentFont', results)
      await ctx.reopenProjectEditor('phase2-cleanup')
      await sleep(500)
    }

    // Phase 3: Git History tests
    if (!ctx.cancelled() && shouldRun('git-history')) {
      log('phase3:begin')
      await ctx.reopenProjectEditor('phase3-setup')
      await sleep(300)
      const results = await testGitHistory(ctx)
      collectSuiteResults('GitHistory', results)
      await ctx.reopenProjectEditor('phase3-cleanup')
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('git-history-multi-terminal-scope')) {
      log('phase3.5:begin')
      await ctx.reopenProjectEditor('phase3.5-setup')
      await sleep(300)
      const results = await testGitHistoryMultiTerminalScope(ctx)
      collectSuiteResults('GitHistoryMultiTerminalScope', results)
      await ctx.reopenProjectEditor('phase3.5-cleanup')
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('git-history-ref-decoration')) {
      log('phase3.6:begin')
      await ctx.reopenProjectEditor('phase3.6-setup')
      await sleep(300)
      const results = await testGitHistoryRefDecoration(ctx)
      collectSuiteResults('GitHistoryRefDecoration', results)
      await ctx.reopenProjectEditor('phase3.6-cleanup')
      await sleep(500)
    }

    // Phase 4: Prompt cleanup tests
    if (!ctx.cancelled() && shouldRun('prompt-cleanup')) {
      log('phase4:begin')
      const results = await testPromptCleanup(ctx)
      collectSuiteResults('PromptCleanup', results)
      await sleep(500)
    }

    // Phase 4.5: Schedule tests
    if (!ctx.cancelled() && shouldRun('schedule')) {
      log('phase4.5:begin')
      const results = await testSchedule(ctx)
      collectSuiteResults('Schedule', results)
      await sleep(500)
    }

    // Phase 5: Regression tests
    if (!ctx.cancelled() && shouldRun('regression')) {
      log('phase5:begin')
      await ctx.reopenProjectEditor('phase5-setup')
      await sleep(300)
      const results = await testRegression(ctx)
      collectSuiteResults('Regression', results)
      await ctx.reopenProjectEditor('phase5-cleanup')
      await sleep(500)
    }

    // Phase 5.4: Git cross-platform tests
    if (!ctx.cancelled() && shouldRun('git-cross-platform')) {
      log('phase5.4:begin')
      await ctx.reopenProjectEditor('phase5.4-setup')
      await sleep(300)
      const results = await testGitCrossPlatform(ctx)
      collectSuiteResults('GitCrossPlatform', results)
      await ctx.reopenProjectEditor('phase5.4-cleanup')
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('git-diff-submodules')) {
      log('phase5.45:begin')
      await ctx.reopenProjectEditor('phase5.45-setup')
      await sleep(300)
      const results = await testGitDiffSubmodules(ctx)
      collectSuiteResults('GitDiffSubmodules', results)
      await ctx.reopenProjectEditor('phase5.45-cleanup')
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('git-diff-recursive-submodules')) {
      log('phase5.47:begin')
      await ctx.reopenProjectEditor('phase5.47-setup')
      await sleep(300)
      const results = await testGitDiffRecursiveSubmodules(ctx)
      collectSuiteResults('GitDiffRecursiveSubmodules', results)
      await ctx.reopenProjectEditor('phase5.47-cleanup')
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('git-nested-submodules')) {
      log('phase5.48:begin')
      await ctx.reopenProjectEditor('phase5.48-setup')
      await sleep(300)
      const results = await testGitNestedSubmodules(ctx)
      collectSuiteResults('GitNestedSubmodules', results)
      await ctx.reopenProjectEditor('phase5.48-cleanup')
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('git-diff-staleness-and-submodule')) {
      log('phase5.49:begin')
      await ctx.reopenProjectEditor('phase5.49-setup')
      await sleep(300)
      const results = await testGitDiffStalenessAndSubmodule(ctx)
      collectSuiteResults('GitDiffStalenessAndSubmodule', results)
      await ctx.reopenProjectEditor('phase5.49-cleanup')
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('git-diff-nested-gitlink')) {
      log('phase5.491:begin')
      await ctx.reopenProjectEditor('phase5.491-setup')
      await sleep(300)
      const results = await testGitDiffNestedGitlink(ctx)
      collectSuiteResults('GitDiffNestedGitlink', results)
      await ctx.reopenProjectEditor('phase5.491-cleanup')
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('git-diff-click-latency')) {
      log('phase5.493:begin')
      await ctx.reopenProjectEditor('phase5.493-setup')
      await sleep(300)
      const results = await testGitDiffClickLatency(ctx)
      collectSuiteResults('GitDiffClickLatency', results)
      await ctx.reopenProjectEditor('phase5.493-cleanup')
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('git-diff-identical-blob')) {
      log('phase5.494:begin')
      await ctx.reopenProjectEditor('phase5.494-setup')
      await sleep(300)
      const results = await testGitDiffIdenticalBlob(ctx)
      collectSuiteResults('GitDiffIdenticalBlob', results)
      await ctx.reopenProjectEditor('phase5.494-cleanup')
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('git-large-file-confirmation')) {
      log('phase5.4945:begin')
      await ctx.reopenProjectEditor('phase5.4945-setup')
      await sleep(300)
      const results = await testGitLargeFileConfirmation(ctx)
      collectSuiteResults('GitLargeFileConfirmation', results)
      void ctx.reopenProjectEditor('phase5.4945-cleanup')
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('git-state-mirror-latency')) {
      log('phase5.495:begin')
      await ctx.reopenProjectEditor('phase5.495-setup')
      await sleep(300)
      const results = await testGitStateMirrorLatency(ctx)
      collectSuiteResults('GitStateMirrorLatency', results)
      await ctx.reopenProjectEditor('phase5.495-cleanup')
      await sleep(500)
    }

    // Phase 5.5: Git Diff subdirectory tests
    if (!ctx.cancelled() && shouldRun('git-diff-subdir')) {
      log('phase5.5:begin')
      await ctx.reopenProjectEditor('phase5.5-setup')
      await sleep(300)
      const results = await testGitDiffSubdir(ctx)
      collectSuiteResults('GitDiffSubdir', results)
      await ctx.reopenProjectEditor('phase5.5-cleanup')
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('image-diff')) {
      log('phase5.55:begin')
      await ctx.reopenProjectEditor('phase5.55-setup')
      await sleep(300)
      const results = await testImageDiff(ctx)
      collectSuiteResults('ImageDiff', results)
      await ctx.reopenProjectEditor('phase5.55-cleanup')
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('image-history-diff')) {
      log('phase5.555:begin')
      await ctx.reopenProjectEditor('phase5.555-setup')
      await sleep(300)
      const results = await testImageHistoryDiff(ctx)
      collectSuiteResults('ImageHistoryDiff', results)
      await ctx.reopenProjectEditor('phase5.555-cleanup')
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('pdf-epub-preview')) {
      log('phase5.56:begin')
      await ctx.reopenProjectEditor('phase5.56-setup')
      await sleep(300)
      const results = await testPdfEpubPreview(ctx)
      collectSuiteResults('PdfEpubPreview', results)
      await ctx.reopenProjectEditor('phase5.56-cleanup')
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('pdf-epub-diff')) {
      log('phase5.57:begin')
      await ctx.reopenProjectEditor('phase5.57-setup')
      await sleep(300)
      const results = await testPdfEpubDiff(ctx)
      collectSuiteResults('PdfEpubDiff', results)
      await ctx.reopenProjectEditor('phase5.57-cleanup')
      await sleep(500)
    }

    // Phase 5.6: Terminal performance tests
    if (!ctx.cancelled() && shouldRun('terminal-perf')) {
      log('phase5.6:begin')
      const results = await testTerminalPerf(ctx)
      collectSuiteResults('TerminalPerf', results)
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('terminal-architecture-baseline')) {
      log('phase5.65:begin')
      const results = await testTerminalArchitectureBaseline(ctx)
      collectSuiteResults('TerminalArchitectureBaseline', results)
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('prompt-input-latency')) {
      log('phase5.66:begin')
      const results = await testPromptInputLatency(ctx)
      collectSuiteResults('PromptInputLatency', results)
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('prompt-input-longtail')) {
      log('phase5.67:begin')
      const results = await testPromptInputLongtail(ctx)
      collectSuiteResults('PromptInputLongtail', results)
      await sleep(500)
    }

    // Phase 5.7: Terminal focus activation regression test
    if (!ctx.cancelled() && shouldRun('terminal-focus-activation')) {
      log('phase5.7:begin')
      const results = await testTerminalFocusActivation(ctx)
      collectSuiteResults('TerminalFocusActivation', results)
      await sleep(500)
    }

    // Phase 5.8: Terminal stress test (extended multi-terminal pressure)
    if (!ctx.cancelled() && shouldRun('terminal-stress')) {
      log('phase5.8:begin')
      const results = await testTerminalStress(ctx)
      collectSuiteResults('TerminalStress', results)
      await sleep(500)
    }

    // Phase 5.9: Render corruption stress — six-terminal pixel-fidelity probe
    // for the multi-WebGL atlas-pollution / context-pressure rendering bug
    // observed when six Tasks run heavy TUI workloads simultaneously.
    if (!ctx.cancelled() && shouldRun('render-corruption-stress')) {
      log('phase5.9:begin')
      const results = await testRenderCorruptionStress(ctx)
      collectSuiteResults('RenderCorruptionStress', results)
      await sleep(500)
    }

    // Phase 6: Stress tests
    if (!ctx.cancelled() && shouldRun('stress')) {
      log('phase6:begin')
      await ctx.reopenProjectEditor('phase6-setup')
      await sleep(300)
      const results = await testStress(ctx)
      collectSuiteResults('Stress', results)
      await ctx.reopenProjectEditor('phase6-cleanup')
      await sleep(500)
    }

    // Phase 7: Summary report
    const elapsedMs = Math.round(performance.now() - startTime)

    if (runtimeErrors.length > 0) {
      const runtimeErrorResult: TestResult = {
        name: 'AT-RT-no-runtime-errors',
        ok: false,
        detail: {
          count: runtimeErrors.length,
          errors: runtimeErrors.slice(0, 10)
        }
      }
      allTestResults.push(runtimeErrorResult)
      allResults.push({
        suite: 'RuntimeErrors',
        results: [runtimeErrorResult],
        passed: 0,
        failed: 1,
        skipped: 0
      })
      log('runtime-errors-detected', runtimeErrorResult.detail)
    }

    log('=== Test Summary ===', {
      totalTests: allTestResults.length,
      totalPassed: allTestResults.filter(r => r.ok).length,
      totalFailed: allTestResults.filter(r => !r.ok).length,
      elapsedMs,
      suites: allResults.map(s => ({
        suite: s.suite,
        passed: s.passed,
        failed: s.failed,
        total: s.results.length
      }))
    })

    // Output each failed test
    const failedTests = allTestResults.filter(r => !r.ok)
    if (failedTests.length > 0) {
      log('=== Failed Cases ===', {
        count: failedTests.length,
        tests: failedTests.map(r => ({
          name: r.name,
          detail: r.detail
        }))
      })
    }

    // Output a list of all test results
    log('=== Result List ===', {
      results: allTestResults.map(r => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}`)
    })

    log('=== Autotest Completed ===', {
      elapsed: `${(elapsedMs / 1000).toFixed(1)}s`,
      passed: allTestResults.filter(r => r.ok).length,
      failed: allTestResults.filter(r => !r.ok).length,
      total: allTestResults.length
    })

  } catch (error) {
    log('autotest-error', { error: String(error) })
  } finally {
    window.removeEventListener('error', handleWindowError)
    window.removeEventListener('unhandledrejection', handleUnhandledRejection)
  }
}
