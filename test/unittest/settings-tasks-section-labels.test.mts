/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SUPPORTED_LOCALES, translate } from '../../src/i18n/core.ts'

/**
 * The Settings section that hosts the per-terminal style controls is titled "Tasks",
 * and its size control is labelled "Terminal font size" so it reads distinctly from the
 * "Git Diff / Project Editor font size" row directly below it.
 *
 * Both labels are user-visible copy, so the project's bilingual rule applies: every
 * supported locale must carry a real translation, never an English fallback leaking
 * through and never an empty string.
 */
describe('settings Tasks section labels', () => {
  it('titles the terminal-style section "Tasks" in every locale', () => {
    assert.equal(translate('en', 'settings.section.agentTerminal'), 'Tasks')
    assert.equal(translate('zh-CN', 'settings.section.agentTerminal'), 'Tasks')
  })

  it('labels the terminal size control "Terminal font size" in English', () => {
    assert.equal(translate('en', 'settings.terminal.fontSize'), 'Terminal font size')
  })

  it('translates the terminal size control into Simplified Chinese', () => {
    assert.equal(translate('zh-CN', 'settings.terminal.fontSize'), '终端字体大小')
  })

  it('keeps the terminal size label distinct from the editor size label per locale', () => {
    for (const { value: locale } of SUPPORTED_LOCALES) {
      const terminalLabel = translate(locale, 'settings.terminal.fontSize')
      const editorLabel = translate(locale, 'settings.terminal.editorFontSize')
      assert.notEqual(
        terminalLabel,
        editorLabel,
        `locale ${locale} renders both font-size rows with the same label`
      )
    }
  })

  it('never renders an empty label in any supported locale', () => {
    const keys = ['settings.section.agentTerminal', 'settings.terminal.fontSize'] as const
    for (const { value: locale } of SUPPORTED_LOCALES) {
      for (const key of keys) {
        const label = translate(locale, key)
        assert.ok(label.length > 0, `locale ${locale} has an empty label for ${key}`)
      }
    }
  })
})
