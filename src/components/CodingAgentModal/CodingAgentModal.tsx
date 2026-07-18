/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CodingAgentConfigInput, CodingAgentHistoryEntry, EnvVarEntry } from '../../types/electron'
import { useI18n } from '../../i18n/useI18n'
import type { TranslationKey, TranslationParams } from '../../i18n/core'
import { useModalEscape } from '../../hooks/useModalEscape'
import { trackFeatureUse } from '../../telemetry/track-feature-use'
import './CodingAgentModal.css'

interface CodingAgentModalProps {
  onLaunch: (config: CodingAgentConfigInput) => void
  onCancel: () => void
}

type ModalMode = 'select' | 'edit'

const PRESET_COMMANDS = [
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude Code' }
]

const CUSTOM_SENTINEL = '__custom__'

const MASKED_PLACEHOLDER = '••••••'

function formatRelativeTime(
  timestamp: number,
  t: (key: TranslationKey, params?: TranslationParams) => string
): string {
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return t('codingAgent.timeJustNow')
  const hours = Math.floor(diff / 3600000)
  if (minutes < 60) return t('codingAgent.timeMinutesAgo', { n: minutes })
  const days = Math.floor(diff / 86400000)
  if (hours < 24) return t('codingAgent.timeHoursAgo', { n: hours })
  return t('codingAgent.timeDaysAgo', { n: days })
}

export function CodingAgentModal({ onLaunch, onCancel }: CodingAgentModalProps) {
  const { t } = useI18n()

  const [mode, setMode] = useState<ModalMode>('select')

  // Select mode
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Edit mode form
  const [selectValue, setSelectValue] = useState(PRESET_COMMANDS[0].value)
  const [customCommand, setCustomCommand] = useState('')
  const [useAbsolutePath, setUseAbsolutePath] = useState(false)
  const [executablePathInput, setExecutablePathInput] = useState('')
  const [alias, setAlias] = useState('')
  const [extraArgs, setExtraArgs] = useState('')
  const [envVars, setEnvVars] = useState<EnvVarEntry[]>([])
  const [envVarsExpanded, setEnvVarsExpanded] = useState(false)
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null)

  // Shared
  const [history, setHistory] = useState<CodingAgentHistoryEntry[]>([])
  const [lastUsedId, setLastUsedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [installStatus, setInstallStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [installError, setInstallError] = useState('')
  const [error, setError] = useState('')
  const modalRef = useRef<HTMLDivElement>(null)

  const isCustom = selectValue === CUSTOM_SENTINEL
  const editCommand = isCustom ? customCommand.trim() : selectValue

  const selectedEntry = history.find(e => e.id === selectedId)
  const effectiveCommand = mode === 'select' ? (selectedEntry?.command || '') : editCommand
  const effectiveExecPath = mode === 'select'
    ? (selectedEntry?.executablePath || '')
    : (useAbsolutePath ? executablePathInput.trim() : '')
  const currentPreset = PRESET_COMMANDS.find(p => p.value === effectiveCommand)

  const displayTitle = effectiveCommand
    ? t('codingAgent.titleWithCommand', { command: currentPreset?.label || effectiveCommand })
    : t('codingAgent.title')

  // ── Load history on mount ──
  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    window.electronAPI.codingAgentConfig.load()
      .then((state) => {
        if (!active) return
        setHistory(state.history)
        setLastUsedId(state.lastUsedId)
        if (state.history.length > 0) {
          setMode('select')
          const initial = state.history.find(item => item.id === state.lastUsedId) ?? state.history[0]
          setSelectedId(initial?.id ?? null)
        } else {
          setMode('edit')
          setEditingEntryId(null)
        }
      })
      .catch((err) => {
        if (!active) return
        console.error('Failed to load coding agent config:', err)
        setError(t('codingAgent.errorLoadConfig'))
        setMode('edit')
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [t])

  useEffect(() => { modalRef.current?.focus() }, [])

  // ── Install status check ──
  useEffect(() => {
    if (!effectiveCommand) { setInstallStatus('loading'); return }
    // When absolute path mode is active but path is empty, wait for user input
    if (mode === 'edit' && useAbsolutePath && !effectiveExecPath) {
      setInstallStatus('loading')
      setInstallError('')
      return
    }
    let active = true
    setInstallStatus('loading')
    setInstallError('')
    window.electronAPI.codingAgent.prepare(effectiveCommand, effectiveExecPath || undefined)
      .then((r) => { if (active) { setInstallStatus(r.success ? 'ready' : 'error'); setInstallError(r.success ? '' : (r.error || '')) } })
      .catch(() => { if (active) { setInstallStatus('error'); setInstallError(t('codingAgent.statusError', { command: effectiveCommand })) } })
    return () => { active = false }
  }, [effectiveCommand, effectiveExecPath, mode, useAbsolutePath, t])

  // ── Fill form from an entry ──
  const fillFormFromEntry = useCallback((entry: CodingAgentHistoryEntry) => {
    const preset = PRESET_COMMANDS.find(p => p.value === entry.command)
    if (preset) { setSelectValue(preset.value); setCustomCommand('') }
    else { setSelectValue(CUSTOM_SENTINEL); setCustomCommand(entry.command) }
    setUseAbsolutePath(Boolean(entry.executablePath))
    setExecutablePathInput(entry.executablePath || '')
    setAlias(entry.alias || '')
    setExtraArgs(entry.extraArgs || '')
    setEnvVars((entry.envVars || []).map(e => ({ ...e })))
    setEnvVarsExpanded((entry.envVars?.length ?? 0) > 0)
  }, [])

  // ── Click history item → select (only in select mode) ──
  const handleSelectEntry = useCallback((id: string) => {
    if (mode === 'edit') return // do not exit edit mode on item click
    setSelectedId(id)
  }, [mode])

  // ── Edit → fill form, mark as editing existing entry ──
  const handleEditEntry = useCallback((entry: CodingAgentHistoryEntry) => {
    fillFormFromEntry(entry)
    setEditingEntryId(entry.id)
    setMode('edit')
  }, [fillFormFromEntry])

  // ── Duplicate → fill form as new (editingEntryId = null) ──
  const handleDuplicateEntry = useCallback((entry: CodingAgentHistoryEntry) => {
    fillFormFromEntry(entry)
    setAlias((entry.alias || entry.command) + t('codingAgent.duplicateSuffix'))
    setEditingEntryId(null)
    setSelectedId(null)
    setMode('edit')
  }, [fillFormFromEntry, t])

  // ── + New ──
  const handleNewConfig = useCallback(() => {
    setSelectValue(PRESET_COMMANDS[0].value)
    setCustomCommand('')
    setUseAbsolutePath(false)
    setExecutablePathInput('')
    setAlias('')
    setExtraArgs('')
    setEnvVars([])
    setEnvVarsExpanded(false)
    setEditingEntryId(null)
    setSelectedId(null)
    setMode('edit')
  }, [])

  // ── Form Save (save without launching) ──
  const handleFormSave = useCallback(async () => {
    if (!editCommand) return
    setError('')
    const payload: CodingAgentConfigInput = {
      command: editCommand,
      executablePath: useAbsolutePath ? executablePathInput.trim() : '',
      extraArgs: extraArgs.trim(),
      envVars: envVars.filter(e => e.key.trim()),
      alias: alias.trim()
    }
    try {
      let state
      if (editingEntryId) {
        state = await window.electronAPI.codingAgentConfig.update(editingEntryId, payload)
      } else {
        state = await window.electronAPI.codingAgentConfig.save(payload)
      }
      // Product telemetry: an agent config was saved/created.
      trackFeatureUse('agent-config-save')
      setHistory(state.history)
      setLastUsedId(state.lastUsedId)
      // Switch to select mode, select the saved entry
      const savedId = editingEntryId || state.lastUsedId
      setSelectedId(savedId)
      setMode('select')
      setEditingEntryId(null)
    } catch (err) {
      console.error('Failed to save coding agent config:', err)
      setError(t('codingAgent.errorSaveConfig'))
    }
  }, [editCommand, useAbsolutePath, executablePathInput, extraArgs, envVars, alias, editingEntryId, t])

  // ── Form Cancel (discard edits, return to select mode if possible) ──
  const handleFormCancel = useCallback(() => {
    setEditingEntryId(null)
    if (history.length > 0) {
      setSelectedId(lastUsedId ?? history[0]?.id ?? null)
      setMode('select')
    } else {
      // No history to select from — close the entire modal
      onCancel()
    }
  }, [history, lastUsedId, onCancel])

  // ── Delete ──
  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    try {
      const state = await window.electronAPI.codingAgentConfig.delete(id)
      setHistory(state.history)
      setLastUsedId(state.lastUsedId)
      if (selectedId === id) setSelectedId(state.history[0]?.id ?? null)
      if (editingEntryId === id) setEditingEntryId(null)
      if (state.history.length === 0) { setMode('edit'); setEditingEntryId(null) }
    } catch (err) {
      console.error('Failed to delete coding agent config:', err)
      setError(t('codingAgent.errorDeleteConfig'))
    }
  }

  // ── Env var handlers ──
  const handleAddEnvVar = useCallback(() => { setEnvVars(prev => [...prev, { key: '', value: '' }]); setEnvVarsExpanded(true) }, [])
  const handleRemoveEnvVar = useCallback((index: number) => { setEnvVars(prev => prev.filter((_, i) => i !== index)) }, [])
  const handleEnvVarChange = useCallback((index: number, field: 'key' | 'value', val: string) => {
    setEnvVars(prev => prev.map((entry, i) => i === index ? { ...entry, [field]: val } : entry))
  }, [])
  const handleToggleMask = useCallback((index: number) => {
    setEnvVars(prev => prev.map((entry, i) => i === index ? { ...entry, masked: !entry.masked } : entry))
  }, [])

  // ── Launch ──
  const canStart = mode === 'select'
    ? Boolean(selectedEntry) && installStatus === 'ready'
    : Boolean(editCommand) && installStatus === 'ready'

  const handleLaunch = async () => {
    if (!canStart) return
    setError('')

    let payload: CodingAgentConfigInput
    if (mode === 'select' && selectedEntry) {
      // Select mode: launch the selected entry directly, just touch lastUsedAt
      payload = {
        command: selectedEntry.command,
        executablePath: selectedEntry.executablePath,
        extraArgs: selectedEntry.extraArgs,
        envVars: selectedEntry.envVars,
        alias: selectedEntry.alias
      }
      try {
        const state = await window.electronAPI.codingAgentConfig.save(payload)
        setHistory(state.history)
        setLastUsedId(state.lastUsedId)
      } catch { /* non-critical */ }
    } else {
      // Edit mode
      payload = {
        command: editCommand,
        executablePath: useAbsolutePath ? executablePathInput.trim() : '',
        extraArgs: extraArgs.trim(),
        envVars: envVars.filter(e => e.key.trim()),
        alias: alias.trim()
      }
      try {
        let state
        if (editingEntryId) {
          // Edit existing → update in place
          state = await window.electronAPI.codingAgentConfig.update(editingEntryId, payload)
        } else {
          // New / Duplicate → create new entry
          state = await window.electronAPI.codingAgentConfig.save(payload)
        }
        setHistory(state.history)
        setLastUsedId(state.lastUsedId)
      } catch (err) {
        console.error('Failed to save coding agent config:', err)
        setError(t('codingAgent.errorSaveConfig'))
      }
    }

    onLaunch(payload)
  }

  // ESC cancels regardless of where focus sits (unified modal dismiss);
  // the previous React onKeyDown Escape branch went dead once focus left
  // the modal subtree (e.g. after a click on the inert backdrop).
  useModalEscape(true, onCancel, 'coding-agent')

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && canStart) {
      // Do not trigger launch when user is typing in an input field
      const tag = (event.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      handleLaunch()
    }
  }

  const installStatusText = installStatus === 'ready'
    ? t('codingAgent.statusReady', { command: effectiveCommand })
    : installStatus === 'error'
      ? (installError || t('codingAgent.statusError', { command: effectiveCommand }))
      : t('codingAgent.statusLoading', { command: effectiveCommand || '...' })

  return (
    <div className="claude-code-modal-overlay">
      <div className="claude-code-modal" ref={modalRef} tabIndex={-1}
        onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="claude-code-modal-header">
          <h3 className="claude-code-modal-title">
            <span className={`claude-code-status-dot is-${installStatus}`}
              aria-label={installStatusText} title={installStatusText} />
            {displayTitle}
          </h3>
          <button className="claude-code-modal-close" onClick={onCancel} aria-label={t('codingAgent.close')}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1L13 13M1 13L13 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        <div className="claude-code-modal-body">
          {/* ── Edit form ── */}
          {mode === 'edit' && (
            <div className="claude-code-form">
              <div className="claude-code-field">
                <label className="claude-code-label" htmlFor="ca-command">{t('codingAgent.commandLabel')}</label>
                <div className="onward-select-shell onward-select-shell--block">
                  <select id="ca-command" className="claude-code-select onward-select onward-select--regular"
                    value={selectValue} onChange={(e) => { setSelectValue(e.target.value); if (e.target.value !== CUSTOM_SENTINEL) setCustomCommand('') }}>
                    {PRESET_COMMANDS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                    <option value={CUSTOM_SENTINEL}>{t('codingAgent.commandCustom')}</option>
                  </select>
                </div>
              </div>

              {isCustom && (
                <div className="claude-code-field">
                  <input className="claude-code-input" value={customCommand}
                    onChange={(e) => setCustomCommand(e.target.value)}
                    placeholder={t('codingAgent.commandCustomPlaceholder')} autoFocus />
                  <div className="claude-code-hint">{t('codingAgent.commandCustomHint')}</div>
                </div>
              )}

              <div className="claude-code-field">
                <label className="claude-code-checkbox-label">
                  <input type="checkbox" checked={useAbsolutePath}
                    onChange={(e) => setUseAbsolutePath(e.target.checked)} />
                  {t('codingAgent.commandAbsolutePath')}
                </label>
                {useAbsolutePath && (
                  <>
                    <input className="claude-code-input" value={executablePathInput}
                      onChange={(e) => setExecutablePathInput(e.target.value)}
                      placeholder={t('codingAgent.commandPathPlaceholder')} />
                    <div className="claude-code-hint">{t('codingAgent.commandPathHint')}</div>
                  </>
                )}
              </div>

              <div className="claude-code-field">
                <label className="claude-code-label" htmlFor="ca-alias">{t('codingAgent.aliasLabel')}</label>
                <input id="ca-alias" className="claude-code-input" value={alias}
                  onChange={(e) => setAlias(e.target.value)} placeholder={t('codingAgent.aliasPlaceholder')} />
              </div>

              <div className="claude-code-field">
                <label className="claude-code-label" htmlFor="ca-extra-args">{t('codingAgent.extraArgs')}</label>
                <input id="ca-extra-args" className="claude-code-input" value={extraArgs}
                  onChange={(e) => setExtraArgs(e.target.value)} placeholder={t('codingAgent.extraArgsPlaceholder')} />
                <div className="claude-code-hint">{t('codingAgent.extraArgsHint')}</div>
              </div>

              <div className="claude-code-envvars">
                <div className="claude-code-envvars-header">
                  <button type="button" className="claude-code-envvars-toggle"
                    onClick={() => setEnvVarsExpanded(p => !p)} aria-expanded={envVarsExpanded}>
                    <svg className={`claude-code-envvars-chevron ${envVarsExpanded ? 'is-expanded' : ''}`}
                         width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M4 2L8 6L4 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    {t('codingAgent.envVars')}
                    {envVars.length > 0 && <span className="claude-code-envvars-count">{envVars.length}</span>}
                  </button>
                  <button type="button" className="claude-code-envvars-add" onClick={handleAddEnvVar}>+ {t('codingAgent.envVarsAdd')}</button>
                </div>
                {envVarsExpanded && (
                  <div className="claude-code-envvars-list">
                    {envVars.map((entry, index) => (
                      <div key={index} className="claude-code-envvar-row">
                        <input className="claude-code-input claude-code-envvar-key" value={entry.key}
                          onChange={(e) => handleEnvVarChange(index, 'key', e.target.value)}
                          placeholder={t('codingAgent.envVarKeyPlaceholder')} />
                        <span className="claude-code-envvar-eq">=</span>
                        <input className="claude-code-input claude-code-envvar-value" value={entry.value}
                          type={entry.masked ? 'password' : 'text'}
                          onChange={(e) => handleEnvVarChange(index, 'value', e.target.value)}
                          placeholder={t('codingAgent.envVarValuePlaceholder')} />
                        <button type="button" className="claude-code-envvar-mask"
                          onClick={() => handleToggleMask(index)} aria-label={t('codingAgent.envVarToggleMask')}>
                          {entry.masked ? (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                              <path d="M4 4L20 20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                              <path d="M10.4 10.9a2.5 2.5 0 0 0 2.6 2.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                              <path d="M6.5 6.8C4.6 8.3 3.3 10 2.5 12c1.6 3.8 5.1 6.5 9.5 6.5 1.9 0 3.6-.4 5-1.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                              <path d="M9.9 5.1c.7-.1 1.4-.1 2.1-.1 4.4 0 7.9 2.7 9.5 6.5-.7 1.7-1.8 3.2-3.2 4.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                          ) : (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                              <path d="M2.5 12c1.6-3.8 5.1-6.5 9.5-6.5s7.9 2.7 9.5 6.5c-1.6 3.8-5.1 6.5-9.5 6.5S4.1 15.8 2.5 12Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                              <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.8"/>
                            </svg>
                          )}
                        </button>
                        <button type="button" className="claude-code-envvar-remove"
                          onClick={() => handleRemoveEnvVar(index)} aria-label={t('codingAgent.envVarRemove')}>
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                            <path d="M1 1L13 13M1 13L13 1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                          </svg>
                        </button>
                      </div>
                    ))}
                    <div className="claude-code-hint">{t('codingAgent.envVarsHint')}</div>
                  </div>
                )}
              </div>

              {/* Save / Cancel buttons inside the form */}
              <div className="claude-code-form-actions">
                <button type="button" className="claude-code-modal-btn claude-code-modal-btn-ghost"
                  onClick={handleFormCancel}>
                  {t('codingAgent.formCancel')}
                </button>
                <button type="button" className="claude-code-modal-btn claude-code-modal-btn-primary"
                  onClick={handleFormSave} disabled={!editCommand}>
                  {t('codingAgent.formSave')}
                </button>
              </div>
            </div>
          )}

          {/* ── History ── */}
          <div className={`claude-code-history ${mode === 'select' ? 'is-primary' : ''}`}>
            <div className="claude-code-history-header">
              <span>{t('codingAgent.history')}</span>
              <div className="claude-code-history-header-actions">
                {loading && <span className="claude-code-history-loading">{t('codingAgent.historyLoading')}</span>}
                <button type="button" className="claude-code-history-new-btn" onClick={handleNewConfig}>+ {t('codingAgent.historyNew')}</button>
              </div>
            </div>
            {history.length === 0 && !loading ? (
              <div className="claude-code-history-empty">{t('codingAgent.historyEmpty')}</div>
            ) : (
              history.map(item => {
                const isSelected = mode === 'select' && item.id === selectedId
                const isEditing = mode === 'edit' && item.id === editingEntryId
                const displayName = item.alias || item.command
                return (
                  <div key={item.id}
                    className={`claude-code-history-item ${isSelected ? 'is-selected' : ''} ${isEditing ? 'is-editing' : ''}`}
                    onClick={() => handleSelectEntry(item.id)}>
                    <div className="claude-code-history-main">
                      <div className="claude-code-history-title">
                        <span className="claude-code-history-command">{displayName}</span>
                        {item.alias && <span className="claude-code-history-meta-item">{item.command}</span>}
                        <span className="claude-code-history-time">{formatRelativeTime(item.lastUsedAt, t)}</span>
                        {item.id === lastUsedId && <span className="claude-code-history-badge">{t('codingAgent.historyLastUsed')}</span>}
                      </div>
                      <div className="claude-code-history-meta">
                        {item.executablePath && <span className="claude-code-history-meta-item">{item.executablePath}</span>}
                        {item.extraArgs && <span className="claude-code-history-meta-item">{t('codingAgent.historyArgs', { args: item.extraArgs })}</span>}
                      </div>
                      {item.envVars.length > 0 && (
                        <div className="claude-code-history-envvars">
                          {item.envVars.map((v, i) => (
                            <span key={i} className="claude-code-history-envvar-tag">
                              <span className="claude-code-history-envvar-key">{v.key}</span>
                              <span className="claude-code-history-envvar-sep">=</span>
                              <span className="claude-code-history-envvar-val">{v.masked ? MASKED_PLACEHOLDER : v.value}</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="claude-code-history-actions">
                      <button className="claude-code-history-btn" onClick={(e) => { e.stopPropagation(); handleEditEntry(item) }}>
                        {t('codingAgent.historyEdit')}
                      </button>
                      <button className="claude-code-history-btn" onClick={(e) => { e.stopPropagation(); handleDuplicateEntry(item) }}>
                        {t('codingAgent.historyDuplicate')}
                      </button>
                      <button className="claude-code-history-btn claude-code-history-btn-danger" onClick={(e) => handleDelete(e, item.id)}>
                        {t('codingAgent.historyDelete')}
                      </button>
                    </div>
                  </div>
                )
              })
            )}
          </div>

          {installStatus === 'error' && <div className="claude-code-error" role="status">{installError}</div>}
          {error && <div className="claude-code-error" role="status">{error}</div>}
        </div>

        <div className="claude-code-modal-footer">
          <button className="claude-code-modal-btn claude-code-modal-btn-ghost" onClick={onCancel}>{t('codingAgent.cancel')}</button>
          <button className="claude-code-modal-btn claude-code-modal-btn-primary"
            onClick={handleLaunch} disabled={!canStart}>{t('codingAgent.start')}</button>
        </div>
      </div>
    </div>
  )
}
