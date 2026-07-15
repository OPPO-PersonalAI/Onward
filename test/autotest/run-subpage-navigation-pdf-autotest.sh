#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ONWARD_SUBPAGE_NAVIGATION_GROUP=pdf \
  exec bash "$SCRIPT_DIR/run-subpage-navigation-autotest.sh" "$@"
