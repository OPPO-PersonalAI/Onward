/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from 'react'
import type { MemoryPressureAlert } from '../../types/electron'
import { useI18n } from '../../i18n/useI18n'
import { perfTraceDiagnostic } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import './MemoryPressureNotification.css'

interface MemoryPressureNotificationProps {
  alert: MemoryPressureAlert | null
  onOpenFeedback: () => void
  onDismiss: () => void
}

/**
 * Non-blocking persistent notification for the memory diagnostics closed
 * loop (Tier 3 UX — docs/html/memory-diagnostics-closed-loop-design.html).
 * Shown at most once per session (main-side guard); stays until acted on.
 */
export function MemoryPressureNotification({
  alert,
  onOpenFeedback,
  onDismiss
}: MemoryPressureNotificationProps) {
  const { t } = useI18n()

  useEffect(() => {
    if (alert) {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_MEM_WATCH_NOTIFICATION, {
        action: 'shown',
        level: alert.level
      })
    }
  }, [alert])

  if (!alert) return null

  const detail =
    alert.footprintMb !== null
      ? t('memoryWatch.notification.messageFootprint', { footprintMb: alert.footprintMb })
      : t('memoryWatch.notification.messageHeap', { heapRatioPct: alert.heapRatioPct ?? 0 })

  return (
    <div className="memory-pressure-notification" role="status" data-testid="memory-pressure-notification">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="memory-pressure-notification-icon">
        <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm7-4h2v5H7V4Zm0 6h2v2H7v-2Z" />
      </svg>
      <div className="memory-pressure-notification-text">
        <strong>{t('memoryWatch.notification.title')}</strong>
        <span>{detail}</span>
      </div>
      <div className="memory-pressure-notification-actions">
        <button
          type="button"
          className="memory-pressure-notification-btn primary"
          data-testid="memory-pressure-open-feedback"
          onClick={() => {
            perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_MEM_WATCH_NOTIFICATION, {
              action: 'open-feedback',
              level: alert.level
            })
            onOpenFeedback()
          }}
        >
          {t('memoryWatch.notification.openFeedback')}
        </button>
        <button
          type="button"
          className="memory-pressure-notification-btn"
          data-testid="memory-pressure-dismiss"
          onClick={() => {
            perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_MEM_WATCH_NOTIFICATION, {
              action: 'dismiss',
              level: alert.level
            })
            onDismiss()
          }}
        >
          {t('memoryWatch.notification.dismiss')}
        </button>
      </div>
    </div>
  )
}
