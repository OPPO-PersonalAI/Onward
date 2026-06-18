/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Proves the sibling file:// script loaded under the any-file policy.
window.__obScriptRan = true
document.documentElement.dataset.obScript = 'ran'
