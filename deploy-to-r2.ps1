# deploy-to-r2.ps1 - Sync deploy repo folders to Cloudflare R2 (evo-campaign bucket)
# Run from anywhere; auto-detects repo root. No arguments needed.
# Requires rclone with a "cf" remote configured for Cloudflare R2.

$bucket = "cf:evo-campaign"
$deployRoot = if (Test-Path "$PSScriptRoot\manifests") { $PSScriptRoot }
              elseif (Test-Path "$PSScriptRoot\..\manifests") { "$PSScriptRoot\.." }
              else { $PWD.Path }

$folders = @(
  @{ Name = "Assets";      Local = "assets"      },
  @{ Name = "Manifests";   Local = "manifests"   },
  @{ Name = "Payload";     Local = "payload"      },
  @{ Name = "BetaPayload"; Local = "betapayload" },
  @{ Name = "Launcher";    Local = "launcher"    },
  @{ Name = "Installer";   Local = "installer"   }
)

# --- Config ---
$configPath = "$PSScriptRoot\deploy-config.json"
$config = if (Test-Path $configPath) {
  try { Get-Content $configPath -Raw | ConvertFrom-Json } catch { $null }
} else { $null }

$launcherRepo = $config.launcherRepoPath
if (-not $launcherRepo -or -not (Test-Path "$launcherRepo\package.json")) {
  Write-Host ""
  Write-Host "Launcher repo path not configured or invalid." -ForegroundColor Yellow
  $launcherRepo = (Read-Host "Enter full path to the launcher repo (e.g. D:\EvoLauncher\sc-evo-launcher)").Trim()
  if (-not (Test-Path "$launcherRepo\package.json")) {
    Write-Host "ERROR: package.json not found at that path. Aborting." -ForegroundColor Red
    exit 1
  }
  $configJson = "{`n  `"launcherRepoPath`": `"$($launcherRepo.Replace('\','\\'))`"`n}"
  [System.IO.File]::WriteAllText($configPath, $configJson, (New-Object System.Text.UTF8Encoding $false))
  Write-Host "Config saved to $configPath" -ForegroundColor DarkGray
}

if (-not (Get-Command rclone -ErrorAction SilentlyContinue)) {
  Write-Host "ERROR: rclone not found. Install: winget install Rclone.Rclone" -ForegroundColor Red
  exit 1
}

Write-Host "Deploy root:   $deployRoot" -ForegroundColor DarkGray
Write-Host "Launcher repo: $launcherRepo" -ForegroundColor DarkGray
Write-Host "Bucket:        $bucket" -ForegroundColor DarkGray

# --- Copy portable exe if changed ---
$exeName    = "SC Evo Launcher.exe"
$srcExe     = "$launcherRepo\dist-electron\$exeName"
$dstDir     = "$deployRoot\launcher"
$dstExe     = "$dstDir\$exeName"

if (Test-Path $srcExe) {
  $srcHash = (Get-FileHash $srcExe -Algorithm SHA256).Hash
  $dstHash = if (Test-Path $dstExe) { (Get-FileHash $dstExe -Algorithm SHA256).Hash } else { "" }
  if ($srcHash -ne $dstHash) {
    if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Path $dstDir | Out-Null }
    Copy-Item $srcExe $dstExe -Force
    Write-Host "Portable exe copied (hash changed)" -ForegroundColor Cyan
  } else {
    Write-Host "Portable exe unchanged, skipping copy." -ForegroundColor DarkGray
  }
} else {
  Write-Host "WARNING: Portable exe not found at $srcExe -- skipping copy." -ForegroundColor Yellow
}

# --- Copy installer exe if changed ---
$setupName  = "SC Evo Launcher Setup.exe"
$srcSetup   = "$launcherRepo\dist-electron\$setupName"
$dstSetupDir = "$deployRoot\installer"
$dstSetup   = "$dstSetupDir\$setupName"

if (Test-Path $srcSetup) {
  $srcHash = (Get-FileHash $srcSetup -Algorithm SHA256).Hash
  $dstHash = if (Test-Path $dstSetup) { (Get-FileHash $dstSetup -Algorithm SHA256).Hash } else { "" }
  if ($srcHash -ne $dstHash) {
    if (-not (Test-Path $dstSetupDir)) { New-Item -ItemType Directory -Path $dstSetupDir | Out-Null }
    Copy-Item $srcSetup $dstSetup -Force
    Write-Host "Installer exe copied (hash changed)" -ForegroundColor Cyan
  } else {
    Write-Host "Installer exe unchanged, skipping copy." -ForegroundColor DarkGray
  }
} else {
  Write-Host "Installer exe not found at $srcSetup -- skipping (build with npm run build:installer)." -ForegroundColor DarkGray
}

# --- Generate launcher-version.json from package.json ---
$pkgPath = "$launcherRepo\package.json"
if (Test-Path $pkgPath) {
  $ver = (Get-Content $pkgPath -Raw | ConvertFrom-Json).version
  $launcherJsonPath = "$deployRoot\manifests\launcher-version.json"
  $debugLine = if ($config.showVersionDebug -eq $true) { "`n  `"showVersionDebug`": true," } else { "" }
  $base = "https://pub-8a599b66a5cf440ab429113861fd1c21.r2.dev"
  $launcherJson = "{$debugLine`n  `"version`": `"$ver`",`n  `"portable`": {`n    `"url`": `"$base/launcher/SC%20Evo%20Launcher.exe`"`n  },`n  `"installer`": {`n    `"url`": `"$base/installer/SC%20Evo%20Launcher%20Setup.exe`"`n  }`n}"
  [System.IO.File]::WriteAllText($launcherJsonPath, $launcherJson, (New-Object System.Text.UTF8Encoding $false))
  Write-Host "launcher-version.json -> v$ver (showVersionDebug: $($config.showVersionDebug -eq $true))" -ForegroundColor Cyan
} else {
  Write-Host "WARNING: package.json not found at $pkgPath -- skipping launcher-version.json generation." -ForegroundColor Yellow
}

$results = [System.Collections.Generic.List[object]]::new()

foreach ($f in $folders) {
  $localPath = "$deployRoot\$($f.Local)"
  if (-not (Test-Path $localPath)) {
    Write-Host "`n$($f.Name): folder not found, skipping." -ForegroundColor DarkGray
    continue
  }
  Write-Host "`nSyncing $($f.Name)..." -ForegroundColor Cyan
  rclone copy $localPath "$bucket/$($f.Local)" --checksum --progress
  if ($LASTEXITCODE -eq 0) {
    $results.Add([pscustomobject]@{ Label = $f.Name; OK = $true;  Detail = "$($f.Local)\ -> $bucket/$($f.Local)" })
  } else {
    $results.Add([pscustomobject]@{ Label = $f.Name; OK = $false; Detail = "rclone exited $LASTEXITCODE" })
  }
}

Write-Host ""
Write-Host "-----------------------------------------" -ForegroundColor DarkGray
$allOk = $true
foreach ($r in $results) {
  if ($r.OK) {
    Write-Host "  OK    $($r.Label)" -ForegroundColor Green
    Write-Host "        $($r.Detail)" -ForegroundColor DarkGray
  } else {
    Write-Host "  FAIL  $($r.Label)" -ForegroundColor Red
    Write-Host "        $($r.Detail)" -ForegroundColor Red
    $allOk = $false
  }
}
Write-Host "-----------------------------------------" -ForegroundColor DarkGray
if ($allOk) { Write-Host "  All synced." -ForegroundColor Green }
else        { Write-Host "  Some folders failed - check errors above." -ForegroundColor Red }
Write-Host ""
