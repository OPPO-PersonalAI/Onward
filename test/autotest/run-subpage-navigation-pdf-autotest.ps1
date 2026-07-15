# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HadPreviousGroup = Test-Path Env:\ONWARD_SUBPAGE_NAVIGATION_GROUP
$PreviousGroup = if ($HadPreviousGroup) { $env:ONWARD_SUBPAGE_NAVIGATION_GROUP } else { $null }

try {
  $env:ONWARD_SUBPAGE_NAVIGATION_GROUP = "pdf"
  & (Join-Path $ScriptDir "run-subpage-navigation-autotest.ps1") @args
}
finally {
  if ($HadPreviousGroup) {
    $env:ONWARD_SUBPAGE_NAVIGATION_GROUP = $PreviousGroup
  } else {
    Remove-Item Env:\ONWARD_SUBPAGE_NAVIGATION_GROUP -ErrorAction SilentlyContinue
  }
}
