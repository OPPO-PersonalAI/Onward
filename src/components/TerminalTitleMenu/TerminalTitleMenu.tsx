/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { createPortal } from 'react-dom'
import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import { useI18n } from '../../i18n/useI18n'
import { trackFeatureUse } from '../../telemetry/track-feature-use'
import './TerminalTitleMenu.css'

const MENU_VIEWPORT_PADDING = 8
const MENU_VERTICAL_GAP = 4

export type TerminalTitleMenuItemKey = 'rename' | 'auto-follow-toggle' | 'use-branch' | 'use-repo'

interface TerminalTitleMenuProps {
  open: boolean
  onRequestClose: () => void
  anchorEl: HTMLElement | null
  onRename: () => void
  onUseBranch: () => void
  onUseRepoName: () => void
  /** Current state of the "Auto-follow Git branch name" preference. */
  autoFollowEnabled: boolean
  /**
   * Toggle the auto-follow preference. The menu stays open after this
   * interaction so the user can see the new state, unlike Rename / Use Branch
   * / Use Repo which close the menu after activation.
   */
  onToggleAutoFollow: () => void
  branch: string | null
  repoName: string | null
  forceClose?: boolean
}

export function TerminalTitleMenu({
  open,
  onRequestClose,
  anchorEl,
  onRename,
  onUseBranch,
  onUseRepoName,
  autoFollowEnabled,
  onToggleAutoFollow,
  branch,
  repoName,
  forceClose = false
}: TerminalTitleMenuProps) {
  const { t } = useI18n()
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPosition, setMenuPosition] = useState({ left: MENU_VIEWPORT_PADDING, top: MENU_VIEWPORT_PADDING })

  const updateMenuPosition = useCallback(() => {
    const menu = menuRef.current
    if (!anchorEl || !menu) return

    const anchorRect = anchorEl.getBoundingClientRect()
    const menuWidth = menu.offsetWidth
    const menuHeight = menu.offsetHeight
    const maxLeft = Math.max(MENU_VIEWPORT_PADDING, window.innerWidth - menuWidth - MENU_VIEWPORT_PADDING)
    const maxTop = Math.max(MENU_VIEWPORT_PADDING, window.innerHeight - menuHeight - MENU_VIEWPORT_PADDING)
    const openBelowTop = anchorRect.bottom + MENU_VERTICAL_GAP
    const openAboveTop = anchorRect.top - menuHeight - MENU_VERTICAL_GAP

    let nextLeft = Math.round(anchorRect.left)
    let nextTop = Math.round(openBelowTop)

    if (nextLeft > maxLeft) {
      nextLeft = maxLeft
    }
    if (nextLeft < MENU_VIEWPORT_PADDING) {
      nextLeft = MENU_VIEWPORT_PADDING
    }
    if (nextTop > maxTop && openAboveTop >= MENU_VIEWPORT_PADDING) {
      nextTop = Math.round(openAboveTop)
    }
    if (nextTop > maxTop) {
      nextTop = maxTop
    }
    if (nextTop < MENU_VIEWPORT_PADDING) {
      nextTop = MENU_VIEWPORT_PADDING
    }

    setMenuPosition((current) => {
      if (current.left === nextLeft && current.top === nextTop) {
        return current
      }
      return { left: nextLeft, top: nextTop }
    })
  }, [anchorEl])

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      const clickedAnchor = anchorEl ? anchorEl.contains(target) : false
      const clickedMenu = menuRef.current ? menuRef.current.contains(target) : false
      if (!clickedAnchor && !clickedMenu) {
        onRequestClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [open, anchorEl, onRequestClose])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onRequestClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, onRequestClose])

  useEffect(() => {
    if (forceClose && open) {
      onRequestClose()
    }
  }, [forceClose, open, onRequestClose])

  useLayoutEffect(() => {
    if (!open) return
    updateMenuPosition()
  }, [open, updateMenuPosition])

  useEffect(() => {
    if (!open) return
    const handleViewportChange = () => {
      updateMenuPosition()
    }
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)
    return () => {
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [open, updateMenuPosition])

  if (!open) return null

  const canUseBranch = typeof branch === 'string' && branch.trim().length > 0
  const canUseRepo = typeof repoName === 'string' && repoName.trim().length > 0

  const handleItemClick = (action: () => void) => {
    onRequestClose()
    action()
  }

  return createPortal(
    <div
      ref={menuRef}
      className="terminal-title-menu"
      style={{ left: menuPosition.left, top: menuPosition.top }}
      role="menu"
      aria-label={t('terminalTitleMenu.ariaLabel')}
      onMouseDown={(event) => event.stopPropagation()}
      data-testid="terminal-title-menu"
    >
      <button
        type="button"
        className="terminal-title-menu-item"
        role="menuitem"
        title={t('terminalTitleMenu.renameTooltip')}
        onClick={() => { trackFeatureUse('terminal-rename'); handleItemClick(onRename) }}
        data-action="rename"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M12.146.854a.5.5 0 0 1 .708 0l2.292 2.292a.5.5 0 0 1 0 .708l-9.5 9.5a.5.5 0 0 1-.241.131l-3.5 1a.5.5 0 0 1-.616-.616l1-3.5a.5.5 0 0 1 .131-.241l9.5-9.5zM11.207 2.5L13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 3 10.707V11h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l7.5-7.5z" />
        </svg>
        <span>{t('terminalTitleMenu.renameItem')}</span>
      </button>
      <div className="terminal-title-menu-separator" role="separator" aria-orientation="horizontal" />
      <button
        type="button"
        className="terminal-title-menu-item terminal-title-menu-checkbox-item"
        role="menuitemcheckbox"
        aria-checked={autoFollowEnabled}
        title={t('terminalTitleMenu.autoFollowBranchTooltip')}
        onClick={() => { trackFeatureUse('auto-follow'); onToggleAutoFollow() }}
        data-action="auto-follow-toggle"
        data-checked={autoFollowEnabled ? 'true' : 'false'}
      >
        {autoFollowEnabled ? (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M2.5 2A1.5 1.5 0 0 0 1 3.5v9A1.5 1.5 0 0 0 2.5 14h11a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 13.5 2h-11zm9.255 3.182-5.25 5.25a.5.5 0 0 1-.708 0l-2.5-2.5a.5.5 0 0 1 .708-.708l2.146 2.147 4.896-4.896a.5.5 0 1 1 .708.707z" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M2.5 2A1.5 1.5 0 0 0 1 3.5v9A1.5 1.5 0 0 0 2.5 14h11a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 13.5 2h-11zm0 1h11a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-9a.5.5 0 0 1 .5-.5z" />
          </svg>
        )}
        <span>{t('terminalTitleMenu.autoFollowBranchItem')}</span>
      </button>
      <div className="terminal-title-menu-separator" role="separator" aria-orientation="horizontal" />
      <button
        type="button"
        className="terminal-title-menu-item"
        role="menuitem"
        disabled={!canUseBranch}
        aria-disabled={!canUseBranch}
        title={canUseBranch ? t('terminalTitleMenu.useBranchTooltip') : t('terminalTitleMenu.useBranchDisabledTooltip')}
        onClick={() => { if (canUseBranch) { trackFeatureUse('title-from-branch'); handleItemClick(onUseBranch) } }}
        data-action="use-branch"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M11.75 2.5a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5zm-2.25.75a2.25 2.25 0 1 0 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a4 4 0 0 0-2.25.694v-5.34a2.25 2.25 0 1 0-1.5 0v5.388a2.25 2.25 0 1 0 1.5.028V9a2.5 2.5 0 0 1 2.5-2.5h4A4 4 0 0 0 14 5.6V5.372A2.25 2.25 0 0 0 9.5 3.25zM2.5 13.75a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0z" />
        </svg>
        <span>{t('terminalTitleMenu.useBranchItem')}</span>
      </button>
      <button
        type="button"
        className="terminal-title-menu-item"
        role="menuitem"
        disabled={!canUseRepo}
        aria-disabled={!canUseRepo}
        title={canUseRepo ? t('terminalTitleMenu.useRepoTooltip') : t('terminalTitleMenu.useRepoDisabledTooltip')}
        onClick={() => { if (canUseRepo) { trackFeatureUse('title-from-branch'); handleItemClick(onUseRepoName) } }}
        data-action="use-repo"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M14.5 3H7.71l-.85-.85A.5.5 0 0 0 6.5 2h-5a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-10a.5.5 0 0 0-.5-.5zM14 13H2V3h4.29l.85.85a.5.5 0 0 0 .36.15H14v9z" />
        </svg>
        <span>{t('terminalTitleMenu.useRepoItem')}</span>
      </button>
    </div>,
    document.body
  )
}
