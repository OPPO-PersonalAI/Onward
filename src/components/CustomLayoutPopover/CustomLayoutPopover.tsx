/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../../i18n/useI18n'
import type { CustomLayoutPreset, LayoutMode } from '../../types/prompt'
import { CustomLayoutEditor } from '../CustomLayoutEditor/CustomLayoutEditor'
import { CustomLayoutThumbnail } from './CustomLayoutThumbnail'
import { trackFeatureUse } from '../../telemetry/track-feature-use'
import './CustomLayoutPopover.css'

interface CustomLayoutPopoverProps {
  anchorEl: HTMLElement | null
  presets: readonly CustomLayoutPreset[]
  activeMode: LayoutMode
  onClose: () => void
  /**
   * Apply a custom preset by id. The optional `effectiveCount` hint is
   * read by the parent's downsize gate when state has not yet
   * propagated — e.g. immediately after createPreset queues a state
   * update and we apply the new preset in the same tick.
   */
  onApplyPreset: (presetId: string, effectiveCount?: number) => void
  onCreatePreset: (preset: { name: string; cells: CustomLayoutPreset['cells'] }) => string
  /**
   * Transactional preset edit. The popover hands the user's intent to
   * the parent; the parent (App.tsx) decides whether to gate on a
   * downsize dialog before committing cells. This avoids the bug where
   * cells flipped before the dialog finished, leaving cancelled edits
   * with hidden PTYs (Codex P1).
   */
  onCommitEdit: (id: string, payload: { name: string; cells: CustomLayoutPreset['cells'] }) => void
  onDuplicatePreset: (id: string) => string
  onDeletePreset: (id: string) => void
}

type PopoverView = 'list' | 'create' | { kind: 'edit'; presetId: string }

export function CustomLayoutPopover({
  anchorEl,
  presets,
  activeMode,
  onClose,
  onApplyPreset,
  onCreatePreset,
  onCommitEdit,
  onDuplicatePreset,
  onDeletePreset
}: CustomLayoutPopoverProps) {
  const { t } = useI18n()
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const [view, setView] = useState<PopoverView>(presets.length === 0 ? 'create' : 'list')
  const [menuOpenForId, setMenuOpenForId] = useState<string | null>(null)

  // Anchor next to the sidebar button (right edge + 8px margin).
  useEffect(() => {
    if (!anchorEl) return
    const rect = anchorEl.getBoundingClientRect()
    setPosition({ top: rect.top, left: rect.right + 8 })
  }, [anchorEl])

  // Close on outside click / escape.
  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!popoverRef.current || !target) return
      if (popoverRef.current.contains(target)) return
      if (anchorEl && anchorEl.contains(target)) return
      // The per-cell right-click menu is rendered through its own
      // createPortal(document.body) call inside CustomLayoutEditor — DOM
      // wise it's a sibling of this popover, not a descendant. Without
      // this guard a click on the menu's number / reset / delete buttons
      // fires mousedown on body first, the popover treats it as outside,
      // and the whole editor unmounts before the menu's onClick fires —
      // i.e. the picker silently does nothing. Treat its subtree as
      // logically "inside".
      if (target.closest('.custom-layout-cell-context')) return
      onClose()
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [anchorEl, onClose])

  // Create flow: the new preset has no referencing tabs, so cell
  // commit is safe immediately. Apply with a hint so the active tab's
  // downsize gate sees the right count before AppState commits.
  const handleSaveCreate = useCallback((payload: { name: string; cells: CustomLayoutPreset['cells'] }) => {
    const id = onCreatePreset(payload)
    trackFeatureUse('custom-layout')
    onApplyPreset(id, payload.cells.length)
    onClose()
  }, [onApplyPreset, onClose, onCreatePreset])

  // Edit flow: hand intent to the parent. Parent decides whether to gate
  // on a downsize dialog (see App.tsx::handleCommitPresetEdit). Cells
  // are NOT touched here — that's the whole fix for Codex P1.
  const handleSaveEdit = useCallback((id: string, payload: { name: string; cells: CustomLayoutPreset['cells'] }) => {
    onCommitEdit(id, payload)
    onClose()
  }, [onCommitEdit, onClose])

  if (!position) return null

  const editTarget = typeof view === 'object' && view.kind === 'edit'
    ? presets.find(p => p.id === view.presetId) ?? null
    : null

  return createPortal(
    <div
      ref={popoverRef}
      className="custom-layout-popover"
      style={{ top: position.top, left: position.left }}
    >
      {view === 'list' && (
        <div className="custom-layout-popover-list">
          <div className="custom-layout-popover-header">
            <span className="custom-layout-popover-title">{t('sidebar.layout.custom.title')}</span>
          </div>
          {presets.length === 0 ? (
            <div className="custom-layout-popover-empty">{t('sidebar.layout.custom.empty')}</div>
          ) : (
            presets.map(preset => {
              const isActive = activeMode.kind === 'custom' && activeMode.presetId === preset.id
              return (
                <div
                  key={preset.id}
                  className={`custom-layout-popover-item ${isActive ? 'is-active' : ''}`}
                >
                  <button
                    type="button"
                    className="custom-layout-popover-item-main"
                    onClick={() => {
                      trackFeatureUse('custom-layout')
                      onApplyPreset(preset.id)
                      onClose()
                    }}
                    title={preset.name}
                  >
                    <CustomLayoutThumbnail cells={preset.cells} />
                    <span className="custom-layout-popover-item-name">
                      {preset.name || t('sidebar.layout.custom.untitled')}
                    </span>
                  </button>
                  <div className="custom-layout-popover-item-menu-wrapper">
                    <button
                      type="button"
                      className="custom-layout-popover-item-menu"
                      onClick={(e) => {
                        e.stopPropagation()
                        setMenuOpenForId(menuOpenForId === preset.id ? null : preset.id)
                      }}
                      aria-label="actions"
                    >
                      ⋯
                    </button>
                    {menuOpenForId === preset.id && (
                      <div className="custom-layout-popover-menu">
                        <button
                          type="button"
                          onClick={() => {
                            setMenuOpenForId(null)
                            setView({ kind: 'edit', presetId: preset.id })
                          }}
                        >
                          {t('sidebar.layout.custom.edit')}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setMenuOpenForId(null)
                            onDuplicatePreset(preset.id)
                          }}
                        >
                          {t('sidebar.layout.custom.duplicate')}
                        </button>
                        <button
                          type="button"
                          className="custom-layout-popover-menu-danger"
                          onClick={() => {
                            setMenuOpenForId(null)
                            onDeletePreset(preset.id)
                          }}
                        >
                          {t('sidebar.layout.custom.delete')}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )
            })
          )}
          <button
            type="button"
            className="custom-layout-popover-create"
            onClick={() => setView('create')}
          >
            {t('sidebar.layout.custom.create')}
          </button>
        </div>
      )}

      {view === 'create' && (
        <CustomLayoutEditor
          onSave={handleSaveCreate}
          onCancel={() => setView(presets.length > 0 ? 'list' : 'list')}
        />
      )}

      {editTarget && (
        <CustomLayoutEditor
          initialName={editTarget.name}
          initialCells={editTarget.cells}
          onSave={(payload) => handleSaveEdit(editTarget.id, payload)}
          onCancel={() => setView('list')}
        />
      )}
    </div>,
    document.body
  )
}
