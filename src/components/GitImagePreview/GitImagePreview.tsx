/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type SyntheticEvent } from 'react'
import { trackFeatureUse } from '../../telemetry/track-feature-use'
import './GitImagePreview.css'

export type ImageDisplayMode = 'original' | 'fit'
export type ImageCompareMode = '2up' | 'swipe' | 'onion'
export type SvgViewMode = 'visual' | 'text'
export type GitImageStatus = 'added' | 'deleted' | 'modified'

export const IMAGE_DISPLAY_MODE_STORAGE_KEY = 'git-diff-image-display-mode'
export const IMAGE_COMPARE_MODE_STORAGE_KEY = 'git-diff-image-compare-mode'

export interface GitImagePreviewFileState {
  originalContent: string
  modifiedContent: string
  isBinary: boolean
  isSvg?: boolean
  originalImageUrl?: string
  modifiedImageUrl?: string
  originalImageSize?: number
  modifiedImageSize?: number
}

export interface GitImagePreviewLabels {
  statusAdded: string
  statusDeleted: string
  statusModified: string
  svg: string
  viewVisual: string
  viewText: string
  compareTwoUp: string
  compareSwipe: string
  compareOnion: string
  displayOriginal: string
  displayFit: string
  labelOriginal: string
  labelAdded: string
  labelModified: string
  opacity: string
}

interface GitImagePreviewProps {
  fileState: GitImagePreviewFileState
  status: GitImageStatus
  labels: GitImagePreviewLabels
  imageDisplayMode: ImageDisplayMode
  imageCompareMode: ImageCompareMode
  svgViewMode: SvgViewMode
  onImageDisplayModeChange: (mode: ImageDisplayMode) => void
  onImageCompareModeChange: (mode: ImageCompareMode) => void
  onSvgViewModeChange: (mode: SvgViewMode) => void
  renderSvgDiffEditor: (fileState: GitImagePreviewFileState) => ReactNode
}

function formatFileSize(dataUrl: string, sizeBytes?: number): string {
  let bytes: number
  if (sizeBytes !== undefined) {
    bytes = sizeBytes
  } else if (dataUrl.startsWith('data:')) {
    const base64Part = dataUrl.split(',')[1] || ''
    bytes = Math.ceil(base64Part.length * 3 / 4)
  } else {
    return ''
  }

  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function GitImagePreview({
  fileState,
  status,
  labels,
  imageDisplayMode,
  imageCompareMode,
  svgViewMode,
  onImageDisplayModeChange,
  onImageCompareModeChange,
  onSvgViewModeChange,
  renderSvgDiffEditor
}: GitImagePreviewProps) {
  const [imageMetadata, setImageMetadata] = useState<Record<string, { width: number; height: number }>>({})
  const [swipePercent, setSwipePercent] = useState(50)
  const [onionOpacity, setOnionOpacity] = useState(50)
  const swipeContainerRef = useRef<HTMLDivElement | null>(null)
  const swipeDraggingRef = useRef(false)

  // Product telemetry: count once per image-diff view open (mount), never per re-render.
  useEffect(() => { trackFeatureUse('image-diff') }, [])

  const handleImageLoad = useCallback((key: string, event: SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget
    setImageMetadata((prev) => {
      const current = prev[key]
      if (current?.width === image.naturalWidth && current?.height === image.naturalHeight) {
        return prev
      }
      return {
        ...prev,
        [key]: {
          width: image.naturalWidth,
          height: image.naturalHeight
        }
      }
    })
  }, [])

  const renderImagePanel = useCallback((
    label: string,
    imageUrl: string | undefined,
    panelKey: string,
    labelColor: string,
    sizeBytes?: number
  ) => {
    if (!imageUrl) return null
    const meta = imageMetadata[panelKey]
    const sizeText = formatFileSize(imageUrl, sizeBytes)
    return (
      <div className="git-diff-image-panel">
        <div className="git-diff-image-panel-header">
          <span className="git-diff-image-panel-label" style={{ color: labelColor }}>{label}</span>
        </div>
        <div className="git-diff-image-wrapper">
          <img
            src={imageUrl}
            alt={label}
            className={`git-diff-image ${imageDisplayMode}`}
            onLoad={(event) => handleImageLoad(panelKey, event)}
          />
        </div>
        {meta && (
          <div className="git-diff-image-meta">
            <span>{meta.width} × {meta.height}</span>
            {sizeText && <span>{sizeText}</span>}
          </div>
        )}
      </div>
    )
  }, [handleImageLoad, imageDisplayMode, imageMetadata])

  const handleSwipeMouseDown = useCallback((event: ReactMouseEvent) => {
    event.preventDefault()
    swipeDraggingRef.current = true

    const updatePercent = (clientX: number) => {
      const container = swipeContainerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      const x = clientX - rect.left
      const percent = Math.max(0, Math.min(100, (x / rect.width) * 100))
      setSwipePercent(percent)
    }

    const onMouseMove = (mouseEvent: MouseEvent) => {
      if (!swipeDraggingRef.current) return
      updatePercent(mouseEvent.clientX)
    }

    const onMouseUp = () => {
      swipeDraggingRef.current = false
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [])

  const renderSwipeCompare = useCallback(() => {
    return (
      <div className="git-diff-image-container single">
        <div className="git-diff-image-panel" style={{ position: 'relative' }}>
          <div className="git-diff-image-swipe" ref={swipeContainerRef}>
            <img
              src={fileState.modifiedImageUrl}
              alt={labels.labelModified}
              className="git-diff-image fit git-diff-image-swipe-after"
              onLoad={(event) => handleImageLoad('modified', event)}
            />
            <img
              src={fileState.originalImageUrl}
              alt={labels.labelOriginal}
              className="git-diff-image fit git-diff-image-swipe-before"
              style={{ clipPath: `inset(0 ${100 - swipePercent}% 0 0)` }}
              onLoad={(event) => handleImageLoad('original', event)}
            />
            <div
              className="git-diff-image-swipe-handle"
              style={{ left: `${swipePercent}%` }}
              onMouseDown={handleSwipeMouseDown}
            >
              <div className="git-diff-image-swipe-handle-grip" />
            </div>
          </div>
          <div className="git-diff-image-meta">
            <span style={{ color: '#f14c4c' }}>{labels.labelOriginal}: {swipePercent.toFixed(0)}%</span>
            <span style={{ color: '#89d185' }}>{labels.labelModified}: {(100 - swipePercent).toFixed(0)}%</span>
          </div>
        </div>
      </div>
    )
  }, [fileState.modifiedImageUrl, fileState.originalImageUrl, handleImageLoad, handleSwipeMouseDown, labels.labelModified, labels.labelOriginal, swipePercent])

  const renderOnionSkinCompare = useCallback(() => {
    return (
      <div className="git-diff-image-container single">
        <div className="git-diff-image-panel">
          <div className="git-diff-image-onion">
            <img
              src={fileState.originalImageUrl}
              alt={labels.labelOriginal}
              className="git-diff-image fit git-diff-image-onion-base"
              onLoad={(event) => handleImageLoad('original', event)}
            />
            <img
              src={fileState.modifiedImageUrl}
              alt={labels.labelModified}
              className="git-diff-image fit git-diff-image-onion-overlay"
              style={{ opacity: onionOpacity / 100 }}
              onLoad={(event) => handleImageLoad('modified', event)}
            />
          </div>
          <div className="git-diff-image-meta">
            <span>{labels.opacity}</span>
            <input
              type="range"
              className="git-diff-image-onion-slider"
              min={0}
              max={100}
              value={onionOpacity}
              onChange={(event) => setOnionOpacity(Number(event.target.value))}
            />
            <span>{onionOpacity}%</span>
          </div>
        </div>
      </div>
    )
  }, [fileState.modifiedImageUrl, fileState.originalImageUrl, handleImageLoad, labels.labelModified, labels.labelOriginal, labels.opacity, onionOpacity])

  const isAdded = status === 'added'
  const isDeleted = status === 'deleted'
  const isModified = status === 'modified'
  const showSvgToggle = Boolean(fileState.isSvg)
  const statusLabel = isAdded
    ? labels.statusAdded
    : isDeleted
      ? labels.statusDeleted
      : labels.statusModified
  const statusColor = isAdded ? '#89d185' : isDeleted ? '#f14c4c' : '#e2c08d'

  if (showSvgToggle && svgViewMode === 'text') {
    return (
      <div className="git-diff-image-preview">
        <div className="git-diff-image-toolbar">
          <span className="git-diff-image-status" style={{ color: statusColor }}>
            {statusLabel} ({labels.svg})
          </span>
          <div className="git-diff-image-mode-toggle">
            <button
              className="git-diff-image-mode-btn"
              onClick={() => onSvgViewModeChange('visual')}
            >
              {labels.viewVisual}
            </button>
            <button
              className="git-diff-image-mode-btn active"
              onClick={() => onSvgViewModeChange('text')}
            >
              {labels.viewText}
            </button>
          </div>
        </div>
        {renderSvgDiffEditor(fileState)}
      </div>
    )
  }

  return (
    <div className="git-diff-image-preview">
      <div className="git-diff-image-toolbar">
        <span className="git-diff-image-status" style={{ color: statusColor }}>
          {statusLabel}{showSvgToggle ? ` (${labels.svg})` : ''}
        </span>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {showSvgToggle && (
            <div className="git-diff-image-mode-toggle">
              <button
                className="git-diff-image-mode-btn"
                onClick={() => onSvgViewModeChange('visual')}
              >
                {labels.viewVisual}
              </button>
              <button
                className="git-diff-image-mode-btn active"
                onClick={() => onSvgViewModeChange('text')}
              >
                {labels.viewText}
              </button>
            </div>
          )}
          {isModified && (
            <div className="git-diff-image-mode-toggle">
              <button
                className={`git-diff-image-mode-btn ${imageCompareMode === '2up' ? 'active' : ''}`}
                onClick={() => onImageCompareModeChange('2up')}
              >
                {labels.compareTwoUp}
              </button>
              <button
                className={`git-diff-image-mode-btn ${imageCompareMode === 'swipe' ? 'active' : ''}`}
                onClick={() => onImageCompareModeChange('swipe')}
              >
                {labels.compareSwipe}
              </button>
              <button
                className={`git-diff-image-mode-btn ${imageCompareMode === 'onion' ? 'active' : ''}`}
                onClick={() => onImageCompareModeChange('onion')}
              >
                {labels.compareOnion}
              </button>
            </div>
          )}
          <div className="git-diff-image-mode-toggle">
            <button
              className={`git-diff-image-mode-btn ${imageDisplayMode === 'original' ? 'active' : ''}`}
              onClick={() => onImageDisplayModeChange('original')}
            >
              {labels.displayOriginal}
            </button>
            <button
              className={`git-diff-image-mode-btn ${imageDisplayMode === 'fit' ? 'active' : ''}`}
              onClick={() => onImageDisplayModeChange('fit')}
            >
              {labels.displayFit}
            </button>
          </div>
        </div>
      </div>
      {isModified && imageCompareMode === 'swipe' && fileState.originalImageUrl && fileState.modifiedImageUrl
        ? renderSwipeCompare()
        : isModified && imageCompareMode === 'onion' && fileState.originalImageUrl && fileState.modifiedImageUrl
          ? renderOnionSkinCompare()
          : (
            <div className={`git-diff-image-container ${isModified ? 'side-by-side' : 'single'}`}>
              {isDeleted && renderImagePanel(labels.labelOriginal, fileState.originalImageUrl, 'original', '#f14c4c', fileState.originalImageSize)}
              {isAdded && renderImagePanel(labels.labelAdded, fileState.modifiedImageUrl, 'modified', '#89d185', fileState.modifiedImageSize)}
              {isModified && (
                <>
                  {renderImagePanel(labels.labelOriginal, fileState.originalImageUrl, 'original', '#f14c4c', fileState.originalImageSize)}
                  {renderImagePanel(labels.labelModified, fileState.modifiedImageUrl, 'modified', '#89d185', fileState.modifiedImageSize)}
                </>
              )}
            </div>
          )}
    </div>
  )
}
