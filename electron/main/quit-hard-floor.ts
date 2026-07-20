/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure hard-floor race used by every production quit/restart path.
 * Extracted from index.ts so the timing contract is lockable in a plain
 * Node unit test: the sequence either completes first ('done') or the
 * floor fires first ('timeout') and the caller force-exits. A sequence
 * that REJECTS also resolves the race as 'done' — quit paths treat their
 * own errors as "proceed to exit", never as "hang".
 */

export type QuitSequenceOutcome = 'done' | 'timeout'

export async function raceQuitSequenceAgainstFloor(
  sequence: () => Promise<void>,
  floorMs: number
): Promise<QuitSequenceOutcome> {
  let floorTimer: ReturnType<typeof setTimeout> | null = null
  const floor = new Promise<'timeout'>((resolve) => {
    floorTimer = setTimeout(() => resolve('timeout'), floorMs)
    if (typeof floorTimer.unref === 'function') floorTimer.unref()
  })
  try {
    const outcome = await Promise.race([
      sequence().then(
        () => 'done' as const,
        () => 'done' as const
      ),
      floor
    ])
    return outcome
  } finally {
    if (floorTimer) clearTimeout(floorTimer)
  }
}
