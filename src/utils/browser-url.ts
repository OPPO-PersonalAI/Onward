/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Pure, Electron-free helpers for the Open Browser panel.
//
// Two concerns live here:
//   1. Resolving free-form address-bar input (URL / search / local file path / local host)
//      into a single loadable URL string.
//   2. Computing the Auto Refresh interval from a value + unit, with the product floor.
//
// Path handling deliberately normalizes BOTH separators ('/' and '\\') explicitly instead
// of using Node's platform-specific `path`/`sep`, so the same logic is deterministic when
// unit-tested on macOS, Linux, and Windows CI alike.

export const AUTO_REFRESH_MIN_INTERVAL_MS = 5000

// Preset intervals (ms) shown in the Auto Refresh native menu. The smallest is the 5s product
// floor; the ladder spans seconds and minutes. `null` interval = Auto Refresh off.
export const AUTO_REFRESH_PRESETS_MS: number[] = [5000, 10000, 30000, 60000, 300000, 600000, 1800000]

/**
 * Defensive clamp for an auto-refresh interval: null/invalid/non-positive -> null (off);
 * otherwise floored to the 5s product minimum and rounded to whole ms.
 */
export function clampAutoRefreshIntervalMs(ms: unknown): number | null {
  if (ms == null) return null
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null
  return Math.max(AUTO_REFRESH_MIN_INTERVAL_MS, Math.round(ms))
}

/** Compact label for the toolbar badge / menu: "5s", "30s", "1m", "5m", "30m". */
export function formatAutoRefreshInterval(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  return `${Math.round(ms / 1000)}s`
}

/** Per-segment encode that preserves '/' separators and is safe for spaces / non-ASCII names. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment)
}

/**
 * True when the input looks like an absolute local filesystem path:
 *   - POSIX absolute: "/Users/me/x.html"
 *   - Windows drive:  "C:\\x.html" or "C:/x.html"
 *   - UNC:            "\\\\server\\share\\x.html"
 * (Home-relative "~" is expanded by the caller before this is consulted.)
 */
export function looksLikeLocalPath(input: string): boolean {
  if (!input) return false
  if (/^[A-Za-z]:[\\/]/.test(input)) return true // Windows drive
  if (input.startsWith('\\\\')) return true // UNC
  if (input.startsWith('/') && !input.startsWith('//')) return true // POSIX absolute (not protocol-relative)
  return false
}

/**
 * Convert an absolute local path to a `file://` URL with per-segment encoding.
 * Returns null when the input is not an absolute path we recognize.
 */
export function localPathToFileUrl(absPath: string): string | null {
  if (!absPath) return null
  const p = absPath.replace(/\\/g, '/')

  // UNC: "\\\\server\\share\\x" -> "//server/share/x" -> file://server/share/x
  if (p.startsWith('//')) {
    const segments = p.replace(/^\/+/, '').split('/').map(encodeSegment)
    return `file://${segments.join('/')}`
  }

  // Windows drive with a path: C:/Users/x -> file:///C:/Users/x
  const driveWithPath = /^([A-Za-z]):\/(.*)$/.exec(p)
  if (driveWithPath) {
    const drive = driveWithPath[1].toUpperCase()
    const segments = driveWithPath[2].split('/').map(encodeSegment)
    return `file:///${drive}:/${segments.join('/')}`
  }

  // Windows drive root only: C: or C:/
  const driveRoot = /^([A-Za-z]):\/?$/.exec(p)
  if (driveRoot) {
    return `file:///${driveRoot[1].toUpperCase()}:/`
  }

  // POSIX absolute: "/Users/x" -> ['', 'Users', 'x'] -> file:///Users/x
  if (p.startsWith('/')) {
    const segments = p.split('/').map(encodeSegment)
    return `file://${segments.join('/')}`
  }

  return null
}

/**
 * True for hosts that should default to the `http://` scheme when typed without one:
 * localhost, IPv4 loopback/private/link-local, 0.0.0.0, and IPv6 loopback/ULA.
 */
export function isLocalOrPrivateHost(host: string): boolean {
  if (!host) return false
  let h = host.trim().toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1) // [::1] -> ::1

  if (h === 'localhost' || h.endsWith('.localhost')) return true

  // IPv6 loopback + unique-local (fc00::/7 => fc.. / fd..)
  if (h === '::1') return true
  if (h.includes(':') && /^f[cd][0-9a-f:]*$/.test(h)) return true

  // IPv4
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (m) {
    const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
    if (octets.some((n) => n > 255)) return false
    const [a, b] = octets
    if (a === 127) return true // loopback
    if (a === 10) return true // private
    if (a === 192 && b === 168) return true // private
    if (a === 172 && b >= 16 && b <= 31) return true // private
    if (a === 169 && b === 254) return true // link-local
    if (a === 0) return true // 0.0.0.0
    return false
  }

  return false
}

/** Split a scheme-less authority+rest into its host (for scheme selection) and remainder. */
function splitAuthority(input: string): { authority: string; host: string } | null {
  const m = /^([^/?#]+)(?:[/?#].*)?$/.exec(input)
  if (!m) return null
  const authority = m[1]

  // IPv6: [::1] or [::1]:3000
  const v6 = /^(\[[^\]]+\])(?::\d+)?$/.exec(authority)
  if (v6) return { authority, host: v6[1] }

  // host or host:port
  const hp = /^([^:]+)(?::(\d+))?$/.exec(authority)
  if (hp) return { authority, host: hp[1] }

  return { authority, host: authority }
}

/** Decide whether a scheme-less token should be treated as a host (URL) vs a search query. */
function isHostLike(host: string, authority: string): boolean {
  if (isLocalOrPrivateHost(host)) return true
  if (host.startsWith('[') && host.endsWith(']')) return true // bracketed IPv6
  if (/^[^\s.]+(\.[^\s.]+)+$/.test(host)) return true // has a dot, e.g. example.com / a.b.c
  if (/:\d+$/.test(authority) && /^[a-z0-9-]+$/i.test(host)) return true // host:port, bare hostname
  return false
}

export interface ResolveBrowserInputOptions {
  /** Home directory used to expand a leading "~" (supplied by the main process). */
  homeDir?: string
}

/**
 * Resolve free-form address-bar input into a single loadable URL.
 * Priority: explicit scheme > file:// > ~ expansion > local path > local-host http >
 *           public-domain https > search query. Returns null only for empty input.
 */
export function resolveBrowserInputToUrl(input: string, opts: ResolveBrowserInputOptions = {}): string | null {
  const trimmed = (input ?? '').trim()
  if (!trimmed) return null
  if (/^about:blank$/i.test(trimmed)) return 'about:blank'

  // Explicit http(s): normalize.
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).toString()
    } catch {
      return null
    }
  }

  // Explicit file://: pass through (normalized when parseable).
  if (/^file:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).toString()
    } catch {
      return trimmed
    }
  }

  // Other explicit schemes we allow to pass through.
  if (/^(data|blob):/i.test(trimmed)) return trimmed

  // "~" / "~/..." home expansion -> absolute path -> file://
  if (opts.homeDir && (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\'))) {
    const home = opts.homeDir.replace(/[\\/]+$/, '')
    const rest = trimmed === '~' ? '' : trimmed.slice(1) // keep the leading separator
    const fileUrl = localPathToFileUrl(`${home}${rest}`)
    if (fileUrl) return fileUrl
  }

  // Absolute local filesystem path -> file://
  if (looksLikeLocalPath(trimmed)) {
    const fileUrl = localPathToFileUrl(trimmed)
    if (fileUrl) return fileUrl
  }

  // Host-like token (domain / localhost / IP, optional :port and /path).
  const split = splitAuthority(trimmed)
  if (split && isHostLike(split.host, split.authority)) {
    const scheme = isLocalOrPrivateHost(split.host) ? 'http' : 'https'
    try {
      return new URL(`${scheme}://${trimmed}`).toString()
    } catch {
      // fall through to search
    }
  }

  // Fallback: treat as a search query.
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}
