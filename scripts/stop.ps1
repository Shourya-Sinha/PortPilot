# Stop the background PortPilot process on Windows.
#   powershell -ExecutionPolicy Bypass -File scripts\stop.ps1
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$pidFile = "data\portpilot.pid"

if (-not (Test-Path $pidFile)) {
    Write-Host "[stop] No pid file - PortPilot does not appear to be running in the background."
    exit 0
}
$procId = Get-Content $pidFile
$proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
if (-not $proc) {
    Write-Host "[stop] Process $procId not running - cleaning up."
    Remove-Item $pidFile -Force
    exit 0
}

Write-Host "[stop] Stopping PortPilot (pid $procId)..."
# Graceful: send Ctrl+C equivalent via taskkill (child trees included).
taskkill /PID $procId /T /F | Out-Null
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "[stop] Stopped." -ForegroundColor Green
