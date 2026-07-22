# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

# Test suite: PowerShell TTY — default shell detection, Ctrl+C copy logic, context menu rendering
$ErrorActionPreference = "Stop"
$passed = 0
$failed = 0

function Pass($name) {
  $script:passed++
  Write-Host "  PASS  $name" -ForegroundColor Green
}
function Fail($name, $detail) {
  $script:failed++
  Write-Host "  FAIL  $name -- $detail" -ForegroundColor Red
}

$RootDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))

Write-Host "`n=== PowerShell TTY Autotest ===" -ForegroundColor Cyan

# ────────────────────────────────────────
# TC-1  Shell resolution: PowerShell available on this Windows machine
# ────────────────────────────────────────
Write-Host "`n[TC-1] Shell resolution: PowerShell exists on this system"
$pwshFound = $false
foreach ($candidate in @("pwsh.exe", "powershell.exe")) {
  $where = Get-Command $candidate -ErrorAction SilentlyContinue
  if ($where) {
    Pass "TC-1a: '$candidate' found at $($where.Source)"
    $pwshFound = $true
    break
  }
}
if (-not $pwshFound) {
  Fail "TC-1a" "Neither pwsh.exe nor powershell.exe found on PATH"
}

# ────────────────────────────────────────
# TC-2  pty-manager.ts contains resolveWindowsShell with correct priority
# ────────────────────────────────────────
Write-Host "`n[TC-2] pty-manager.ts: resolveWindowsShell priority order"
$ptyFile = Get-Content (Join-Path $RootDir "electron\main\pty-manager.ts") -Raw

if ($ptyFile -match "resolveWindowsShell") {
  Pass "TC-2a: resolveWindowsShell method exists"
} else {
  Fail "TC-2a" "resolveWindowsShell method not found"
}

$pwshIdx = $ptyFile.IndexOf("pwsh.exe")
$psIdx   = $ptyFile.IndexOf("powershell.exe")
if ($pwshIdx -ge 0 -and $psIdx -ge 0 -and $pwshIdx -lt $psIdx) {
  Pass "TC-2b: pwsh.exe checked before powershell.exe"
} else {
  Fail "TC-2b" "Priority order wrong or candidates missing"
}

if ($ptyFile -match "cmd\.exe") {
  Pass "TC-2c: cmd.exe fallback present"
} else {
  Fail "TC-2c" "cmd.exe fallback missing"
}

if ($ptyFile -match "cachedShell") {
  Pass "TC-2d: shell result is cached (cachedShell field)"
} else {
  Fail "TC-2d" "cachedShell not found"
}

# TC-2e: OSC 9;9 CWD tracking infrastructure
if ($ptyFile -match "OSC_CWD_RE") {
  Pass "TC-2e: OSC 9;9 regex (OSC_CWD_RE) defined"
} else {
  Fail "TC-2e" "OSC_CWD_RE not found"
}

if ($ptyFile -match "detectCwd") {
  Pass "TC-2f: detectCwd method exists"
} else {
  Fail "TC-2f" "detectCwd method not found"
}

if ($ptyFile -match "getCwd") {
  Pass "TC-2g: getCwd method exists"
} else {
  Fail "TC-2g" "getCwd method not found"
}

if ($ptyFile -match "cwdMap") {
  Pass "TC-2h: cwdMap storage exists"
} else {
  Fail "TC-2h" "cwdMap not found"
}

# TC-2i: PowerShell integration is injected INLINE via -Command (RC-1 fix,
# 2026-07 bundles: the pwsh.ps1 dot-source was blocked by script execution
# policy on locked-down machines; a -Command string payload is exempt).
# The previous form of this assertion grepped for "EncodedCommand", which
# only survived inside a historical comment — assertion rot.
if ($ptyFile -match "buildPowerShellInlineIntegrationCommand") {
  Pass "TC-2i: inline -Command payload used for PowerShell prompt injection"
} else {
  Fail "TC-2i" "inline integration builder not referenced -- PS injection may have regressed to a policy-blockable script file"
}

# TC-2j: USERPROFILE fallback for initial CWD on Windows
if ($ptyFile -match "USERPROFILE") {
  Pass "TC-2j: USERPROFILE fallback for initial CWD"
} else {
  Fail "TC-2j" "USERPROFILE fallback missing"
}

# TC-2k: cmd.exe PROMPT env var for OSC 9;9
if ($ptyFile -match "shellIntegrationEnv" -and $ptyFile -match '\$e\]9;9;') {
  Pass "TC-2k: cmd.exe PROMPT with OSC 9;9 CWD report"
} else {
  Fail "TC-2k" "cmd.exe PROMPT OSC 9;9 integration missing"
}

# ────────────────────────────────────────
# TC-3  terminal-session-manager.ts: Ctrl+C / Ctrl+V keyboard handling
# ────────────────────────────────────────
Write-Host "`n[TC-3] terminal-session-manager.ts: Ctrl+C / Ctrl+V keyboard handling"
$ssmFile = Get-Content (Join-Path $RootDir "src\terminal\terminal-session-manager.ts") -Raw

if ($ssmFile -match "attachCustomKeyEventHandler") {
  Pass "TC-3a: attachCustomKeyEventHandler registered"
} else {
  Fail "TC-3a" "attachCustomKeyEventHandler not found -- keyboard shortcuts won't work"
}

# TC-3b: uses event.code for robust key detection (not event.key)
if ($ssmFile -match "event\.code\s*===\s*'KeyC'") {
  Pass "TC-3b: uses event.code === 'KeyC' (keyboard-layout independent)"
} else {
  Fail "TC-3b" "event.code check not found -- may fail with non-US layouts"
}

# TC-3c: uses hasSelection() for reliable selection check
if ($ssmFile -match "terminal\.hasSelection\(\)") {
  Pass "TC-3c: uses terminal.hasSelection() for selection check"
} else {
  Fail "TC-3c" "terminal.hasSelection() not found"
}

# TC-3d: copies to clipboard when selection exists
if ($ssmFile -match "clipboard\.writeText\(terminal\.getSelection\(\)\)") {
  Pass "TC-3d: clipboard.writeText(terminal.getSelection()) in copy path"
} else {
  Fail "TC-3d" "clipboard write call not found in Ctrl+C path"
}

# TC-3e: clears selection after copy
if ($ssmFile -match "clearSelection") {
  Pass "TC-3e: clearSelection called after copy"
} else {
  Fail "TC-3e" "clearSelection not called"
}

# TC-3f: returns false for both keydown and keypress when copying
# The handler must return false for ALL event types when Ctrl+C should copy
# Pattern: if (hasSelection) block should return false outside keydown check
$blockPattern = [regex]::Match($ssmFile, "hasSelection\(\)[\s\S]{0,200}?return\s+false")
if ($blockPattern.Success) {
  Pass "TC-3f: returns false when selection exists (blocks PTY interrupt)"
} else {
  Fail "TC-3f" "return false not found in hasSelection branch"
}

# TC-3g: Ctrl+V paste handler exists
if ($ssmFile -match "event\.code\s*===\s*'KeyV'" -and $ssmFile -match "clipboard\.readText") {
  Pass "TC-3g: Ctrl+V paste handler exists"
} else {
  Fail "TC-3g" "Ctrl+V paste handler not found"
}

# TC-3h: rightClickSelectsWord enabled
if ($ssmFile -match "rightClickSelectsWord:\s*true") {
  Pass "TC-3h: rightClickSelectsWord enabled in xterm config"
} else {
  Fail "TC-3h" "rightClickSelectsWord not enabled"
}

# TC-3i: platform guard — keyboard handler only on Windows/Linux, not macOS
if ($ssmFile -match "isMac" -and $ssmFile -match "Mac OS X\|Macintosh") {
  Pass "TC-3i: macOS platform guard exists (Ctrl+C/V only on Windows/Linux)"
} else {
  Fail "TC-3i" "macOS platform guard missing -- Ctrl+C/V handler must be Windows/Linux only"
}

# TC-3j: handler wrapped inside !isMac condition
$guardPattern = [regex]::Match($ssmFile, "if\s*\(\s*!isMac\s*\)\s*\{[\s\S]*?attachCustomKeyEventHandler")
if ($guardPattern.Success) {
  Pass "TC-3j: attachCustomKeyEventHandler wrapped in !isMac guard"
} else {
  Fail "TC-3j" "attachCustomKeyEventHandler not inside !isMac guard"
}

# ────────────────────────────────────────
# TC-4  TerminalGrid.tsx: right-click context menu
# ────────────────────────────────────────
Write-Host "`n[TC-4] TerminalGrid.tsx: right-click context menu"
$gridFile = Get-Content (Join-Path $RootDir "src\components\TerminalGrid\TerminalGrid.tsx") -Raw

if ($gridFile -match "addEventListener\(\s*'contextmenu'") {
  Pass "TC-4a: contextmenu event listener attached"
} else {
  Fail "TC-4a" "contextmenu event listener not found"
}

if ($gridFile -match "createPortal") {
  Pass "TC-4b: createPortal used -- menu renders at document.body level"
} else {
  Fail "TC-4b" "createPortal not used -- menu may be hidden behind xterm layers"
}

$hasMenuCopy     = $gridFile -match "terminal\.contextMenu\.copy"
$hasMenuPaste    = $gridFile -match "terminal\.contextMenu\.paste"
$hasMenuSelectAll = $gridFile -match "terminal\.contextMenu\.selectAll"
$hasMenuClear    = $gridFile -match "terminal\.contextMenu\.clear"
if ($hasMenuCopy -and $hasMenuPaste -and $hasMenuSelectAll -and $hasMenuClear) {
  Pass "TC-4c: context menu has all 4 actions (copy/paste/selectAll/clear)"
} else {
  Fail "TC-4c" "Missing actions: copy=$hasMenuCopy paste=$hasMenuPaste selectAll=$hasMenuSelectAll clear=$hasMenuClear"
}

if ($gridFile -match "disabled=\{!termCtxMenu\.hasSelection\}") {
  Pass "TC-4d: copy button disabled when no selection"
} else {
  Fail "TC-4d" "copy button not disabled for empty selection"
}

# ────────────────────────────────────────
# TC-5  i18n: locale keys exist for both en and zh-CN
# ────────────────────────────────────────
Write-Host "`n[TC-5] i18n: terminal context menu locale keys"
$i18nFile = Get-Content (Join-Path $RootDir "src\i18n\core.ts") -Raw

$keys = @(
  "terminal.contextMenu.copy",
  "terminal.contextMenu.paste",
  "terminal.contextMenu.selectAll",
  "terminal.contextMenu.clear"
)

foreach ($key in $keys) {
  $matches = [regex]::Matches($i18nFile, [regex]::Escape("'$key'"))
  if ($matches.Count -eq 2) {
    Pass "TC-5: '$key' present in both en and zh-CN"
  } elseif ($matches.Count -eq 1) {
    Fail "TC-5" "'$key' found only once -- missing in one language"
  } else {
    Fail "TC-5" "'$key' found $($matches.Count) times (expected 2)"
  }
}

# ────────────────────────────────────────
# TC-6  CSS: context menu follows unified project rules
# ────────────────────────────────────────
Write-Host "`n[TC-6] CSS: context menu unified style"
$cssFile = Get-Content (Join-Path $RootDir "src\components\TerminalGrid\TerminalGrid.css") -Raw

if ($cssFile -match "terminal-context-menu" -and $cssFile -match "border-radius:\s*10px") {
  Pass "TC-6a: menu container uses border-radius: 10px"
} else {
  Fail "TC-6a" "menu container missing or wrong border-radius"
}

if ($cssFile -match "terminal-context-item" -and $cssFile -match "border-radius:\s*6px") {
  Pass "TC-6b: menu item uses border-radius: 6px"
} else {
  Fail "TC-6b" "menu item missing or wrong border-radius"
}

if ($cssFile -match "terminal-context-fade-in") {
  Pass "TC-6c: fade-in animation defined"
} else {
  Fail "TC-6c" "fade-in animation missing"
}

if ($cssFile -match "color-mix.*var\(--accent\)\s*15%") {
  Pass "TC-6d: hover uses accent 15% color-mix"
} else {
  Fail "TC-6d" "hover accent color-mix missing"
}

# ────────────────────────────────────────
# TC-7  Build verification
# ────────────────────────────────────────
Write-Host "`n[TC-7] Build verification"
. (Join-Path $RootDir "test\autotest\Resolve-DevAppBin.ps1")
$AppExe = Resolve-DevAppBin -RootDir $RootDir
if ($AppExe -and (Test-Path $AppExe)) {
  Pass "TC-7a: built executable exists at $AppExe"
} else {
  Fail "TC-7a" "built executable not found -- run: rm -rf out release && pnpm dist:dev"
}

# TC-7b: launch app and verify no crash
if ($AppExe -and (Test-Path $AppExe)) {
  Write-Host "  Launching app for smoke test (10s timeout)..."
  $logFile = "$env:TEMP\onward-powershell-tty-autotest.log"
  if (Test-Path $logFile) { Remove-Item $logFile -Force }
  $proc = Start-Process -FilePath $AppExe -PassThru -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err" -WindowStyle Hidden
  Start-Sleep -Seconds 10
  if (-not $proc.HasExited) {
    $proc.Kill()
    $proc.WaitForExit(5000)
    Pass "TC-7b: app launched and ran for 10s without crash"
  } else {
    $exitCode = $proc.ExitCode
    if ($exitCode -eq 0) {
      Pass "TC-7b: app launched and exited cleanly (code 0)"
    } else {
      Fail "TC-7b" "app crashed with exit code $exitCode"
    }
  }
}

# ────────────────────────────────────────
# TC-8  Compiled output: verify key handler in bundled JS
# ────────────────────────────────────────
Write-Host "`n[TC-8] Compiled output: key handler in bundle"
$mainJs = Get-Content (Join-Path $RootDir "out\renderer\assets\index-*.js") -Raw -ErrorAction SilentlyContinue
if (-not $mainJs) {
  $jsFiles = Get-ChildItem (Join-Path $RootDir "out\renderer\assets") -Filter "index-*.js" -ErrorAction SilentlyContinue
  if ($jsFiles) {
    $mainJs = Get-Content $jsFiles[0].FullName -Raw
  }
}

if ($mainJs) {
  if ($mainJs -match "attachCustomKeyEventHandler") {
    Pass "TC-8a: attachCustomKeyEventHandler present in compiled bundle"
  } else {
    Fail "TC-8a" "attachCustomKeyEventHandler missing from compiled bundle -- code may be tree-shaken or in wrong file"
  }

  if ($mainJs -match "KeyC" -and $mainJs -match "hasSelection") {
    Pass "TC-8b: KeyC + hasSelection logic present in compiled bundle"
  } else {
    Fail "TC-8b" "KeyC/hasSelection missing from bundle"
  }

  if ($mainJs -match "contextmenu" -and $mainJs -match "createPortal") {
    Pass "TC-8c: contextmenu + createPortal present in compiled bundle"
  } else {
    Fail "TC-8c" "contextmenu/createPortal missing from bundle"
  }
} else {
  Fail "TC-8a" "Could not read compiled bundle"
  Fail "TC-8b" "Could not read compiled bundle"
  Fail "TC-8c" "Could not read compiled bundle"
}

# ────────────────────────────────────────
# TC-9  ipc-handlers.ts: CWD detection integration
# ────────────────────────────────────────
Write-Host "`n[TC-9] ipc-handlers.ts: CWD detection integration"
$ipcFile = Get-Content (Join-Path $RootDir "electron\main\ipc-handlers.ts") -Raw

if ($ipcFile -match "detectCwd") {
  Pass "TC-9a: detectCwd called in PTY data handler"
} else {
  Fail "TC-9a" "detectCwd not called in ipc-handlers -- OSC 9;9 parsing won't work"
}

# ────────────────────────────────────────
# TC-10  git-utils.ts: Windows CWD uses shell integration
# ────────────────────────────────────────
Write-Host "`n[TC-10] git-utils.ts: Windows CWD uses shell integration"
$gitFile = Get-Content (Join-Path $RootDir "electron\main\git-utils.ts") -Raw

if ($gitFile -match "ptyManager\.getCwd") {
  Pass "TC-10a: getTerminalCwd uses ptyManager.getCwd on Windows"
} else {
  Fail "TC-10a" "ptyManager.getCwd not found in git-utils -- Windows CWD detection broken"
}

if ($gitFile -match "win32" -and $gitFile -match "OSC 9;9") {
  Pass "TC-10b: Windows branch documented with OSC 9;9 reference"
} else {
  Fail "TC-10b" "Windows CWD branch missing OSC 9;9 documentation"
}

# ────────────────────────────────────────
# Summary
# ────────────────────────────────────────
Write-Host "`n=== Results ===" -ForegroundColor Cyan
Write-Host "Passed: $passed" -ForegroundColor Green
if ($failed -gt 0) {
  Write-Host "Failed: $failed" -ForegroundColor Red
  exit 1
} else {
  Write-Host "All tests passed!" -ForegroundColor Green
  exit 0
}
