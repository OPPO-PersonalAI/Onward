/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Real-stall harness for the threadpool watchdog's PROBE CONCEPT: prove
 * that with a genuinely starved libuv threadpool, a zlib.gzip probe times
 * out while timers keep firing — exactly the discrimination the watchdog
 * relies on (2026-07-20 incident: timers/IPC healthy, threadpool dead).
 *
 * Mechanism: a child Node process with UV_THREADPOOL_SIZE=1 opens a FIFO
 * for reading via callback fs.open. Opening a FIFO read-end with no
 * writer BLOCKS in the kernel — parking the pool's ONLY worker forever
 * and starving every later threadpool op, a faithful stand-in for the
 * lost-wakeup state (from the queue's perspective both are "workers never
 * pick up work"). The child then races a 1-byte zlib.gzip against a
 * timer, mirroring threadpool-watchdog.ts's probe.
 *
 * POSIX-only (FIFOs); on Windows the equivalent downstream wiring is
 * exercised through the DEBUG_SIMULATE_THREADPOOL_STALL hook in the
 * `run-infra-watchdog` autotest.
 *
 * Usage: node --experimental-strip-types --test test/unittest/threadpool-stall-probe.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, execFile, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const isPosix = process.platform !== 'win32'

const CHILD_SCRIPT = `
const fs = require('fs');
const zlib = require('zlib');
const fifoPath = process.env.ONWARD_TSP_FIFO;

// Park the single threadpool worker forever: FIFO read-open with no writer.
fs.open(fifoPath, 'r', () => { /* never reached without a writer */ });

// Give the open() a moment to occupy the worker, then probe.
setTimeout(() => {
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    console.log('PROBE_TIMEOUT');
    process.exit(0);
  }, 1500);
  zlib.gzip(Buffer.from([0]), () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    console.log('PROBE_SUCCESS');
    process.exit(0);
  });
}, 300);

// Timers must stay healthy while the pool is starved — the watchdog's
// entire discrimination depends on it.
setTimeout(() => { console.log('TIMER_ALIVE'); }, 900);
`

test('TSP-U-01 starved threadpool: probe times out while timers stay alive', { skip: !isPosix }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'onward-tsp-'))
  const fifoPath = join(scratch, 'stall.fifo')
  try {
    execFileSync('mkfifo', [fifoPath])
    // The child cannot exit on its own: Node's shutdown JOINS the threadpool
    // workers, and the fifo-blocked worker never joins — the same
    // cannot-quit shape the production incident had (locked separately by
    // the quit hard floor). The parent therefore reads the verdict from
    // stdout and SIGKILLs the child.
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', CHILD_SCRIPT], {
        env: { ...process.env, UV_THREADPOOL_SIZE: '1', ONWARD_TSP_FIFO: fifoPath },
        stdio: ['ignore', 'pipe', 'inherit']
      })
      let stdout = ''
      const killTimer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`no probe verdict within 8s; stdout so far: ${stdout}`))
      }, 8_000)
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        if (stdout.includes('PROBE_TIMEOUT') || stdout.includes('PROBE_SUCCESS')) {
          clearTimeout(killTimer)
          child.kill('SIGKILL')
          resolve(stdout)
        }
      })
      child.on('error', (err) => {
        clearTimeout(killTimer)
        reject(err)
      })
    })
    assert.match(output, /TIMER_ALIVE/, 'event-loop timer died — harness invalid')
    assert.match(output, /PROBE_TIMEOUT/, 'zlib probe completed despite a starved pool — probe concept broken')
    assert.doesNotMatch(output, /PROBE_SUCCESS/)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('TSP-U-02 healthy threadpool: the same probe succeeds fast', { skip: !isPosix }, async () => {
  // Control arm: without the FIFO block, the identical probe must succeed —
  // proving TSP-U-01's timeout is caused by the starvation, not the probe.
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      [
        '-e',
        `
        const zlib = require('zlib');
        const timer = setTimeout(() => { console.log('PROBE_TIMEOUT'); process.exit(0); }, 1500);
        zlib.gzip(Buffer.from([0]), () => { clearTimeout(timer); console.log('PROBE_SUCCESS'); process.exit(0); });
        `
      ],
      { env: { ...process.env, UV_THREADPOOL_SIZE: '1' }, timeout: 10_000, encoding: 'utf-8' },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    )
  })
  assert.match(output, /PROBE_SUCCESS/)
})
