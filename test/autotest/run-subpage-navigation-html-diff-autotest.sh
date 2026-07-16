#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

# HTML subpage-navigation round-trips for the GIT-DIFF entry point only. The full
# html group (diff + history, COLD + WARM) runs ~242s and overruns the 180s
# regression budget, so it is split by source; this half runs one COLD + one WARM
# block (~120s). See run-subpage-navigation-html-history-autotest.sh for the other.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ONWARD_SUBPAGE_NAVIGATION_GROUP=html \
ONWARD_SUBPAGE_NAVIGATION_SOURCE=diff \
  exec bash "$SCRIPT_DIR/run-subpage-navigation-autotest.sh" "$@"
