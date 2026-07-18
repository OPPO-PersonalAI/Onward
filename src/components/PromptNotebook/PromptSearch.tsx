/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useRef, memo } from 'react'
import { useI18n } from '../../i18n/useI18n'
import { trackFeatureUse } from '../../telemetry/track-feature-use'

interface PromptSearchProps {
  value: string
  onChange: (value: string) => void
  saveMessage?: { type: 'success' | 'error'; text: string } | null
}

export const PromptSearch = memo(function PromptSearch({ value, onChange, saveMessage }: PromptSearchProps) {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value
    // Count once per search session: fire only on the empty → non-empty
    // transition, not on every keystroke while a query is being refined.
    if (value === '' && next !== '') {
      trackFeatureUse('prompt-search')
    }
    onChange(next)
  }, [value, onChange])

  const handleClear = useCallback(() => {
    onChange('')
    inputRef.current?.focus()
  }, [onChange])

  // Shortcut support
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onChange('')
    }
  }, [onChange])

  return (
    <div className="prompt-search">
      <svg
        className="prompt-search-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        ref={inputRef}
        type="text"
        className="prompt-search-input"
        placeholder={t('promptSearch.placeholder')}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />
      {value && (
        <button
          className="prompt-search-clear"
          onClick={handleClear}
          title={t('promptSearch.clear')}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
      {saveMessage && (
        <span className={`prompt-search-status ${saveMessage.type}`}>
          {saveMessage.text}
        </span>
      )}
    </div>
  )
})
