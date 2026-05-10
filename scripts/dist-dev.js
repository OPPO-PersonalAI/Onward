#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

const { execSync, spawnSync } = require('child_process')
const { existsSync, readFileSync, readdirSync } = require('fs')
const { join } = require('path')

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function getBranchName() {
  try {
    const output = execSync('git rev-parse --abbrev-ref HEAD', {
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return output.toString().trim()
  } catch {
    return 'detached'
  }
}

function sanitizeBranchName(value) {
  let name = String(value || '').trim()
  if (!name || name === 'HEAD') {
    name = 'detached'
  }
  name = name.replace(/[^a-zA-Z0-9._-]+/g, '-')
  name = name.replace(/-+/g, '-')
  name = name.replace(/^-+|-+$/g, '')
  return name || 'branch'
}

function getPackageVersion() {
  try {
    const pkgPath = join(__dirname, '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return pkg.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function isTruthyCi() {
  const ci = process.env.CI
  return ci === 'true' || ci === '1' || Boolean(process.env.GITHUB_ACTIONS)
}

/** Whether to open the packaged app after a successful dev build. */
function shouldOpenPackagedApp() {
  if (process.env.ONWARD_DIST_DEV_OPEN === '0') return false
  if (process.env.ONWARD_DIST_DEV_OPEN === '1') return true
  return !isTruthyCi()
}

/**
 * Resolve path to the unpacked packaged app (electron-builder --dir).
 * @param {string} productName
 * @returns {string | null}
 */
function getPackagedAppPath(productName) {
  const releaseRoot = join(__dirname, '..', 'release')
  if (!existsSync(releaseRoot)) return null

  if (process.platform === 'darwin') {
    let dirNames = []
    try {
      dirNames = readdirSync(releaseRoot).filter((n) => n === 'mac' || n.startsWith('mac-'))
    } catch {
      return null
    }
    for (const dirName of dirNames) {
      const dir = join(releaseRoot, dirName)
      const direct = join(dir, `${productName}.app`)
      if (existsSync(direct)) return direct
      try {
        for (const ent of readdirSync(dir)) {
          if (ent.endsWith('.app')) return join(dir, ent)
        }
      } catch {
        /* ignore */
      }
    }
    return null
  }

  if (process.platform === 'win32') {
    const dir = join(releaseRoot, 'win-unpacked')
    const exePath = join(dir, `${productName}.exe`)
    return existsSync(exePath) ? exePath : null
  }

  const dir = join(releaseRoot, 'linux-unpacked')
  const binPath = join(dir, productName)
  return existsSync(binPath) ? binPath : null
}

/**
 * Open the packaged app in a GUI session (non-blocking where supported).
 * @param {string} appPath
 */
function openPackagedApp(appPath) {
  if (process.platform === 'darwin') {
    spawnSync('open', [appPath], { stdio: 'inherit' })
    return
  }
  if (process.platform === 'win32') {
    spawnSync('cmd', ['/c', 'start', '', appPath], { stdio: 'inherit', shell: true })
    return
  }
  spawnSync('xdg-open', [appPath], { stdio: 'inherit' })
}

const branchRaw = getBranchName()
const branch = sanitizeBranchName(branchRaw)
const version = getPackageVersion()
const productName = `Under Development ${version}-${branch}`

run('node', [join(__dirname, 'check-chinese-comments.js')])
run('node', [join(__dirname, 'compile-changelog.js')])
run('pnpm', ['typecheck'])
// Generate third-party license notices for binary distribution
run('pnpm', ['generate-notices'])
run('node', [join(__dirname, 'ensure-node-pty-spawn-helper.js')])
run('electron-vite', ['build'])
// On Windows with shell: true, arguments containing spaces must be quoted
const q = process.platform === 'win32' ? '"' : ''
run('electron-builder', [
  `${q}-c.productName=${productName}${q}`,
  `${q}-c.executableName=${productName}${q}`,
  `${q}-c.extraMetadata.productName=${productName}${q}`,
  '-c.extraMetadata.buildChannel=dev',
  `${q}-c.extraMetadata.branch=${branch}${q}`,
  '-c.npmRebuild=false',
  '--dir'
])

if (!shouldOpenPackagedApp()) {
  if (process.env.ONWARD_DIST_DEV_OPEN === '0') {
    console.log('[dist:dev] Skipping packaged app launch (ONWARD_DIST_DEV_OPEN=0)')
  } else {
    console.log('[dist:dev] Skipping packaged app launch (CI); set ONWARD_DIST_DEV_OPEN=1 to force')
  }
} else {
  const appPath = getPackagedAppPath(productName)
  if (appPath) {
    console.log(`[dist:dev] Opening packaged app: ${appPath}`)
    openPackagedApp(appPath)
  } else {
    console.warn('[dist:dev] Packaged app not found under release/; skip auto-launch')
  }
}
