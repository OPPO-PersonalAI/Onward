#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Split runner: the watcher-failure-injection passes of the GitStateMirror latency
# suite — subscribe-failure (GSM-15), callback-failure (GSM-16), silent-watcher
# (GSM-19). Each is a separate short app launch; together they are well under the
# 300s budget. Split out of the whole suite (which overran 1500s — class-2).
# Shared body in run-git-state-mirror-latency-autotest.sh (runnable whole).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
LATENCY_SUITE=git-state-mirror-latency-injection LATENCY_MODE=injection \
  exec "$DIR/run-git-state-mirror-latency-autotest.sh" "$@"
