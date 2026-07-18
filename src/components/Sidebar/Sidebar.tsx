/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useRef, useState } from 'react'
import { LayoutMode, PresetCount, CustomLayoutCell } from '../../types/prompt'
import { useI18n } from '../../i18n/useI18n'
import { useAppState } from '../../contexts/AppStateContext'
import { CustomLayoutPopover } from '../CustomLayoutPopover/CustomLayoutPopover'
import { terminalSessionManager } from '../../terminal/terminal-session-manager'
import { perfTraceTask } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import { trackFeatureUse } from '../../telemetry/track-feature-use'
import './Sidebar.css'

const isPresetActive = (mode: LayoutMode, count: PresetCount): boolean =>
  mode.kind === 'preset' && mode.count === count

const presetMode = (count: PresetCount): LayoutMode => ({ kind: 'preset', count })

interface SidebarProps {
  activePanel: 'prompt' | 'settings' | null
  isFeedbackOpen: boolean
  layoutMode: LayoutMode
  isChangeLogOpen: boolean
  onPanelChange: (panel: 'prompt' | 'settings' | null) => void
  onFeedbackToggle: () => void
  /**
   * Set the active layout. The optional `effectiveCount` short-circuits
   * the parent's downsize gate so freshly-created custom presets — whose
   * cells aren't yet visible in AppState on this render — can still be
   * applied atomically without re-reading stale state.
   */
  onLayoutChange: (mode: LayoutMode, effectiveCount?: number) => void
  /**
   * Transactional preset edit. The popover surfaces the user's intent
   * (id + new payload) and the parent decides whether to gate on a
   * downsize dialog before committing — see App.tsx::handleCommitPresetEdit.
   */
  onCommitPresetEdit: (presetId: string, payload: { name: string; cells: CustomLayoutCell[] }) => void
  onChangeLogToggle: () => void
}

export function Sidebar({
  activePanel,
  isFeedbackOpen,
  layoutMode,
  isChangeLogOpen,
  onPanelChange,
  onFeedbackToggle,
  onLayoutChange,
  onCommitPresetEdit,
  onChangeLogToggle
}: SidebarProps) {
  const { t } = useI18n()
  const {
    state,
    addCustomLayoutPreset,
    updateCustomLayoutPreset,
    duplicateCustomLayoutPreset,
    deleteCustomLayoutPreset
  } = useAppState()
  // updateCustomLayoutPreset is intentionally unused now — preset edits
  // go through onCommitPresetEdit so we can gate on the downsize dialog
  // before flipping cells. Renames-only could still use the direct
  // reducer, but the popover only surfaces edits via the editor today.
  void updateCustomLayoutPreset
  const customLayoutPresets = state.customLayoutPresets
  const customButtonRef = useRef<HTMLButtonElement | null>(null)
  const [customPopoverOpen, setCustomPopoverOpen] = useState(false)
  const isCustomActive = layoutMode.kind === 'custom'

  // Deleting a preset triggers an in-reducer truncate of every tab that
  // references it (down to one terminal). The reducer can't reach into
  // terminalSessionManager, so we dispose the trailing terminal sessions
  // here first — synchronously, before the state update queues — to
  // prevent orphan PTYs.
  const handleDeletePreset = useCallback((id: string) => {
    for (const tab of state.tabs) {
      if (tab.layoutMode.kind !== 'custom' || tab.layoutMode.presetId !== id) continue
      tab.terminals.slice(1).forEach(term => {
        perfTraceTask(PERF_TRACE_EVENT.RENDERER_TERMINAL_DESTROY_BY_DOWNSIZE, {
          tabId: tab.id,
          terminalId: term.id,
          reason: 'preset-deleted'
        }, term.id)
        try {
          terminalSessionManager.dispose(term.id)
        } catch (error) {
          console.warn('Failed to dispose terminal during preset delete:', error)
        }
      })
    }
    deleteCustomLayoutPreset(id)
  }, [state.tabs, deleteCustomLayoutPreset])

  const handlePromptToggle = () => {
    onPanelChange(activePanel === 'prompt' ? null : 'prompt')
  }

  const handleSettingsToggle = () => {
    onPanelChange(activePanel === 'settings' ? null : 'settings')
  }

  return (
    <div className="sidebar">
      {/* Prompt notebook switching button */}
      <button
        className={`sidebar-btn ${activePanel === 'prompt' ? 'active' : ''}`}
        onClick={handlePromptToggle}
        title={t('sidebar.promptNotebook')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
      </button>

      <div className="sidebar-divider" />

      {/* Layout toggle button group */}
      <button
        className={`sidebar-btn ${isPresetActive(layoutMode, 1) ? 'active' : ''}`}
        onClick={() => onLayoutChange(presetMode(1))}
        title={t('sidebar.layout.single')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
        </svg>
      </button>

      <button
        className={`sidebar-btn ${isPresetActive(layoutMode, 2) ? 'active' : ''}`}
        onClick={() => onLayoutChange(presetMode(2))}
        title={t('sidebar.layout.double')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="12" y1="3" x2="12" y2="21" />
        </svg>
      </button>

      <button
        className={`sidebar-btn ${isPresetActive(layoutMode, 4) ? 'active' : ''}`}
        onClick={() => onLayoutChange(presetMode(4))}
        title={t('sidebar.layout.quad')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="12" y1="3" x2="12" y2="21" />
          <line x1="3" y1="12" x2="21" y2="12" />
        </svg>
      </button>

      <button
        className={`sidebar-btn ${isPresetActive(layoutMode, 6) ? 'active' : ''}`}
        onClick={() => onLayoutChange(presetMode(6))}
        title={t('sidebar.layout.six')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="9" y1="3" x2="9" y2="21" />
          <line x1="15" y1="3" x2="15" y2="21" />
          <line x1="3" y1="12" x2="21" y2="12" />
        </svg>
      </button>

      {/*
        8-grid (2x4) icon — design B: just the outer frame, one mid-row
        rule, and three short column ticks on each row. Conveys "more
        slots" without painting the cell mesh; reads cleanly at 20px.
      */}
      <button
        className={`sidebar-btn ${isPresetActive(layoutMode, 8) ? 'active' : ''}`}
        onClick={() => onLayoutChange(presetMode(8))}
        title={t('sidebar.layout.eight')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="8" y1="6" x2="8" y2="9" />
          <line x1="13" y1="6" x2="13" y2="9" />
          <line x1="18" y1="6" x2="18" y2="9" />
          <line x1="8" y1="15" x2="8" y2="18" />
          <line x1="13" y1="15" x2="13" y2="18" />
          <line x1="18" y1="15" x2="18" y2="18" />
        </svg>
      </button>

      {/*
        Custom layout — opens a popover with saved presets and a "+ New"
        entry. The icon is intentionally non-uniform (one wide cell, two
        narrow cells, one tall cell) so it reads as "user-defined" rather
        than another preset count.
      */}
      <button
        ref={customButtonRef}
        className={`sidebar-btn ${isCustomActive ? 'active' : ''}`}
        onClick={() => setCustomPopoverOpen(prev => !prev)}
        title={t('sidebar.layout.custom')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="11" y1="3" x2="11" y2="14" />
          <line x1="3" y1="14" x2="21" y2="14" />
          <line x1="16" y1="14" x2="16" y2="21" />
        </svg>
      </button>

      {customPopoverOpen && (
        <CustomLayoutPopover
          anchorEl={customButtonRef.current}
          presets={customLayoutPresets}
          activeMode={layoutMode}
          onClose={() => setCustomPopoverOpen(false)}
          onApplyPreset={(presetId, effectiveCount) =>
            onLayoutChange({ kind: 'custom', presetId }, effectiveCount)
          }
          onCreatePreset={(payload) => addCustomLayoutPreset(payload)}
          onCommitEdit={(id, payload) => onCommitPresetEdit(id, payload)}
          onDuplicatePreset={(id) => duplicateCustomLayoutPreset(id)}
          onDeletePreset={(id) => handleDeletePreset(id)}
        />
      )}

      {/* Spacer Push the Settings button to the bottom */}
      <div className="sidebar-spacer" />

      {/* Change Log button */}
      <button
        className={`sidebar-btn ${isChangeLogOpen ? 'active' : ''}`}
        onClick={() => {
          // Product telemetry: count only the open action, not the close toggle.
          if (!isChangeLogOpen) trackFeatureUse('changelog')
          onChangeLogToggle()
        }}
        title={t('sidebar.changeLog')}
        data-testid="sidebar-change-log-button"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3Z" />
          <path d="M5 3v4" />
          <path d="M19 17v4" />
          <path d="M3 5h4" />
          <path d="M17 19h4" />
        </svg>
      </button>

      <button
        className={`sidebar-btn ${isFeedbackOpen ? 'active' : ''}`}
        onClick={onFeedbackToggle}
        title={t('sidebar.feedback')}
        data-testid="sidebar-feedback-button"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
          <path d="M9 18h6" />
          <path d="M10 22h4" />
        </svg>
      </button>

      {/* Settings button */}
      <button
        className={`sidebar-btn ${activePanel === 'settings' ? 'active' : ''}`}
        onClick={handleSettingsToggle}
        title={t('sidebar.settings')}
        data-testid="sidebar-settings-button"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
    </div>
  )
}
