/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Locks the seed-determinism and schedule-shape contracts of the chaos
 * writer's pure core (test/autotest/git-diff-chaos-core.mjs). Determinism is
 * load-bearing: a chaos failure report carries the seed, and replaying that
 * seed MUST reproduce the exact op stream, or the whole harness loses its
 * debuggability.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createPrng, buildBurstSchedule, pickOpKind, CHAOS_OP_KINDS } from '../../test/autotest/git-diff-chaos-core.mjs'

const SEED_FILES = ['docs/alpha.md', 'docs/beta.md', 'notes.md']

test('same seed produces a byte-identical burst schedule (replayability)', () => {
  const a = buildBurstSchedule(createPrng(42), { burstMs: 10_000, cycle: 1, seedFiles: SEED_FILES })
  const b = buildBurstSchedule(createPrng(42), { burstMs: 10_000, cycle: 1, seedFiles: SEED_FILES })
  assert.deepEqual(a, b)
  assert.ok(a.length > 5, `expected a non-trivial schedule, got ${a.length} ops`)
})

test('different seeds produce different schedules (the explorer actually explores)', () => {
  const a = buildBurstSchedule(createPrng(1), { burstMs: 10_000, cycle: 1, seedFiles: SEED_FILES })
  const b = buildBurstSchedule(createPrng(2), { burstMs: 10_000, cycle: 1, seedFiles: SEED_FILES })
  assert.notDeepEqual(a, b)
})

test('schedule respects the burst window and gap bounds', () => {
  const ops = buildBurstSchedule(createPrng(7), {
    burstMs: 8_000, cycle: 2, seedFiles: SEED_FILES, minGapMs: 60, maxGapMs: 420
  })
  let prev = 0
  for (const op of ops) {
    assert.ok(op.atMs < 8_000, `op at ${op.atMs} escaped the burst window`)
    const gap = op.atMs - prev
    assert.ok(gap >= 60 && gap <= 420, `gap ${gap} outside [60, 420]`)
    prev = op.atMs
  }
})

test('remove/gitAdd never target a file the writer did not create', () => {
  const ops = buildBurstSchedule(createPrng(99), { burstMs: 20_000, cycle: 3, seedFiles: SEED_FILES })
  const created = new Set()
  for (const op of ops) {
    if (op.kind === 'create') created.add(op.target)
    if (op.kind === 'remove') {
      assert.ok(created.has(op.target), `remove targeted non-created ${op.target}`)
      created.delete(op.target)
    }
    if (op.kind === 'gitAdd') {
      assert.ok(created.has(op.target), `gitAdd targeted non-created ${op.target}`)
    }
  }
})

test('op-kind roulette only emits registered kinds and covers them over a long run', () => {
  const rng = createPrng(5)
  const seen = new Set()
  const known = new Set(CHAOS_OP_KINDS.map((o) => o.kind))
  for (let i = 0; i < 2_000; i += 1) {
    const kind = pickOpKind(rng)
    assert.ok(known.has(kind), `unknown kind ${kind}`)
    seen.add(kind)
  }
  assert.equal(seen.size, known.size, 'a registered op kind never fired in 2000 draws')
})
