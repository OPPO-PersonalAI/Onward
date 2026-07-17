// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  evaluatePromptImeLatencyTrials,
  nearestRankPercentile
} from '../autotest/prompt-ime-latency-metrics.mjs'

const VERDICT_OPTIONS = {
  budgetMs: 40,
  expectedTrials: 3,
  expectedSamplesPerTrial: 60
}
const trial = (p95, n = 60) => ({ p95, n })

test('PIL-M01 nearest-rank p95 selects the 57th of 60 ordered samples', () => {
  const samples = Array.from({ length: 60 }, (_, index) => index + 1)

  assert.equal(nearestRankPercentile(samples, 0.95), 57)
})

test('PIL-M02 one of three trials meeting the signed budget passes', () => {
  const verdict = evaluatePromptImeLatencyTrials(
    [trial(40.1), trial(39.9), trial(45)],
    VERDICT_OPTIONS
  )

  assert.equal(verdict.trialsMeetingBudget, 1)
  assert.equal(verdict.pass, true)
})

test('PIL-M03 three trials over budget fail', () => {
  const verdict = evaluatePromptImeLatencyTrials(
    [trial(40.1), trial(40.2), trial(40.3)],
    VERDICT_OPTIONS
  )

  assert.equal(verdict.trialsMeetingBudget, 0)
  assert.equal(verdict.pass, false)
})

test('PIL-M04 the exact 40 ms boundary passes', () => {
  const verdict = evaluatePromptImeLatencyTrials(
    [trial(40), trial(40.1), trial(45)],
    VERDICT_OPTIONS
  )

  assert.equal(verdict.bestP95Ms, 40)
  assert.equal(verdict.pass, true)
})

test('PIL-M05 incomplete trials or sample sets cannot pass', () => {
  const incompleteSamples = evaluatePromptImeLatencyTrials(
    [trial(20), trial(21, 59), trial(22)],
    VERDICT_OPTIONS
  )
  const incompleteTrials = evaluatePromptImeLatencyTrials(
    [trial(20), trial(21)],
    VERDICT_OPTIONS
  )
  const invalidP95 = evaluatePromptImeLatencyTrials(
    [trial(20), trial(null), trial(22)],
    VERDICT_OPTIONS
  )

  assert.equal(incompleteSamples.sampleCountsValid, false)
  assert.equal(incompleteSamples.pass, false)
  assert.equal(incompleteTrials.trialCountValid, false)
  assert.equal(incompleteTrials.pass, false)
  assert.equal(invalidP95.p95ValuesValid, false)
  assert.equal(invalidP95.pass, false)
})
