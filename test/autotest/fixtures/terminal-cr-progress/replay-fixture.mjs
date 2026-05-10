// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
//
// Synthesize a high-volume git-clone-like progress stream and dump it
// to stdout in one shot. node-pty + the kernel pty pipe deliver our
// big write to the main process `onData` callback in many small
// (~4 KB on macOS) chunks, which is exactly the fast-burst arrival
// pattern that triggers the OLD pipeline's 64 KB FORCE_FLUSH_BYTES
// at arbitrary chunk boundaries. The new pipeline's 5 ms batch +
// flow control keeps the chunk granularity small enough that xterm
// renders each `<text>\x1b[K\r` redraw in place.
//
// Why synthetic and not the captured `git-clone-progress.bin`:
// the real fixture is only 2.6 KB; it never reaches the 64 KB
// force-flush, so the OLD broken pipeline silently passes too. With
// 3 × 5000 redraws (~750 KB total) the force-flush fires several
// times mid-stream and the bug becomes deterministic.

import { stdout } from 'node:process'

// 2000 redraws per phase × 3 phases ≈ 360 KB total, which:
//   - triggers OLD pipeline's 64 KB FORCE_FLUSH_BYTES ~6 times during
//     the burst (the pattern that exposes the bug);
//   - keeps total scrolled-line count at ~6000 (well under xterm's
//     default 10 000-line scrollback) so a failing trial leaves all
//     intermediate states inspectable from the buffer tail rather
//     than evicting them and looking falsely-clean.
const PROGRESS_REDRAWS = 2000
// Sentinel split into halves so the shell echo of the `node …`
// command line cannot match the tail-text waitFor in the autotest.
const DONE_HALF_A = '__TCR_REPLAY'
const DONE_HALF_B = '_DONE__'

function progressLine(prefix, phase, current, total) {
  const pct = Math.floor((current / total) * 100)
  return `${prefix}${phase}: ${pct.toString().padStart(3)}% (${current}/${total})\x1b[K\r`
}

function finalLine(prefix, phase, total) {
  return `${prefix}${phase}: 100% (${total}/${total}), done.\x1b[K\r\n`
}

const phases = [
  { prefix: 'remote: ', name: 'Counting objects' },
  { prefix: 'remote: ', name: 'Compressing objects' },
  { prefix: '', name: 'Receiving objects' }
]

let stream = "Cloning into 'big-repo'...\r\n"
stream += `remote: Enumerating objects: ${PROGRESS_REDRAWS * phases.length}, done.\x1b[K\r\n`
for (const { prefix, name } of phases) {
  for (let i = 1; i <= PROGRESS_REDRAWS; i += 1) {
    stream += progressLine(prefix, name, i, PROGRESS_REDRAWS)
  }
  stream += finalLine(prefix, name, PROGRESS_REDRAWS)
}

stdout.write(stream)
stdout.write(`\n${DONE_HALF_A}${DONE_HALF_B}\n`)
