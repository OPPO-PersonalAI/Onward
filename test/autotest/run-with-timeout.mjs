#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
//
// Node wrapper that runs a child command with a wall-clock timeout.
// Fresh macOS hosts ship without `gtimeout`; this keeps the full
// regression reproducible on any dev machine.
//
// Usage:
//   node test/autotest/run-with-timeout.mjs <seconds> <cmd> [args...]
//
// Behaviour:
//   - Spawns <cmd> [args...] with stdio inherited.
//   - Starts a timer at <seconds>. On fire, terminates the whole child
//     process tree; 10 s later, force-kills anything still alive.
//   - Exits 124 on timeout, 127 on spawn error, otherwise the child's
//     exit code. Signal-caused exits are reported as 128 + (9 or 15).

import { spawn, spawnSync } from 'node:child_process'

const timeoutSec = Number(process.argv[2])
const cmd = process.argv[3]
const args = process.argv.slice(4)

if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
  console.error('usage: node run-with-timeout.mjs <seconds> <cmd> [args...]')
  process.exit(2)
}

const isWindows = process.platform === 'win32'
const child = spawn(cmd, args, {
  stdio: 'inherit',
  detached: !isWindows
})
let timedOut = false
let forceTimer = null

function terminateChild(force) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (isWindows) {
    // taskkill walks the live PPID tree from child.pid. /F is mandatory for
    // console processes (bash, node) which ignore the graceful WM_CLOSE that a
    // /F-less taskkill sends; /T reaches the non-detached dev app while the tree
    // is still rooted at child.pid.
    const taskkillArgs = ['/PID', String(child.pid), '/T']
    if (force) taskkillArgs.push('/F')
    spawnSync('taskkill.exe', taskkillArgs, { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM')
  } catch {
    try { child.kill(force ? 'SIGKILL' : 'SIGTERM') } catch { /* already exited */ }
  }
}

const killTimer = setTimeout(() => {
  timedOut = true
  console.error(`run-with-timeout: command exceeded ${timeoutSec}s, terminating process tree`)
  if (isWindows) {
    // Windows: a graceful (/F-less) taskkill is a no-op for console processes, and
    // the old "graceful now, force 10s later" path had a hole — if the graceful
    // pass let `bash` exit, child.on('exit') cleared the force timer and the
    // wrapper exited BEFORE force-killing, leaking any surviving grandchild. Force
    // the whole live tree at once while it is still rooted at child.pid.
    terminateChild(true)
  } else {
    // POSIX: SIGTERM the process group, SIGKILL holdouts 10s later. (A dev app
    // launched detached lives in its own session and is reaped by the
    // orchestrator's kill_app(EXACT name) backstop, not by this group signal.)
    terminateChild(false)
    forceTimer = setTimeout(() => {
      terminateChild(true)
    }, 10_000).unref()
  }
}, timeoutSec * 1000)

child.on('exit', (code, signal) => {
  clearTimeout(killTimer)
  if (forceTimer !== null) clearTimeout(forceTimer)
  if (timedOut) process.exit(124)
  if (typeof code === 'number') process.exit(code)
  if (signal) process.exit(128 + (signal === 'SIGKILL' ? 9 : 15))
  process.exit(1)
})

child.on('error', (err) => {
  clearTimeout(killTimer)
  if (forceTimer !== null) clearTimeout(forceTimer)
  console.error(err)
  process.exit(127)
})
