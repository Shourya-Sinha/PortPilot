# Start PortPilot in the background on Windows.
#   powershell -ExecutionPolicy Bypass -File scripts\start.ps1
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path "apps\api\dist\index.js")) {
    Write-Host "[start] Building first..."
    npx tsc -b tsconfig.build.json
    npm run build --workspace @portpilot/dashboard
}

$pidFile = "data\portpilot.pid"
if (Test-Path $pidFile) {
    $existing = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($existing) {
        $proc = Get-Process -Id $existing -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "[start] PortPilot already running (pid $existing). Use scripts\stop.ps1 first." -ForegroundColor Yellow
            exit 1
        }
    }
}

New-Item -ItemType Directory -Force -Path data, logs | Out-Null
$logOut = Join-Path $root "logs\portpilot-out.log"
Write-Host "[start] Launching PortPilot (background)... logs: logs\portpilot-out.log"
$p = Start-Process -FilePath "node" -ArgumentList "apps\api\dist\index.js" `
    -WorkingDirectory $root -RedirectStandardOutput $logOut -RedirectStandardError "logs\portpilot-err.log" `
    -WindowStyle Hidden -PassThru
Set-Content -Path $pidFile -Value $p.Id
Start-Sleep -Seconds 3

$health = $null
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:4300/api/system/health" -TimeoutSec 5
} catch { }

if ($health -and $health.ok) {
    Write-Host "[start] PortPilot is running (pid $($p.Id))." -ForegroundColor Green
    $token = Get-Content "data\.session-token" -ErrorAction SilentlyContinue
    Write-Host "[start] Dashboard: http://127.0.0.1:4300/?token=$token"
    Write-Host "[start] Proxy:     http://<website-name>.localhost:8080"
} else {
    Write-Host "[start] Process started (pid $($p.Id)) but health check did not respond yet. Check logs\portpilot-err.log" -ForegroundColor Yellow
}
