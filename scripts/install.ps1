# PortPilot HomeDeploy Dashboard - Windows installation script.
# Run from an ELEVATED-free normal PowerShell: no admin rights required.
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host " PortPilot HomeDeploy Dashboard - install" -ForegroundColor Cyan
Write-Host "==============================================================" -ForegroundColor Cyan

# 1. Node.js version
Write-Host "`n[1/6] Checking Node.js..." -ForegroundColor Yellow
$nodeVersion = (node --version).Trim()
$major = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($major -lt 22) {
    Write-Host "  X Node.js $nodeVersion is too old. Install Node.js 22 LTS+ from https://nodejs.org" -ForegroundColor Red
    exit 1
}
Write-Host "  OK $nodeVersion"

# 2. Git
Write-Host "`n[2/6] Checking Git..." -ForegroundColor Yellow
try {
    $gitVersion = (git --version).Trim()
    Write-Host "  OK $gitVersion"
} catch {
    Write-Host "  X Git not found. Install Git for Windows: https://git-scm.com/download/win" -ForegroundColor Red
    exit 1
}

# 3. Dependencies
Write-Host "`n[3/6] Installing npm dependencies..." -ForegroundColor Yellow
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Write-Host "  X npm install failed" -ForegroundColor Red; exit 1 }
Write-Host "  OK dependencies installed"

# 4. Directories + .env
Write-Host "`n[4/6] Preparing data directories..." -ForegroundColor Yellow
foreach ($dir in @("data", "workspaces", "artifacts", "logs", "logs\deployments", "logs\runtime")) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
}
if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "  OK .env created from .env.example"
} else {
    Write-Host "  OK .env already exists"
}

# 5. Build
Write-Host "`n[5/6] Building TypeScript packages and dashboard..." -ForegroundColor Yellow
npx tsc -b tsconfig.build.json
if ($LASTEXITCODE -ne 0) { Write-Host "  X TypeScript build failed" -ForegroundColor Red; exit 1 }
npm run build --workspace @portpilot/dashboard
if ($LASTEXITCODE -ne 0) { Write-Host "  X dashboard build failed" -ForegroundColor Red; exit 1 }
Write-Host "  OK build complete"

# 6. Setup (database init + port checks + summary)
Write-Host "`n[6/6] Running setup checks..." -ForegroundColor Yellow
node scripts\setup.mjs

Write-Host "`nInstall complete. Next steps:" -ForegroundColor Green
Write-Host "  npm run dev     # development mode (HMR dashboard)"
Write-Host "  npm start       # production mode"
Write-Host "  npm run doctor  # diagnostics"
Write-Host "`nOptional startup integration (explicit consent, no admin required for per-user startup):"
Write-Host "  powershell -File scripts\install-startup.ps1   # adds a per-user Startup shortcut"
