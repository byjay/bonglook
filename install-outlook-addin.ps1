# BongLook AI Outlook Add-in Installer
# One-click installation script for Windows
# Usage: Right-click > Run with PowerShell

param(
    [switch]$Uninstall,
    [switch]$StartOnly
)

$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "BongLook AI Installer"

# Colors
function Write-Step { param($msg) Write-Host "`n[*] $msg" -ForegroundColor Cyan }
function Write-Success { param($msg) Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "[!] $msg" -ForegroundColor Yellow }
function Write-Err { param($msg) Write-Host "[X] $msg" -ForegroundColor Red }

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

# Banner
Write-Host @"

  ____                   _                 _       _    ___
 | __ )  ___  _ __   ___| |     ___   ___ | | __  / \  |_ _|
 |  _ \ / _ \| '_ \ / _ \ |    / _ \ / _ \| |/ / / _ \  | |
 | |_) | (_) | | | |  __/ |___| (_) | (_) |   < / ___ \ | |
 |____/ \___/|_| |_|\___|_____|\___/ \___/|_|\_\_/  \_\___|

        Outlook AI Mail Analyzer - One-Click Installer

"@ -ForegroundColor Blue

# Uninstall
if ($Uninstall) {
    Write-Step "Uninstalling BongLook AI Add-in..."

    $manifestPath = Join-Path $scriptDir "manifest.xml"
    $addinsFolder = "$env:LOCALAPPDATA\Microsoft\Office\16.0\Wef"

    # Stop running processes
    Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -like "*bonglook*" -or $_.CommandLine -like "*bonglook*"
    } | Stop-Process -Force -ErrorAction SilentlyContinue

    Write-Success "Add-in uninstalled. Remove from Outlook: File > Manage Add-ins"
    exit 0
}

# Check Node.js
Write-Step "Checking prerequisites..."
try {
    $nodeVersion = node --version 2>$null
    Write-Success "Node.js found: $nodeVersion"
} catch {
    Write-Err "Node.js not found! Please install from https://nodejs.org"
    Write-Host "`nPress any key to open download page..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    Start-Process "https://nodejs.org"
    exit 1
}

# Install dependencies
if (-not $StartOnly) {
    Write-Step "Installing dependencies..."
    npm install 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Success "Dependencies installed"
    } else {
        Write-Warn "Some dependencies may have issues, continuing..."
    }
}

# Create self-signed certificate for HTTPS (Outlook requires HTTPS)
$certPath = Join-Path $scriptDir "localhost.pfx"
if (-not (Test-Path $certPath)) {
    Write-Step "Creating SSL certificate for localhost..."
    try {
        $cert = New-SelfSignedCertificate -DnsName "localhost" -CertStoreLocation "Cert:\CurrentUser\My" -NotAfter (Get-Date).AddYears(5)
        $pwd = ConvertTo-SecureString -String "bonglook" -Force -AsPlainText
        Export-PfxCertificate -Cert $cert -FilePath $certPath -Password $pwd | Out-Null

        # Trust the certificate
        Import-PfxCertificate -FilePath $certPath -CertStoreLocation "Cert:\CurrentUser\Root" -Password $pwd | Out-Null
        Write-Success "SSL certificate created and trusted"
    } catch {
        Write-Warn "Could not create SSL cert. HTTPS may not work."
    }
}

# Start servers
Write-Step "Starting BongLook AI servers..."

# Kill existing processes on ports
$ports = @(3000, 3001)
foreach ($port in $ports) {
    $process = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($process) {
        Stop-Process -Id $process.OwningProcess -Force -ErrorAction SilentlyContinue
    }
}

# Start backend server
Write-Host "  Starting backend server on port 3001..." -ForegroundColor Gray
$backendJob = Start-Job -ScriptBlock {
    param($dir)
    Set-Location $dir
    node server.js 2>&1
} -ArgumentList $scriptDir

# Start frontend dev server
Write-Host "  Starting frontend server on port 3000..." -ForegroundColor Gray
$frontendJob = Start-Job -ScriptBlock {
    param($dir)
    Set-Location $dir
    npm run dev 2>&1
} -ArgumentList $scriptDir

Start-Sleep -Seconds 5

# Check if servers started
$backendRunning = Test-NetConnection -ComputerName localhost -Port 3001 -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
$frontendRunning = Test-NetConnection -ComputerName localhost -Port 3000 -WarningAction SilentlyContinue -ErrorAction SilentlyContinue

if ($frontendRunning.TcpTestSucceeded) {
    Write-Success "Frontend server running at http://localhost:3000"
} else {
    Write-Warn "Frontend may still be starting..."
}

if ($backendRunning.TcpTestSucceeded) {
    Write-Success "Backend server running at http://localhost:3001"
}

# Show Outlook sideload instructions
Write-Host @"

========================================
   OUTLOOK ADD-IN INSTALLATION GUIDE
========================================

"@ -ForegroundColor Yellow

Write-Host @"
[Method 1: Outlook Web (Recommended)]
1. Open https://outlook.office.com
2. Click Settings (gear icon) > View all Outlook settings
3. Go to Mail > Customize actions > Add-ins
4. Click "My add-ins" > "Add a custom add-in" > "Add from file"
5. Select: $scriptDir\manifest.xml

[Method 2: Outlook Desktop]
1. Open Outlook
2. Go to File > Manage Add-ins (opens web browser)
3. Follow Method 1 steps above

[Method 3: Centralized Deployment (Admin)]
1. Go to Microsoft 365 admin center
2. Settings > Integrated apps > Add-ins
3. Upload manifest.xml

"@ -ForegroundColor White

Write-Host "Servers are running. Press Ctrl+C to stop." -ForegroundColor Green
Write-Host "Frontend: http://localhost:3000" -ForegroundColor Cyan
Write-Host "Backend:  http://localhost:3001" -ForegroundColor Cyan

# Open browser
Start-Process "http://localhost:3000"

# Keep script running
Write-Host "`nPress any key to stop servers and exit..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")

# Cleanup
Write-Step "Stopping servers..."
Stop-Job $backendJob -ErrorAction SilentlyContinue
Stop-Job $frontendJob -ErrorAction SilentlyContinue
Remove-Job $backendJob -ErrorAction SilentlyContinue
Remove-Job $frontendJob -ErrorAction SilentlyContinue

Write-Success "BongLook AI stopped. Goodbye!"
