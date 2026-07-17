// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0

export function nearestRankPercentile(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) return null
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1) {
    throw new RangeError('percentile must be greater than 0 and at most 1')
  }
  if (values.some((value) => !Number.isFinite(value))) return null

  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.ceil(sorted.length * percentile) - 1
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))]
}

export function evaluatePromptImeLatencyTrials(
  trials,
  { budgetMs, expectedTrials, expectedSamplesPerTrial }
) {
  const trialCountValid = trials.length === expectedTrials
  const sampleCountsValid = trialCountValid
    && trials.every((trial) => trial.n === expectedSamplesPerTrial)
  const p95ValuesValid = trialCountValid
    && trials.every((trial) => Number.isFinite(trial.p95))
  const trialsMeetingBudget = trials.filter(
    (trial) => Number.isFinite(trial.p95) && trial.p95 <= budgetMs
  ).length
  const bestP95Ms = p95ValuesValid
    ? Math.min(...trials.map((trial) => trial.p95))
    : null

  return {
    bestP95Ms,
    trialsMeetingBudget,
    trialCountValid,
    sampleCountsValid,
    p95ValuesValid,
    pass: trialCountValid
      && sampleCountsValid
      && p95ValuesValid
      && trialsMeetingBudget >= 1
  }
}
