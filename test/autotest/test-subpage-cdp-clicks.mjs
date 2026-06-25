/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { setTimeout as sleep } from 'node:timers/promises'

const DEFAULT_PORT = 9339

function parseArgs(argv) {
  const args = {
    port: DEFAULT_PORT,
    fixtureRoot: ''
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--port') {
      args.port = Number.parseInt(argv[++i] ?? '', 10)
    } else if (arg === '--fixture-root') {
      args.fixtureRoot = argv[++i] ?? ''
    }
  }
  if (!Number.isFinite(args.port) || args.port <= 0) {
    throw new Error(`Invalid CDP port: ${args.port}`)
  }
  if (!args.fixtureRoot) {
    throw new Error('Missing --fixture-root')
  }
  return args
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '')
}

function quoteForShell(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function buildChangeDirectoryCommand(platform, fixtureRoot) {
  if (platform === 'win32') {
    return `cd /d "${String(fixtureRoot).replace(/"/g, '""')}"\r`
  }
  return `cd ${quoteForShell(fixtureRoot)}\r`
}

async function createCdpClient(port) {
  let targets = null
  // EDR-tolerant startup connect (was 80 x 250ms = 20s): on an anti-malware host
  // the Electron launch + renderer load are spawn-taxed, so the page target can
  // appear past 20s. 360 x 250ms = 90s rides that out; breaks the instant a page
  // target appears, so a fast host is unaffected.
  for (let attempt = 0; attempt < 360; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`)
      targets = await response.json()
      if (Array.isArray(targets) && targets.some((target) => target.type === 'page')) {
        break
      }
    } catch {
      // Retry while Electron is still starting.
    }
    await sleep(250)
  }

  const page = Array.isArray(targets)
    ? targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
    : null
  if (!page) {
    throw new Error(`No CDP page target found on port ${port}`)
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })

  let nextId = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const raw = typeof event.data === 'string' ? event.data : event.data.toString()
    const message = JSON.parse(raw)
    if (typeof message.id !== 'number') return
    const handlers = pending.get(message.id)
    if (!handlers) return
    pending.delete(message.id)
    if (message.error) {
      handlers.reject(new Error(message.error.message || JSON.stringify(message.error)))
    } else {
      handlers.resolve(message)
    }
  })

  const send = (method, params = {}) => {
    if (ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP socket is not open for ${method}`))
    }
    const id = ++nextId
    const payload = { id, method, params }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP command timed out: ${method}`))
      }, 15000)
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        }
      })
      ws.send(JSON.stringify(payload))
    })
  }

  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    const result = response.result
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description
        || result.exceptionDetails.text
        || 'Runtime.evaluate exception'
      throw new Error(description)
    }
    return result.result?.value
  }

  await send('Runtime.enable')
  await send('Page.enable')

  return {
    send,
    evaluate,
    close: () => {
      ws.close()
    }
  }
}

// HOLISTIC EDR scale for this external CDP driver's readiness waits: this host
// taxes every git/conpty spawn 1.3-12.9s, so a CDP-observed render/settle a wait
// depends on legitimately needs longer under full-suite load. Scaling the ceiling
// is nearly free — the loop returns the instant the expression is truthy, so a
// passing wait is not slowed; the scale only extends the give-up point for a wait
// that would otherwise time out mid-spawn-tax (observed: subpage-cdp render-settled
// timeout). On a fast/CI host it is inert.
const EDR_CDP_WAIT_SCALE = 2.5
async function waitFor(cdp, label, expression, timeoutMs = 12000, intervalMs = 120) {
  const startedAt = Date.now()
  const effectiveTimeout = Math.round(timeoutMs * EDR_CDP_WAIT_SCALE)
  let lastValue = null
  while (Date.now() - startedAt < effectiveTimeout) {
    lastValue = await cdp.evaluate(expression)
    if (lastValue) return lastValue
    await sleep(intervalMs)
  }
  throw new Error(`Timed out waiting for ${label} (after ${effectiveTimeout}ms, base ${timeoutMs}ms x${EDR_CDP_WAIT_SCALE}); last value: ${JSON.stringify(lastValue)}`)
}

async function findVisibleCenter(cdp, selector) {
  return await cdp.evaluate(`
    (() => {
      const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
      const node = nodes.find((element) => {
        if (!(element instanceof HTMLElement)) return false
        if (element.closest('[aria-hidden="true"]')) return false
        if ('disabled' in element && element.disabled) return false
        const rect = element.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        const style = window.getComputedStyle(element)
        return style.display !== 'none' && style.visibility !== 'hidden'
      })
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        text: node.textContent?.trim() || '',
        selector: ${JSON.stringify(selector)}
      }
    })()
  `)
}

async function clickSelector(cdp, selector, label) {
  const center = await findVisibleCenter(cdp, selector)
  if (!center) {
    throw new Error(`No visible click target for ${label}: ${selector}`)
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: center.x,
    y: center.y,
    button: 'none'
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: center.x,
    y: center.y,
    button: 'left',
    clickCount: 1
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: center.x,
    y: center.y,
    button: 'left',
    clickCount: 1
  })
  console.log(`[CDP] click:${label}`, JSON.stringify(center))
  await sleep(180)
}

async function clickWhenReady(cdp, selector, label, timeoutMs = 12000) {
  await waitFor(
    cdp,
    `visible ${label}`,
    `(() => {
      const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
      return nodes.some((element) => {
        if (!(element instanceof HTMLElement)) return false
        if (element.closest('[aria-hidden="true"]')) return false
        if ('disabled' in element && element.disabled) return false
        const rect = element.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        const style = window.getComputedStyle(element)
        return style.display !== 'none' && style.visibility !== 'hidden'
      })
    })()`,
    timeoutMs
  )
  await clickSelector(cdp, selector, label)
}

async function pressEscape(cdp) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 53
  })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 53
  })
}

async function closeActiveSubpageIfAny(cdp) {
  const active = await cdp.evaluate(`
    document.querySelector('.terminal-grid-subpage-host')?.getAttribute('data-active-subpage') || ''
  `)
  if (!active) return
  await pressEscape(cdp)
  await waitFor(
    cdp,
    'subpage closed before dropdown click',
    `!(document.querySelector('.terminal-grid-subpage-host')?.getAttribute('data-active-subpage') || '')`,
    8000
  )
}

async function clickSubpage(cdp, target) {
  await clickWhenReady(cdp, `[data-subpage-button="${target}"]`, `subpage:${target}`)
}

async function waitActiveSubpage(cdp, target) {
  await waitFor(
    cdp,
    `active subpage ${target}`,
    `Boolean(document.querySelector('.terminal-grid-subpage-host[data-active-subpage="${target}"]'))`,
    12000
  )
}

async function prepareTerminalCwd(cdp, fixtureRoot) {
  const terminalId = await waitFor(
    cdp,
    'terminal id',
    `document.querySelector('[data-terminal-id]')?.getAttribute('data-terminal-id') ?? null`,
    12000
  )
  const platform = await cdp.evaluate(`window.electronAPI.platform`)
  const command = buildChangeDirectoryCommand(platform, fixtureRoot)
  await cdp.evaluate(`
    (async () => {
      const terminalId = ${JSON.stringify(terminalId)}
      await window.electronAPI.terminal.write(terminalId, ${JSON.stringify(command)})
      await new Promise((resolve) => window.setTimeout(resolve, 900))
      await window.electronAPI.git.notifyTerminalActivity(terminalId)
      return true
    })()
  `)
  await waitFor(
    cdp,
    'terminal cwd fixture',
    `(() => {
      const terminalId = ${JSON.stringify(terminalId)}
      return window.electronAPI.git.getTerminalCwd(terminalId)
        .then((cwd) => Boolean(cwd && cwd.replace(/\\\\/g, '/').replace(/\\/+$/, '') === ${JSON.stringify(normalizePath(fixtureRoot))}))
    })()`,
    15000,
    300
  )
  return terminalId
}

async function waitEditorFile(cdp, expectedPath) {
  await waitActiveSubpage(cdp, 'editor')
  await waitFor(
    cdp,
    `editor file ${expectedPath}`,
    `(() => {
      const api = window.__onwardProjectEditorDebug
      return Boolean(api?.isOpen?.() && api.getActiveFilePath?.() === ${JSON.stringify(expectedPath)})
    })()`,
    12000
  )
}

async function waitDiffFile(cdp, expectedPath) {
  await waitActiveSubpage(cdp, 'diff')
  await waitFor(
    cdp,
    `diff loaded ${expectedPath}`,
    `(() => {
      const api = window.__onwardGitDiffDebug
      if (!api?.isOpen?.()) return false
      return api.getFileList?.().some((file) => file.filename === ${JSON.stringify(expectedPath)})
    })()`,
    15000
  )
}

async function waitHistoryReady(cdp) {
  await waitActiveSubpage(cdp, 'history')
  await waitFor(
    cdp,
    'history files loaded',
    `(() => {
      const api = window.__onwardGitHistoryDebug
      return Boolean(api?.isOpen?.() && !api.isLoading?.() && api.getFiles?.().length > 0)
    })()`,
    15000
  )
}

async function getEditorSnapshot(cdp) {
  return await cdp.evaluate(`
    (() => {
      const api = window.__onwardProjectEditorDebug
      if (!api) return null
      return {
        activeFilePath: api.getActiveFilePath?.() ?? null,
        previewVisible: api.isMarkdownPreviewVisible?.() ?? false,
        previewScrollTop: api.getPreviewScrollTop?.() ?? 0,
        htmlLength: api.getMarkdownRenderedHtml?.().length ?? 0,
        previewPhase: api.getPreviewRestorePhase?.() ?? null
      }
    })()
  `)
}

async function waitEditorPreviewRestored(cdp, baseline, label) {
  await waitEditorFile(cdp, 'notes.md')
  await waitFor(
    cdp,
    `editor preview restored:${label}`,
    `(() => {
      const api = window.__onwardProjectEditorDebug
      if (!api?.isOpen?.()) return false
      const activeFilePath = api.getActiveFilePath?.() ?? null
      const previewVisible = api.isMarkdownPreviewVisible?.() ?? false
      const previewScrollTop = api.getPreviewScrollTop?.() ?? 0
      const htmlLength = api.getMarkdownRenderedHtml?.().length ?? 0
      return Boolean(
        activeFilePath === 'notes.md' &&
        previewVisible &&
        htmlLength === ${JSON.stringify(baseline.htmlLength)} &&
        Math.abs(previewScrollTop - ${JSON.stringify(baseline.previewScrollTop)}) <= 80
      )
    })()`,
    12000,
    120
  )
  return await getEditorSnapshot(cdp)
}

// Deep-link jumps (e.g. the Git Diff "jump to editor" button) open the editor
// fresh on the target file, so the preview scroll legitimately resets to the top
// rather than restoring the pre-diff baseline scroll. The correct invariant here
// is "editor opened on the file with a fully rendered, visible preview" — assert
// activeFilePath + previewVisible + htmlLength against the baseline html length,
// WITHOUT the scroll-equality requirement that back-navigation restoration uses.
async function waitEditorOpenedRendered(cdp, baseline, expectedPath, label) {
  await waitEditorFile(cdp, expectedPath)
  await waitFor(
    cdp,
    `editor opened rendered:${label}`,
    `(() => {
      const api = window.__onwardProjectEditorDebug
      if (!api?.isOpen?.()) return false
      const activeFilePath = api.getActiveFilePath?.() ?? null
      const previewVisible = api.isMarkdownPreviewVisible?.() ?? false
      const htmlLength = api.getMarkdownRenderedHtml?.().length ?? 0
      return Boolean(
        activeFilePath === ${JSON.stringify(expectedPath)} &&
        previewVisible &&
        htmlLength === ${JSON.stringify(baseline.htmlLength)}
      )
    })()`,
    12000,
    120
  )
  return await getEditorSnapshot(cdp)
}

function assertCase(results, name, ok, detail = {}) {
  results.push({ name, ok, detail })
  console.log(`[CDP] ${ok ? 'PASS' : 'FAIL'} ${name}`, JSON.stringify(detail))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const fixtureRoot = normalizePath(args.fixtureRoot)
  const results = []
  console.log('[CDP] subpage click acceptance start', JSON.stringify({
    port: args.port,
    fixtureRoot
  }))

  const cdp = await createCdpClient(args.port)
  try {
    await waitFor(
      cdp,
      'renderer ready',
      `Boolean(window.electronAPI && document.querySelector('[data-terminal-id]'))`,
      20000
    )
    const terminalId = await prepareTerminalCwd(cdp, args.fixtureRoot)
    assertCase(results, 'CDP-00-terminal-cwd-ready', true, { terminalId, fixtureRoot })
    await closeActiveSubpageIfAny(cdp)

    await clickWhenReady(cdp, '[data-terminal-dropdown-trigger="true"]', 'terminal-dropdown')
    await clickWhenReady(cdp, '[data-terminal-dropdown-action="editor"]', 'dropdown-open-editor')
    await waitFor(
      cdp,
      'project editor root',
      `(() => {
        const api = window.__onwardProjectEditorDebug
        const root = api?.getRootPath?.()
        return Boolean(api?.isOpen?.() && root && root.replace(/\\\\/g, '/').replace(/\\/+$/, '') === ${JSON.stringify(fixtureRoot)})
      })()`,
      15000
    )
    assertCase(results, 'CDP-01-dropdown-opens-editor', true, { fixtureRoot })

    await cdp.evaluate(`
      (async () => {
        const api = window.__onwardProjectEditorDebug
        await api.openFileByPathAsUser('notes.md', { trackRecent: true })
        api.setMarkdownPreviewOpen(true)
        api.setMarkdownEditorVisible(true)
        return true
      })()
    `)
    await waitEditorFile(cdp, 'notes.md')
    await waitFor(
      cdp,
      'markdown preview rendered',
      `(() => {
        const api = window.__onwardProjectEditorDebug
        return Boolean(
          api?.isMarkdownPreviewVisible?.() &&
          api.getMarkdownRenderedHtml?.().includes('Section 20')
        )
      })()`,
      15000
    )
    await cdp.evaluate(`window.__onwardProjectEditorDebug.scrollPreviewToFraction(0.62)`)
    await sleep(350)
    const baselineEditor = await getEditorSnapshot(cdp)
    assertCase(results, 'CDP-02-markdown-preview-baseline', Boolean(
      baselineEditor?.activeFilePath === 'notes.md' &&
      baselineEditor.previewVisible &&
      baselineEditor.htmlLength > 500 &&
      baselineEditor.previewScrollTop > 0
    ), baselineEditor ?? {})

    await clickSubpage(cdp, 'diff')
    await waitDiffFile(cdp, 'notes.md')
    await cdp.evaluate(`window.__onwardGitDiffDebug.selectFileByPath('notes.md')`)
    await waitFor(
      cdp,
      'diff notes selected',
      `window.__onwardGitDiffDebug?.getSelectedFile?.()?.filename === 'notes.md'`,
      8000
    )
    assertCase(results, 'CDP-03-editor-to-diff-click', true)

    await clickSubpage(cdp, 'editor')
    const editorAfterDiff = await waitEditorPreviewRestored(cdp, baselineEditor, 'after-diff')
    assertCase(results, 'CDP-04-diff-to-editor-restores-preview', Boolean(
      editorAfterDiff?.previewVisible &&
      editorAfterDiff.htmlLength === baselineEditor.htmlLength &&
      Math.abs(editorAfterDiff.previewScrollTop - baselineEditor.previewScrollTop) <= 80
    ), { baselineEditor, editorAfterDiff })

    await clickSubpage(cdp, 'history')
    await waitHistoryReady(cdp)
    await cdp.evaluate(`
      (() => {
        const api = window.__onwardGitHistoryDebug
        const index = api.getFiles().findIndex((file) => file.filename === 'notes.md')
        return index >= 0 ? api.selectFileByIndex(index) : false
      })()
    `)
    await waitFor(
      cdp,
      'history notes selected',
      `window.__onwardGitHistoryDebug?.getSelectedFile?.()?.filename === 'notes.md'`,
      8000
    )
    assertCase(results, 'CDP-05-editor-to-history-click', true)

    await clickSubpage(cdp, 'diff')
    await waitDiffFile(cdp, 'notes.md')
    const diffSelectionAfterHistory = await cdp.evaluate(
      `window.__onwardGitDiffDebug?.getSelectedFile?.()?.filename ?? null`
    )
    assertCase(results, 'CDP-06-history-to-diff-restores-diff', diffSelectionAfterHistory === 'notes.md', {
      diffSelectionAfterHistory
    })

    await clickSubpage(cdp, 'history')
    await waitHistoryReady(cdp)
    const historySelectionAfterDiff = await cdp.evaluate(
      `window.__onwardGitHistoryDebug?.getSelectedFile?.()?.filename ?? null`
    )
    assertCase(results, 'CDP-07-diff-to-history-restores-history', historySelectionAfterDiff === 'notes.md', {
      historySelectionAfterDiff
    })

    await clickSubpage(cdp, 'editor')
    const editorAfterHistory = await waitEditorPreviewRestored(cdp, baselineEditor, 'after-history')
    assertCase(results, 'CDP-08-history-to-editor-restores-editor', Boolean(
      editorAfterHistory?.previewVisible &&
      editorAfterHistory.htmlLength === baselineEditor.htmlLength &&
      Math.abs(editorAfterHistory.previewScrollTop - baselineEditor.previewScrollTop) <= 80
    ), { editorAfterHistory })

    for (let i = 1; i <= 5; i += 1) {
      await clickSubpage(cdp, 'diff')
      await waitDiffFile(cdp, 'notes.md')
      await clickSubpage(cdp, 'editor')
      const snapshot = await waitEditorPreviewRestored(cdp, baselineEditor, `cycle-${i}`)
      assertCase(results, `CDP-09-high-frequency-cycle-${i}`, Boolean(
        snapshot?.previewVisible &&
        snapshot.htmlLength === baselineEditor.htmlLength &&
        Math.abs(snapshot.previewScrollTop - baselineEditor.previewScrollTop) <= 80
      ), snapshot ?? {})
    }

    await clickSubpage(cdp, 'diff')
    await waitDiffFile(cdp, 'notes.md')
    await cdp.evaluate(`window.__onwardGitDiffDebug.selectFileByPath('notes.md')`)
    await waitFor(
      cdp,
      'diff jump button enabled',
      `(() => {
        const button = document.querySelector('[data-testid="git-diff-jump-editor"]')
        return Boolean(button && !button.disabled && button.getClientRects().length > 0)
      })()`,
      8000
    )
    await clickWhenReady(cdp, '[data-testid="git-diff-jump-editor"]', 'diff-jump-to-editor')
    const editorAfterJump = await waitEditorOpenedRendered(cdp, baselineEditor, 'notes.md', 'after-jump')
    assertCase(results, 'CDP-10-deep-link-diff-jump-editor', Boolean(
      editorAfterJump?.activeFilePath === 'notes.md' &&
      editorAfterJump.previewVisible &&
      editorAfterJump.htmlLength === baselineEditor.htmlLength
    ), editorAfterJump ?? {})

    const failed = results.filter((result) => !result.ok)
    console.log('[CDP] summary', JSON.stringify({
      total: results.length,
      failed: failed.length
    }))
    if (failed.length > 0) {
      console.log('RESULT: FAIL')
      process.exitCode = 1
      return
    }
    console.log('RESULT: PASS')
  } finally {
    try {
      await cdp.evaluate(`window.electronAPI?.debug?.quit?.()`)
    } catch {
      // The runner trap also terminates the app if the debug quit IPC is unavailable.
    }
    cdp.close()
  }
}

main().catch((error) => {
  console.error('[CDP] fatal', error)
  console.log('RESULT: FAIL')
  process.exitCode = 1
})
