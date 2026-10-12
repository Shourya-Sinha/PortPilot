# PortPilot diagnostics on Windows.
#   powershell -ExecutionPolicy Bypass -File scripts\doctor.ps1
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
node scripts\doctor.mjs
