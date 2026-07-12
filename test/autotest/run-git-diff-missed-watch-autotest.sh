#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Split runner: the EXPLICIT-ONLY 'missed-watch' group of the Git Diff
# staleness+submodule suite — GDS-50 (reopen after a mirror-missed NEW-file
# creation must list the new file) + GDS-51 (reopen after a mirror-missed edit
# must show the fresh body, not the previous open's renderer memory).
#
# Authored as a REPRODUCTION attempt for the 2026-07-12 diagnostic bundle
# ("Git Diff shows stale list/content until manual refresh") — and the cases
# PASSED: with the mirror fully silenced, a subpage close drops the viewer's
# mirror subscription, the reopen re-attaches, and the ATTACH recompute runs a
# real `git status` that restores freshness. That pass is itself the finding:
# the reopen path recovers via the attach lifecycle, so the bundle's root cause
# is NOT a missed-event class — it is the content-cache staleToken TOCTOU
# pinned by test/unittest/git-diff-content-cache-wiring.test.mts "REPRO TOCTOU".
# The cases stay registered as GREEN regression locks for that recovery
# contract (a refactor that drops the attach recompute would regress exactly
# the staleness the bundle reported).
#
# The group models "the mirror authority missed the change entirely": both
# automatic freshness sources are silenced below (watcher events dropped +
# reconcile heartbeat skipped), leaving explicit revalidate/focus-resync/attach
# recomputes functional. Under a LIVE mirror the watcher push would satisfy the
# assertions for the wrong reason, which is why this group never rides the
# whole-suite default (GDS_GROUP='') and owns a dedicated runner.
# Shared body in run-git-diff-staleness-and-submodule-autotest.sh.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
export ONWARD_AUTOTEST_GSM_WATCHER_SILENT=1
export ONWARD_AUTOTEST_GSM_RECONCILE_SILENT=1
GDS_SUITE=git-diff-missed-watch GDS_GROUP=missed-watch \
  exec "$DIR/run-git-diff-staleness-and-submodule-autotest.sh" "$@"
