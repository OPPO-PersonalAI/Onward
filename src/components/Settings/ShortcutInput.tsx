/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { useI18n } from '../../i18n/useI18n'
import { trackFeatureUse } from '../../telemetry/track-feature-use'

interface ShortcutInputProps {
  value: string | null
  onChange: (value: string | null) => void
  onConflict?: (conflictKey: string | null) => void
  placeholder?: string
}

// Convert KeyboardEvent to Electron Accelerator format
function keyEventToAccelerator(e: KeyboardEvent): string | null {
  const keys: string[] = []

  // Add modifier keys
  if (e.metaKey) keys.push('CommandOrControl')
  if (e.ctrlKey && !e.metaKey) keys.push('Ctrl')
  if (e.altKey) keys.push('Alt')
  if (e.shiftKey) keys.push('Shift')

  // Get primary key
  let mainKey = ''
  const code = e.code

  // Function keys
  if (code.startsWith('F') && /^F\d{1,2}$/.test(code)) {
    mainKey = code
  }
  // Numeric keys
  else if (code.startsWith('Digit')) {
    mainKey = code.replace('Digit', '')
  }
  // letter keys
  else if (code.startsWith('Key')) {
    mainKey = code.replace('Key', '')
  }
  // Special keys
  else {
    const specialKeys: Record<string, string> = {
      'Space': 'Space',
      'Enter': 'Enter',
      'Tab': 'Tab',
      'Backspace': 'Backspace',
      'Delete': 'Delete',
      'Escape': 'Escape',
      'ArrowUp': 'Up',
      'ArrowDown': 'Down',
      'ArrowLeft': 'Left',
      'ArrowRight': 'Right',
      'Home': 'Home',
      'End': 'End',
      'PageUp': 'PageUp',
      'PageDown': 'PageDown',
      'Insert': 'Insert',
      'Minus': '-',
      'Equal': '=',
      'BracketLeft': '[',
      'BracketRight': ']',
      'Backslash': '\\',
      'Semicolon': ';',
      'Quote': "'",
      'Comma': ',',
      'Period': '.',
      'Slash': '/',
      'Backquote': '`'
    }
    mainKey = specialKeys[code] || ''
  }

  // If there is no primary key, returns null
  if (!mainKey) return null

  // If there are only modifier keys but no primary keys, null is also returned.
  if (keys.length === 0) return null

  keys.push(mainKey)
  return keys.join('+')
}

// Convert Accelerator format to display format
function acceleratorToDisplay(accelerator: string | null): string {
  if (!accelerator) return ''

  const platform = window.electronAPI?.platform || 'darwin'
  const isMac = platform === 'darwin'

  const parts = accelerator.split('+')
  const displayParts = parts.map(part => {
    const mappings: Record<string, string> = {
      'CommandOrControl': isMac ? '\u2318' : 'Ctrl',
      'Command': '\u2318',
      'Control': 'Ctrl',
      'Ctrl': 'Ctrl',
      'Alt': isMac ? '\u2325' : 'Alt',
      'Option': '\u2325',
      'Shift': isMac ? '\u21E7' : 'Shift',
      'Meta': isMac ? '\u2318' : 'Win',
      'Space': '\u2423',
      'Enter': '\u21B5',
      'Tab': '\u21E5',
      'Backspace': '\u232B',
      'Delete': '\u2326',
      'Escape': 'Esc',
      'Up': '\u2191',
      'Down': '\u2193',
      'Left': '\u2190',
      'Right': '\u2192'
    }
    return mappings[part] || part
  })

  return displayParts.join(isMac ? '' : '+')
}

export function ShortcutInput({
  value,
  onChange,
  onConflict,
  placeholder
}: ShortcutInputProps) {
  const { t } = useI18n()
  const [isRecording, setIsRecording] = useState(false)
  const [conflict, setConflict] = useState<string | null>(null)
  const inputRef = useRef<HTMLDivElement>(null)

  // Check for shortcut conflicts
  const checkConflict = useCallback(async (accelerator: string) => {
    if (!window.electronAPI?.settings) return null

    const conflictKey = await window.electronAPI.settings.checkShortcutConflict(accelerator)
    return conflictKey
  }, [])

  // Handle keyboard presses
  const handleKeyDown = useCallback(async (e: KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()

    // If it is Escape, cancel recording
    if (e.key === 'Escape') {
      setIsRecording(false)
      setConflict(null)
      return
    }

    // Convert to Accelerator format
    const accelerator = keyEventToAccelerator(e)
    if (!accelerator) return

    // Check for conflicts
    const conflictKey = await checkConflict(accelerator)
    if (conflictKey) {
      setConflict(conflictKey)
      onConflict?.(conflictKey)
      return
    }

    // Set the new shortcut
    setConflict(null)
    setIsRecording(false)
    // Product telemetry: a recorded shortcut was committed.
    trackFeatureUse('shortcut-edit')
    onChange(accelerator)
    onConflict?.(null)
  }, [onChange, onConflict, checkConflict])

  // Process click to start recording
  const handleClick = useCallback(() => {
    setIsRecording(true)
    setConflict(null)
  }, [])

  // Dealing with losing focus
  const handleBlur = useCallback(() => {
    setIsRecording(false)
    setConflict(null)
  }, [])

  // Handle clear
  const handleClear = useCallback(() => {
    onChange(null)
    setConflict(null)
    onConflict?.(null)
  }, [onChange, onConflict])

  // Add keyboard event listener
  useEffect(() => {
    if (!isRecording) return

    const element = inputRef.current
    if (!element) return

    const listener = (e: Event) => handleKeyDown(e as KeyboardEvent)
    element.addEventListener('keydown', listener)
    return () => {
      element.removeEventListener('keydown', listener)
    }
  }, [isRecording, handleKeyDown])

  const displayValue = isRecording
    ? t('settings.shortcut.prompt')
    : value
      ? acceleratorToDisplay(value)
      : (placeholder || t('settings.shortcut.notSet'))

  const inputClassName = [
    'shortcut-input',
    isRecording && 'recording',
    conflict && 'conflict',
    !value && !isRecording && 'not-set'
  ].filter(Boolean).join(' ')

  return (
    <div className="shortcut-input-wrapper">
      <div
        ref={inputRef}
        className={inputClassName}
        tabIndex={0}
        onClick={handleClick}
        onBlur={handleBlur}
      >
        {displayValue}
      </div>
      <button
        className="shortcut-clear-btn"
        onClick={handleClear}
        disabled={!value}
        title={t('settings.shortcut.clear')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
      {conflict && (
        <div className="shortcut-conflict-msg">
          {t('settings.shortcut.conflict', { label: getShortcutLabel(conflict, t) })}
        </div>
      )}
    </div>
  )
}

// Get the display label for the shortcut
function getShortcutLabel(key: string, t: ReturnType<typeof useI18n>['t']): string {
  const labels: Record<string, string> = {
    focusTerminal1: t('settings.shortcut.focusTask', { index: 1 }),
    focusTerminal2: t('settings.shortcut.focusTask', { index: 2 }),
    focusTerminal3: t('settings.shortcut.focusTask', { index: 3 }),
    focusTerminal4: t('settings.shortcut.focusTask', { index: 4 }),
    focusTerminal5: t('settings.shortcut.focusTask', { index: 5 }),
    focusTerminal6: t('settings.shortcut.focusTask', { index: 6 }),
    focusTerminal7: t('settings.shortcut.focusTask', { index: 7 }),
    focusTerminal8: t('settings.shortcut.focusTask', { index: 8 }),
    switchTab1: t('settings.shortcut.switchTab', { index: 1 }),
    switchTab2: t('settings.shortcut.switchTab', { index: 2 }),
    switchTab3: t('settings.shortcut.switchTab', { index: 3 }),
    switchTab4: t('settings.shortcut.switchTab', { index: 4 }),
    switchTab5: t('settings.shortcut.switchTab', { index: 5 }),
    switchTab6: t('settings.shortcut.switchTab', { index: 6 }),
    activateAndFocusPrompt: t('settings.shortcut.togglePrompt'),
    addToHistory: t('settings.shortcut.addToHistory'),
    focusPromptEditor: t('settings.shortcut.focusPromptEditor'),
    terminalGitDiff: t('settings.shortcut.viewGitDiff'),
    terminalGitHistory: t('settings.shortcut.viewGitHistory'),
    terminalChangeWorkDir: t('settings.shortcut.changeWorkDir'),
    terminalOpenWorkDir: t('settings.shortcut.openWorkDir'),
    terminalProjectEditor: t('settings.shortcut.openProjectEditor'),
    viewGitDiff: t('settings.shortcut.projectEditorViewGitDiff'),
    promptEditCancel: t('settings.shortcut.reservedPromptEditCancel'),
    promptEditSave: t('settings.shortcut.reservedPromptEditSave'),
    promptEditSaveAsNew: t('settings.shortcut.reservedPromptEditSaveAsNew')
  }
  return labels[key] || key
}
