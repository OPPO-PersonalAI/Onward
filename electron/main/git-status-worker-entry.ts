/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'child_process'
import { constants } from 'fs'
import { access, stat } from 'fs/promises'
import { delimiter, isAbsolute, join, resolve } from 'path'
import { platform } from 'os'
import { parentPort } from 'worker_threads'
import { promisify } from 'util'

import {
  collectXyCategories,
  deriveTerminalGitStatus,
  type GitChangeCategory,
  type TerminalGitStatus
} from './git-status-classify'
import { startWorkerMemorySampler } from './worker-memory-sampler'

startWorkerMemorySampler('git-status')

type GitBranchAndStatus = {
  branch: string | null
  status: TerminalGitStatus
}

type GitRepoMeta = {
  gitExecutable: string | null
  repoRoot: string | null
  gitDir: string | null
  isRepo: boolean
}

type WorkerRequest = {
  id: number
  method: 'getRepoMeta' | 'getRepoFingerprint' | 'getBranchAndStatus'
  payload: Record<string, unknown>
}

type WorkerResponse = {
  id: number
  ok: boolean
  result?: unknown
  error?: string
}

const rawExecFileAsync = promisify(execFile)
const EXEC_TIMEOUT = 10000
const MAX_DIFF_OUTPUT = 10 * 1024 * 1024

let cachedGitExecutable: string | null | undefined

function getExecEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH'
  const currentPath = env[pathKey] || ''
  const extraPaths: string[] = []

  if (platform() === 'win32') {
    extraPaths.push(
      'C:\\Program Files\\Git\\cmd',
      'C:\\Program Files\\Git\\bin',
      'C:\\Program Files (x86)\\Git\\cmd',
      'C:\\Program Files (x86)\\Git\\bin'
    )
  } else {
    extraPaths.push('/usr/local/bin', '/opt/homebrew/bin', '/opt/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin')
  }

  const merged = [
    ...currentPath.split(delimiter).filter(Boolean),
    ...extraPaths
  ]
  env[pathKey] = Array.from(new Set(merged)).join(delimiter)
  return env
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, platform() === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

function normalizeGitPath(pathValue: string | null | undefined): string | null {
  if (!pathValue) return null
  return pathValue.replace(/\\/g, '/')
}

async function resolveGitExecutable(): Promise<string | null> {
  if (cachedGitExecutable !== undefined) return cachedGitExecutable

  const candidates: string[] = []
  const envGitPath = process.env.GIT_PATH
  if (envGitPath) {
    candidates.push(envGitPath)
  }

  if (platform() === 'win32') {
    candidates.push(
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files\\Git\\bin\\git.exe',
      'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
      'C:\\Program Files (x86)\\Git\\bin\\git.exe'
    )
  } else {
    candidates.push(
      '/usr/bin/git',
      '/opt/homebrew/bin/git',
      '/usr/local/bin/git',
      '/opt/local/bin/git',
      '/bin/git'
    )
  }

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      cachedGitExecutable = candidate
      return candidate
    }
  }

  try {
    await rawExecFileAsync('git', ['--version'], { timeout: EXEC_TIMEOUT, env: getExecEnv() })
    cachedGitExecutable = 'git'
    return cachedGitExecutable
  } catch {
    cachedGitExecutable = null
    return null
  }
}

async function getRepoMeta(cwd: string): Promise<GitRepoMeta> {
  const gitExecutable = await resolveGitExecutable()
  if (!gitExecutable) {
    return { gitExecutable: null, repoRoot: null, gitDir: null, isRepo: false }
  }

  try {
    const { stdout } = await rawExecFileAsync(
      gitExecutable,
      ['rev-parse', '--is-inside-work-tree', '--show-toplevel', '--git-dir'],
      {
        cwd,
        timeout: EXEC_TIMEOUT,
        env: getExecEnv()
      }
    )
    const output = String(stdout).trim()
    const lines = output.split(/\r?\n/)
    const isRepo = lines[0]?.trim() === 'true'
    if (!isRepo) {
      return { gitExecutable, repoRoot: null, gitDir: null, isRepo: false }
    }
    const repoRootRaw = lines[1]?.trim() || cwd
    const rawGitDir = lines[2]?.trim() || null
    const repoRoot = normalizeGitPath(repoRootRaw) || repoRootRaw
    const gitDir = rawGitDir
      ? (normalizeGitPath(isAbsolute(rawGitDir) ? rawGitDir : resolve(repoRootRaw, rawGitDir)) || rawGitDir)
      : null
    return { gitExecutable, repoRoot, gitDir, isRepo: true }
  } catch {
    return { gitExecutable, repoRoot: null, gitDir: null, isRepo: false }
  }
}

async function getStatToken(path: string): Promise<string> {
  try {
    const info = await stat(path)
    return `${Math.floor(info.mtimeMs)}:${info.size}`
  } catch {
    return '-'
  }
}

async function getRepoFingerprint(gitDir: string | null, repoRoot: string): Promise<string> {
  const root = gitDir || join(repoRoot, '.git')
  const [headToken, indexToken, packedRefsToken, refsToken, logsHeadToken] = await Promise.all([
    getStatToken(join(root, 'HEAD')),
    getStatToken(join(root, 'index')),
    getStatToken(join(root, 'packed-refs')),
    getStatToken(join(root, 'refs')),
    getStatToken(join(root, 'logs', 'HEAD'))
  ])
  return [headToken, indexToken, packedRefsToken, refsToken, logsHeadToken].join('|')
}

function parsePorcelainV2BranchAndStatus(output: string): GitBranchAndStatus {
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean)
  let branchHead: string | null = null
  let branchOid: string | null = null
  const categories = new Set<GitChangeCategory>()

  for (const line of lines) {
    if (line.startsWith('# branch.head ')) {
      branchHead = line.slice('# branch.head '.length).trim()
      continue
    }
    if (line.startsWith('# branch.oid ')) {
      branchOid = line.slice('# branch.oid '.length).trim()
      continue
    }
    if (line.startsWith('? ')) {
      categories.add('add')
      continue
    }
    if (line.startsWith('u ')) {
      // Unmerged record → conflict → modify (never classify its XY).
      categories.add('mod')
      continue
    }
    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const tokens = line.split(' ')
      collectXyCategories(tokens[1] || '', categories)
    }
  }

  const status = deriveTerminalGitStatus(categories)
  const detached = branchHead === '(detached)' || branchHead === 'HEAD'
  const branch = branchHead && !detached ? branchHead : (branchOid ? branchOid.slice(0, 7) : null)
  return { branch, status }
}

async function getBranchAndStatus(cwd: string, includeUntracked: boolean): Promise<GitBranchAndStatus> {
  const meta = await getRepoMeta(cwd)
  if (!meta.isRepo || !meta.repoRoot) {
    return { branch: null, status: 'unknown' }
  }

  try {
    const untrackedArg = includeUntracked ? '--untracked-files=all' : '--untracked-files=no'
    const { stdout } = await rawExecFileAsync(
      meta.gitExecutable || 'git',
      ['-c', 'core.quotepath=false', 'status', '--porcelain=2', '--branch', untrackedArg],
      {
        cwd: meta.repoRoot,
        timeout: EXEC_TIMEOUT,
        env: getExecEnv(),
        maxBuffer: MAX_DIFF_OUTPUT
      }
    )
    const output = String(stdout)
    return parsePorcelainV2BranchAndStatus(output)
  } catch {
    return { branch: null, status: 'unknown' }
  }
}

async function handleRequest(request: WorkerRequest): Promise<unknown> {
  switch (request.method) {
    case 'getRepoMeta':
      return getRepoMeta(String(request.payload.cwd || ''))
    case 'getRepoFingerprint':
      return getRepoFingerprint(
        typeof request.payload.gitDir === 'string' ? request.payload.gitDir : null,
        String(request.payload.repoRoot || '')
      )
    case 'getBranchAndStatus':
      return getBranchAndStatus(
        String(request.payload.cwd || ''),
        request.payload.includeUntracked === true
      )
    default:
      throw new Error(`Unknown Git status worker method: ${(request as { method?: string }).method}`)
  }
}

parentPort?.on('message', (request: WorkerRequest) => {
  void handleRequest(request)
    .then((result) => {
      const response: WorkerResponse = { id: request.id, ok: true, result }
      parentPort?.postMessage(response)
    })
    .catch((error) => {
      const response: WorkerResponse = {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
      parentPort?.postMessage(response)
    })
})
