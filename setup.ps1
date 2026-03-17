#Requires -RunAsAdministrator
# File Watch — Dev Setup Script (Windows)

# Enable unsigned CEP extensions (CSXS.10, CSXS.11, CSXS.12)
Write-Host "[1/2] Enabling unsigned extension support..."
$csxsVersions = @("CSXS.10", "CSXS.11", "CSXS.12")
foreach ($ver in $csxsVersions) {
    $regPath = "HKCU:\Software\Adobe\$ver"
    if (-not (Test-Path $regPath)) {
        New-Item -Path $regPath -Force | Out-Null
    }
    Set-ItemProperty -Path $regPath -Name "PlayerDebugMode" -Value "1" -Type String
}
Write-Host "   Done." -ForegroundColor Green

# Create CEP extensions directory if it doesn't exist
$extensionsDir = Join-Path $env:APPDATA "Adobe\CEP\extensions"
if (-not (Test-Path $extensionsDir)) {
    New-Item -ItemType Directory -Path $extensionsDir -Force | Out-Null
}

# Create symlink from extensions folder to project directory
$linkPath   = Join-Path $extensionsDir "FileWatch"
$sourcePath = $PSScriptRoot

Write-Host "[2/2] Creating symlink..."
Write-Host "   Link:   $linkPath"
Write-Host "   Source: $sourcePath"

if (Test-Path $linkPath) {
    Write-Host "   Removing existing link/folder..."
    Remove-Item -Path $linkPath -Recurse -Force
}

New-Item -ItemType Junction -Path $linkPath -Target $sourcePath | Out-Null

if (Test-Path $linkPath) {
    Write-Host "   Symlink created successfully." -ForegroundColor Green
    Write-Host ""
    Write-Host "   Restart Premiere Pro, then open:"
    Write-Host "   Window > Extensions > File Watch"
} else {
    Write-Host "   ERROR: Failed to create symlink." -ForegroundColor Red
    exit 1
}
