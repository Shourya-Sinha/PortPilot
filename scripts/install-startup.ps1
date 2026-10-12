# OPTIONAL startup integration - explicit user consent only.
# Adds a per-user Startup shortcut so PortPilot starts when YOU sign in.
# This is NOT a Windows service and requires NO administrator privileges.
#   powershell -ExecutionPolicy Bypass -File scripts\install-startup.ps1
$root = Split-Path -Parent $PSScriptRoot
$answer = Read-Host "Add PortPilot to your per-user Startup folder so it starts at sign-in? (yes/no)"
if ($answer -ne "yes") {
    Write-Host "[startup] Cancelled - no system changes were made."
    exit 0
}

$shortcutPath = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup\PortPilot.lnk"
$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "powershell.exe"
$shortcut.Arguments = "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$root\scripts\start.ps1`""
$shortcut.WorkingDirectory = $root
$shortcut.Description = "Start PortPilot HomeDeploy Dashboard"
$shortcut.Save()
Write-Host "[startup] Startup shortcut created: $shortcutPath" -ForegroundColor Green
Write-Host "[startup] Remove it any time with: scripts\uninstall.ps1 -RemoveStartup"
