/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useRef, type MouseEvent } from 'react'
import DOMPurify from 'dompurify'
import { marked, type Tokens } from 'marked'
import type { CurrentChangelogResult } from '../../types/electron.d.ts'
import type { ChangeLogDebugApi } from '../../autotest/types'
import { useI18n } from '../../i18n/useI18n'
import { useSubpageEscape } from '../../hooks/useSubpageEscape'
import { buildMermaidPlaceholder, isMermaidLang, renderMermaidDiagrams } from '../../utils/mermaidRenderer'
import { enhanceMermaidDiagrams, disposeMermaidPanZoom } from '../../utils/mermaidPanZoom'
import './ChangeLogModal.css'

interface ChangeLogModalProps {
  isOpen: boolean
  onClose: () => void
  result: CurrentChangelogResult | null
  isLoading: boolean
}

function getUnavailableMessage(
  result: CurrentChangelogResult | null,
  t: ReturnType<typeof useI18n>['t']
): string {
  if (!result) return t('changeLog.unavailable.error')
  if (result.reason === 'no-tag') return t('changeLog.unavailable.noTag')
  if (result.reason === 'entry-missing' || result.reason === 'file-missing' || result.reason === 'index-missing') {
    return t('changeLog.unavailable.missing')
  }
  return t('changeLog.unavailable.error')
}

export function ChangeLogModal({ isOpen, onClose, result, isLoading }: ChangeLogModalProps) {
  const { t } = useI18n()
  const isAutotest = Boolean(window.electronAPI?.debug?.autotest)
  const modalRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const previousActiveElementRef = useRef<HTMLElement | null>(null)

  useSubpageEscape({ isOpen, onEscape: onClose })

  useEffect(() => {
    if (!isOpen) return
    previousActiveElementRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    requestAnimationFrame(() => {
      modalRef.current?.focus()
    })
    return () => {
      const previous = previousActiveElementRef.current
      if (!previous || !document.contains(previous)) return
      requestAnimationFrame(() => {
        previous.focus()
      })
    }
  }, [isOpen])

  const contentRef = useRef<HTMLDivElement>(null)

  const renderedHtml = useMemo(() => {
    if (!result?.success) return ''
    if (result.html) return result.html
    if (!result.content) return ''
    let counter = 0
    const renderer = new marked.Renderer()
    const defaultCode = renderer.code.bind(renderer)
    renderer.code = function code(token: Tokens.Code): string {
      if (isMermaidLang(token.lang)) {
        return buildMermaidPlaceholder(token.text, `changelog-mermaid-${counter++}`)
      }
      return defaultCode(token)
    }
    const parsed = marked.parse(result.content, {
      async: false,
      gfm: true,
      renderer
    }) as string
    return DOMPurify.sanitize(parsed)
  }, [result])

  useEffect(() => {
    const el = contentRef.current
    if (!el || !renderedHtml) return
    if (el.querySelectorAll('.mermaid-diagram[data-mermaid-id]').length === 0) return
    const signal = { cancelled: false }
    void renderMermaidDiagrams(el, signal, t('mermaid.syntaxError')).then(() => {
      if (signal.cancelled) return
      enhanceMermaidDiagrams(el, signal, {
        zoomIn: t('mermaid.zoomIn'),
        zoomOut: t('mermaid.zoomOut'),
        resetZoom: t('mermaid.resetZoom'),
        fitToScreen: t('mermaid.fitToScreen'),
        fullscreen: t('mermaid.fullscreen'),
        exitFullscreen: t('mermaid.exitFullscreen'),
        dragHint: t('mermaid.dragHint')
      })
    })
    return () => {
      signal.cancelled = true
      disposeMermaidPanZoom(el)
    }
  }, [renderedHtml, t])

  const currentTag = result?.tag ?? null
  const unavailableMessage = getUnavailableMessage(result, t)

  useEffect(() => {
    if (!isAutotest) return

    const debugWindow = window as Window & { __onwardChangeLogDebug?: ChangeLogDebugApi }
    const api: ChangeLogDebugApi = {
      isOpen: () => isOpen,
      isLoading: () => isLoading,
      getCurrentTag: () => currentTag,
      getRenderedText: () => {
        const node = document.querySelector('.change-log-markdown')
        return node?.textContent?.trim() || ''
      },
      getUnavailableState: () => {
        const stateNode = document.querySelector('.change-log-modal-state')
        const titleNode = document.querySelector('.change-log-modal-state-title')
        const detailNode = document.querySelector('.change-log-modal-state-detail')
        return {
          visible: Boolean(stateNode),
          message: titleNode?.textContent?.trim() || null,
          detail: detailNode?.textContent?.trim() || null
        }
      },
      clickCloseButton: () => {
        if (!isOpen) return false
        closeButtonRef.current?.click()
        return true
      },
      clickOverlay: () => {
        if (!isOpen) return false
        overlayRef.current?.click()
        return true
      },
      pressEscape: () => {
        if (!isOpen) return false
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        return true
      }
    }

    debugWindow.__onwardChangeLogDebug = api
    return () => {
      if (debugWindow.__onwardChangeLogDebug === api) {
        delete debugWindow.__onwardChangeLogDebug
      }
    }
  }, [currentTag, isAutotest, isLoading, isOpen])

  if (!isOpen) return null

  const handleContentClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof HTMLElement
      ? event.target.closest('a[href]')
      : null
    if (!target) return
    const href = target.getAttribute('href')
    if (!href || !/^https?:\/\//i.test(href)) return
    event.preventDefault()
    void window.electronAPI.shell.openExternal(href)
  }

  return (
    <div
      className="change-log-modal-overlay"
      ref={overlayRef}
      data-testid="change-log-overlay"
    >
      <div
        className="change-log-modal"
        ref={modalRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t('changeLog.title')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="change-log-modal-header">
          <div className="change-log-modal-heading">
            <div className="change-log-modal-title">{t('changeLog.title')}</div>
            {currentTag && (
              <div className="change-log-modal-subtitle">
                {t('changeLog.currentVersion')}: {currentTag}
              </div>
            )}
          </div>
          <button
            className="change-log-modal-close"
            type="button"
            ref={closeButtonRef}
            onClick={onClose}
            title={t('changeLog.close')}
            aria-label={t('changeLog.close')}
            data-testid="change-log-close-button"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M3 3L13 13" strokeLinecap="round" />
              <path d="M13 3L3 13" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="change-log-modal-body">
          {isLoading ? (
            <div className="change-log-modal-state">{t('changeLog.loading')}</div>
          ) : result?.success ? (
            <div
              ref={contentRef}
              className="change-log-markdown"
              dangerouslySetInnerHTML={{ __html: renderedHtml }}
              onClick={handleContentClick}
            />
          ) : (
            <div className="change-log-modal-state is-error">
              <div className="change-log-modal-state-title">{unavailableMessage}</div>
              {result?.error && (
                <div className="change-log-modal-state-detail">
                  {t('changeLog.errorDetail', { error: result.error })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
