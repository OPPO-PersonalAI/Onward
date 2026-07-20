/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect } from 'react'
import { TabItem } from './TabItem'
import { useAppState } from '../../hooks/useAppState'
import { useModalEscape } from '../../hooks/useModalEscape'
import { useI18n } from '../../i18n/useI18n'
import { perfTrace } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import type { UpdaterStatus } from '../../types/electron.d.ts'
import './TabBar.css'

interface ConfirmDialogState {
  isOpen: boolean
  tabId: string
  tabName: string
}

export function TabBar() {
  const { t } = useI18n()
  const {
    state,
    createTab,
    closeTab,
    switchTab,
    renameTab,
    reorderTabs,
    canCreateTab,
    getTabDisplayName,
    hasRunningTerminals
  } = useAppState()
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
    isOpen: false,
    tabId: '',
    tabName: ''
  })
  const [appName, setAppName] = useState('Onward 2')
  const [updateStatus, setUpdateStatus] = useState<UpdaterStatus | null>(null)
  const [isRestartingForUpdate, setIsRestartingForUpdate] = useState(false)
  const [threadpoolStalled, setThreadpoolStalled] = useState(false)
  const [stallBannerDismissed, setStallBannerDismissed] = useState(false)
  const [isRelaunchingForRecovery, setIsRelaunchingForRecovery] = useState(false)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)

  const platform = window.electronAPI.platform

  useEffect(() => {
    let isActive = true
    window.electronAPI.appInfo.get()
      .then((info) => {
        if (isActive && info?.displayName) {
          setAppName(info.displayName)
        }
      })
      .catch(() => {})
    return () => {
      isActive = false
    }
  }, [])

  useEffect(() => {
    let isActive = true
    window.electronAPI.updater.getStatus()
      .then((status) => {
        if (isActive) {
          setUpdateStatus(status)
        }
      })
      .catch(() => {})

    const unsubscribe = window.electronAPI.updater.onStatusChanged((status) => {
      setUpdateStatus(status)
    })

    return () => {
      isActive = false
      unsubscribe()
    }
  }, [])

  // Threadpool-watchdog banner: the main process broadcasts when its libuv
  // threadpool stalls (async fs/dns dead until restart — terminal input,
  // log generation and update checks are all degraded). Restarting kills
  // running shells, so the banner only *offers* the restart.
  useEffect(() => {
    const unsubscribe = window.electronAPI.system?.onThreadpoolHealthChanged?.((info) => {
      setThreadpoolStalled(info.status === 'stalled')
      if (info.status !== 'stalled') {
        setStallBannerDismissed(false)
      }
    })
    return () => {
      unsubscribe?.()
    }
  }, [])

  const highlightName = appName.startsWith('Onward') ? 'Onward' : null
  const restName = highlightName ? appName.slice(highlightName.length) : appName
  const showStallBanner = threadpoolStalled && !stallBannerDismissed
  // Infrastructure degradation outranks the update banner; never stack both.
  const showUpdateBanner = !showStallBanner && updateStatus?.phase === 'downloaded' && !updateStatus.bannerDismissed
  const installableVersion = updateStatus?.phase === 'downloaded' ? updateStatus.targetVersion : null

  const handleRelaunchForRecovery = useCallback(async () => {
    setIsRelaunchingForRecovery(true)
    try {
      const result = await window.electronAPI.system.relaunchApp()
      if (!result.success) {
        setIsRelaunchingForRecovery(false)
      }
    } catch {
      setIsRelaunchingForRecovery(false)
    }
  }, [])

  const handleRestartToUpdate = useCallback(async () => {
    setIsRestartingForUpdate(true)
    try {
      const result = await window.electronAPI.updater.restartToUpdate()
      if (!result.success) {
        setIsRestartingForUpdate(false)
      }
    } catch {
      setIsRestartingForUpdate(false)
    }
  }, [])

  const handleDismissUpdateBanner = useCallback(async () => {
    try {
      const status = await window.electronAPI.updater.dismissBanner()
      setUpdateStatus(status)
    } catch {
      // ignore dismiss failures
    }
  }, [])

  const handleCloseTab = (tabId: string, tabIndex: number) => {
    const tab = state.tabs.find(t => t.id === tabId)
    if (!tab) return

    // If there is a running terminal, display a confirmation dialog box
    if (hasRunningTerminals(tabId)) {
      setConfirmDialog({
        isOpen: true,
        tabId,
        tabName: getTabDisplayName(tab, tabIndex)
      })
      return
    }

    closeTab(tabId)
  }

  // Handle drag start
  const handleDragStart = useCallback((index: number) => {
    setDraggedIndex(index)
  }, [])

  // Handling drag-and-drop entry
  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault()
    if (draggedIndex !== null && draggedIndex !== index) {
      setDragOverIndex(index)
    }
  }, [draggedIndex])

  // Handle drag and leave
  const handleDragLeave = useCallback(() => {
    setDragOverIndex(null)
  }, [])

  // Handle placement
  const handleDrop = useCallback((e: React.DragEvent, toIndex: number) => {
    e.preventDefault()
    if (draggedIndex !== null && draggedIndex !== toIndex) {
      reorderTabs(draggedIndex, toIndex)
    }
    setDraggedIndex(null)
    setDragOverIndex(null)
  }, [draggedIndex, reorderTabs])

  // Process drag end
  const handleDragEnd = useCallback(() => {
    setDraggedIndex(null)
    setDragOverIndex(null)
  }, [])

  const handleConfirmClose = () => {
    closeTab(confirmDialog.tabId)
    setConfirmDialog({ isOpen: false, tabId: '', tabName: '' })
  }

  const handleCancelClose = useCallback(() => {
    setConfirmDialog({ isOpen: false, tabId: '', tabName: '' })
  }, [])

  useModalEscape(confirmDialog.isOpen, handleCancelClose, 'tab-close-confirm')

  return (
    <>
      <div className={`tab-bar platform-${platform}`}>
        {/* Left placeholder: macOS window button */}
        <div className="tab-bar-left">
          <div className="tab-bar-traffic-lights" />
        </div>

        {/* Middle area: LOGO + Tab list (centered) */}
        <div className="tab-bar-center">
          {/* Application title */}
          <div className="tab-bar-title">
            {highlightName ? (
              <span className="app-name"><span className="app-name-highlight">{highlightName}</span>{restName}</span>
            ) : (
              <span className="app-name">{appName}</span>
            )}
            {installableVersion && (
              <span className="tab-bar-installable-version">
                {t('tabBar.updateReady.installableVersion', { version: installableVersion })}
              </span>
            )}
          </div>

          {showStallBanner && (
            <div className="tab-bar-update-banner tab-bar-stall-banner" role="alert" aria-live="assertive">
              <span className="tab-bar-update-text">
                {t('tabBar.threadpoolStall.message')}
              </span>
              <button
                className="tab-bar-update-action"
                type="button"
                onClick={handleRelaunchForRecovery}
                disabled={isRelaunchingForRecovery}
                title={t('tabBar.threadpoolStall.restart')}
              >
                {isRelaunchingForRecovery ? t('tabBar.threadpoolStall.restarting') : t('tabBar.threadpoolStall.restart')}
              </button>
              <button
                className="tab-bar-update-close"
                type="button"
                onClick={() => setStallBannerDismissed(true)}
                title={t('tabBar.threadpoolStall.dismiss')}
                aria-label={t('tabBar.threadpoolStall.dismiss')}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <line x1="9" y1="3" x2="3" y2="9" />
                  <line x1="3" y1="3" x2="9" y2="9" />
                </svg>
              </button>
            </div>
          )}

          {showUpdateBanner && (
            <div className="tab-bar-update-banner" role="status" aria-live="polite">
              <span className="tab-bar-update-text">
                {t('tabBar.updateReady.message', { version: updateStatus?.targetVersion || '' })}
              </span>
              <button
                className="tab-bar-update-action"
                type="button"
                onClick={handleRestartToUpdate}
                disabled={isRestartingForUpdate}
                title={t('tabBar.updateReady.restart')}
              >
                {isRestartingForUpdate ? t('tabBar.updateReady.restarting') : t('tabBar.updateReady.restart')}
              </button>
              <button
                className="tab-bar-update-close"
                type="button"
                onClick={handleDismissUpdateBanner}
                title={t('tabBar.updateReady.dismiss')}
                aria-label={t('tabBar.updateReady.dismiss')}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <line x1="9" y1="3" x2="3" y2="9" />
                  <line x1="3" y1="3" x2="9" y2="9" />
                </svg>
              </button>
            </div>
          )}

          {/* Tab list */}
          <div className="tab-list">
            {state.tabs.map((tab, index) => (
              <TabItem
                key={tab.id}
                name={getTabDisplayName(tab, index)}
                customName={tab.customName}
                isActive={tab.id === state.activeTabId}
                isOnly={state.tabs.length === 1}
                isDragOver={dragOverIndex === index}
                isDragging={draggedIndex === index}
                onSelect={() => {
                  if (tab.id !== state.activeTabId) {
                    perfTrace(PERF_TRACE_EVENT.RENDERER_TAB_SWITCH, {
                      fromActive: state.activeTabId === tab.id ? 0 : 1,
                      tabCount: state.tabs.length
                    })
                  }
                  switchTab(tab.id)
                }}
                onClose={() => handleCloseTab(tab.id, index)}
                onRename={(customName) => renameTab(tab.id, customName)}
                onDragStart={() => handleDragStart(index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, index)}
                onDragEnd={handleDragEnd}
              />
            ))}
          </div>

          {/* New Tab button */}
          <button
            className={`tab-add-btn ${!canCreateTab() ? 'disabled' : ''}`}
            onClick={() => {
              perfTrace(PERF_TRACE_EVENT.RENDERER_TAB_CREATE, {
                tabCountBefore: state.tabs.length
              })
              createTab()
            }}
            disabled={!canCreateTab()}
            title={canCreateTab() ? t('tabBar.newTab') : t('tabBar.maxTabsReached')}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
              <path d="M7.5 3v3.5H11v1H7.5V11h-1V7.5H3v-1h3.5V3h1z" />
            </svg>
          </button>
        </div>

        {/* Right placeholder: drag area */}
        <div className="tab-bar-right">
          <div className="tab-bar-drag-region" />
        </div>
      </div>

      {/* Confirm to close dialog */}
      {confirmDialog.isOpen && (
        <div className="confirm-dialog-overlay">
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-dialog-title">{t('tabBar.confirmClose.title', { tabName: confirmDialog.tabName })}</div>
            <div className="confirm-dialog-message">
              {t('tabBar.confirmClose.message')}
            </div>
            <div className="confirm-dialog-actions">
              <button className="confirm-dialog-btn cancel" onClick={handleCancelClose}>
                {t('common.cancel')}
              </button>
              <button className="confirm-dialog-btn confirm" onClick={handleConfirmClose}>
                {t('tabBar.confirmClose.action')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
