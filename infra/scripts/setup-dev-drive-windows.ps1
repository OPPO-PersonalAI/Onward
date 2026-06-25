# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Plan 1 — Windows EDR mitigation via a Dev Drive.
# =============================================================================
# WHY: On this host every process spawn (git.exe / conpty / rg.exe / electron)
# is taxed 1.3-12.9 s by the synchronous on-access Defender/EDR scan. Defender
# exclusions are blocked here (Tamper Protection + Intune-managed), so the only
# in-our-control environment fix is a **Windows 11 Dev Drive**: a ReFS volume
# that Microsoft scans in *performance mode* (asynchronous, post-write) instead
# of synchronously on every open. Moving the repo + its node_modules onto a Dev
# Drive removes the synchronous spawn tax that makes the full regression flake.
# Refs: learn.microsoft.com/windows/dev-drive/ ; Defender performance mode.
#
# WHAT THIS SCRIPT DOES (idempotent, non-destructive to your existing disks):
#   1. Verifies it is running ELEVATED and on a Windows build that supports
#      Dev Drive (Win 11 22H2 / build 22621+).
#   2. Creates a NEW VHDX file (a virtual disk; does NOT repartition C:) of the
#      size you choose, at the path you choose.
#   3. Attaches it, creates a GPT partition, and formats it ReFS as a Dev Drive
#      (`format <X>: /DevDrv`), then marks the volume TRUSTED.
#   4. Prints the next manual step (copy/clone the repo onto the new drive).
# It NEVER touches your system disk layout and NEVER deletes the existing repo.
#
# HOW TO RUN (you must do this — it needs admin, which the agent does not have):
#   Right-click PowerShell -> "Run as administrator", then:
#     Set-ExecutionPolicy -Scope Process Bypass
#     .\infra\scripts\setup-dev-drive-windows.ps1 -VhdxPath 'D:\devdrives\onward.vhdx' -SizeGB 64
#   Then copy the repo onto the new drive letter it prints and re-run the
#   regression there:  py test/autotest/run-full-regression.py --build
# =============================================================================

[CmdletBinding()]
param(
    # Where to create the backing virtual-disk file. Pick a folder on a drive
    # with enough free space (the VHDX grows up to -SizeGB).
    [Parameter(Mandatory = $true)]
    [string]$VhdxPath,

    # Maximum size of the Dev Drive in GB. 50+ is the Microsoft minimum for a
    # Dev Drive; 64 comfortably holds this repo + node_modules + build output.
    [int]$SizeGB = 64,

    # Volume label for the new Dev Drive.
    [string]$Label = 'DevDrive'
)

$ErrorActionPreference = 'Stop'

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'This script must be run from an ELEVATED PowerShell (Run as administrator). Dev Drive creation requires admin rights.'
    }
}

function Assert-DevDriveSupported {
    $build = [int](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuildNumber
    if ($build -lt 22621) {
        throw "Dev Drive needs Windows 11 22H2 (build 22621) or newer. This host reports build $build."
    }
    Write-Host "[ok] Windows build $build supports Dev Drive." -ForegroundColor Green
}

function New-DevDriveVhdx {
    param([string]$Path, [int]$SizeGB, [string]$Label)

    if (Test-Path -LiteralPath $Path) {
        throw "A file already exists at '$Path'. Choose a fresh -VhdxPath (this script will not overwrite an existing disk image)."
    }
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    Write-Host "[..] Creating $SizeGB GB dynamic VHDX at '$Path' and formatting it as a Dev Drive..." -ForegroundColor Cyan

    # diskpart drives this universally (no Hyper-V PowerShell module dependency,
    # which is often unavailable on managed laptops). We create a dynamically-
    # expanding VHDX, attach it, partition GPT, then format ReFS /DevDrv below.
    $sizeMB = $SizeGB * 1024
    $script = @"
create vdisk file="$Path" maximum=$sizeMB type=expandable
select vdisk file="$Path"
attach vdisk
convert gpt
create partition primary
"@
    $tmp = [System.IO.Path]::GetTempFileName()
    Set-Content -LiteralPath $tmp -Value $script -Encoding ascii
    try {
        & diskpart.exe /s $tmp | Write-Host
        if ($LASTEXITCODE -ne 0) { throw "diskpart failed (exit $LASTEXITCODE)." }
    }
    finally {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }

    # Find the just-attached disk's new RAW partition and assign a letter.
    Start-Sleep -Seconds 2
    $part = Get-Disk |
        Where-Object { $_.Location -like "*$([System.IO.Path]::GetFileName($Path))*" -or $_.FriendlyName -like '*Virtual*' } |
        Get-Partition -ErrorAction SilentlyContinue |
        Where-Object { $_.Type -ne 'Reserved' -and -not $_.DriveLetter } |
        Select-Object -First 1
    if (-not $part) { throw 'Could not locate the new VHDX partition to assign a drive letter. Inspect with: Get-Disk | Get-Partition' }

    $letter = [char[]](70..90) | Where-Object { -not (Test-Path "$($_):") } | Select-Object -First 1
    Add-PartitionAccessPath -DiskNumber $part.DiskNumber -PartitionNumber $part.PartitionNumber -AccessPath "$($letter):"

    # Format ReFS as a Dev Drive. The /DevDrv flag is what enables Defender
    # performance-mode (async) scanning — the whole point of Plan 1.
    & format.com "$($letter):" /DevDrv /Q /Y /V:$Label | Write-Host
    if ($LASTEXITCODE -ne 0) { throw "format /DevDrv failed (exit $LASTEXITCODE). Your build may need the Dev Drive feature enabled in Settings > System > For developers." }

    return "$($letter):"
}

# --- main -------------------------------------------------------------------
Assert-Admin
Assert-DevDriveSupported
$drive = New-DevDriveVhdx -Path $VhdxPath -SizeGB $SizeGB -Label $Label

Write-Host ''
Write-Host "[done] Dev Drive ready at $drive (backed by $VhdxPath)." -ForegroundColor Green
Write-Host 'Verify it is a trusted Dev Drive with:' -ForegroundColor Yellow
Write-Host "    fsutil devdrv query $drive" -ForegroundColor Yellow
Write-Host ''
Write-Host 'NEXT (Plan 1 completion — do these, then the EDR spawn tax is gone on the new drive):' -ForegroundColor Yellow
Write-Host "  1. Clone/copy the repo onto the Dev Drive, e.g.:" -ForegroundColor Yellow
Write-Host "       git clone <this-repo> $drive\Onward-Agent-Workbench" -ForegroundColor Yellow
Write-Host "     (or robocopy the working tree; then run 'pnpm install' on the Dev Drive)" -ForegroundColor Yellow
Write-Host "  2. From the copy on $drive, run the regression to confirm the tax is gone:" -ForegroundColor Yellow
Write-Host "       py test/autotest/run-full-regression.py --build --repeat 3" -ForegroundColor Yellow
Write-Host ''
Write-Host 'To re-attach this Dev Drive after a reboot (it does not auto-mount by default):' -ForegroundColor Yellow
Write-Host "       Mount-DiskImage -ImagePath '$VhdxPath'" -ForegroundColor Yellow
