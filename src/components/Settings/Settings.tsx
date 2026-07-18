/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { useSettings } from '../../contexts/SettingsContext'
import { ShortcutInput } from './ShortcutInput'
import { ColorPicker } from './ColorPicker'
import { FontSelector } from './FontSelector'
import { NumberInput } from './NumberInput'
import { ApplyToAllIcon } from './ApplyToAllIcon'
import { ThemeSelector } from './ThemeSelector'
import { DEFAULT_TERMINAL_FONT_SIZE, MIN_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE } from '../../constants/terminal'
import { DEFAULT_GIT_DIFF_FONT_SIZE, MIN_GIT_DIFF_FONT_SIZE, MAX_GIT_DIFF_FONT_SIZE } from '../../constants/gitDiff'
import type { SettingsDebugApi } from '../../autotest/types'
import type { ShortcutConfig, TerminalStyleConfig, GlobalTerminalStyle } from '../../types/settings'
import type { AppInfo, DownloadErrorCode, UpdatePhase, UpdaterStatus } from '../../types/electron.d.ts'
import type { TranslationKey } from '../../i18n/core'
import { useI18n } from '../../i18n/useI18n'
import { trackFeatureUse } from '../../telemetry/track-feature-use'
import './Settings.css'

interface SettingsProps {
  terminals: { id: string; title: string; customName?: string | null }[]
  onClose: () => void
  width: number
  onWidthChange: (width: number) => void
}

// Shortcut configuration items
interface ShortcutItem {
  key: keyof ShortcutConfig
  labelKey: TranslationKey
  labelParams?: { index: number }
}

// Shortcut groups
const SHORTCUT_GROUPS: { titleKey: TranslationKey; descriptionKey?: TranslationKey; items: ShortcutItem[] }[] = [
  {
    titleKey: 'settings.group.globalShortcuts',
    descriptionKey: 'settings.group.globalShortcuts.description',
    items: [
      { key: 'activateAndFocusPrompt', labelKey: 'settings.shortcut.togglePrompt' }
    ]
  },
  {
    titleKey: 'settings.group.windowShortcuts',
    descriptionKey: 'settings.group.windowShortcuts.description',
    items: [
      { key: 'focusPromptEditor', labelKey: 'settings.shortcut.focusPromptEditor' },
      { key: 'addToHistory', labelKey: 'settings.shortcut.addToHistory' }
    ]
  },
  {
    titleKey: 'settings.group.terminalActions',
    descriptionKey: 'settings.group.terminalActions.description',
    items: [
      { key: 'terminalGitDiff', labelKey: 'settings.shortcut.viewGitDiff' },
      { key: 'terminalGitHistory', labelKey: 'settings.shortcut.viewGitHistory' },
      { key: 'terminalChangeWorkDir', labelKey: 'settings.shortcut.changeWorkDir' },
      { key: 'terminalOpenWorkDir', labelKey: 'settings.shortcut.openWorkDir' },
      { key: 'terminalProjectEditor', labelKey: 'settings.shortcut.openProjectEditor' }
    ]
  },
  {
    titleKey: 'settings.group.terminalFocus',
    items: [
      { key: 'focusTerminal1', labelKey: 'settings.shortcut.focusTask', labelParams: { index: 1 } },
      { key: 'focusTerminal2', labelKey: 'settings.shortcut.focusTask', labelParams: { index: 2 } },
      { key: 'focusTerminal3', labelKey: 'settings.shortcut.focusTask', labelParams: { index: 3 } },
      { key: 'focusTerminal4', labelKey: 'settings.shortcut.focusTask', labelParams: { index: 4 } },
      { key: 'focusTerminal5', labelKey: 'settings.shortcut.focusTask', labelParams: { index: 5 } },
      { key: 'focusTerminal6', labelKey: 'settings.shortcut.focusTask', labelParams: { index: 6 } },
      { key: 'focusTerminal7', labelKey: 'settings.shortcut.focusTask', labelParams: { index: 7 } },
      { key: 'focusTerminal8', labelKey: 'settings.shortcut.focusTask', labelParams: { index: 8 } }
    ]
  },
  {
    titleKey: 'settings.group.tabSwitch',
    items: [
      { key: 'switchTab1', labelKey: 'settings.shortcut.switchTab', labelParams: { index: 1 } },
      { key: 'switchTab2', labelKey: 'settings.shortcut.switchTab', labelParams: { index: 2 } },
      { key: 'switchTab3', labelKey: 'settings.shortcut.switchTab', labelParams: { index: 3 } },
      { key: 'switchTab4', labelKey: 'settings.shortcut.switchTab', labelParams: { index: 4 } },
      { key: 'switchTab5', labelKey: 'settings.shortcut.switchTab', labelParams: { index: 5 } },
      { key: 'switchTab6', labelKey: 'settings.shortcut.switchTab', labelParams: { index: 6 } }
    ]
  }
]

interface UpdaterDebugPatch extends Partial<UpdaterStatus> {
  phase: UpdatePhase
}

interface MockCheckResult {
  delayMs: number
  patch: UpdaterDebugPatch
}

interface MockRestartResult {
  delayMs: number
  success: boolean
  error?: string
}

const DEFAULT_MOCK_ACTION_DELAY_MS = 180

function resolveFallbackReleaseOs(platform: string): AppInfo['releaseOs'] {
  switch (platform) {
    case 'darwin':
      return 'macos'
    case 'win32':
      return 'windows'
    case 'linux':
      return 'linux'
    default:
      return 'unknown'
  }
}

function createFallbackUpdaterStatus(appInfo: AppInfo | null, platform: string): UpdaterStatus {
  return {
    phase: appInfo?.isPackaged ? 'idle' : 'unsupported',
    supported: false,
    currentVersion: appInfo?.version ?? '0.0.0',
    currentTag: appInfo?.tag ?? null,
    currentChannel: appInfo?.releaseChannel ?? 'unknown',
    currentReleaseOs: appInfo?.releaseOs ?? resolveFallbackReleaseOs(platform),
    targetVersion: null,
    targetTag: null,
    downloadedFileName: null,
    lastCheckedAt: null,
    error: null,
    errorCode: null,
    bannerDismissed: false,
    downloadProgress: null
  }
}

const ERROR_CODE_I18N_MAP: Record<DownloadErrorCode, TranslationKey> = {
  'offline': 'settings.update.error.offline',
  'connection-failed': 'settings.update.error.connectionFailed',
  'timeout': 'settings.update.error.timeout',
  'stalled': 'settings.update.error.stalled',
  'http-error': 'settings.update.error.httpError',
  'checksum-mismatch': 'settings.update.error.checksumMismatch',
  'disk-error': 'settings.update.error.diskError',
  'aborted': 'settings.update.error.aborted'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function summarizeUpdateError(error: string | null | undefined): string | null {
  if (!error) return null
  const normalized = error.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 120) return normalized
  return `${normalized.slice(0, 117)}...`
}

export function Settings({ terminals, onClose, width, onWidthChange }: SettingsProps) {
  const {
    settings,
    updateShortcut,
    updateTerminalStyle,
    getTerminalStyle,
    applyStyleGlobally,
    updatePerformanceDiagnosticsEnabled
  } = useSettings()
  const { t, locale, locales, updateLanguage } = useI18n()
  const isAutotest = window.electronAPI.debug.autotest
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [updaterStatus, setUpdaterStatus] = useState<UpdaterStatus | null>(null)
  const [debugUpdaterStatus, setDebugUpdaterStatus] = useState<UpdaterStatus | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [isCheckingForUpdate, setIsCheckingForUpdate] = useState(false)
  const [isRestartingForUpdate, setIsRestartingForUpdate] = useState(false)
  const [selectedTerminalId, setSelectedTerminalId] = useState<string>(
    terminals[0]?.id || ''
  )
  const [isDragging, setIsDragging] = useState(false)
  const [telemetryEnabled, setTelemetryEnabled] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const updateActionButtonRef = useRef<HTMLButtonElement>(null)
  const debugActionCountsRef = useRef({ checkNow: 0, restartToUpdate: 0 })
  const debugNextCheckResultRef = useRef<MockCheckResult | null>(null)
  const debugNextRestartResultRef = useRef<MockRestartResult | null>(null)
  const debugCheckTimerRef = useRef<number | null>(null)
  const debugRestartTimerRef = useRef<number | null>(null)
  const effectiveUpdaterStatus = debugUpdaterStatus ?? updaterStatus
  const isDevChannel = effectiveUpdaterStatus?.currentChannel === 'dev'
  const updateStatusKey: TranslationKey = (() => {
    switch (effectiveUpdaterStatus?.phase) {
      case 'checking':
        return 'settings.update.statusValue.checking'
      case 'available':
        return 'settings.update.statusValue.available'
      case 'downloading':
        return 'settings.update.statusValue.downloading'
      case 'downloaded':
        return 'settings.update.statusValue.downloaded'
      case 'up-to-date':
        return 'settings.update.statusValue.up-to-date'
      case 'unsupported':
        return 'settings.update.statusValue.unsupported'
      case 'error':
        return 'settings.update.statusValue.error'
      default:
        return isDevChannel ? 'settings.update.statusValue.idle.dev' : 'settings.update.statusValue.idle'
    }
  })()
  const updateActionKey: TranslationKey = (() => {
    if (isRestartingForUpdate) {
      return 'settings.update.action.restarting'
    }
    if (isCheckingForUpdate || effectiveUpdaterStatus?.phase === 'checking') {
      return 'settings.update.action.checking'
    }
    switch (effectiveUpdaterStatus?.phase) {
      case 'available':
        return 'settings.update.action.download'
      case 'downloading':
        return 'settings.update.action.downloading'
      case 'downloaded':
        return 'settings.update.action.restart'
      default:
        return 'settings.update.action.checkNow'
    }
  })()
  const isUpdateActionDisabled =
    !effectiveUpdaterStatus ||
    effectiveUpdaterStatus.phase === 'unsupported' ||
    effectiveUpdaterStatus.phase === 'checking' ||
    effectiveUpdaterStatus.phase === 'downloading' ||
    isCheckingForUpdate ||
    isRestartingForUpdate

  // Get the style of the currently selected terminal
  const currentTerminalStyle = useMemo(() => {
    return getTerminalStyle(selectedTerminalId)
  }, [selectedTerminalId, getTerminalStyle])


  // Handle shortcut changes
  const handleShortcutChange = useCallback((key: keyof ShortcutConfig, value: string | null) => {
    updateShortcut(key, value)
  }, [updateShortcut])

  // Handling terminal style changes
  const handleStyleChange = useCallback((key: keyof TerminalStyleConfig, value: string | number | null) => {
    if (!selectedTerminalId) return
    updateTerminalStyle(selectedTerminalId, { [key]: value } as Partial<TerminalStyleConfig>)
  }, [selectedTerminalId, updateTerminalStyle])


  // Handling terminal selection changes
  const handleTerminalSelect = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedTerminalId(e.target.value)
  }, [])

  // Handling font size changes
  const handleFontSizeChange = useCallback((value: number | null) => {
    handleStyleChange('fontSize', value)
  }, [handleStyleChange])


  const handleGitDiffFontSizeChange = useCallback((value: number | null) => {
    handleStyleChange('gitDiffFontSize', value)
  }, [handleStyleChange])

  const handleApplyGlobally = useCallback((field: keyof GlobalTerminalStyle) => {
    if (!currentTerminalStyle) return
    applyStyleGlobally(field, currentTerminalStyle[field])
  }, [applyStyleGlobally, currentTerminalStyle])

  const handleLanguageChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    updateLanguage(e.target.value as typeof locale)
  }, [updateLanguage])

  const formatUpdateTimestamp = useCallback((value: number) => {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(value)
  }, [locale])

  const updateDetailText = useMemo(() => {
    const summarizedActionError = summarizeUpdateError(actionError)
    if (summarizedActionError) {
      return t('settings.update.detail.error', { error: summarizedActionError })
    }
    if (!effectiveUpdaterStatus) return null

    if (effectiveUpdaterStatus.phase === 'error' && effectiveUpdaterStatus.error) {
      // Use localized error message when a known error code is available;
      // fall back to the raw error string for unclassified errors.
      const i18nKey = effectiveUpdaterStatus.errorCode
        ? ERROR_CODE_I18N_MAP[effectiveUpdaterStatus.errorCode]
        : null
      if (i18nKey) {
        return t(i18nKey)
      }
      const summarizedStatusError = summarizeUpdateError(effectiveUpdaterStatus.error)
      if (summarizedStatusError) {
        return t('settings.update.detail.error', { error: summarizedStatusError })
      }
    }
    if (effectiveUpdaterStatus.phase === 'downloading') {
      const progress = effectiveUpdaterStatus.downloadProgress
      if (progress && progress.downloadedBytes > 0) {
        const speed = formatBytes(progress.bytesPerSecond)
        if (progress.totalBytes > 0) {
          return t('settings.update.detail.downloadProgress', {
            downloaded: formatBytes(progress.downloadedBytes),
            total: formatBytes(progress.totalBytes),
            speed
          })
        }
        return t('settings.update.detail.downloadProgressUnknown', {
          downloaded: formatBytes(progress.downloadedBytes),
          speed
        })
      }
      if (effectiveUpdaterStatus.targetVersion) {
        return t('settings.update.detail.targetVersion', { version: effectiveUpdaterStatus.targetVersion })
      }
      return null
    }
    if (effectiveUpdaterStatus.phase === 'downloaded' && effectiveUpdaterStatus.targetVersion) {
      return t('settings.update.detail.targetVersion', { version: effectiveUpdaterStatus.targetVersion })
    }
    if (effectiveUpdaterStatus.phase === 'unsupported') {
      return t('settings.update.detail.unsupported')
    }
    if (effectiveUpdaterStatus.lastCheckedAt) {
      return t('settings.update.detail.lastChecked', {
        time: formatUpdateTimestamp(effectiveUpdaterStatus.lastCheckedAt)
      })
    }
    return null
  }, [actionError, effectiveUpdaterStatus, formatUpdateTimestamp, t])
  const targetChannelValue = appInfo?.releaseChannel === 'stable' ? 'stable' : appInfo?.releaseChannel === 'dev' ? 'dev' : 'daily'
  const isUpdateDetailError = Boolean(actionError) || effectiveUpdaterStatus?.phase === 'error'
  const isUpdateDetailSuccess = effectiveUpdaterStatus?.phase === 'up-to-date'
  const updateStatusLabel = t(updateStatusKey)
  const updateActionLabel = t(updateActionKey)

  const clearPendingTimer = (timerRef: React.MutableRefObject<number | null>) => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const buildUpdaterStatus = useCallback((patch: UpdaterDebugPatch): UpdaterStatus => {
    const base =
      debugUpdaterStatus ??
      updaterStatus ??
      createFallbackUpdaterStatus(appInfo, window.electronAPI.platform)
    const nextStatus = {
      ...base,
      ...patch
    }
    if (patch.error === null && patch.errorCode === undefined) {
      nextStatus.errorCode = null
    }
    if (patch.phase !== 'downloading' && patch.downloadProgress === undefined) {
      nextStatus.downloadProgress = null
    }
    return nextStatus
  }, [appInfo, debugUpdaterStatus, updaterStatus])

  const resetMockUpdater = useCallback(() => {
    clearPendingTimer(debugCheckTimerRef)
    clearPendingTimer(debugRestartTimerRef)
    debugActionCountsRef.current = { checkNow: 0, restartToUpdate: 0 }
    debugNextCheckResultRef.current = null
    debugNextRestartResultRef.current = null
    setDebugUpdaterStatus(null)
    setActionError(null)
    setIsCheckingForUpdate(false)
    setIsRestartingForUpdate(false)
    return true
  }, [])

  const handleCheckNow = useCallback(async () => {
    if (!effectiveUpdaterStatus || isUpdateActionDisabled || effectiveUpdaterStatus.phase === 'downloaded') {
      return
    }

    setActionError(null)

    if (isAutotest && debugUpdaterStatus) {
      debugActionCountsRef.current.checkNow += 1
      setIsCheckingForUpdate(true)
      setDebugUpdaterStatus(buildUpdaterStatus({
        phase: 'checking',
        supported: effectiveUpdaterStatus.supported,
        error: null
      }))

      const nextCheckResult = debugNextCheckResultRef.current
      const nextStatus = buildUpdaterStatus(
        nextCheckResult?.patch ?? {
          phase: 'up-to-date',
          supported: effectiveUpdaterStatus.supported,
          targetVersion: null,
          targetTag: null,
          downloadedFileName: null,
          lastCheckedAt: Date.now(),
          error: null,
          bannerDismissed: false
        }
      )

      clearPendingTimer(debugCheckTimerRef)
      debugCheckTimerRef.current = window.setTimeout(() => {
        setDebugUpdaterStatus(nextStatus)
        setIsCheckingForUpdate(false)
        debugNextCheckResultRef.current = null
        debugCheckTimerRef.current = null
      }, nextCheckResult?.delayMs ?? DEFAULT_MOCK_ACTION_DELAY_MS)
      return
    }

    setIsCheckingForUpdate(true)
    try {
      const status = await window.electronAPI.updater.checkNow()
      setUpdaterStatus(status)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsCheckingForUpdate(false)
    }
  }, [buildUpdaterStatus, debugUpdaterStatus, effectiveUpdaterStatus, isAutotest, isUpdateActionDisabled])

  const handleRestartToUpdate = useCallback(async () => {
    if (!effectiveUpdaterStatus || isUpdateActionDisabled || effectiveUpdaterStatus.phase !== 'downloaded') {
      return
    }

    setActionError(null)

    if (isAutotest && debugUpdaterStatus) {
      debugActionCountsRef.current.restartToUpdate += 1
      setIsRestartingForUpdate(true)

      const nextRestartResult = debugNextRestartResultRef.current ?? {
        delayMs: DEFAULT_MOCK_ACTION_DELAY_MS,
        success: true
      }

      clearPendingTimer(debugRestartTimerRef)
      debugRestartTimerRef.current = window.setTimeout(() => {
        setIsRestartingForUpdate(false)
        if (!nextRestartResult.success) {
          setActionError(nextRestartResult.error ?? 'Mock restart failed.')
        }
        debugNextRestartResultRef.current = null
        debugRestartTimerRef.current = null
      }, nextRestartResult.delayMs)
      return
    }

    setIsRestartingForUpdate(true)
    try {
      const result = await window.electronAPI.updater.restartToUpdate()
      if (!result.success) {
        setActionError(result.error || 'Restart action is unavailable.')
        setIsRestartingForUpdate(false)
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
      setIsRestartingForUpdate(false)
    }
  }, [debugUpdaterStatus, effectiveUpdaterStatus, isAutotest, isUpdateActionDisabled])

  const handleDownloadNow = useCallback(async () => {
    if (!effectiveUpdaterStatus || effectiveUpdaterStatus.phase !== 'available') return
    setActionError(null)
    try {
      const status = await window.electronAPI.updater.downloadNow()
      setUpdaterStatus(status)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }, [effectiveUpdaterStatus])

  const handleUpdateAction = useCallback(async () => {
    if (!effectiveUpdaterStatus || isUpdateActionDisabled) {
      return
    }
    if (effectiveUpdaterStatus.phase === 'downloaded') {
      await handleRestartToUpdate()
      return
    }
    if (effectiveUpdaterStatus.phase === 'available') {
      await handleDownloadNow()
      return
    }
    await handleCheckNow()
  }, [effectiveUpdaterStatus, handleCheckNow, handleDownloadNow, handleRestartToUpdate, isUpdateActionDisabled])

  // Handle drag start
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  // Handle drag move and end
  useEffect(() => {
    let isActive = true
    window.electronAPI.appInfo.get()
      .then((info) => {
        if (isActive) {
          setAppInfo(info)
        }
      })
      .catch(() => {})

    window.electronAPI.updater.getStatus()
      .then((status) => {
        if (isActive) {
          setUpdaterStatus(status)
        }
      })
      .catch(() => {})

    const unsubscribe = window.electronAPI.updater.onStatusChanged((status) => {
      setUpdaterStatus(status)
    })

    return () => {
      isActive = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    window.electronAPI.telemetry.getConsent().then((consent) => {
      setTelemetryEnabled(consent === true)
    })
  }, [])

  // Product telemetry: Settings surface mounted (opened) — count once per open.
  useEffect(() => {
    trackFeatureUse('settings-open')
  }, [])

  const handleTelemetryToggle = useCallback(() => {
    const newValue = !telemetryEnabled
    setTelemetryEnabled(newValue)
    window.electronAPI.telemetry.setConsent(newValue)
  }, [telemetryEnabled])

  const handlePerformanceDiagnosticsToggle = useCallback(() => {
    updatePerformanceDiagnosticsEnabled(!(settings?.performanceDiagnosticsEnabled === true))
  }, [settings?.performanceDiagnosticsEnabled, updatePerformanceDiagnosticsEnabled])

  useEffect(() => {
    if (debugUpdaterStatus || updaterStatus?.phase === 'downloaded') return
    if (!actionError) return
    setActionError(null)
  }, [actionError, debugUpdaterStatus, updaterStatus?.phase])

  useEffect(() => {
    return () => {
      clearPendingTimer(debugCheckTimerRef)
      clearPendingTimer(debugRestartTimerRef)
    }
  }, [])

  useEffect(() => {
    if (!isAutotest) return

    const debugWindow = window as Window & { __onwardSettingsDebug?: SettingsDebugApi }
    const api: SettingsDebugApi = {
      isOpen: () => true,
      getUpdaterState: () => ({
        phase: effectiveUpdaterStatus?.phase ?? 'idle',
        supported: Boolean(effectiveUpdaterStatus?.supported),
        statusLabel: updateStatusLabel,
        actionLabel: updateActionLabel,
        actionDisabled: isUpdateActionDisabled,
        detailText: updateDetailText,
        actionCounts: { ...debugActionCountsRef.current },
        targetVersion: effectiveUpdaterStatus?.targetVersion ?? null,
        lastCheckedAt: effectiveUpdaterStatus?.lastCheckedAt ?? null,
        actionError
      }),
      setMockUpdaterStatus: (patch) => {
        clearPendingTimer(debugCheckTimerRef)
        clearPendingTimer(debugRestartTimerRef)
        setDebugUpdaterStatus(buildUpdaterStatus(patch))
        setActionError(null)
        setIsCheckingForUpdate(false)
        setIsRestartingForUpdate(false)
        return true
      },
      setMockNextCheckResult: (patch, delayMs = DEFAULT_MOCK_ACTION_DELAY_MS) => {
        debugNextCheckResultRef.current = { delayMs, patch }
        return true
      },
      setMockRestartResult: (result) => {
        debugNextRestartResultRef.current = {
          delayMs: result.delayMs ?? DEFAULT_MOCK_ACTION_DELAY_MS,
          success: result.success,
          error: result.error
        }
        return true
      },
      clickUpdateAction: async () => {
        const button = updateActionButtonRef.current
        if (!button || button.disabled) {
          return false
        }
        button.click()
        await Promise.resolve()
        return true
      },
      resetMockUpdater
    }

    debugWindow.__onwardSettingsDebug = api
    return () => {
      if (debugWindow.__onwardSettingsDebug === api) {
        delete debugWindow.__onwardSettingsDebug
      }
    }
  }, [
    actionError,
    buildUpdaterStatus,
    effectiveUpdaterStatus,
    isAutotest,
    isUpdateActionDisabled,
    resetMockUpdater,
    updateActionLabel,
    updateDetailText,
    updateStatusLabel
  ])

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return
      // Calculate the distance from the right edge to the mouse (since the Settings panel is on the right)
      const containerRect = containerRef.current.getBoundingClientRect()
      const newWidth = containerRect.right - e.clientX
      // Limit width range to 300-600px
      const clampedWidth = Math.max(300, Math.min(600, newWidth))
      onWidthChange(clampedWidth)
    }

    const handleMouseUp = () => {
      setIsDragging(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, onWidthChange])

  return (
    <div
      ref={containerRef}
      className={`settings-container ${isDragging ? 'is-dragging' : ''}`}
      style={{ width: `${width}px` }}
    >
      {/* Drag strip */}
      <div
        className="settings-resize-handle"
        onMouseDown={handleDragStart}
      />
      {/* Header */}
      <div className="settings-header">
        <span className="settings-title">{t('settings.title')}</span>
        <button className="settings-close-btn" onClick={onClose} title={t('settings.close')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="settings-content">
        {/* Version Info */}
        <div className="settings-version">
          <span className="settings-version-number">{appInfo?.tag || `v${appInfo?.version || '2.0.1'}`}</span>
          <span className="settings-version-label">{t('settings.versionLabel')}</span>
          <span className="settings-version-copyright">Copyright 2026 OPPO</span>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">{t('settings.section.updates')}</div>
          <div className="settings-section-content">
            <div className="settings-group settings-group-updates">
              <div className="settings-update-action-row">
                <div className="settings-update-action-copy">
                  <div className="settings-update-action-label">{t('settings.update.checkLabel')}</div>
                  {(isUpdateDetailSuccess || updateDetailText) && (
                    <div
                      className={`settings-update-action-detail${isUpdateDetailError ? ' is-error' : ''}${isUpdateDetailSuccess ? ' is-success' : ''}`}
                      data-testid="settings-update-detail"
                    >
                      {isUpdateDetailSuccess && <div>{t('settings.update.detail.upToDate')}</div>}
                      {updateDetailText && <div>{updateDetailText}</div>}
                    </div>
                  )}
                  {effectiveUpdaterStatus?.phase === 'downloading' && effectiveUpdaterStatus.downloadProgress && (
                    <div className="settings-update-progress" data-testid="settings-update-progress">
                      <div className="settings-update-progress-track">
                        <div
                          className="settings-update-progress-fill"
                          style={{
                            width: effectiveUpdaterStatus.downloadProgress.percent >= 0
                              ? `${effectiveUpdaterStatus.downloadProgress.percent}%`
                              : '100%',
                            ...(effectiveUpdaterStatus.downloadProgress.percent < 0
                              ? { animation: 'settings-progress-indeterminate 1.5s ease-in-out infinite' }
                              : {})
                          }}
                        />
                      </div>
                      {effectiveUpdaterStatus.downloadProgress.percent >= 0 && (
                        <span className="settings-update-progress-pct">
                          {effectiveUpdaterStatus.downloadProgress.percent}%
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <button
                  ref={updateActionButtonRef}
                  className="reset-btn settings-update-action-btn"
                  type="button"
                  onClick={() => {
                    void handleUpdateAction()
                  }}
                  disabled={isUpdateActionDisabled}
                  title={updateActionLabel}
                  data-testid="settings-update-action"
                >
                  {updateActionLabel}
                </button>
              </div>

              <div className="settings-update-row">
                <div className="settings-row">
                  <span className="settings-row-label">{t('settings.update.targetChannel')}</span>
                  <div className="settings-row-input">
                    <div className="onward-select-shell">
                      <select
                        className="font-selector onward-select onward-select--control"
                        value={targetChannelValue}
                        disabled
                        aria-label={t('settings.update.targetChannel')}
                        data-testid="settings-update-channel-select"
                      >
                        <option value="daily">{t('settings.update.channel.daily')}</option>
                        <option value="dev">{t('settings.update.channel.dev')}</option>
                        <option value="stable">{t('settings.update.channel.stable')}</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>

              <div className="settings-placeholder-note">
                <div className="settings-placeholder-title">{t('settings.update.placeholderTitle')}</div>
                <div className="settings-placeholder-text">{t('settings.update.placeholderBody')}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Diagnostics Section */}
        <div className="settings-section">
          <div className="settings-section-title">{t('settings.section.diagnostics')}</div>
          <div className="settings-section-content">
            <div className="settings-group">
              <div className="settings-row">
                <div className="settings-diagnostics-info">
                  <label className="settings-diagnostics-toggle">
                    <input
                      type="checkbox"
                      checked={settings?.performanceDiagnosticsEnabled === true}
                      onChange={handlePerformanceDiagnosticsToggle}
                      data-testid="settings-performance-diagnostics-toggle"
                    />
                    <span>{t('settings.diagnostics.performanceToggle')}</span>
                  </label>
                  <p className="settings-diagnostics-description">
                    {t('settings.diagnostics.performanceDescription')}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Language Section */}
        <div className="settings-section">
          <div className="settings-section-title">{t('settings.language.label')}</div>
          <div className="settings-section-content">
            <div className="settings-group">
              <div className="settings-row">
                <span className="settings-row-label">{t('settings.language.selectLabel')}</span>
                <div className="settings-row-input">
                  <div className="onward-select-shell">
                    <select
                      className="font-selector onward-select onward-select--control"
                      value={locale}
                      onChange={handleLanguageChange}
                      aria-label={t('settings.language.selectLabel')}
                      data-testid="settings-language-select"
                    >
                      {locales.map(option => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Appearance Section */}
        <div className="settings-section">
          <div className="settings-section-title">{t('settings.section.appearance')}</div>
          <div className="settings-section-content">
            <div className="settings-group">
              <ThemeSelector />
            </div>
          </div>
        </div>

        {/* Shortcuts Section */}
        <div className="settings-section">
          <div className="settings-section-title">{t('settings.section.shortcuts')}</div>
          <div className="settings-section-content">
            {SHORTCUT_GROUPS.map(group => (
              <div key={group.titleKey} className="settings-group">
                <div className="settings-group-title">{t(group.titleKey)}</div>
                {group.descriptionKey && (
                  <div className="settings-group-description">{t(group.descriptionKey)}</div>
                )}
                {group.items.map(item => (
                  <div key={item.key} className="settings-row">
                    <span className="settings-row-label">{t(item.labelKey, item.labelParams)}</span>
                    <div className="settings-row-input">
                      <ShortcutInput
                        value={settings?.shortcuts[item.key] || null}
                        onChange={(value) => handleShortcutChange(item.key, value)}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Agent Terminal Section */}
        <div className="settings-section">
          <div className="settings-section-title">{t('settings.section.agentTerminal')}</div>
          <div className="settings-section-content">
            <div className="settings-group">
              {/* Terminal Selector */}
              <div className="terminal-selector-wrapper">
                <span className="terminal-selector-label">{t('settings.terminal.select')}</span>
                <div className="onward-select-shell">
                  <select
                    className="terminal-selector onward-select onward-select--control"
                    value={selectedTerminalId}
                    onChange={handleTerminalSelect}
                    data-testid="settings-terminal-select"
                  >
                    {terminals.length === 0 ? (
                      <option value="">{t('settings.terminal.none')}</option>
                    ) : (
                      terminals.map(terminal => (
                        <option key={terminal.id} value={terminal.id}>
                          {terminal.title}
                        </option>
                      ))
                    )}
                  </select>
                </div>
              </div>

              {terminals.length > 0 && selectedTerminalId && (
                <>
                  {/* Apply globally hint */}
                  <div className="apply-globally-hint">
                    <ApplyToAllIcon size={12} />
                    <span>{t('settings.terminal.applyGloballyHint')}</span>
                  </div>

                  {/* Foreground Color */}
                  <div className="settings-row">
                    <span className="settings-row-label">{t('settings.terminal.foregroundColor')}</span>
                    <div className="settings-row-input">
                      <ColorPicker
                        value={currentTerminalStyle?.foregroundColor || null}
                        onChange={(value) => handleStyleChange('foregroundColor', value)}
                        defaultValue="#cccccc"
                      />
                      <button
                        className="settings-apply-global-btn"
                        type="button"
                        onClick={() => handleApplyGlobally('foregroundColor')}
                        title={t('settings.terminal.applyGlobally')}
                      >
                        <ApplyToAllIcon />
                      </button>
                    </div>
                  </div>

                  {/* Background Color */}
                  <div className="settings-row">
                    <span className="settings-row-label">{t('settings.terminal.backgroundColor')}</span>
                    <div className="settings-row-input">
                      <ColorPicker
                        value={currentTerminalStyle?.backgroundColor || null}
                        onChange={(value) => handleStyleChange('backgroundColor', value)}
                        defaultValue="#1e1e1e"
                      />
                      <button
                        className="settings-apply-global-btn"
                        type="button"
                        onClick={() => handleApplyGlobally('backgroundColor')}
                        title={t('settings.terminal.applyGlobally')}
                      >
                        <ApplyToAllIcon />
                      </button>
                    </div>
                  </div>

                  {/* Font Family */}
                  <div className="settings-row">
                    <span className="settings-row-label">{t('settings.terminal.fontFamily')}</span>
                    <div className="settings-row-input">
                      <div className="onward-select-shell">
                        <FontSelector
                          value={currentTerminalStyle?.fontFamily || null}
                          onChange={(value) => handleStyleChange('fontFamily', value)}
                          dataTestId="settings-terminal-font-select"
                        />
                      </div>
                      <button
                        className="settings-apply-global-btn"
                        type="button"
                        onClick={() => handleApplyGlobally('fontFamily')}
                        title={t('settings.terminal.applyGlobally')}
                      >
                        <ApplyToAllIcon />
                      </button>
                    </div>
                  </div>

                  {/* Font Size */}
                  <div className="settings-row">
                    <span className="settings-row-label">{t('settings.terminal.fontSize')}</span>
                    <div className="settings-row-input">
                      <NumberInput
                        value={currentTerminalStyle?.fontSize ?? null}
                        onChange={handleFontSizeChange}
                        min={MIN_TERMINAL_FONT_SIZE}
                        max={MAX_TERMINAL_FONT_SIZE}
                        defaultValue={DEFAULT_TERMINAL_FONT_SIZE}
                        placeholder={String(DEFAULT_TERMINAL_FONT_SIZE)}
                      />
                      <button
                        className="settings-apply-global-btn"
                        type="button"
                        onClick={() => handleApplyGlobally('fontSize')}
                        title={t('settings.terminal.applyGlobally')}
                      >
                        <ApplyToAllIcon />
                      </button>
                    </div>
                  </div>

                  {/* Git Diff / Project Editor Font Size */}
                  <div className="settings-row">
                    <span className="settings-row-label">{t('settings.terminal.editorFontSize')}</span>
                    <div className="settings-row-input">
                      <NumberInput
                        value={currentTerminalStyle?.gitDiffFontSize ?? null}
                        onChange={handleGitDiffFontSizeChange}
                        min={MIN_GIT_DIFF_FONT_SIZE}
                        max={MAX_GIT_DIFF_FONT_SIZE}
                        defaultValue={DEFAULT_GIT_DIFF_FONT_SIZE}
                        placeholder={String(DEFAULT_GIT_DIFF_FONT_SIZE)}
                      />
                      <button
                        className="settings-apply-global-btn"
                        type="button"
                        onClick={() => handleApplyGlobally('gitDiffFontSize')}
                        title={t('settings.terminal.applyGlobally')}
                      >
                        <ApplyToAllIcon />
                      </button>
                    </div>
                  </div>


                </>
              )}

              {terminals.length === 0 && (
                <div className="settings-empty">
                  {t('settings.terminal.createFirst')}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Privacy & Telemetry Section */}
        <div className="settings-section">
          <div className="settings-section-title">{t('settings.section.telemetry')}</div>
          <div className="settings-section-content">
            <div className="settings-group">
              <div className="settings-row">
                <div className="settings-telemetry-info">
                  <label className="settings-telemetry-toggle">
                    <input
                      type="checkbox"
                      checked={telemetryEnabled}
                      onChange={handleTelemetryToggle}
                    />
                    <span>{t('settings.telemetry.toggle')}</span>
                  </label>
                  <p className="settings-telemetry-description">
                    {t('settings.telemetry.description')}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  )
}
