/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure logic core for the git-diff chaos-convergence suite.
 *
 * The chaos suite models the product's real workload (Agent Coding First): an
 * external writer mutates the repo CONCURRENTLY with the user's Git Diff
 * interactions, then quiesces; the UI must converge to the on-disk truth
 * within a bounded window without a manual refresh. This module holds the
 * seed-deterministic pieces (PRNG + per-burst op schedule) so the writer
 * process (git-diff-chaos-writer.mjs) stays a thin executor and the schedule
 * math is unit-testable in plain Node (test/unittest/git-diff-chaos-core.test.mts).
 *
 * Determinism contract: same seed → byte-identical schedule. The regression
 * gate runs FIXED seeds (reproducible verdicts, per the timing-sensitive
 * authoring rule); exploratory runs may pass CHAOS_SEED to hunt new interleavings,
 * and a failure report always carries the seed for exact replay.
 */

/** mulberry32 — tiny deterministic PRNG, returns floats in [0, 1). */
export function createPrng(seed) {
  let a = seed >>> 0
  return function next() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Integer in [min, max] inclusive. */
export function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1))
}

export function pickOne(rng, items) {
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))]
}

/**
 * Weighted op kinds. Mirrors a coding agent's real write mix:
 *   - atomicRewrite: tmp-file + rename (Claude Code's save pattern; also the
 *     exact shape whose tmp events the mirror's watcher filter classifies)
 *   - create:        brand-new file (the "new file never shows up" symptom class)
 *   - append:        in-place growth (mtime+size both move)
 *   - remove:        delete a file the writer itself created
 *   - gitAdd:        stage a file (changeType transition untracked/unstaged → staged)
 */
export const CHAOS_OP_KINDS = [
  { kind: 'atomicRewrite', weight: 35 },
  { kind: 'create', weight: 20 },
  { kind: 'append', weight: 20 },
  { kind: 'remove', weight: 10 },
  { kind: 'gitAdd', weight: 15 }
]

export function pickOpKind(rng) {
  const total = CHAOS_OP_KINDS.reduce((sum, o) => sum + o.weight, 0)
  let roll = rng() * total
  for (const o of CHAOS_OP_KINDS) {
    roll -= o.weight
    if (roll < 0) return o.kind
  }
  return CHAOS_OP_KINDS[CHAOS_OP_KINDS.length - 1].kind
}

/**
 * Build one burst's op schedule: a list of {atMs, kind, target, content} whose
 * cumulative delays fill ~burstMs. Targets alternate between the committed
 * seed files (tracked-modified churn) and writer-created files (untracked
 * churn). Content embeds seed/op index so every version is unique and a stale
 * body is identifiable in a failure report.
 *
 * Pure: no I/O, no Date; the writer executes the schedule with real timers.
 */
export function buildBurstSchedule(rng, options) {
  const { burstMs, cycle, seedFiles, minGapMs = 60, maxGapMs = 420 } = options
  const ops = []
  const created = []
  let clock = 0
  let opIndex = 0
  while (true) {
    clock += randInt(rng, minGapMs, maxGapMs)
    if (clock >= burstMs) break
    let kind = pickOpKind(rng)
    // remove / gitAdd need an existing writer-created file; degrade gracefully.
    if ((kind === 'remove' || kind === 'gitAdd') && created.length === 0) {
      kind = 'create'
    }
    let target
    if (kind === 'create') {
      target = `chaos_c${cycle}_${opIndex}.md`
      created.push(target)
    } else if (kind === 'remove') {
      const idx = randInt(rng, 0, created.length - 1)
      target = created.splice(idx, 1)[0]
    } else if (kind === 'gitAdd') {
      target = pickOne(rng, created)
    } else {
      // atomicRewrite / append hit both committed seed files and created files.
      const pool = created.length > 0 && rng() < 0.5 ? created : seedFiles
      target = pickOne(rng, pool)
    }
    ops.push({
      atMs: clock,
      kind,
      target,
      content: `chaos cycle=${cycle} op=${opIndex} kind=${kind}\nbody line for ${target}\n`
    })
    opIndex += 1
  }
  return ops
}
