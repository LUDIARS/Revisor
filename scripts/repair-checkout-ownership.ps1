#requires -Version 5.1
<#
.SYNOPSIS
Reports, and optionally repairs, checkouts whose directory or gitdir is owned by
another local account.

.DESCRIPTION
A history rewrite or any operation that re-creates `.git` under a different local
account (a sandbox account, for example) leaves that account as the owner. Git
then refuses the repository with "detected dubious ownership". Revisor itself is
unaffected because it passes its own global-scope trust configuration
(src/git-trust.mjs), but every other tool on the host still refuses the checkout.

Ownership is set on the directory and on its `.git` entry only. Git checks those
two paths; the object files below them do not need to change, which keeps the
repair fast and its blast radius small. Access control entries are not touched.

.PARAMETER WorkspaceRoot
Directory holding the checkouts. Defaults to the parent of this repository.

.PARAMETER Owner
Account to set as owner. Defaults to the current user.

.PARAMETER Apply
Perform the repair. Without it the script only reports.

.EXAMPLE
powershell -File scripts/repair-checkout-ownership.ps1
.EXAMPLE
powershell -File scripts/repair-checkout-ownership.ps1 -Apply
#>
[CmdletBinding()]
param(
    [string] $WorkspaceRoot,
    [string] $Owner = "$env:USERDOMAIN\$env:USERNAME",
    [switch] $Apply
)

$ErrorActionPreference = 'Stop'

if (-not $WorkspaceRoot) {
    $WorkspaceRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}
if (-not (Test-Path -LiteralPath $WorkspaceRoot)) {
    throw "Workspace root not found: $WorkspaceRoot"
}

function Get-OwnerOrNull([string] $Path) {
    try { return (Get-Acl -LiteralPath $Path).Owner } catch { return $null }
}

$expected = $Owner.ToLowerInvariant()
$targets = @()

foreach ($directory in Get-ChildItem -LiteralPath $WorkspaceRoot -Directory) {
    $gitPath = Join-Path $directory.FullName '.git'
    if (-not (Test-Path -LiteralPath $gitPath)) { continue }
    foreach ($path in @($directory.FullName, $gitPath)) {
        $owner = Get-OwnerOrNull $path
        if ($owner -and $owner.ToLowerInvariant() -ne $expected) {
            $targets += [pscustomobject]@{ Path = $path; Owner = $owner }
        }
    }
}

if ($targets.Count -eq 0) {
    Write-Output "All checkouts under $WorkspaceRoot are owned by $Owner."
    exit 0
}

$targets | ForEach-Object { Write-Output ("{0}`t{1}" -f $_.Owner, $_.Path) }
Write-Output ""
Write-Output ("{0} path(s) are owned by another account." -f $targets.Count)

if (-not $Apply) {
    Write-Output "Re-run with -Apply to set the owner to $Owner."
    exit 0
}

$failed = 0
foreach ($target in $targets) {
    & icacls.exe $target.Path /setowner $Owner | Out-Null
    if ($LASTEXITCODE -ne 0) {
        $failed++
        Write-Warning ("Could not set the owner of {0}" -f $target.Path)
    }
}
Write-Output ("Repaired {0} of {1} path(s)." -f ($targets.Count - $failed), $targets.Count)
if ($failed -gt 0) { exit 1 }
