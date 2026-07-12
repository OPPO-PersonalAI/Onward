/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Seeded PRNG for the chaos-convergence suite's USER-ACTION stream (mulberry32,
 * the same algorithm as test/autotest/git-diff-chaos-core.mjs — duplicated
 * because src/autotest must never import from test/ paths, which would drag
 * test files into the renderer bundle). Fixed seeds keep the regression
 * verdict reproducible; the writer's op stream uses an independent seed.
 */

export function createChaosPrng(seed: number): () => number {
  let a = seed >>> 0
  return function next(): number {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Uniform index into a list of the given length (length must be >= 1). */
export function pickIndex(rng: () => number, length: number): number {
  return Math.min(length - 1, Math.floor(rng() * length))
}
