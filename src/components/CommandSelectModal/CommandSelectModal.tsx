/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from 'react'
import { CommandPreset } from '../../types/electron'
import { useI18n } from '../../i18n/useI18n'
import { useModalEscape } from '../../hooks/useModalEscape'
import './CommandSelectModal.css'

interface CommandSelectModalProps {
  targetDirectory: string
  onConfirm: (command: string) => void
  onCancel: () => void
}

export function CommandSelectModal({
  targetDirectory,
  onConfirm,
  onCancel
}: CommandSelectModalProps) {
  const { t } = useI18n()
  const [commands, setCommands] = useState<CommandPreset[]>([])
  const [selectedCommand, setSelectedCommand] = useState<string>('')
  const [isAddingCustom, setIsAddingCustom] = useState(false)
  const [customCommand, setCustomCommand] = useState('')
  const customInputRef = useRef<HTMLInputElement>(null)

  // Load command list
  useEffect(() => {
    loadCommands()
  }, [])

  // Focus on custom command input box
  useEffect(() => {
    if (isAddingCustom && customInputRef.current) {
      customInputRef.current.focus()
    }
  }, [isAddingCustom])

  const loadCommands = async () => {
    try {
      const presets = await window.electronAPI.commandPreset.load()
      setCommands(presets)
      // The first command is selected by default
      if (presets.length > 0 && !selectedCommand) {
        setSelectedCommand(presets[0].command)
      }
    } catch (error) {
      console.error('Failed to load commands:', error)
    }
  }

  const handleAddCustomCommand = async () => {
    if (!customCommand.trim()) return

    const newPreset: CommandPreset = {
      id: `custom-${Date.now()}`,
      command: customCommand.trim(),
      isBuiltin: false,
      createdAt: Date.now()
    }

    try {
      const success = await window.electronAPI.commandPreset.save(newPreset)
      if (success) {
        setCustomCommand('')
        setIsAddingCustom(false)
        await loadCommands()
        setSelectedCommand(newPreset.command)
      }
    } catch (error) {
      console.error('Failed to save custom command:', error)
    }
  }

  const handleDeleteCommand = async (id: string) => {
    try {
      const success = await window.electronAPI.commandPreset.delete(id)
      if (success) {
        await loadCommands()
        // If deleting the currently selected command, reset the selection
        const deletedCmd = commands.find(c => c.id === id)
        if (deletedCmd && deletedCmd.command === selectedCommand) {
          setSelectedCommand('')
        }
      }
    } catch (error) {
      console.error('Failed to delete command:', error)
    }
  }

  const handleConfirm = () => {
    if (selectedCommand) {
      onConfirm(selectedCommand)
    }
  }

  // ESC cancels regardless of where focus sits (unified modal dismiss).
  useModalEscape(true, onCancel, 'command-select')

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isAddingCustom) {
      handleConfirm()
    }
  }

  const handleCustomInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleAddCustomCommand()
    } else if (e.key === 'Escape') {
      // ESC inside the custom-command field only exits add-custom mode.
      e.stopPropagation()
      setIsAddingCustom(false)
      setCustomCommand('')
    }
  }

  // Grouping: built-in commands and custom commands
  const builtinCommands = commands.filter(c => c.isBuiltin)
  const customCommands = commands.filter(c => !c.isBuiltin)

  return (
    <div className="command-modal-overlay">
      <div
        className="command-modal"
        onClick={e => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="command-modal-header">
          <h3 className="command-modal-title">{t('commandModal.title')}</h3>
          <button className="command-modal-close" onClick={onCancel}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1L13 13M1 13L13 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        <div className="command-modal-body">
          <div className="command-modal-directory">
            <span className="command-modal-label">{t('commandModal.targetDirectory')}</span>
            <span className="command-modal-path">{targetDirectory}</span>
          </div>

          <div className="command-modal-section">
            <div className="command-modal-section-header">
              <span className="command-modal-label">{t('commandModal.builtinCommands')}</span>
            </div>
            <div className="command-list">
              {builtinCommands.map(cmd => (
                <label key={cmd.id} className="command-item">
                  <input
                    type="radio"
                    name="command"
                    checked={selectedCommand === cmd.command}
                    onChange={() => setSelectedCommand(cmd.command)}
                  />
                  <span className="command-text">{cmd.command}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="command-modal-section">
            <div className="command-modal-section-header">
              <span className="command-modal-label">{t('commandModal.customCommands')}</span>
              <button
                className="command-add-btn"
                onClick={() => setIsAddingCustom(true)}
                title={t('commandModal.addCustom')}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M6 1V11M1 6H11" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              </button>
            </div>

            {isAddingCustom && (
              <div className="command-add-form">
                <input
                  ref={customInputRef}
                  type="text"
                  className="command-add-input"
                  value={customCommand}
                  onChange={e => setCustomCommand(e.target.value)}
                  onKeyDown={handleCustomInputKeyDown}
                  placeholder={t('commandModal.customPlaceholder')}
                />
                <button
                  className="command-add-confirm"
                  onClick={handleAddCustomCommand}
                  disabled={!customCommand.trim()}
                >
                  {t('common.add')}
                </button>
                <button
                  className="command-add-cancel"
                  onClick={() => {
                    setIsAddingCustom(false)
                    setCustomCommand('')
                  }}
                >
                  {t('common.cancel')}
                </button>
              </div>
            )}

            <div className="command-list">
              {customCommands.length === 0 && !isAddingCustom ? (
                <div className="command-list-empty">{t('commandModal.emptyCustom')}</div>
              ) : (
                customCommands.map(cmd => (
                  <label key={cmd.id} className="command-item">
                    <input
                      type="radio"
                      name="command"
                      checked={selectedCommand === cmd.command}
                      onChange={() => setSelectedCommand(cmd.command)}
                    />
                    <span className="command-text">{cmd.command}</span>
                    <button
                      className="command-delete-btn"
                      onClick={(e) => {
                        e.preventDefault()
                        handleDeleteCommand(cmd.id)
                      }}
                      title={t('common.delete')}
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M2 2L10 10M2 10L10 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                      </svg>
                    </button>
                  </label>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="command-modal-footer">
          <button
            className="command-modal-btn command-modal-btn-cancel"
            onClick={onCancel}
          >
            {t('common.cancel')}
          </button>
          <button
            className="command-modal-btn command-modal-btn-confirm"
            onClick={handleConfirm}
            disabled={!selectedCommand}
          >
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
