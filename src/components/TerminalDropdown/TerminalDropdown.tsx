/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { createPortal } from 'react-dom'
import { useState, useEffect, useRef, useLayoutEffect, useCallback } from 'react'
import { useI18n } from '../../i18n/useI18n'
import './TerminalDropdown.css'

const MENU_VIEWPORT_PADDING = 8
const MENU_VERTICAL_GAP = 4

interface TerminalDropdownProps {
  terminalId: string
  onViewGitDiff: () => void
  onViewGitHistory: () => void
  onChangeWorkDir: () => void
  onOpenWorkDir: () => void
  onOpenProjectEditor: () => void
  onToggleBrowser: () => void
  isBrowserOpen: boolean
  onOpenCodingAgent: () => void
  /** Arm grid rearrange mode (the menu-triggered path; long-press is the other). */
  onRearrangeTasks: () => void
  /** False when the layout has a single Task — there is nothing to reorder. */
  canRearrangeTasks: boolean
  forceClose?: boolean
}

export function TerminalDropdown({
  terminalId: _terminalId,
  onViewGitDiff,
  onViewGitHistory,
  onChangeWorkDir,
  onOpenWorkDir,
  onOpenProjectEditor,
  onToggleBrowser,
  isBrowserOpen,
  onOpenCodingAgent,
  onRearrangeTasks,
  canRearrangeTasks,
  forceClose = false
}: TerminalDropdownProps) {
  const { t } = useI18n()
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPosition, setMenuPosition] = useState({ left: MENU_VIEWPORT_PADDING, top: MENU_VIEWPORT_PADDING })

  const closeMenu = useCallback(() => {
    setIsOpen(false)
  }, [])

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current
    const menu = menuRef.current
    if (!trigger || !menu) return

    const triggerRect = trigger.getBoundingClientRect()
    const menuWidth = menu.offsetWidth
    const menuHeight = menu.offsetHeight
    const maxLeft = Math.max(MENU_VIEWPORT_PADDING, window.innerWidth - menuWidth - MENU_VIEWPORT_PADDING)
    const maxTop = Math.max(MENU_VIEWPORT_PADDING, window.innerHeight - menuHeight - MENU_VIEWPORT_PADDING)
    const openBelowTop = triggerRect.bottom + MENU_VERTICAL_GAP
    const openAboveTop = triggerRect.top - menuHeight - MENU_VERTICAL_GAP

    let nextLeft = Math.round(triggerRect.left)
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
  }, [])

  // Click outside to close menu
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      const clickedTrigger = dropdownRef.current?.contains(target)
      const clickedMenu = menuRef.current?.contains(target)
      if (!clickedTrigger && !clickedMenu) {
        closeMenu()
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => {
        document.removeEventListener('mousedown', handleClickOutside)
      }
    }
  }, [closeMenu, isOpen])

  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [closeMenu, isOpen])

  useEffect(() => {
    if (forceClose) {
      closeMenu()
    }
  }, [closeMenu, forceClose])

  useLayoutEffect(() => {
    if (!isOpen) return
    updateMenuPosition()
  }, [isOpen, updateMenuPosition])

  useEffect(() => {
    if (!isOpen) return

    const handleViewportChange = () => {
      updateMenuPosition()
    }

    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)
    return () => {
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [isOpen, updateMenuPosition])

  // Handling menu item clicks with telemetry
  const handleMenuItemClick = (action: () => void, telemetryEvent?: string, telemetryAction?: string) => {
    closeMenu()
    if (telemetryEvent && telemetryAction) {
      window.electronAPI.telemetry.track(telemetryEvent, { action: telemetryAction })
    }
    action()
  }

  const handleTriggerClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (isOpen) {
      closeMenu()
      return
    }

    const triggerRect = triggerRef.current?.getBoundingClientRect()
    if (triggerRect) {
      setMenuPosition({
        left: Math.max(MENU_VIEWPORT_PADDING, Math.round(triggerRect.left)),
        top: Math.round(triggerRect.bottom + MENU_VERTICAL_GAP)
      })
    }
    setIsOpen(true)
  }

  const menu = isOpen ? createPortal(
    <div
      className="terminal-dropdown-menu"
      ref={menuRef}
      style={{ left: menuPosition.left, top: menuPosition.top }}
      role="menu"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="terminal-dropdown-section" role="presentation">
        <div className="terminal-dropdown-section-title">
          {t('terminalDropdown.workspaceGroup')}
        </div>
        <div className="terminal-dropdown-section-card">
          <button
            type="button"
            className="terminal-dropdown-item"
            onClick={() => { handleMenuItemClick(onOpenWorkDir, 'dropdown/workspace', 'openDir') }}
            role="menuitem"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M14.5 3H7.71l-.85-.85A.5.5 0 0 0 6.5 2h-5a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-10a.5.5 0 0 0-.5-.5zM14 13H2V3h4.29l.85.85a.5.5 0 0 0 .36.15H14v9z"/>
              <path d="M8 5.5a.5.5 0 0 1 .5.5v2.5H11a.5.5 0 0 1 0 1H8.5V12a.5.5 0 0 1-1 0V9.5H5a.5.5 0 0 1 0-1h2.5V6a.5.5 0 0 1 .5-.5z"/>
            </svg>
            <span>{t('terminalDropdown.openWorkDir')}</span>
          </button>
          <button
            type="button"
            className="terminal-dropdown-item"
            onClick={() => { handleMenuItemClick(onChangeWorkDir, 'dropdown/workspace', 'changeDir') }}
            role="menuitem"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M14.5 3H7.71l-.85-.85A.5.5 0 0 0 6.5 2h-5a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-10a.5.5 0 0 0-.5-.5zm-.5 10H2V3h4.29l.85.85a.5.5 0 0 0 .36.15H14v9z"/>
            </svg>
            <span>{t('terminalDropdown.changeWorkDir')}</span>
          </button>
        </div>
      </div>

      <div className="terminal-dropdown-section" role="presentation">
        <div className="terminal-dropdown-section-title">
          {t('terminalDropdown.developmentGroup')}
        </div>
        <div className="terminal-dropdown-section-card">
	          <button
	            type="button"
	            className="terminal-dropdown-item"
	            data-terminal-dropdown-action="editor"
	            onClick={() => { handleMenuItemClick(onOpenProjectEditor, 'dropdown/development', 'editor') }}
	            role="menuitem"
	          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2.5 2.75A.75.75 0 0 1 3.25 2h4.19c.2 0 .39.08.53.22l1.06 1.06c.14.14.33.22.53.22h3.24a.75.75 0 0 1 .75.75v9.5a.75.75 0 0 1-.75.75H3.25a.75.75 0 0 1-.75-.75v-11zm1.5.75v9.5h8.5V4.5h-3.5a1 1 0 0 1-.7-.3L7 2.5H4z" />
              <path d="M6.25 6.5a.75.75 0 0 1 .75-.75h4a.75.75 0 0 1 0 1.5H8.5v3.25a.75.75 0 0 1-1.5 0V7.25H7a.75.75 0 0 1-.75-.75z" />
            </svg>
            <span>{t('terminalDropdown.openEditor')}</span>
          </button>
	          <button
	            type="button"
	            className="terminal-dropdown-item"
	            data-terminal-dropdown-action="diff"
	            onClick={() => { handleMenuItemClick(onViewGitDiff, 'dropdown/development', 'gitDiff') }}
	            role="menuitem"
	          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M5.5 2.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM4 5a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0zm6.5 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM9 11a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0z"/>
              <path d="M5.5 8v4.5h1V8h-1zm4-2.5V1h-1v4.5h1z"/>
              <path d="M5.5 7.5h4v1h-4v-1z"/>
            </svg>
            <span>{t('terminalDropdown.viewGitDiff')}</span>
          </button>
	          <button
	            type="button"
	            className="terminal-dropdown-item"
	            data-terminal-dropdown-action="history"
	            onClick={() => { handleMenuItemClick(onViewGitHistory, 'dropdown/development', 'gitHistory') }}
	            role="menuitem"
	          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3 2.75A.75.75 0 0 1 3.75 2h6.5a.75.75 0 0 1 .75.75v1.5H14a.75.75 0 0 1 .75.75v7.25a.75.75 0 0 1-.75.75H7.75a.75.75 0 0 1-.75-.75V11H3.75A.75.75 0 0 1 3 10.25Z" />
              <path d="M4.5 5.5A.5.5 0 0 1 5 5h5a.5.5 0 0 1 0 1H5a.5.5 0 0 1-.5-.5zm0 2A.5.5 0 0 1 5 7h5a.5.5 0 0 1 0 1H5a.5.5 0 0 1-.5-.5zm0 2A.5.5 0 0 1 5 9h3.5a.5.5 0 0 1 0 1H5a.5.5 0 0 1-.5-.5z" />
            </svg>
            <span>{t('terminalDropdown.viewGitHistory')}</span>
          </button>
        </div>
      </div>

      <div className="terminal-dropdown-section" role="presentation">
        <div className="terminal-dropdown-section-title">
          {t('terminalDropdown.toolsGroup')}
        </div>
        <div className="terminal-dropdown-section-card">
          <button
            type="button"
            className="terminal-dropdown-item"
            onClick={() => { handleMenuItemClick(() => onOpenCodingAgent(), 'dropdown/tools', 'codeAgent') }}
            role="menuitem"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1a.5.5 0 0 1 .5.5V3h2A2.5 2.5 0 0 1 13 5.5v5A2.5 2.5 0 0 1 10.5 13h-5A2.5 2.5 0 0 1 3 10.5v-5A2.5 2.5 0 0 1 5.5 3h2V1.5A.5.5 0 0 1 8 1zM5.5 4A1.5 1.5 0 0 0 4 5.5v5A1.5 1.5 0 0 0 5.5 12h5a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 10.5 4h-5zM6 6.5a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm4 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2zM5.5 10h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1z"/>
              <path d="M2.5 6a.5.5 0 0 0-.5.5v2a.5.5 0 0 0 1 0v-2a.5.5 0 0 0-.5-.5zm11 0a.5.5 0 0 0-.5.5v2a.5.5 0 0 0 1 0v-2a.5.5 0 0 0-.5-.5z"/>
            </svg>
            <span>{t('terminalDropdown.codeAgent')}</span>
          </button>
          <button
            type="button"
            className={`terminal-dropdown-item${isBrowserOpen ? ' is-active' : ''}`}
            onClick={() => { handleMenuItemClick(onToggleBrowser, 'dropdown/tools', 'browser') }}
            role="menuitem"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm7.5-6.923c-.67.204-1.335.82-1.887 1.855A8 8 0 0 0 5.145 4H7.5V1.077zM4.09 4a9.3 9.3 0 0 1 .64-1.539 7 7 0 0 1 .597-.933A7 7 0 0 0 2.255 4zm-.582 3.5c.03-.877.138-1.718.312-2.5H1.674a7 7 0 0 0-.656 2.5zM4.847 5a12.5 12.5 0 0 0-.338 2.5H7.5V5zM8.5 5v2.5h2.99a12.5 12.5 0 0 0-.337-2.5zM4.51 8.5a12.5 12.5 0 0 0 .337 2.5H7.5V8.5zm3.99 0V11h2.653c.187-.765.306-1.608.338-2.5zM5.145 12a8 8 0 0 0 .468 1.068c.552 1.035 1.218 1.65 1.887 1.855V12zm.182 2.472a7 7 0 0 1-.597-.933A9.3 9.3 0 0 1 4.09 12H2.255a7 7 0 0 0 3.072 2.472zM3.82 11a13.7 13.7 0 0 1-.312-2.5H1.674A7 7 0 0 0 1.018 11zm6.853 3.472A7 7 0 0 0 13.745 12H11.91a9.3 9.3 0 0 1-.64 1.539 7 7 0 0 1-.597.933M8.5 12v2.923c.67-.204 1.335-.82 1.887-1.855A8 8 0 0 0 10.855 12zm2.31-1H14.33a7 7 0 0 0 .656-2.5H12.18c-.03.877-.138 1.718-.312 2.5zm.747-3.5H14.98a7 7 0 0 0-.656-2.5h-2.49c.174.782.282 1.623.312 2.5zM11.91 4a9.3 9.3 0 0 0-.64-1.539 7 7 0 0 0-.597-.933A7 7 0 0 1 13.745 4zm-1.055 0H8.5V1.077c.67.204 1.335.82 1.887 1.855.173.324.33.682.468 1.068z"/>
            </svg>
            <span>{t(isBrowserOpen ? 'terminalDropdown.closeBrowser' : 'terminalDropdown.openBrowser')}</span>
          </button>
          <button
            type="button"
            className="terminal-dropdown-item"
            data-terminal-dropdown-action="rearrange"
            disabled={!canRearrangeTasks}
            title={canRearrangeTasks ? undefined : t('terminalDropdown.rearrangeTasksDisabledHint')}
            onClick={() => { handleMenuItemClick(onRearrangeTasks, 'dropdown/tools', 'rearrangeTasks') }}
            role="menuitem"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1.5a.5.5 0 0 1 .354.146l2 2a.5.5 0 0 1-.708.708L8.5 3.207V7.5h4.293l-1.147-1.146a.5.5 0 0 1 .708-.708l2 2a.5.5 0 0 1 0 .708l-2 2a.5.5 0 0 1-.708-.708L12.793 8.5H8.5v4.293l1.146-1.147a.5.5 0 0 1 .708.708l-2 2a.5.5 0 0 1-.708 0l-2-2a.5.5 0 0 1 .708-.708L7.5 12.793V8.5H3.207l1.147 1.146a.5.5 0 0 1-.708.708l-2-2a.5.5 0 0 1 0-.708l2-2a.5.5 0 0 1 .708.708L3.207 7.5H7.5V3.207L6.354 4.354a.5.5 0 1 1-.708-.708l2-2A.5.5 0 0 1 8 1.5z"/>
            </svg>
            <span>{t('terminalDropdown.rearrangeTasks')}</span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  ) : null

  return (
    <div className="terminal-dropdown" ref={dropdownRef}>
	      <button
	        ref={triggerRef}
	        className={`terminal-dropdown-trigger ${isOpen ? 'open' : ''}`}
	        data-terminal-dropdown-trigger="true"
	        onClick={handleTriggerClick}
	        title={t('terminalDropdown.title')}
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          className="terminal-dropdown-icon"
        >
          <circle cx="2" cy="6" r="1.2" fill="currentColor" />
          <circle cx="6" cy="6" r="1.2" fill="currentColor" />
          <circle cx="10" cy="6" r="1.2" fill="currentColor" />
        </svg>
      </button>
      {menu}
    </div>
  )
}
