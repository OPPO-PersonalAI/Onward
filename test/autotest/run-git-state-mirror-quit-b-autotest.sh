#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Split runner B of the GitStateMirror graceful-quit suite (GSMQ-01..04): runs 2
# of the 5 stochastic sustained-churn-through-quit trials. Paired with the -a
# runner (3 trials) so the 5-trial budget is split into two sub-5-minute runners
# (the whole 5-trial suite overran 180s under full-regression load — class-2).
# All logic lives in the shared, parameterised run-git-state-mirror-quit-autotest.sh;
# this wrapper only sets the trial count + a distinct suite label for log/result files.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
GSM_QUIT_TRIALS=2 QUIT_SUITE=git-state-mirror-quit-b \
  exec "$DIR/run-git-state-mirror-quit-autotest.sh" "$@"
