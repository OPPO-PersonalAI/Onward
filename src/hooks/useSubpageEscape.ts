/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from 'react'
import { isAnyModalOpen } from '../utils/modal-dismiss'

interface UseSubpageEscapeOptions {
  isOpen: boolean
  onEscape: () => void | Promise<void>
}

export function useSubpageEscape({ isOpen, onEscape }: UseSubpageEscapeOptions) {
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isOpen) return
      if (event.key !== 'Escape') return
      // If the focus is in the Prompt editor being edited, let PromptNotebook handle it.
      const active = document.activeElement
      if (active?.closest('[data-prompt-editing="true"]')) return
      // An app-level modal is open (open-modal registry): ESC belongs to
      // the modal, not the subpage. This capture-phase listener would
      // otherwise both close the subpage AND stop propagation before the
      // modal's bubble-phase useModalEscape listener could run.
      if (isAnyModalOpen()) return
      event.preventDefault()
      event.stopPropagation()
      void onEscape()
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [isOpen, onEscape])
}
