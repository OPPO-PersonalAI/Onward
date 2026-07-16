# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

# HTML subpage-navigation round-trips for the GIT-HISTORY entry point only (split
# from the full html group to fit the 180s regression budget).

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HadPreviousGroup = Test-Path Env:\ONWARD_SUBPAGE_NAVIGATION_GROUP
$PreviousGroup = if ($HadPreviousGroup) { $env:ONWARD_SUBPAGE_NAVIGATION_GROUP } else { $null }
$HadPreviousSource = Test-Path Env:\ONWARD_SUBPAGE_NAVIGATION_SOURCE
$PreviousSource = if ($HadPreviousSource) { $env:ONWARD_SUBPAGE_NAVIGATION_SOURCE } else { $null }

try {
  $env:ONWARD_SUBPAGE_NAVIGATION_GROUP = "html"
  $env:ONWARD_SUBPAGE_NAVIGATION_SOURCE = "history"
  & (Join-Path $ScriptDir "run-subpage-navigation-autotest.ps1") @args
}
finally {
  if ($HadPreviousGroup) {
    $env:ONWARD_SUBPAGE_NAVIGATION_GROUP = $PreviousGroup
  } else {
    Remove-Item Env:\ONWARD_SUBPAGE_NAVIGATION_GROUP -ErrorAction SilentlyContinue
  }
  if ($HadPreviousSource) {
    $env:ONWARD_SUBPAGE_NAVIGATION_SOURCE = $PreviousSource
  } else {
    Remove-Item Env:\ONWARD_SUBPAGE_NAVIGATION_SOURCE -ErrorAction SilentlyContinue
  }
}
