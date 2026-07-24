/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared WebGL surface/pixel probes for autotest suites. Extracted from
 * test-terminal-focus-activation.ts so the GPU real-kill recovery suite
 * (test-gpu-real-kill-recovery.ts) asserts against the exact same
 * renderable-pixels definition TFA pinned — one probe contract, two suites.
 */

export type WebglContext = WebGLRenderingContext | WebGL2RenderingContext

export interface WebglSurfaceProbe {
  canvas: HTMLCanvasElement
  gl: WebglContext
}

export interface WebglPixelStats {
  width: number
  height: number
  sampledPixels: number
  nonZeroPixels: number
  alphaPixels: number
  maxChannel: number
  checksum: number
  nonZeroRatio: number
  intensityMean: number
  intensityVariance: number
}

export const escapeCssIdent = (value: string) => {
  const css = window.CSS as (typeof window.CSS & { escape?: (value: string) => string }) | undefined
  return css?.escape ? css.escape(value) : value.replace(/["\\]/g, '\\$&')
}

export const findWebglSurface = (terminalId: string): WebglSurfaceProbe | null => {
  const cell = document.querySelector<HTMLElement>(`.terminal-grid-cell[data-terminal-id="${escapeCssIdent(terminalId)}"]`)
  if (!cell) return null

  const canvases = Array.from(cell.querySelectorAll<HTMLCanvasElement>('.xterm-screen canvas'))
  for (const canvas of canvases) {
    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 1 || rect.height <= 1 || canvas.width <= 1 || canvas.height <= 1) {
      continue
    }

    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    if (gl && !gl.isContextLost()) {
      return { canvas, gl }
    }
  }

  return null
}

export const readWebglPixels = (gl: WebglContext): WebglPixelStats => {
  const width = gl.drawingBufferWidth
  const height = gl.drawingBufferHeight
  const pixels = new Uint8Array(width * height * 4)

  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.finish()
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)

  let nonZeroPixels = 0
  let alphaPixels = 0
  let maxChannel = 0
  let checksum = 0
  let intensitySum = 0
  let intensitySquaredSum = 0

  for (let index = 0; index < pixels.length; index += 4) {
    const r = pixels[index]
    const g = pixels[index + 1]
    const b = pixels[index + 2]
    const a = pixels[index + 3]
    const pixelMax = Math.max(r, g, b, a)
    const intensity = r + g + b
    intensitySum += intensity
    intensitySquaredSum += intensity * intensity
    if (pixelMax > 8) {
      nonZeroPixels += 1
      checksum = ((checksum * 31) + r + (g * 3) + (b * 7) + (a * 11)) >>> 0
    }
    if (a > 8) {
      alphaPixels += 1
    }
    if (pixelMax > maxChannel) {
      maxChannel = pixelMax
    }
  }

  const sampledPixels = width * height
  const intensityMean = sampledPixels > 0 ? intensitySum / sampledPixels : 0
  const intensityVariance = sampledPixels > 0
    ? Math.max(0, (intensitySquaredSum / sampledPixels) - (intensityMean * intensityMean))
    : 0

  return {
    width,
    height,
    sampledPixels,
    nonZeroPixels,
    alphaPixels,
    maxChannel,
    checksum,
    nonZeroRatio: sampledPixels > 0 ? nonZeroPixels / sampledPixels : 0,
    intensityMean,
    intensityVariance
  }
}

export const hasRenderablePixels = (stats: WebglPixelStats) => {
  return stats.maxChannel > 8 && stats.intensityVariance > 0.05
}
