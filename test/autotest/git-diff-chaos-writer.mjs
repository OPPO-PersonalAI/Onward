/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Chaos writer — the "external coding agent" of the git-diff chaos-convergence
 * suite. Runs OUTSIDE the app (spawned by the runner, exactly like a real
 * agent in a terminal) and drives cycles of:
 *
 *   burst    — seed-deterministic random FS ops against the fixture repo
 *              (atomic tmp+rename rewrites, new files, appends, deletes,
 *              `git add`) at random 60–420 ms gaps, deliberately overlapping
 *              every read the app performs;
 *   quiesce  — stop writing, capture the ON-DISK TRUTH (fresh `git status
 *              --porcelain -z --untracked-files=all --no-optional-locks` +
 *              worktree bodies) into truth-<cycle>.json, flip state.json to
 *              phase=quiesced, and wait for the in-app suite to ack before
 *              the next burst.
 *
 * The truth capture runs entirely outside the app's caches, so it is a valid
 * oracle for "what should the UI converge to". State/truth/ack files live in
 * a state dir OUTSIDE the repo — invisible to the watcher and to git.
 *
 * Usage:
 *   node git-diff-chaos-writer.mjs --repo <path> --state <dir> --seed <n>
 *        --cycles <n> --burst-ms <n> [--ack-timeout-ms <n>]
 */

import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { createPrng, buildBurstSchedule } from './git-diff-chaos-core.mjs'

function parseArgs(argv) {
  const args = {}
  for (let i = 2; i < argv.length; i += 2) {
    args[argv[i].replace(/^--/, '')] = argv[i + 1]
  }
  return args
}

const args = parseArgs(process.argv)
const repo = args.repo
const stateDir = args.state
const seed = Number(args.seed ?? 20260712)
const cycles = Number(args.cycles ?? 3)
const burstMs = Number(args['burst-ms'] ?? 12000)
const ackTimeoutMs = Number(args['ack-timeout-ms'] ?? 90000)

if (!repo || !stateDir) {
  console.error('usage: git-diff-chaos-writer --repo <path> --state <dir> --seed <n> --cycles <n> --burst-ms <n>')
  process.exit(2)
}
mkdirSync(stateDir, { recursive: true })

const opsLog = join(stateDir, 'ops-log.jsonl')
function logOp(entry) {
  appendFileSync(opsLog, `${JSON.stringify({ t: Date.now(), ...entry })}\n`)
}

function setState(state) {
  // Atomic rename so the in-app reader never sees a torn JSON.
  const tmp = join(stateDir, 'state.json.tmp')
  writeFileSync(tmp, JSON.stringify(state))
  renameSync(tmp, join(stateDir, 'state.json'))
  logOp({ state })
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

const SEED_FILES = ['docs/alpha.md', 'docs/beta.md', 'src/one.md', 'src/two.md', 'notes.md']
const BODY_CAP_BYTES = 64 * 1024

// Per-path last-write timestamps, attached to truth entries as `lastOpAt` so
// the in-app oracle can sample bodies MOST-RECENTLY-WRITTEN-FIRST — the files
// whose reads most likely overlapped a write (the TOCTOU poison class).
const lastWriteAtByPath = new Map()

function execOp(op, cycle) {
  const abs = join(repo, op.target)
  try {
    switch (op.kind) {
      case 'create':
        writeFileSync(abs, op.content, 'utf-8')
        break
      case 'atomicRewrite': {
        // Claude Code's save shape: write a sibling tmp file, then rename over
        // the target. The tmp events are the class the mirror's watcher filter
        // drops as 'tmpfile'; the rename target event is the real signal.
        const tmp = `${abs}.tmp.${process.pid}.${cycle}${op.atMs}`
        writeFileSync(tmp, op.content, 'utf-8')
        renameSync(tmp, abs)
        break
      }
      case 'append':
        appendFileSync(abs, op.content)
        break
      case 'remove':
        rmSync(abs, { force: true })
        break
      case 'gitAdd':
        execFileSync('git', ['-C', repo, 'add', '--', op.target], { stdio: 'ignore' })
        break
      default:
        break
    }
    if (op.kind === 'create' || op.kind === 'atomicRewrite' || op.kind === 'append') {
      lastWriteAtByPath.set(op.target, Date.now())
    } else if (op.kind === 'remove') {
      lastWriteAtByPath.delete(op.target)
    }
    logOp({ op })
  } catch (error) {
    // A remove/gitAdd racing itself is acceptable chaos; record and continue.
    logOp({ op, error: String(error) })
  }
}

/** Fresh, cache-free ground truth. --no-optional-locks: never touches .git/index. */
function captureTruth(cycle) {
  // NB: --no-optional-locks is a GLOBAL git option and must precede the
  // subcommand (after `status` git rejects it and prints usage).
  const stdout = execFileSync(
    'git',
    ['-C', repo, '-c', 'core.quotepath=false', '--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all'],
    { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 }
  )
  const entries = []
  for (const record of stdout.split('\0')) {
    if (!record) continue
    const xy = record.slice(0, 2)
    const path = record.slice(3)
    if (!path) continue
    let body = null
    const abs = join(repo, path)
    // Worktree body only for unambiguous worktree-backed states (pure
    // untracked / pure worktree-modified). Staged-involved entries render the
    // index side in some panes; the filename-set check still covers them.
    const worktreeBacked = xy === '??' || xy === ' M' || xy === ' A'
    if (worktreeBacked && existsSync(abs)) {
      try {
        const raw = readFileSync(abs, 'utf-8')
        body = raw.length > BODY_CAP_BYTES ? null : raw
      } catch {
        body = null
      }
    }
    entries.push({ path, xy, body, lastOpAt: lastWriteAtByPath.get(path) ?? null })
  }
  const truth = { cycle, seed, capturedAt: Date.now(), entries }
  const tmp = join(stateDir, `truth-${cycle}.json.tmp`)
  writeFileSync(tmp, JSON.stringify(truth))
  renameSync(tmp, join(stateDir, `truth-${cycle}.json`))
  return truth
}

async function waitForAck(cycle) {
  const ackPath = join(stateDir, `ack-${cycle}.json`)
  const startedAt = Date.now()
  while (Date.now() - startedAt < ackTimeoutMs) {
    if (existsSync(ackPath)) return true
    await sleep(200)
  }
  // Deadlock backstop: proceed so a hung app cannot wedge the writer; the
  // in-app suite's own assertions will report what went wrong.
  logOp({ ackTimeout: cycle })
  return false
}

async function main() {
  const rng = createPrng(seed)
  logOp({ start: { repo, seed, cycles, burstMs } })
  // Handshake 0: the app boots slower than this process spawns. Wait for the
  // in-app suite to open Git Diff and ack before the first burst, so every
  // cycle's writes genuinely overlap live user interaction.
  setState({ phase: 'waiting', cycle: 0, cycles })
  await waitForAck(0)
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    setState({ phase: 'burst', cycle, cycles })
    const schedule = buildBurstSchedule(rng, { burstMs, cycle, seedFiles: SEED_FILES })
    let elapsed = 0
    for (const op of schedule) {
      await sleep(op.atMs - elapsed)
      elapsed = op.atMs
      execOp(op, cycle)
    }
    // Let the last write's own FS event flush before declaring quiesce, so
    // "converge after quiesce" measures the app, not the final write's latency.
    await sleep(300)
    const truth = captureTruth(cycle)
    setState({ phase: 'quiesced', cycle, cycles, entryCount: truth.entries.length })
    await waitForAck(cycle)
  }
  setState({ phase: 'done', cycle: cycles, cycles })
}

main().catch((error) => {
  logOp({ fatal: String(error) })
  setState({ phase: 'error', error: String(error) })
  process.exit(1)
})
