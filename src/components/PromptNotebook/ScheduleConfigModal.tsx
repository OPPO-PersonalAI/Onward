/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useMemo, useEffect } from 'react'
import type { Prompt } from '../../types/electron.d.ts'
import type { PromptSchedule, ScheduleType } from '../../types/tab.d.ts'
import type { TerminalInfo } from '../../types/prompt'
import { computeNextExecution } from '../../utils/schedule'
import { useI18n } from '../../i18n/useI18n'
import { useModalOpenRegistration } from '../../hooks/useModalEscape'
import { trackFeatureUse } from '../../telemetry/track-feature-use'
import './ScheduleConfigModal.css'

interface ScheduleConfigModalProps {
  prompt: Prompt
  terminals: TerminalInfo[]
  tabId: string
  /** Existing scheduled tasks (edit mode) */
  existingSchedule?: PromptSchedule | null
  onConfirm: (schedule: Omit<PromptSchedule, 'executedCount' | 'createdAt' | 'lastExecutedAt' | 'missedExecutions'>) => void
  onCancel: () => void
}

/**
 * Format execution log time
 */
function formatLogTime(timestamp: number): string {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${month}/${day} ${hours}:${minutes}:${seconds}`
}

/**
 * Default value for formatting datetime-local input
 */
function formatDateTimeLocal(timestamp: number): string {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

export function ScheduleConfigModal({
  prompt,
  terminals,
  tabId,
  existingSchedule,
  onConfirm,
  onCancel
}: ScheduleConfigModalProps) {
  const { t } = useI18n()
  const isEditing = !!existingSchedule

  // target terminal
  const [selectedTerminalIds, setSelectedTerminalIds] = useState<string[]>(() =>
    existingSchedule?.targetTerminalIds ?? (terminals.length > 0 ? [terminals[0].id] : [])
  )

  // Timing mode
  const [scheduleType, setScheduleType] = useState<ScheduleType>(
    existingSchedule?.scheduleType ?? 'relative'
  )

  // absolute time
  const [absoluteTime, setAbsoluteTime] = useState(() =>
    formatDateTimeLocal(existingSchedule?.absoluteTime ?? Date.now() + 60 * 60 * 1000)
  )

  // Relative time (minutes)
  const [relativeMinutes, setRelativeMinutes] = useState(() => {
    if (existingSchedule?.relativeOffsetMs) {
      return String(Math.round(existingSchedule.relativeOffsetMs / 60000))
    }
    return '5'
  })

  // Period configuration (interval mode)
  const [recurStartTime, setRecurStartTime] = useState(() => {
    if (existingSchedule?.recurrence?.startTime) {
      return formatDateTimeLocal(existingSchedule.recurrence.startTime)
    }
    return formatDateTimeLocal(Date.now() + 60 * 60 * 1000)
  })
  const [intervalValue, setIntervalValue] = useState(() => {
    if (existingSchedule?.recurrence?.intervalMs) {
      const ms = existingSchedule.recurrence.intervalMs
      return ms >= 3600000 && ms % 3600000 === 0
        ? String(ms / 3600000) : String(Math.round(ms / 60000))
    }
    return '60'
  })
  const [intervalUnit, setIntervalUnit] = useState<'minutes' | 'hours'>(() => {
    if (existingSchedule?.recurrence?.intervalMs) {
      const ms = existingSchedule.recurrence.intervalMs
      if (ms >= 3600000 && ms % 3600000 === 0) return 'hours'
    }
    return 'minutes'
  })

  // Validation error
  const validationError = useMemo(() => {
    if (selectedTerminalIds.length === 0) {
      return t('scheduleModal.validation.noTerminals')
    }
    if (scheduleType === 'absolute') {
      const ts = new Date(absoluteTime).getTime()
      if (isNaN(ts) || ts <= Date.now()) {
        return t('scheduleModal.validation.absoluteFuture')
      }
    }
    if (scheduleType === 'relative') {
      const mins = Number(relativeMinutes)
      if (!Number.isFinite(mins) || mins <= 0) {
        return t('scheduleModal.validation.relativePositive')
      }
    }
    if (scheduleType === 'recurring') {
      const n = Number(intervalValue)
      if (!Number.isFinite(n) || n <= 0) return t('scheduleModal.validation.intervalPositive')
      const ms = intervalUnit === 'hours' ? n * 3600000 : n * 60000
      if (ms < 60000) return t('scheduleModal.validation.intervalMin')
      if (isNaN(new Date(recurStartTime).getTime())) return t('scheduleModal.validation.startTimeValid')
    }
    return null
  }, [selectedTerminalIds, scheduleType, absoluteTime, relativeMinutes, intervalValue, intervalUnit, recurStartTime, t])

  // Switch terminal selection
  const toggleTerminal = useCallback((terminalId: string) => {
    setSelectedTerminalIds(prev =>
      prev.includes(terminalId)
        ? prev.filter(id => id !== terminalId)
        : [...prev, terminalId]
    )
  }, [])


  // Confirm submission
  const handleConfirm = useCallback(() => {
    if (validationError) return

    const now = Date.now()
    const base: Omit<PromptSchedule, 'executedCount' | 'createdAt' | 'lastExecutedAt' | 'missedExecutions'> = {
      promptId: prompt.id,
      tabId,
      targetTerminalIds: selectedTerminalIds,
      scheduleType,
      maxExecutions: scheduleType === 'recurring' ? null : 1,
      nextExecutionAt: 0,
      status: existingSchedule?.status === 'paused' ? 'paused' : 'active',
      lastError: null
    }

    switch (scheduleType) {
      case 'absolute': {
        base.absoluteTime = new Date(absoluteTime).getTime()
        base.nextExecutionAt = base.absoluteTime
        break
      }
      case 'relative': {
        base.relativeOffsetMs = Number(relativeMinutes) * 60 * 1000
        base.nextExecutionAt = now + base.relativeOffsetMs
        break
      }
      case 'recurring': {
        const n = Number(intervalValue)
        const intervalMs = intervalUnit === 'hours' ? n * 3600000 : n * 60000
        const startTs = new Date(recurStartTime).getTime()
        base.recurrence = { startTime: startTs, intervalMs }
        base.nextExecutionAt = computeNextExecution({
          ...base,
          executedCount: 0,
          createdAt: now,
          lastExecutedAt: null,
          missedExecutions: 0
        } as PromptSchedule, now)
        break
      }
    }

    // Schedule create/update confirmed (validation already passed above).
    trackFeatureUse('schedule-create')
    onConfirm(base)
  }, [validationError, prompt.id, tabId, selectedTerminalIds, scheduleType, absoluteTime, relativeMinutes, intervalValue, intervalUnit, recurStartTime, onConfirm])

  // Suppress subpage-host capture-phase Escape while this modal is open
  // (its own window keydown below keeps handling Escape + Enter).
  useModalOpenRegistration(true)

  // shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      } else if (e.key === 'Enter' && !validationError) {
        e.preventDefault()
        handleConfirm()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel, handleConfirm, validationError])

  const displayText = prompt.title || prompt.content.slice(0, 80)

  return (
    <div className="confirm-dialog-overlay">
      <div className="confirm-dialog schedule-modal" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-dialog-title">
          {isEditing ? t('scheduleModal.title.edit') : t('scheduleModal.title.create')}
        </div>

        {/* Prompt preview */}
        <div className="schedule-modal-prompt-preview">
          {displayText}
        </div>

        {/* Target terminal selection */}
        <div className="schedule-modal-section">
          <div className="schedule-modal-section-title">{t('scheduleModal.targetTerminals')}</div>
          <div className="schedule-modal-terminals">
            {terminals.map(terminal => {
              const selected = selectedTerminalIds.includes(terminal.id)
              return (
                <div
                  key={terminal.id}
                  className={`schedule-modal-terminal ${selected ? 'selected' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected}
                  onClick={() => toggleTerminal(terminal.id)}
                >
                  {terminal.title}
                </div>
              )
            })}
            {terminals.length === 0 && (
              <span style={{ color: 'var(--text-3)', fontSize: 'var(--font-sm)' }}>{t('scheduleModal.noTerminals')}</span>
            )}
          </div>
        </div>

        {/* Timing mode */}
        <div className="schedule-modal-section">
          <div className="schedule-modal-section-title">{t('scheduleModal.type')}</div>
          <div className="schedule-modal-type-options">
            <button
              className={`schedule-modal-type-option ${scheduleType === 'absolute' ? 'selected' : ''}`}
              onClick={() => setScheduleType('absolute')}
            >
              {t('scheduleModal.type.absolute')}
            </button>
            <button
              className={`schedule-modal-type-option ${scheduleType === 'relative' ? 'selected' : ''}`}
              onClick={() => setScheduleType('relative')}
            >
              {t('scheduleModal.type.relative')}
            </button>
            <button
              className={`schedule-modal-type-option ${scheduleType === 'recurring' ? 'selected' : ''}`}
              onClick={() => setScheduleType('recurring')}
            >
              {t('scheduleModal.type.recurring')}
            </button>
          </div>

          {/* Configuration area */}
          <div className="schedule-modal-config">
            {scheduleType === 'absolute' && (
              <div className="schedule-modal-config-row">
                <span>{t('scheduleModal.executeAt')}</span>
                <input
                  type="datetime-local"
                  className="schedule-modal-input schedule-modal-input-datetime"
                  value={absoluteTime}
                  onChange={(e) => setAbsoluteTime(e.target.value)}
                />
              </div>
            )}

            {scheduleType === 'relative' && (
              <div className="schedule-modal-config-row">
                <input
                  type="number"
                  min={1}
                  className="schedule-modal-input schedule-modal-input-number"
                  value={relativeMinutes}
                  onChange={(e) => setRelativeMinutes(e.target.value)}
                />
                <span>{t('scheduleModal.executeAfterMinutes')}</span>
              </div>
            )}

            {scheduleType === 'recurring' && (
              <>
                <div className="schedule-modal-config-row">
                  <span>{t('scheduleModal.startTime')}</span>
                  <input
                    type="datetime-local"
                    className="schedule-modal-input schedule-modal-input-datetime"
                    value={recurStartTime}
                    onChange={(e) => setRecurStartTime(e.target.value)}
                  />
                </div>
                <div className="schedule-modal-config-row">
                  <span>{t('scheduleModal.interval')}</span>
                  <input
                    type="number"
                    min={1}
                    className="schedule-modal-input schedule-modal-input-number"
                    value={intervalValue}
                    onChange={(e) => setIntervalValue(e.target.value)}
                  />
                  <div className="onward-select-shell">
                    <select
                      className="schedule-modal-input schedule-modal-input-select onward-select onward-select--compact"
                      value={intervalUnit}
                      onChange={(e) => setIntervalUnit(e.target.value as 'minutes' | 'hours')}
                    >
                      <option value="minutes">{t('scheduleModal.unit.minutes')}</option>
                      <option value="hours">{t('scheduleModal.unit.hours')}</option>
                    </select>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* execution history */}
        {isEditing && existingSchedule?.executionLog && existingSchedule.executionLog.length > 0 && (
          <div className="schedule-modal-section">
            <div className="schedule-modal-section-title">
              {t('scheduleModal.executionHistory', { count: existingSchedule.executionLog.length })}
            </div>
            <div className="schedule-modal-log">
              {[...existingSchedule.executionLog].reverse().map((entry, idx) => (
                <div
                  key={idx}
                  className={`schedule-modal-log-entry ${entry.success ? 'success' : 'failed'}`}
                >
                  <span className="schedule-modal-log-status">
                    {entry.success ? '✓' : '✗'}
                  </span>
                  <span className="schedule-modal-log-time">
                    {formatLogTime(entry.timestamp)}
                  </span>
                  {entry.error && (
                    <span className="schedule-modal-log-error">{entry.error}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Validation error message */}
        {validationError && (
          <div className="schedule-modal-error">{validationError}</div>
        )}

        {/* Action button */}
        <div className="confirm-dialog-actions">
          <button className="confirm-dialog-btn cancel" onClick={onCancel}>
            {t('scheduleModal.cancel')}
          </button>
          <button
            className="confirm-dialog-btn confirm"
            onClick={handleConfirm}
            disabled={!!validationError}
          >
            {t('scheduleModal.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
