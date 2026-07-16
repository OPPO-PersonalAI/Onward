/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Git Diff revert-scope suite (GRS-*).
 *
 * Reproduces + locks the "single-file revert triggers a GLOBAL refresh" bug
 * (2026-07-16). Historical behaviour per discard of ONE file:
 *   - handleDeny issued loadDiff({force:true})           → full recompute #1
 *   - main's 'manual' invalidation wiped the WHOLE content-cache bucket and
 *     the renderer marked every file stale + reloaded    → full recompute #2
 *   - the mirror echo bumped `generation`, which sat in the DiffEditor React
 *     key → the whole Monaco editor unmounted + remounted (the visible flash)
 *
 * Assertions (red before the fix / green after):
 *   GRS-01  functionality ground truth (green both sides): the discard
 *           restores the worktree content (polled via project.readFile, never
 *           a frozen diff cache — GDS-29 lesson) and the row leaves the list.
 *   GRS-02  remount isolation: while VIEWING file A, an external change to a
 *           DIFFERENT file must not tear down the Monaco editor (DOM identity
 *           probe) nor steal the selection.
 *   GRS-03  cache warmth: after discarding B, re-clicking the already-warm A
 *           must be a cache HIT (click-latency tracker), not a
 *           whole-bucket-wipe miss.
 *   GRS-04  reconcile count: the discard window contains at most ONE list
 *           reconcile (loadDiff pass), not the historical 2-3.
 */
import type { AutotestContext, TestResult } from './types'

interface Manifest {
  tempRoot: string
  repo: string
  baselines: Record<string, string>
  modifications: Record<string, string>
}

const LIST_TIMEOUT_MS = 30_000
const READY_TIMEOUT_MS = 20_000
// GRS-04 observation window after the discard settles: long enough for the
// mirror echo reconcile to land on a healthy host, short of the 3 s renderer
// fallback reload so the count stays deterministic.
const DISCARD_SETTLE_WINDOW_MS = 2_500

const dirOf = (p: string): string => p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '')
const baseOf = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p

async function loadManifest(extraPath: string | null): Promise<Manifest | null> {
  if (!extraPath) return null
  const result = await window.electronAPI.project.readFile(dirOf(extraPath), baseOf(extraPath))
  if (!result.success || typeof result.content !== 'string') return null
  try {
    return JSON.parse(result.content) as Manifest
  } catch {
    return null
  }
}

export async function testGitDiffRevertScope(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, waitFor, sleep, cancelled, log, terminalId } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }
  const api = () => window.__onwardGitDiffDebug

  log('grs:start', {})
  const manifest = await loadManifest(window.electronAPI.debug.autotestFixtureExtra)
  if (!manifest) {
    record('GRS-00-fixture-loaded', false, { extraPath: window.electronAPI.debug.autotestFixtureExtra })
    return results
  }
  record('GRS-00-fixture-loaded', true, { repo: manifest.repo })

  const findRow = (filename: string) =>
    (api()?.getFileList?.() ?? []).find((f: { filename: string }) => f.filename === filename) ?? null

  const selectAndSettle = async (filename: string, label: string): Promise<boolean> => {
    const selected = api()?.selectFileByPath?.(filename)
    if (!selected) return false
    return await waitFor(`grs-ready:${label}`, () => {
      const sel = api()?.getSelectedFile?.()
      return sel?.filename === filename && api()?.isSelectedReady?.() === true
    }, READY_TIMEOUT_MS, 100)
  }

  // ── Open Git Diff on the fixture repo (the app's terminal cwd). ──
  window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId, source: 'debug' } }))
  const opened = await waitFor('grs-open', () => Boolean(api()?.isOpen?.()), LIST_TIMEOUT_MS, 100)
  const listReady = opened && await waitFor('grs-list', () =>
    Boolean(findRow('alpha.txt') && findRow('beta.txt') && findRow('gamma.txt')),
    LIST_TIMEOUT_MS, 150)
  record('GRS-00b-diff-open-with-three-rows', listReady, {
    opened,
    files: (api()?.getFileList?.() ?? []).map((f: { filename: string }) => f.filename)
  })
  if (!listReady || cancelled()) return results

  // Warm alpha (the file we will keep viewing / re-clicking).
  const alphaWarm = await selectAndSettle('alpha.txt', 'alpha-warm')
  record('GRS-00c-alpha-selected-ready', alphaWarm, {})
  if (!alphaWarm || cancelled()) return results

  // ── GRS-02: external change to a DIFFERENT file must not remount the editor. ──
  // Mark the live Monaco container's DOM node; only an unmount/remount can
  // shed the marker (React never strips foreign dataset attributes in place).
  const probeToken = `grs-${Math.floor(performance.now())}`
  const editorEl = document.querySelector('.git-diff-monaco') as HTMLElement | null
  if (editorEl) editorEl.dataset.grsProbe = probeToken
  await window.electronAPI.debug.writeExternalFile({
    root: manifest.repo,
    relPath: 'delta.txt',
    content: 'externally created while viewing alpha\n'
  })
  const deltaAppeared = await waitFor('grs-delta-row', () => Boolean(findRow('delta.txt')), LIST_TIMEOUT_MS, 200)
  // Let the invalidation fan-out finish (generation bump / stale marking land
  // in the same burst as the list update).
  await sleep(600)
  const editorAfter = document.querySelector('.git-diff-monaco') as HTMLElement | null
  const probeSurvived = editorAfter?.dataset.grsProbe === probeToken
  const selectionKept = api()?.getSelectedFile?.()?.filename === 'alpha.txt'
  record('GRS-02-external-change-does-not-remount-editor', deltaAppeared && probeSurvived && selectionKept, {
    deltaAppeared,
    probeSurvived,
    selectionKept,
    note: 'RED before fix: mirror generation sat in the DiffEditor React key, any repo state change re-mounted Monaco'
  })
  if (cancelled()) return results

  // Warm beta too, then land selection back on it as the discard target.
  const betaWarm = await selectAndSettle('beta.txt', 'beta-warm')
  record('GRS-00d-beta-selected-ready', betaWarm, {})
  if (!betaWarm || cancelled()) return results

  // Quiesce: wait until no loadDiff has started for ~1.5 s so a straggler
  // reconcile from GRS-02's external write cannot leak into the discard
  // window and blur the GRS-04 count.
  {
    const deadline = performance.now() + 15_000
    let lastCount = api()?.getLoadDiffStats?.()?.started ?? 0
    let stableSince = performance.now()
    while (performance.now() < deadline) {
      await sleep(250)
      const now = api()?.getLoadDiffStats?.()?.started ?? 0
      if (now !== lastCount) {
        lastCount = now
        stableSince = performance.now()
      } else if (performance.now() - stableSince >= 1_500) {
        break
      }
    }
  }

  // Baselines for the discard window.
  const loadsBefore = api()?.getLoadDiffStats?.()?.started ?? -1
  api()?.resetClickLatencyHistory?.()

  // ── Discard beta. Guarded by expectedFilename: a background reload's
  // selection restore can race the select→deny gap, and acting on the wrong
  // file would corrupt the scenario (observed in the first red run: the
  // discard landed on alpha). Retry select+deny until the guard accepts. ──
  let denyTriggered = false
  for (let attempt = 0; attempt < 3 && !denyTriggered && !cancelled(); attempt++) {
    if (attempt > 0) {
      const reselected = await selectAndSettle('beta.txt', `beta-retry-${attempt}`)
      if (!reselected) continue
    }
    denyTriggered = (await api()?.triggerFileAction?.('deny', 'beta.txt')) === true
  }
  record('GRS-01a-deny-triggered', denyTriggered, {})
  if (!denyTriggered || cancelled()) return results

  // GRS-01: ground truth — worktree content restored to the committed baseline
  // (poll the file itself, never the diff list cache — GDS-29 lesson). Manual
  // async loop: ctx.waitFor only accepts a synchronous predicate.
  let betaRestored = false
  {
    const deadline = performance.now() + LIST_TIMEOUT_MS
    while (performance.now() < deadline) {
      const read = await window.electronAPI.project.readFile(manifest.repo, 'beta.txt')
      if (read.success && read.content === manifest.baselines['beta.txt']) {
        betaRestored = true
        break
      }
      await sleep(200)
    }
  }
  const betaRowGone = await waitFor('grs-beta-row-gone', () => !findRow('beta.txt'), LIST_TIMEOUT_MS, 200)
  record('GRS-01-discard-restores-and-removes-row', betaRestored && betaRowGone, {
    betaRestored,
    betaRowGone
  })
  if (cancelled()) return results

  // Give the post-discard fan-out its settle window, then read the counters.
  await sleep(DISCARD_SETTLE_WINDOW_MS)

  // GRS-04: at most ONE list reconcile in the discard window.
  const loadsAfter = api()?.getLoadDiffStats?.()?.started ?? -1
  const loadDelta = loadsBefore >= 0 && loadsAfter >= 0 ? loadsAfter - loadsBefore : -1
  record('GRS-04-single-reconcile-after-discard', loadDelta >= 0 && loadDelta <= 1, {
    loadsBefore,
    loadsAfter,
    loadDelta,
    note: 'RED before fix: explicit force reload + manual-invalidation reload + mirror echo = 2-3 passes'
  })

  // GRS-03: alpha stayed warm through the discard — re-clicking it must be a
  // cache hit, not an invalidated-mutation / whole-bucket miss.
  const alphaBack = await selectAndSettle('alpha.txt', 'alpha-back')
  // Warmth manifests two ways after the fix, both acceptable:
  //   (a) NO fetch at all — the renderer body was never marked stale, so the
  //       re-click renders from state and the click-latency tracker records
  //       nothing (the strongest warmth signal), or
  //   (b) a fetch that classified as a cache HIT.
  // The failure mode being locked out is a recorded MISS (pre-fix the whole
  // bucket was wiped, so the re-click cold-missed with
  // cacheMissReason='invalidated-mutation'). Grace sleep lets any fetch-driven
  // measurement land before we read the history.
  await sleep(800)
  const alphaHistory = (api()?.getClickLatencyHistory?.() ?? [])
  const alphaMeasurement = [...alphaHistory].reverse().find((m) => m.filename === 'alpha.txt' && !m.cancelled) ?? null
  const warm = alphaBack && (!alphaMeasurement || alphaMeasurement.cacheState === 'hit')
  record('GRS-03-unrelated-file-cache-stays-warm', warm, {
    alphaBack,
    measurement: (alphaMeasurement ?? null) as unknown as Record<string, unknown>,
    note: 'warm = instantly ready with either no fetch at all or a cache-hit fetch; RED before fix: the whole-bucket wipe made the re-click a recorded cold miss'
  })

  // ── GRS-02b: probe sensitivity guard (runs LAST — refreshChanges wipes the
  // content bucket via the force path, which would break GRS-03's premise).
  // A real remount (Refresh Changes bumps the reset nonce) MUST shed the DOM
  // marker; if it survives, the GRS-02 probe was never capable of detecting a
  // remount and its pass would be a feel-good no-op (2026-04-30 lesson #4). ──
  const editorNow = document.querySelector('.git-diff-monaco') as HTMLElement | null
  const sensitivityToken = `grs-sens-${Math.floor(performance.now())}`
  if (editorNow) editorNow.dataset.grsProbe = sensitivityToken
  await api()?.refreshChanges?.()
  const shed = await waitFor('grs-probe-shed', () => {
    const el = document.querySelector('.git-diff-monaco') as HTMLElement | null
    return Boolean(el) && el!.dataset.grsProbe !== sensitivityToken
  }, READY_TIMEOUT_MS, 100)
  record('GRS-02b-probe-detects-real-remount', shed, {
    note: 'refreshChanges bumps diffEditorResetNonce → real remount → marker must disappear'
  })

  return results
}
