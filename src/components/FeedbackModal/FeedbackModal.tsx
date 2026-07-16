/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  FEEDBACK_MAX_DESCRIPTION_LENGTH,
  FEEDBACK_MAX_TITLE_LENGTH,
  type FeedbackRating,
  type FeedbackRecord,
  type FeedbackState,
  type FeedbackSyncStatus,
  type FeedbackType
} from '../../types/feedback'
import { useI18n } from '../../i18n/useI18n'
import { requestOpenExternalHttpLink } from '../../utils/externalLink'
import { useSubpageEscape } from '../../hooks/useSubpageEscape'
import './FeedbackModal.css'

interface FeedbackModalProps {
  isOpen: boolean
  onClose: () => void
}

type FeedbackTab = 'submit' | 'history'

function StarIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={`feedback-star-icon ${active ? 'active' : ''}`} aria-hidden="true">
      <path d="M12 2.7 14.91 8.6l6.52.95-4.72 4.6 1.11 6.48L12 17.58 6.18 20.63l1.11-6.48-4.72-4.6 6.52-.95L12 2.7Z" />
    </svg>
  )
}

function getStatusTone(status: FeedbackSyncStatus): 'pending' | 'positive' | 'neutral' | 'negative' {
  switch (status) {
    case 'accepted':
    case 'in_progress':
      return 'positive'
    case 'completed':
      return 'neutral'
    case 'not_planned':
    case 'duplicate':
    case 'unavailable_on_github':
      return 'negative'
    default:
      return 'pending'
  }
}

function getStatusTranslationKey(status: FeedbackSyncStatus) {
  switch (status) {
    case 'accepted':
      return 'feedback.status.accepted'
    case 'in_progress':
      return 'feedback.status.inProgress'
    case 'completed':
      return 'feedback.status.completed'
    case 'not_planned':
      return 'feedback.status.notPlanned'
    case 'duplicate':
      return 'feedback.status.duplicate'
    case 'unavailable_on_github':
      return 'feedback.status.unavailable'
    case 'submitted':
      return 'feedback.status.submitted'
    default:
      return 'feedback.status.pending'
  }
}

export function FeedbackModal({ isOpen, onClose }: FeedbackModalProps) {
  const { t, locale } = useI18n()
  const modalRef = useRef<HTMLDivElement>(null)
  const hasPreloadedHistoryRef = useRef(false)
  const hasSyncedOnOpenRef = useRef(false)
  const [activeTab, setActiveTab] = useState<FeedbackTab>('submit')
  const [rating, setRating] = useState<FeedbackRating>(0)
  const [type, setType] = useState<FeedbackType>('bug')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [publicConsentAccepted, setPublicConsentAccepted] = useState(false)
  const [feedbackState, setFeedbackState] = useState<FeedbackState | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [submitNotice, setSubmitNotice] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isLoadingHistory, setIsLoadingHistory] = useState(false)
  const [isSyncingHistory, setIsSyncingHistory] = useState(false)
  // Diagnostic bundle export — independent flow from form submit. Status
  // drives an inline message under the button so the user sees the
  // outcome without a separate toast surface.
  //
  // `verifyFailed` is distinct from `error`: the ZIP IS on disk (path
  // is set) but the closed-loop self-verification flagged it as
  // suspect. We keep the file (the user can still inspect it) and
  // surface the failing checks so they know not to share it.
  type BundleStatus = 'idle' | 'generating' | 'success' | 'verifyFailed' | 'error' | 'canceled'
  const [bundleStatus, setBundleStatus] = useState<BundleStatus>('idle')
  const [bundleMessage, setBundleMessage] = useState<string | null>(null)

  useSubpageEscape({ isOpen, onEscape: onClose })

  const formatTimestamp = useMemo(() => {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short'
    })
  }, [locale])

  const historyRecords = feedbackState?.records ?? []
  const loadHistory = useCallback(async () => {
    setHistoryError(null)
    setIsLoadingHistory(true)
    try {
      const state = await window.electronAPI.feedback.load()
      startTransition(() => {
        setFeedbackState(state)
      })
      return state
    } catch (error) {
      setHistoryError(String(error))
      return null
    } finally {
      setIsLoadingHistory(false)
    }
  }, [])

  const syncHistory = useCallback(async (force = false, recordId?: string) => {
    setHistoryError(null)
    setIsSyncingHistory(true)
    try {
      const state = await window.electronAPI.feedback.sync(recordId, force)
      startTransition(() => {
        setFeedbackState(state)
      })
      return state
    } catch (error) {
      setHistoryError(String(error))
      return null
    } finally {
      setIsSyncingHistory(false)
    }
  }, [])

  useEffect(() => {
    if (hasPreloadedHistoryRef.current) {
      return
    }
    hasPreloadedHistoryRef.current = true
    const timer = window.setTimeout(() => {
      void loadHistory()
    }, 0)
    return () => {
      window.clearTimeout(timer)
    }
  }, [loadHistory])

  useEffect(() => {
    if (!isOpen) {
      hasSyncedOnOpenRef.current = false
      return
    }
    const frameId = window.requestAnimationFrame(() => {
      modalRef.current?.focus()
    })
    if (hasSyncedOnOpenRef.current) {
      return () => {
        window.cancelAnimationFrame(frameId)
      }
    }
    hasSyncedOnOpenRef.current = true
    void syncHistory(false)
    return () => {
      window.cancelAnimationFrame(frameId)
    }
  }, [isOpen, syncHistory])

  useEffect(() => {
    if (!feedbackState) {
      return
    }
    setPublicConsentAccepted(feedbackState.preferences.publicConsentAccepted)
  }, [feedbackState])


  const resetForm = useCallback(() => {
    setRating(0)
    setType('bug')
    setTitle('')
    setDescription('')
    setPublicConsentAccepted(feedbackState?.preferences.publicConsentAccepted ?? false)
    setFormError(null)
  }, [feedbackState?.preferences.publicConsentAccepted])

  const handleConsentChange = useCallback(async (checked: boolean) => {
    setPublicConsentAccepted(checked)
    try {
      const nextState = await window.electronAPI.feedback.updatePreferences({
        publicConsentAccepted: checked
      })
      startTransition(() => {
        setFeedbackState(nextState)
      })
    } catch (error) {
      setHistoryError(String(error))
    }
  }, [])

  const handleGenerateDiagnosticBundle = useCallback(async () => {
    setBundleStatus('generating')
    setBundleMessage(null)
    try {
      const result = await window.electronAPI.feedback.exportDiagnosticBundle()
      if (result.canceled) {
        setBundleStatus('canceled')
        setBundleMessage(t('feedback.diagnosticBundle.canceled'))
        return
      }
      if (result.success && result.path) {
        setBundleStatus('success')
        setBundleMessage(t('feedback.diagnosticBundle.success', { path: result.path }))
        return
      }
      // ZIP wrote but self-verification rejected it: keep the file on
      // disk, but surface the failing checks loudly so the user does
      // not unknowingly share a suspect bundle.
      if (!result.success && result.path && result.verification && !result.verification.ok) {
        const failedChecks = result.verification.checks
          .filter((c) => !c.passed)
          .map((c) => c.name)
          .join(', ')
        setBundleStatus('verifyFailed')
        setBundleMessage(
          t('feedback.diagnosticBundle.verifyFailed', {
            path: result.path,
            checks: failedChecks
          })
        )
        return
      }
      setBundleStatus('error')
      setBundleMessage(t('feedback.diagnosticBundle.error', { error: result.error ?? 'unknown' }))
    } catch (error) {
      setBundleStatus('error')
      setBundleMessage(t('feedback.diagnosticBundle.error', { error: String(error) }))
    }
  }, [t])

  const handleSubmit = useCallback(async () => {
    setFormError(null)
    setSubmitNotice(null)

    if (!title.trim()) {
      setFormError(t('feedback.validation.title'))
      return
    }
    if (!description.trim()) {
      setFormError(t('feedback.validation.description'))
      return
    }
    if (!publicConsentAccepted) {
      setFormError(t('feedback.validation.publicConsent'))
      return
    }

    setIsSubmitting(true)
    try {
      const result = await window.electronAPI.feedback.createSubmission({
        rating,
        type,
        title,
        description,
        publicConsentAccepted,
        locale
      })

      if (!result.success || !result.record) {
        setFormError(result.error || t('feedback.submitFailed'))
        return
      }

      const latestState = await window.electronAPI.feedback.load()
      startTransition(() => {
        setFeedbackState(latestState)
      })
      setActiveTab('history')
      resetForm()
      setSubmitNotice(t('feedback.submitOpened'))
      void syncHistory(false, result.record.id)
    } catch (error) {
      setFormError(String(error))
    } finally {
      setIsSubmitting(false)
    }
  }, [description, locale, publicConsentAccepted, rating, resetForm, syncHistory, t, title, type])

  const handleReopenPending = useCallback(async (recordId: string) => {
    const result = await window.electronAPI.feedback.reopenInBrowser(recordId)
    if (!result.success) {
      setHistoryError(result.error || t('feedback.reopenFailed'))
      return
    }
    setSubmitNotice(t('feedback.submitOpened'))
    void syncHistory(false, recordId)
  }, [syncHistory, t])

  const handleOpenIssue = useCallback(async (record: FeedbackRecord) => {
    if (!record.issueUrl) {
      return
    }
    const result = await requestOpenExternalHttpLink(record.issueUrl)
    if (!result.success && result.error && !result.canceled && !result.blocked) {
      setHistoryError(result.error)
    }
  }, [])

  const handleRefresh = useCallback(() => {
    void syncHistory(true)
  }, [syncHistory])

  const handleRemoveRecord = useCallback(async (recordId: string) => {
    setHistoryError(null)
    try {
      const nextState = await window.electronAPI.feedback.removeRecord(recordId)
      startTransition(() => {
        setFeedbackState(nextState)
      })
    } catch (error) {
      setHistoryError(String(error))
    }
  }, [])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      onClose()
      return
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && activeTab === 'submit') {
      event.preventDefault()
      void handleSubmit()
    }
  }, [activeTab, handleSubmit, onClose])

  return (
    <div
      className={`feedback-modal-overlay ${isOpen ? 'is-open' : 'is-hidden'}`}
      data-testid="feedback-modal-overlay"
      data-feedback-open={isOpen ? 'true' : 'false'}
      aria-hidden={!isOpen}
    >
      <div
        className={`feedback-modal ${isOpen ? 'is-open' : 'is-hidden'}`}
        ref={modalRef}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
        data-testid="feedback-modal"
        data-feedback-open={isOpen ? 'true' : 'false'}
        aria-hidden={!isOpen}
      >
        <div className="feedback-modal-header">
          <div>
            <h3 className="feedback-modal-title">{t('feedback.title')}</h3>
            <p className="feedback-modal-subtitle">{t('feedback.subtitle')}</p>
          </div>
          <button className="feedback-modal-close" onClick={onClose} aria-label={t('feedback.close')}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1L13 13M1 13L13 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="feedback-modal-tabs" role="tablist" aria-label={t('feedback.tabsLabel')}>
          <div className="feedback-modal-tabs-left">
            <button
              className={`feedback-modal-tab ${activeTab === 'submit' ? 'active' : ''}`}
              onClick={() => setActiveTab('submit')}
              role="tab"
              aria-selected={activeTab === 'submit'}
              data-testid="feedback-tab-submit"
            >
              {t('feedback.tab.submit')}
            </button>
            <button
              className={`feedback-modal-tab ${activeTab === 'history' ? 'active' : ''}`}
              onClick={() => setActiveTab('history')}
              role="tab"
              aria-selected={activeTab === 'history'}
              data-testid="feedback-tab-history"
            >
              {t('feedback.tab.history')}
            </button>
          </div>
          {/*
            Diagnostic-bundle action — purposely placed in the tab bar
            so it never sits inside the GitHub submit form. The button
            is an "advanced" action: trace + state file packager that
            stays local. The notice strip below makes the privacy
            posture explicit.
          */}
          <div className="feedback-modal-tabs-right">
            <button
              type="button"
              className="feedback-secondary-button feedback-diagnostic-bundle-button"
              onClick={() => void handleGenerateDiagnosticBundle()}
              disabled={bundleStatus === 'generating'}
              data-testid="feedback-diagnostic-bundle-button"
            >
              {bundleStatus === 'generating'
                ? t('feedback.diagnosticBundle.generating')
                : t('feedback.diagnosticBundle.button')}
            </button>
          </div>
        </div>

        <div
          className="feedback-diagnostic-bundle-notice"
          data-testid="feedback-diagnostic-bundle-notice"
          role="note"
        >
          {t('feedback.diagnosticBundle.notice')}
        </div>

        {bundleMessage ? (
          <div
            className={`feedback-diagnostic-bundle-status feedback-diagnostic-bundle-status--${bundleStatus}`}
            data-testid="feedback-diagnostic-bundle-status"
          >
            {bundleMessage}
          </div>
        ) : null}

        <div className="feedback-modal-body">
          {activeTab === 'submit' ? (
            <div className="feedback-form">
              <div className="feedback-field">
                <label className="feedback-label" htmlFor="feedback-type">{t('feedback.type.label')}</label>
                <div className="onward-select-shell onward-select-shell--block">
                  <select
                    id="feedback-type"
                    className="feedback-select onward-select onward-select--roomy"
                    value={type}
                    onChange={(event) => setType(event.target.value as FeedbackType)}
                    data-testid="feedback-type-select"
                  >
                    <option value="bug">{t('feedback.type.bug')}</option>
                    <option value="feature">{t('feedback.type.feature')}</option>
                  </select>
                </div>
              </div>

              <div className="feedback-field">
                <div className="feedback-label-row">
                  <label className="feedback-label" htmlFor="feedback-title">{t('feedback.titleField.label')}</label>
                  <span className="feedback-hint">{title.length}/{FEEDBACK_MAX_TITLE_LENGTH}</span>
                </div>
                <input
                  id="feedback-title"
                  className="feedback-input"
                  value={title}
                  maxLength={FEEDBACK_MAX_TITLE_LENGTH}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder={t('feedback.titleField.placeholder')}
                  data-testid="feedback-title-input"
                />
              </div>

              <div className="feedback-field">
                <div className="feedback-label-row">
                  <label className="feedback-label" htmlFor="feedback-description">{t('feedback.description.label')}</label>
                  <span className="feedback-hint">{description.length}/{FEEDBACK_MAX_DESCRIPTION_LENGTH}</span>
                </div>
                <textarea
                  id="feedback-description"
                  className="feedback-textarea"
                  value={description}
                  maxLength={FEEDBACK_MAX_DESCRIPTION_LENGTH}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder={t('feedback.description.placeholder')}
                  data-testid="feedback-description-input"
                />
                <p className="feedback-helper">{t('feedback.description.helper')}</p>
              </div>

              <label className="feedback-consent">
                <input
                  type="checkbox"
                  className="feedback-consent-checkbox"
                  checked={publicConsentAccepted}
                  onChange={(event) => {
                    void handleConsentChange(event.target.checked)
                  }}
                  data-testid="feedback-public-consent"
                />
                <span className="feedback-consent-text">{t('feedback.publicConsent')}</span>
              </label>

              {formError ? <div className="feedback-error" data-testid="feedback-form-error">{formError}</div> : null}
              {submitNotice ? <div className="feedback-notice" data-testid="feedback-submit-notice">{submitNotice}</div> : null}

              <div className="feedback-field">
                <div className="feedback-label-row">
                  <label className="feedback-label">{t('feedback.rating.label')}</label>
                  <span className="feedback-hint">{t('feedback.rating.hint')}</span>
                </div>
                <div className="feedback-stars" role="radiogroup" aria-label={t('feedback.rating.label')}>
                  {[1, 2, 3, 4, 5].map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={`feedback-star-button ${rating >= value ? 'selected' : ''}`}
                      onClick={() => setRating((current) => (current === value ? 0 : value as FeedbackRating))}
                      aria-checked={rating === value}
                      role="radio"
                      title={t('feedback.rating.value', { value })}
                      data-testid={`feedback-rating-${value}`}
                    >
                      <StarIcon active={rating >= value} />
                    </button>
                  ))}
                </div>
              </div>

              <div className="feedback-submit-footer">
                <p className="feedback-submit-note">{t('feedback.submitNote')}</p>
                <button
                  className="feedback-primary-button"
                  onClick={() => void handleSubmit()}
                  disabled={isSubmitting}
                  data-testid="feedback-submit-button"
                >
                  {isSubmitting ? t('feedback.submitting') : t('feedback.continueToGitHub')}
                </button>
              </div>
            </div>
          ) : (
            <div className="feedback-history">
              <div className="feedback-history-toolbar">
                <p className="feedback-history-note">{t('feedback.history.note')}</p>
                <button
                  className="feedback-secondary-button"
                  onClick={handleRefresh}
                  disabled={isLoadingHistory || isSyncingHistory}
                  data-testid="feedback-history-refresh"
                >
                  {isSyncingHistory ? t('feedback.history.refreshing') : t('feedback.history.refresh')}
                </button>
              </div>

              {historyError ? <div className="feedback-error" data-testid="feedback-history-error">{historyError}</div> : null}
              {submitNotice ? <div className="feedback-notice" data-testid="feedback-history-notice">{submitNotice}</div> : null}

              {isLoadingHistory ? (
                <div className="feedback-history-empty">{t('feedback.history.loading')}</div>
              ) : historyRecords.length === 0 ? (
                <div className="feedback-history-empty">{t('feedback.history.empty')}</div>
              ) : (
                <div className="feedback-history-list" data-testid="feedback-history-list">
                  {historyRecords.map((record) => (
                    <div
                      key={record.id}
                      className="feedback-history-item"
                      data-testid="feedback-history-item"
                      data-feedback-status={record.syncStatus}
                      data-feedback-record-id={record.id}
                    >
                      <div className="feedback-history-row">
                        <div className="feedback-history-main">
                          <div className="feedback-history-title-row">
                            <h4 className="feedback-history-title" data-testid="feedback-history-title">{record.title}</h4>
                            <span
                              className={`feedback-status-pill ${getStatusTone(record.syncStatus)}`}
                              data-testid="feedback-history-status"
                              data-feedback-status={record.syncStatus}
                            >
                              {t(getStatusTranslationKey(record.syncStatus))}
                            </span>
                          </div>
                          <div className="feedback-history-meta">
                            <span>{record.type === 'bug' ? t('feedback.type.bug') : t('feedback.type.feature')}</span>
                            <span>{record.rating === 0 ? t('feedback.history.ratingUnset') : t('feedback.history.rating', { value: record.rating })}</span>
                            <span>{formatTimestamp.format(record.createdAt)}</span>
                          </div>
                          <p className="feedback-history-description">{record.description}</p>
                          {record.lastError ? (
                            <p className="feedback-history-error">{record.lastError}</p>
                          ) : null}
                          {record.lastCheckedAt ? (
                            <p className="feedback-history-checked">
                              {t('feedback.history.lastChecked', { time: formatTimestamp.format(record.lastCheckedAt) })}
                            </p>
                          ) : null}
                        </div>
                        <div className="feedback-history-actions">
                          {record.issueUrl ? (
                            <button
                              className="feedback-secondary-button"
                              onClick={() => void handleOpenIssue(record)}
                              data-testid="feedback-open-issue"
                            >
                              {t('feedback.history.openIssue')}
                            </button>
                          ) : (
                            <button
                              className="feedback-secondary-button"
                              onClick={() => void handleReopenPending(record.id)}
                              data-testid="feedback-reopen-draft"
                            >
                              {t('feedback.history.reopenDraft')}
                            </button>
                          )}
                          <button
                            className="feedback-secondary-button"
                            onClick={() => void syncHistory(true, record.id)}
                            disabled={isSyncingHistory}
                            data-testid="feedback-refresh-one"
                          >
                            {t('feedback.history.refreshOne')}
                          </button>
                          <button
                            className="feedback-secondary-button danger"
                            onClick={() => void handleRemoveRecord(record.id)}
                            data-testid="feedback-remove-record"
                          >
                            {t('feedback.history.removeLocal')}
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
