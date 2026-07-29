/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Git Diff mutation-timing matrix (BUG-0004, 2026-07-26 diagnostic bundle).
 *
 * The bundle's defect was a stale Monaco model surviving a git-state change,
 * but the property it broke is broader than the one path that reported it:
 * **the viewport and the collapse state must describe the content that is on
 * disk right now, no matter WHEN the tree changed relative to the Git Diff
 * lifecycle.** In an Agent Coding First workload the tree changes constantly
 * and at moments the user never chose — before the panel opens, during its
 * load, in the few frames between a click and the reveal decision, while the
 * user is reading, during close.
 *
 * The suite walks that timeline as eight phases:
 *
 *   closed group      P1 never-opened          P2 closed round-trip
 *   load-reveal group P3 during-load           P4 during-select (the 47 ms window)
 *   viewing group     P5 while-viewing         P6 after-scroll-away
 *                     P7 during-close          P8 rapid burst
 *
 * Groups are selected by ONWARD_AUTOTEST_MT_GROUP so each runner stays inside
 * the 300 s per-runner ceiling; the whole matrix runs when it is unset.
 *
 * ── Why two assertion styles ──────────────────────────────────────────────
 * Deterministic phases (P1, P2, P7, P8) pin the EXACT reveal line: the tree is
 * quiescent at decision time, so exactly one answer is correct, and the fixture
 * moves the edit between a low line and a high line so a stale read and a fresh
 * read cannot produce the same number. That indistinguishability is what let
 * GDS-52 stay green through the bundle, and it is designed out here.
 *
 * Racy phases (P3, P4, P5, P6) deliberately do NOT pin a line. When a write
 * lands mid-decision, a reveal computed against the pre-write content was
 * legitimately correct at that instant; demanding the post-write line would be
 * over-specified and would make the case lie. What must hold instead is an
 * invariant — that the UI does not COME TO REST in a state describing content
 * that no longer exists:
 *
 *   INV-1  after settling, the bound models are the ones the selection expects
 *          AND Monaco's diff describes them (`diffCurrent`)
 *   INV-2  no decision came to rest on line 1 while the real first change is
 *          nowhere near line 1 — the bundle's exact signature
 *   INV-3  a 1200-line file with one edited line is collapsed
 *   INV-4  the live onward-git-diff model count stays bounded (the leak that
 *          content-identity URIs would otherwise create under a mutating tree)
 *   INV-5  the applied viewport position was computed from the content that is
 *          loaded now (`getRevealStaleState().stale === false`). This one is a
 *          pure state comparison rather than a scenario assertion, so it is
 *          meaningful at every instant of every case — it is the detector the
 *          four scattered trigger conditions never had.
 *
 * ── Aggregation ───────────────────────────────────────────────────────────
 * Every case is boolean-correctness and timing-sensitive (the defect is a race
 * between Monaco's 200 ms diff debouncer and a rAF tick), so each repeats
 * TRIALS times internally and requires all trials to pass. A single trial is
 * one draw from that race, and a harness-level re-run would only hide it.
 */

import type { AutotestContext, TestResult } from './types'

interface MutationTimingManifest {
  tempRoot: string
  repoRoot: string
  targets: Record<string, string>
  tallFileLines: number
  lowEditLine: number
  highEditLine: number
}

type ChangeType = 'untracked' | 'unstaged' | 'staged'

// One draw from the race is not a measurement; three agreeing draws are enough
// to make a deterministic defect certain while keeping each runner inside the
// per-runner budget (a Git Diff open+select round trip dominates the cost).
const TRIALS = 3
// A bound, not a target: the sweep keeps at most the bound pair plus a
// draft-protected pair, so anything beyond a small constant means superseded
// models are accumulating.
const MAX_LIVE_DIFF_MODELS = 6
// Editor line height (font size 13 x 1.5, rounded) — used only to express the
// viewport-drift budget in lines rather than raw pixels.
const DIFF_LINE_HEIGHT_PX = 20

function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i < 0 ? p : p.slice(0, i)
}
function baseOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i < 0 ? p : p.slice(i + 1)
}

export async function testGitDiffMutationTiming(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, assert, cancelled, sleep, waitFor, terminalId } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const group = (window.electronAPI.debug.autotestMutationTimingGroup ?? '').trim()
  const runGroup = (name: string) => group === '' || group === name

  log('git-diff-mutation-timing:start', { terminalId, group: group || '(all)' })

  const extraPath = window.electronAPI.debug.autotestFixtureExtra
  let manifest: MutationTimingManifest | null = null
  if (extraPath) {
    const raw = await window.electronAPI.project.readFile(dirOf(extraPath), baseOf(extraPath))
    if (raw.success && typeof raw.content === 'string') {
      try {
        manifest = JSON.parse(raw.content) as MutationTimingManifest
      } catch {
        manifest = null
      }
    }
  }
  if (!manifest) {
    record('MT-00-fixture-loaded', false, { extraPath })
    return results
  }
  record('MT-00-fixture-loaded', true, {
    repoRoot: manifest.repoRoot,
    targets: Object.keys(manifest.targets).length
  })

  const repo = manifest.repoRoot
  const { lowEditLine: LOW, highEditLine: HIGH, tallFileLines: TALL } = manifest

  // ── Bodies ────────────────────────────────────────────────────────────────
  // Same length and shape everywhere; only the edited line moves. That keeps
  // "which line did the reveal target" the single variable under test.
  const bodyWithEditAt = (line: number | null): string => {
    const lines = Array.from({ length: TALL }, (_, i) => `baseline line ${i + 1}`)
    if (line !== null) lines[line - 1] = `baseline line ${line} EDITED-AT-${line}`
    return lines.join('\n') + '\n'
  }
  const pristine = bodyWithEditAt(null)
  const editedLow = bodyWithEditAt(LOW)
  const editedHigh = bodyWithEditAt(HIGH)
  // Per-trial variants. Repeating identical bytes across trials makes the view
  // memory's saved position still match the content signature from trial 2
  // onward, so the cycle correctly takes a RESTORE decision and never reveals
  // — the case would then be asserting against a decision it did not provoke.
  // Offsetting the edit line per trial also turns "read the previous trial's
  // diff" into a wrong ANSWER rather than an indistinguishable one.
  const highForTrial = (trial: number) => HIGH - trial * 60
  const editedHighForTrial = (trial: number) => bodyWithEditAt(highForTrial(trial))
  // Scattered edits, so hideUnchangedRegions still leaves a tall document.
  // A single-edit file collapses to ~9 laid-out lines, i.e. a viewport with
  // nothing to scroll — "the user scrolled away" is unestablishable on it.
  const scatteredBody = (marker: string): string => {
    const lines = Array.from({ length: TALL }, (_, i) => `baseline line ${i + 1}`)
    for (let line = 40; line < TALL; line += 40) {
      lines[line - 1] = `baseline line ${line} EDITED-${marker}`
    }
    return lines.join('\n') + '\n'
  }

  // ── UI drivers ────────────────────────────────────────────────────────────
  const api = () => window.__onwardGitDiffDebug
  const openDiff = (label: string) => {
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    return waitFor(label, () => Boolean(api()?.isOpen()), 10_000)
  }
  const closeDiff = async (label: string) => {
    if (!api()?.isOpen()) return true
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    return waitFor(label, () => !api()?.isOpen(), 5_000)
  }
  const write = (rel: string, content: string) =>
    window.electronAPI.git.saveFileContent(repo, rel, content)
  const listed = (label: string, rel: string, changeType: ChangeType) =>
    waitFor(label, () => (api()?.getFileList() ?? [])
      .some((f) => f.filename === rel && f.changeType === changeType), 30_000)
  // selectFileByPath takes the first filename match; a file can legitimately
  // appear as both staged and unstaged, so always select by changeType.
  const selectBy = (rel: string, changeType: ChangeType): boolean => {
    const files = api()?.getFileList() ?? []
    const index = files.findIndex((f) => f.filename === rel && f.changeType === changeType)
    if (index < 0) return false
    return Boolean(api()?.selectFileByIndex(index))
  }
  const waitForDecision = (label: string, since: number) =>
    waitFor(label, () => {
      const d = api()?.getLastRestoreDecision?.()
      return Boolean(d && d.at >= since && d.revealTargetLine !== null)
    }, 12_000)

  // Snapshot of everything an assertion may need, taken after the view settles.
  const settleAndProbe = async () => {
    await sleep(900)
    const decision = api()?.getLastRestoreDecision?.() ?? null
    const bound = api()?.getBoundModelUris?.() ?? null
    const collapse = api()?.getCollapseState?.() ?? null
    const liveModels = api()?.getLiveDiffModelCount?.() ?? -1
    const revealState = api()?.getRevealStaleState?.() ?? null
    return { decision, bound, collapse, liveModels, revealState }
  }
  type Probe = Awaited<ReturnType<typeof settleAndProbe>>

  const invariantsHold = (p: Probe) => ({
    // INV-1
    modelsCurrent: Boolean(
      p.bound &&
      p.bound.originalUri === p.bound.expectedOriginalUri &&
      p.bound.modifiedUri === p.bound.expectedModifiedUri
    ),
    diffCurrent: Boolean(p.bound?.diffCurrent),
    // INV-2 — the bundle's signature
    notStrandedAtTop: p.decision?.revealTargetLine !== 1,
    // INV-3
    collapsed: Boolean(p.collapse?.collapsed && p.collapse.hiddenLineCount > 500),
    // INV-4
    modelsBounded: p.liveModels >= 0 && p.liveModels <= MAX_LIVE_DIFF_MODELS,
    // INV-5 — the reconciliation invariant. Unlike INV-1..4 this one needs no
    // scenario to be meaningful: it is a pure state comparison, so it holds (or
    // does not) at every instant of every case. `stale` still true after the
    // view has settled means a position computed from content that no longer
    // exists was left standing — the whole defect class in one boolean.
    notStale: p.revealState !== null && !p.revealState.stale
  })
  const allInvariants = (p: Probe) => Object.values(invariantsHold(p)).every(Boolean)
  const near = (value: number | null | undefined, target: number, slack = 12) =>
    typeof value === 'number' && value >= target - slack && value <= target + slack

  // Return a target file to its committed state and drop any selection, so the
  // next trial starts from a base the assertions can predict.
  const resetTarget = async (rel: string) => {
    await closeDiff('MT-reset-close')
    await write(rel, pristine)
    await sleep(260)
  }

  const aggregate = (
    name: string,
    trials: Array<Record<string, unknown>>,
    passed: number,
    note: string
  ) => {
    log(`${name}-trials`, trials)
    record(name, passed === TRIALS, { passed, trials: TRIALS, note })
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP `closed` — the tree changed while no diff view was on screen
  // ══════════════════════════════════════════════════════════════════════════
  if (!cancelled() && runGroup('closed')) {
    // ── MT-01 (P1): changed before the panel was EVER opened ────────────────
    // The cold-path baseline. Nothing warm exists to be stale, so a failure
    // here means the reveal is broken outright rather than stale-model-broken.
    {
      const rel = manifest.targets.neverOpened
      const trials: Array<Record<string, unknown>> = []
      let passed = 0
      for (let t = 0; t < TRIALS && !cancelled(); t += 1) {
        await resetTarget(rel)
        await write(rel, editedHighForTrial(t))
        await sleep(300)
        const mark = Date.now()
        await openDiff(`MT-01-t${t}-open`)
        await listed(`MT-01-t${t}-listed`, rel, 'unstaged')
        await sleep(700)
        const selected = selectBy(rel, 'unstaged')
        const decided = await waitForDecision(`MT-01-t${t}-decision`, mark)
        const probe = await settleAndProbe()
        const ok = Boolean(selected && decided && near(probe.decision?.revealTargetLine, highForTrial(t)) && allInvariants(probe))
        if (ok) passed += 1
        trials.push({
          t, selected, decided, expected: highForTrial(t),
          revealTargetLine: probe.decision?.revealTargetLine ?? null,
          trigger: probe.decision?.trigger ?? null,
          ...invariantsHold(probe), liveModels: probe.liveModels,
          revealState: probe.revealState, ok
        })
        await closeDiff(`MT-01-t${t}-close`)
      }
      aggregate('MT-01-cold-open-after-change-reveals-current-line', trials, passed,
        'P1 never-opened: no warm state exists, so this is the reveal contract itself')
      await resetTarget(manifest.targets.neverOpened)
    }

    // ── MT-02 (P2): viewed, closed, changed, reopened — BOTH directions ─────
    // The reported bundle's phase. Run it low→high AND high→low: a stale read
    // fails only one direction depending on which line is smaller, so a
    // single direction would leave half the defect uncovered.
    for (const [label, first, second, expect] of [
      ['forward', editedLow, editedHigh, HIGH],
      ['backward', editedHigh, editedLow, LOW]
    ] as Array<[string, string, string, number]>) {
      const rel = manifest.targets.closedRoundTrip
      const trials: Array<Record<string, unknown>> = []
      let passed = 0
      for (let t = 0; t < TRIALS && !cancelled(); t += 1) {
        await resetTarget(rel)
        await write(rel, first)
        await sleep(300)
        await openDiff(`MT-02-${label}-t${t}-open1`)
        await listed(`MT-02-${label}-t${t}-listed1`, rel, 'unstaged')
        await sleep(700)
        selectBy(rel, 'unstaged')
        // Let the FIRST version's diff and collapse state settle — that is the
        // state a reopen must not inherit.
        await sleep(1200)
        await closeDiff(`MT-02-${label}-t${t}-close`)

        await write(rel, second)
        await sleep(320)
        const mark = Date.now()
        await openDiff(`MT-02-${label}-t${t}-open2`)
        await listed(`MT-02-${label}-t${t}-listed2`, rel, 'unstaged')
        // Wait out the body prefetch so the click is a MEMORY HIT — the cache
        // miss path routes through `loading` and takes the safe deferral, which
        // is exactly why GDS-52 never reproduced the bundle.
        await sleep(900)
        const selected = selectBy(rel, 'unstaged')
        const decided = await waitForDecision(`MT-02-${label}-t${t}-decision`, mark)
        const probe = await settleAndProbe()
        const onCurrent = near(probe.decision?.revealTargetLine, expect)
        const onStale = near(probe.decision?.revealTargetLine, expect === HIGH ? LOW : HIGH)
        const ok = Boolean(selected && decided && onCurrent && !onStale && allInvariants(probe))
        if (ok) passed += 1
        trials.push({
          t, selected, decided, expected: expect,
          revealTargetLine: probe.decision?.revealTargetLine ?? null,
          onCurrent, onStale, trigger: probe.decision?.trigger ?? null,
          ...invariantsHold(probe), liveModels: probe.liveModels, revealState: probe.revealState, ok
        })
        await closeDiff(`MT-02-${label}-t${t}-final-close`)
      }
      aggregate(`MT-02-${label}-closed-round-trip-reveals-current-line`, trials, passed,
        `P2 closed round-trip (${label}): the edit MOVES between versions, so a reveal that read the previous diff lands on the other line and fails`)
      await resetTarget(manifest.targets.closedRoundTrip)
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP `load-reveal` — the tree changed while the view was coming up
  // ══════════════════════════════════════════════════════════════════════════
  if (!cancelled() && runGroup('load-reveal')) {
    // ── MT-03 (P3): changed between `open` and the click ────────────────────
    {
      const rel = manifest.targets.duringLoad
      const trials: Array<Record<string, unknown>> = []
      let passed = 0
      for (let t = 0; t < TRIALS && !cancelled(); t += 1) {
        await resetTarget(rel)
        await write(rel, editedLow)
        await sleep(300)
        const mark = Date.now()
        await openDiff(`MT-03-t${t}-open`)
        // The agent writes WHILE the list and bodies are being fetched.
        await write(rel, editedHighForTrial(t))
        await listed(`MT-03-t${t}-listed`, rel, 'unstaged')
        await sleep(900)
        const selected = selectBy(rel, 'unstaged')
        const decided = await waitForDecision(`MT-03-t${t}-decision`, mark)
        const probe = await settleAndProbe()
        // Invariant-only: whichever body won the load race, the view must come
        // to rest describing it — not stranded at the top of a dead version.
        const ok = Boolean(selected && decided && allInvariants(probe))
        if (ok) passed += 1
        trials.push({
          t, selected, decided,
          revealTargetLine: probe.decision?.revealTargetLine ?? null,
          trigger: probe.decision?.trigger ?? null,
          ...invariantsHold(probe), liveModels: probe.liveModels, revealState: probe.revealState, ok
        })
        await closeDiff(`MT-03-t${t}-close`)
      }
      aggregate('MT-03-change-during-load-settles-on-current-models', trials, passed,
        'P3 during-load: invariant-only by design — either body may win the race, but the view must come to rest describing the one that did')
      await resetTarget(manifest.targets.duringLoad)
    }

    // ── MT-04 (P4): changed inside the click → decision window ──────────────
    // The bundle's decision landed 47 ms after the body was bound. This case
    // drops a write into exactly that window.
    {
      const rel = manifest.targets.duringSelect
      const trials: Array<Record<string, unknown>> = []
      let passed = 0
      for (let t = 0; t < TRIALS && !cancelled(); t += 1) {
        await resetTarget(rel)
        await write(rel, editedLow)
        await sleep(300)
        const mark = Date.now()
        await openDiff(`MT-04-t${t}-open`)
        await listed(`MT-04-t${t}-listed`, rel, 'unstaged')
        await sleep(900)
        const selected = selectBy(rel, 'unstaged')
        // No await: the write must overlap the reveal cycle, not follow it.
        const racingWrite = write(rel, editedHighForTrial(t))
        const decided = await waitForDecision(`MT-04-t${t}-decision`, mark)
        await racingWrite
        const probe = await settleAndProbe()
        const ok = Boolean(selected && decided && allInvariants(probe))
        if (ok) passed += 1
        trials.push({
          t, selected, decided,
          revealTargetLine: probe.decision?.revealTargetLine ?? null,
          trigger: probe.decision?.trigger ?? null,
          ...invariantsHold(probe), liveModels: probe.liveModels, revealState: probe.revealState, ok
        })
        await closeDiff(`MT-04-t${t}-close`)
      }
      aggregate('MT-04-change-during-select-window-settles-current', trials, passed,
        'P4 the 47 ms window: a write racing the reveal decision must not leave the view resting on a diff that no longer describes the models')
      await resetTarget(manifest.targets.duringSelect)
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP `viewing` — the tree changed while the user was looking at it
  // ══════════════════════════════════════════════════════════════════════════
  if (!cancelled() && runGroup('viewing')) {
    // ── MT-05 (P5): changed while viewing, viewport parked ──────────────────
    {
      const rel = manifest.targets.whileViewing
      const trials: Array<Record<string, unknown>> = []
      let passed = 0
      for (let t = 0; t < TRIALS && !cancelled(); t += 1) {
        await resetTarget(rel)
        await write(rel, editedLow)
        await sleep(300)
        await openDiff(`MT-05-t${t}-open`)
        await listed(`MT-05-t${t}-listed`, rel, 'unstaged')
        await sleep(900)
        const selected = selectBy(rel, 'unstaged')
        await sleep(1200)
        // Two consecutive external writes with NO user scroll in between.
        // Both must converge silently. The second one is the assertion that
        // matters: our own reconciling reveal must not be mistaken for a user
        // scroll, or the viewport gets marked as the user's and every later
        // convergence degrades into a banner — measured 49 notify vs 4 silent
        // before the suppression fix, with every test still green.
        await write(rel, editedHighForTrial(t))
        await sleep(900)
        const midOwns = api()?.getRevealStaleState?.()?.userOwnsViewport ?? null
        await write(rel, bodyWithEditAt(highForTrial(t) - 30))
        const probe = await settleAndProbe()
        const stillUnowned = probe.revealState?.userOwnsViewport === false
        const ok = Boolean(selected && allInvariants(probe) && midOwns === false && stillUnowned)
        if (ok) passed += 1
        trials.push({
          t, selected, midOwns, stillUnowned,
          revealTargetLine: probe.decision?.revealTargetLine ?? null,
          ...invariantsHold(probe), liveModels: probe.liveModels, revealState: probe.revealState, ok
        })
        await closeDiff(`MT-05-t${t}-close`)
      }
      aggregate('MT-05-change-while-viewing-keeps-models-current', trials, passed,
        'P5 while-viewing: the worktree side updates in place, so this is the case the diff-currency gate carries. Also gates that a SILENT reconcile does not mark the viewport as user-owned — otherwise only the first convergence is silent and the rest become banners')
      await resetTarget(manifest.targets.whileViewing)
    }

    // ── MT-06 (P6): changed after the user scrolled away ───────────────────
    // Uses the SCATTERED target: a single-edit file collapses to a viewport
    // with nothing to scroll, so the case's own premise cannot be established
    // on it (measured scrollTop 0 after scrollToFraction(1)).
    {
      const rel = manifest.targets.scatteredScroll
      const trials: Array<Record<string, unknown>> = []
      let passed = 0
      for (let t = 0; t < TRIALS && !cancelled(); t += 1) {
        await resetTarget(rel)
        await write(rel, scatteredBody(`V1-${t}`))
        await sleep(300)
        await openDiff(`MT-06-t${t}-open`)
        await listed(`MT-06-t${t}-listed`, rel, 'unstaged')
        await sleep(900)
        const selected = selectBy(rel, 'unstaged')
        await sleep(1200)
        // Genuine input: a real wheel event on the editor DOM, the same path a
        // user's scroll takes. Ownership derived from onDidScrollChange would
        // have been claimed by layout settling long before this point.
        api()?.simulateUserViewportIntent?.()
        api()?.scrollToFraction(0.8)
        await sleep(400)
        const ownsAfterScroll = api()?.getRevealStaleState?.()?.userOwnsViewport ?? null
        const scrolledTop = api()?.getScrollTop() ?? -1
        await write(rel, scatteredBody(`V2-${t}`))
        const probe = await settleAndProbe()
        const finalTop = api()?.getScrollTop() ?? -1
        const metrics = api()?.getScrollMetrics() ?? null
        const maxTop = metrics?.maxScrollTop ?? 0
        const drift = Math.abs(finalTop - scrolledTop)
        // The contract is "convergence did not move the user to a DIFFERENT
        // part of the document", not "scrollTop is byte-identical". We take the
        // notify branch here and call no scroll API at all, but Monaco still
        // settles its collapse layout after a recompute, which shifts the
        // offset by a line or two (measured 29 px against a ~5.5k px document).
        // A genuine breach looks nothing like that: it is a jump to the first
        // change, i.e. thousands of pixels, usually near the top. So gate on
        // "stayed in place at document scale" AND on "did not land where a
        // reveal would have put it".
        const driftBudget = Math.max(2 * DIFF_LINE_HEIGHT_PX, maxTop * 0.02)
        const stayedInPlace = scrolledTop > 0 && drift <= driftBudget
        const notYankedToReveal = finalTop > maxTop * 0.5
        const viewportPreserved = stayedInPlace && notYankedToReveal
        const ok = Boolean(selected && allInvariants(probe) && ownsAfterScroll === true && viewportPreserved)
        if (ok) passed += 1
        trials.push({
          t, selected, ownsAfterScroll, scrolledTop, finalTop, drift, driftBudget,
          maxTop, stayedInPlace, notYankedToReveal, viewportPreserved,
          revealTargetLine: probe.decision?.revealTargetLine ?? null,
          ...invariantsHold(probe), liveModels: probe.liveModels, revealState: probe.revealState, ok
        })
        await closeDiff(`MT-06-t${t}-close`)
      }
      aggregate('MT-06-change-after-scroll-away-keeps-models-current', trials, passed,
        'P6 after-scroll: the user owns the viewport, so convergence must NOT move it — it notifies instead. Gates both halves: ownership is detected, and the scroll offset survives the external write')
      await resetTarget(manifest.targets.scatteredScroll)
    }

    // ── MT-07 (P7): changed during close, checked on reopen ─────────────────
    {
      const rel = manifest.targets.duringClose
      const trials: Array<Record<string, unknown>> = []
      let passed = 0
      for (let t = 0; t < TRIALS && !cancelled(); t += 1) {
        await resetTarget(rel)
        await write(rel, editedLow)
        await sleep(300)
        await openDiff(`MT-07-t${t}-open1`)
        await listed(`MT-07-t${t}-listed1`, rel, 'unstaged')
        await sleep(900)
        selectBy(rel, 'unstaged')
        await sleep(1200)
        // Dispatch close and write in the same turn so the write lands inside
        // the teardown (cache wipe, editor detach, model sweep).
        window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
        const closingWrite = write(rel, editedHighForTrial(t))
        await waitFor(`MT-07-t${t}-closed`, () => !api()?.isOpen(), 5000)
        await closingWrite
        await sleep(320)

        const mark = Date.now()
        await openDiff(`MT-07-t${t}-open2`)
        await listed(`MT-07-t${t}-listed2`, rel, 'unstaged')
        await sleep(900)
        const selected = selectBy(rel, 'unstaged')
        const decided = await waitForDecision(`MT-07-t${t}-decision`, mark)
        const probe = await settleAndProbe()
        const ok = Boolean(selected && decided && near(probe.decision?.revealTargetLine, highForTrial(t)) && allInvariants(probe))
        if (ok) passed += 1
        trials.push({
          t, selected, decided, expected: highForTrial(t),
          revealTargetLine: probe.decision?.revealTargetLine ?? null,
          trigger: probe.decision?.trigger ?? null,
          ...invariantsHold(probe), liveModels: probe.liveModels, revealState: probe.revealState, ok
        })
        await closeDiff(`MT-07-t${t}-final-close`)
      }
      aggregate('MT-07-change-during-close-reveals-current-on-reopen', trials, passed,
        'P7 during-close: the write races the teardown that wipes the body cache and sweeps models; the reopen must still land on the current change')
      await resetTarget(manifest.targets.duringClose)
    }

    // ── MT-08 (P8): rapid burst while viewing — the leak bound ──────────────
    // Six rewrites in quick succession is what an agent editing a file looks
    // like. Each one mints a new base identity, so this is the case that would
    // expose an unswept model table.
    {
      const rel = manifest.targets.burst
      const trials: Array<Record<string, unknown>> = []
      let passed = 0
      for (let t = 0; t < TRIALS && !cancelled(); t += 1) {
        await resetTarget(rel)
        await write(rel, editedLow)
        await sleep(300)
        await openDiff(`MT-08-t${t}-open`)
        await listed(`MT-08-t${t}-listed`, rel, 'unstaged')
        await sleep(900)
        const selected = selectBy(rel, 'unstaged')
        await sleep(900)
        const beforeModels = api()?.getLiveDiffModelCount?.() ?? -1
        for (let burst = 0; burst < 6; burst += 1) {
          await write(rel, bodyWithEditAt(LOW + burst * 100))
          await sleep(220)
        }
        await write(rel, editedHighForTrial(t))
        const probe = await settleAndProbe()
        // The sweep is deferred, so give it its window before counting.
        await sleep(600)
        const afterModels = api()?.getLiveDiffModelCount?.() ?? -1
        const bounded = afterModels >= 0 && afterModels <= MAX_LIVE_DIFF_MODELS
        const ok = Boolean(selected && allInvariants(probe) && bounded)
        if (ok) passed += 1
        trials.push({
          t, selected, beforeModels, afterModels, bounded,
          revealTargetLine: probe.decision?.revealTargetLine ?? null,
          ...invariantsHold(probe), revealState: probe.revealState, ok
        })
        await closeDiff(`MT-08-t${t}-close`)
      }
      aggregate('MT-08-rapid-burst-stays-current-and-bounded', trials, passed,
        `P8 burst: each rewrite mints a new base identity, so an unswept model table shows up here as liveModels > ${MAX_LIVE_DIFF_MODELS}`)
      await resetTarget(manifest.targets.burst)
    }
  }

  await closeDiff('MT-final-close')
  return results
}
