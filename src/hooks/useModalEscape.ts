/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from 'react'
import { isModalCancelKey, registerOpenModal, unregisterOpenModal } from '../utils/modal-dismiss'
import { perfTrace } from '../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../utils/perf-trace-names'

/**
 * Shared ESC-cancels-modal behavior (unified modal dismiss policy).
 *
 * Listens on window in the bubble phase while `active` is true and calls
 * `onCancel` on a non-IME Escape. While active the modal is also entered
 * into the open-modal registry so subpage hosts' capture-phase Escape
 * (useSubpageEscape) yields instead of closing the subpage underneath.
 * Modals rendered inside a subpage must instead branch in that subpage's
 * escape chain.
 *
 * `dialogName` tags the RENDERER_MODAL_ESC_CANCELLED trace instant so a
 * user-reported trace shows which dialog consumed the Escape.
 */
export function useModalEscape(active: boolean, onCancel: () => void, dialogName: string) {
  useEffect(() => {
    if (!active) return
    registerOpenModal()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isModalCancelKey(event)) return
      event.preventDefault()
      event.stopPropagation()
      perfTrace(PERF_TRACE_EVENT.RENDERER_MODAL_ESC_CANCELLED, { dialog: dialogName })
      onCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      unregisterOpenModal()
    }
  }, [active, onCancel, dialogName])
}

/**
 * Registration-only variant for modals that keep their own keyboard
 * handling (extra keys like y/n/Enter) but still must suppress the
 * subpage hosts' capture-phase Escape while open.
 */
export function useModalOpenRegistration(active: boolean) {
  useEffect(() => {
    if (!active) return
    registerOpenModal()
    return () => unregisterOpenModal()
  }, [active])
}
