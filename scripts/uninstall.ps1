# Uninstall PortPilot local data and (optionally) startup integration.
# Does NOT delete the repository source code.
#   powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 [-PurgeData] [-RemoveStartup]
param(
    [switch]$PurgeData,
    [switch]$RemoveStartup
)
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "[uninstall] Stopping PortPilot (if running)..."
powershell -ExecutionPolicy Bypass -File scripts\stop.ps1

if ($RemoveStartup) {
    $shortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup\PortPilot.lnk"
    if (Test-Path $shortcut) {
        Remove-Item $shortcut -Force
        Write-Host "[uninstall] Removed Startup shortcut."
    } else {
        Write-Host "[uninstall] No Startup shortcut found."
    }
}

if ($PurgeData) {
    $answer = Read-Host "This DELETES all projects, deployments, databases and logs. Type 'DELETE' to confirm"
    if ($answer -eq "DELETE") {
        foreach ($dir in @("data", "workspaces", "artifacts", "logs")) {
            if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
        }
        Write-Host "[uninstall] Runtime data deleted." -ForegroundColor Green
    } else {
        Write-Host "[uninstall] Aborted - data preserved."
    }
} else {
    Write-Host "[uninstall] Runtime data preserved (use -PurgeData to delete it)."
}

Write-Host "[uninstall] You can now delete the PortPilot folder manually."
