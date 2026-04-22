# ==============================================================================
# SC Evo -- Manifest Builder
# Run from the root of the deployment repo (TeamKoprulu/SCEvo_Deploy).
# Generates / updates update-manifest.json and/or beta-manifest.json.
# ==============================================================================

# -- Configuration -------------------------------------------------------------
$PUBLIC_SCAN_ROOTS = @("payload\maps", "payload\mods")
$BETA_SCAN_ROOTS   = @("betapayload\maps", "betapayload\mods")
$SCAN_EXTENSIONS   = @("*.SC2Mod", "*.SC2Map")
$MANIFEST_DIR    = "manifests"
$ASSET_THRESHOLD = 100 * 1MB
$GITHUB_REPO     = "TeamKoprulu/SCEvo_Deploy"
$SCHEMA_VERSION  = 1
$SEP             = "=" * 60

# -- Colour helpers ------------------------------------------------------------
function Write-Header([string]$text) {
    Write-Host ""
    Write-Host $SEP -ForegroundColor DarkCyan
    Write-Host "  $text" -ForegroundColor Cyan
    Write-Host $SEP -ForegroundColor DarkCyan
    Write-Host ""
}

function Write-Step([string]$text) {
    Write-Host ">> $text" -ForegroundColor Yellow
}

function Write-Ok([string]$text) {
    Write-Host "   [OK]  $text" -ForegroundColor Green
}

function Write-Warn([string]$text) {
    Write-Host "   [!!]  $text" -ForegroundColor Magenta
}

function Write-Info([string]$text) {
    Write-Host "   ...   $text" -ForegroundColor DarkGray
}

function Write-Changed([string]$text) {
    Write-Host "   [~~]  $text" -ForegroundColor Cyan
}

function Write-New([string]$text) {
    Write-Host "   [++]  $text" -ForegroundColor Green
}

# -- Input helpers -------------------------------------------------------------
function Prompt-Text([string]$label, [string]$default = "") {
    if ($default -ne "") {
        $display = "$label [$default]: "
    } else {
        $display = "${label}: "
    }
    $val = Read-Host $display
    if ($val -eq "" -and $default -ne "") { return $default }
    return $val
}

function Prompt-YN([string]$question, [bool]$defaultYes = $false) {
    $hint = if ($defaultYes) { "[Y/n]" } else { "[y/N]" }
    $val  = Read-Host "$question $hint"
    if ($val -eq "") { return $defaultYes }
    return $val -match "^[Yy]"
}

# -- SHA-256 -------------------------------------------------------------------
function Get-SHA256([string]$path) {
    $h = Get-FileHash -Path $path -Algorithm SHA256
    return $h.Hash.ToLower()
}

function Get-StringSHA256([string]$text) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    $sha   = [System.Security.Cryptography.SHA256]::Create()
    $hash  = $sha.ComputeHash($bytes)
    return ([BitConverter]::ToString($hash) -replace "-", "").ToLower()
}

# -- Hex colour to "R, G, B" string (no System.Drawing dependency) -------------
function Get-ParticleRgb([string]$hex) {
    $h = $hex.TrimStart("#")
    $r = [Convert]::ToInt32($h.Substring(0, 2), 16)
    $g = [Convert]::ToInt32($h.Substring(2, 2), 16)
    $b = [Convert]::ToInt32($h.Substring(4, 2), 16)
    return "$r, $g, $b"
}

# -- Module ID generator -------------------------------------------------------
function Get-ModuleId([string]$filename) {
    $stem = [System.IO.Path]::GetFileNameWithoutExtension($filename)
    return $stem.ToLower().Replace("_", "-")
}

# -- Path normalisation (forward slashes, relative to repo root) ---------------
function Get-RelativePath([string]$fullPath, [string]$repoRoot) {
    $rel = $fullPath.Substring($repoRoot.Length).TrimStart("\", "/")
    return $rel.Replace("\", "/")
}

# -- Build module list from scanned files --------------------------------------
# Untyped parameters avoid the PowerShell parser issue with nested generic
# types (e.g. List[hashtable]) in formal parameter position.
function Build-Modules($scanned, $existingLookup, $releaseVersion) {
    $modules = [System.Collections.ArrayList]@()

    foreach ($f in $scanned) {
        $relPath      = $f.relPath
        $filename     = $f.name
        $size         = $f.size
        $hash         = $f.hash
        $isAsset      = $f.isAsset
        $existing     = $existingLookup[$relPath]

        $downloadUrl  = $null
        $downloadUrls = $null

        if ($existing) {
            $id           = $existing.id
            $name         = $existing.name
            $description  = $existing.description
            $type         = $existing.type
            $downloadUrl  = $existing.downloadUrl
            $downloadUrls = $existing.downloadUrls

            if ($hash -ne $existing.hash) {
                Write-Changed "Hash changed: $filename"
            } else {
                Write-Ok "Unchanged:    $filename"
            }

            if ($isAsset) {
                # Reconstruct existing URL list (supports both downloadUrl and downloadUrls)
                $existingUrls = @()
                if ($downloadUrls -and $downloadUrls.Count -gt 0) {
                    $existingUrls = @($downloadUrls)
                } elseif ($downloadUrl) {
                    $existingUrls = @($downloadUrl)
                }

                $defPrimary = if ($existingUrls.Count -ge 1) { $existingUrls[0] } else { "https://github.com/$GITHUB_REPO/releases/download/$releaseVersion/$filename" }
                $defMirror  = if ($existingUrls.Count -ge 2) { $existingUrls[1] } else { "" }

                Write-Host ""
                Write-Host "   Asset file: $filename" -ForegroundColor Yellow
                Write-Host "   Primary URL: $defPrimary" -ForegroundColor DarkGray
                if ($defMirror) { Write-Host "   Mirror URL:  $defMirror" -ForegroundColor DarkGray }

                $newPrimary = Prompt-Text "   Primary download URL (Enter to keep)" $defPrimary
                $newMirror  = Prompt-Text "   Mirror URL          (Enter to skip)" $defMirror

                if ($newMirror) {
                    $downloadUrls = @($newPrimary, $newMirror)
                    $downloadUrl  = $null
                } else {
                    $downloadUrl  = $newPrimary
                    $downloadUrls = $null
                }
            }
        } else {
            Write-New "New file:     $filename"
            $autoId      = Get-ModuleId $filename
            $id          = Prompt-Text "   Module ID"                           $autoId
            $name        = Prompt-Text "   Name"                                ([System.IO.Path]::GetFileNameWithoutExtension($filename))
            $description = Prompt-Text "   Description"                         $name
            $type        = Prompt-Text "   Type (core/campaign, blank to omit)" ""

            if ($isAsset) {
                $suggestion = "https://github.com/$GITHUB_REPO/releases/download/$releaseVersion/$filename"
                Write-Host "   Asset file -- download URL required." -ForegroundColor Yellow
                $newPrimary = Prompt-Text "   Primary download URL" $suggestion
                $newMirror  = Prompt-Text "   Mirror URL          (Enter to skip)" ""

                if ($newMirror) {
                    $downloadUrls = @($newPrimary, $newMirror)
                } else {
                    $downloadUrl = $newPrimary
                }
            }
        }

        $fileEntry = [ordered]@{
            name = $filename
            path = $relPath
            size = $size
            hash = $hash
        }
        if ($downloadUrls -and $downloadUrls.Count -gt 0) {
            $fileEntry["downloadUrls"] = $downloadUrls
        } elseif ($downloadUrl) {
            $fileEntry["downloadUrl"] = $downloadUrl
        }

        $module = [ordered]@{
            id          = $id
            name        = $name
            description = $description
        }
        if ($type) { $module["type"] = $type }
        $module["files"] = @($fileEntry)

        [void]$modules.Add($module)
    }

    return @($modules)
}

# ==============================================================================
# MAIN
# ==============================================================================

Write-Header "SC Evo -- Manifest Builder"
Write-Host " Deployment repo root: $(Get-Location)" -ForegroundColor DarkGray
Write-Host ""

# -- Repo root check -----------------------------------------------------------
$repoRoot = (Get-Location).Path
if (-not (Test-Path $MANIFEST_DIR)) {
    Write-Warn "No '$MANIFEST_DIR' folder found at current location."
    if (-not (Prompt-YN "Continue anyway?" $false)) { exit 1 }
    New-Item -ItemType Directory -Path $MANIFEST_DIR | Out-Null
}

# -- Choose target -------------------------------------------------------------
Write-Step "Which manifest(s) to build?"
Write-Host "   [1] Public only  (update-manifest.json)" -ForegroundColor White
Write-Host "   [2] Beta only    (beta-manifest.json)"   -ForegroundColor White
Write-Host "   [3] Both"                                 -ForegroundColor White
$choice      = Read-Host "   Choice"
$buildPublic = $choice -in @("1", "3")
$buildBeta   = $choice -in @("2", "3")
if (-not $buildPublic -and -not $buildBeta) {
    Write-Warn "Invalid choice. Exiting."
    exit 1
}

# -- Scan files ----------------------------------------------------------------
# Determine which roots to scan based on the chosen target(s).
# Public files live in payload\maps + payload\mods.
# Beta files live in betapayload\maps + betapayload\mods.
Write-Host ""
Write-Step "Scanning for SC2 files..."

$scannedPublic = [System.Collections.ArrayList]@()
$scannedBeta   = [System.Collections.ArrayList]@()

function Scan-Roots($roots, $list, $stripPrefix) {
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) {
            Write-Warn "Scan root not found, skipping: $root"
            continue
        }
        foreach ($ext in $SCAN_EXTENSIONS) {
            Get-ChildItem -Path $root -Recurse -Filter $ext | ForEach-Object {
                $fullPath = $_.FullName
                $rel      = Get-RelativePath $fullPath $repoRoot
                # Strip the payload prefix so manifest paths are SC2-root-relative,
                # not deployment-repo-relative (e.g. "mods/foo.SC2Mod" not "payload/mods/foo.SC2Mod")
                if ($stripPrefix -and $rel.StartsWith($stripPrefix)) {
                    $rel = $rel.Substring($stripPrefix.Length).TrimStart("/")
                }
                $size    = $_.Length
                $isAsset = $size -ge $ASSET_THRESHOLD

                Write-Host "   Hashing $($_.Name)..." -NoNewline -ForegroundColor DarkGray
                $hash = Get-SHA256 $fullPath
                Write-Host " done" -ForegroundColor DarkGray

                [void]$list.Add(@{
                    name    = $_.Name
                    relPath = $rel
                    size    = $size
                    hash    = $hash
                    isAsset = $isAsset
                })
            }
        }
    }
}

if ($buildPublic) {
    Write-Info "Public roots: $($PUBLIC_SCAN_ROOTS -join ', ')"
    Scan-Roots $PUBLIC_SCAN_ROOTS $scannedPublic "payload/"
    Write-Ok "Public: $($scannedPublic.Count) file(s) found."
}
if ($buildBeta) {
    Write-Info "Beta roots: $($BETA_SCAN_ROOTS -join ', ')"
    Scan-Roots $BETA_SCAN_ROOTS $scannedBeta "betapayload/"
    Write-Ok "Beta:   $($scannedBeta.Count) file(s) found."
}
Write-Host ""

# -- Version prompts -----------------------------------------------------------
# Peek at the existing public manifest (if present) to show current versions.
Write-Host ""
Write-Step "Version numbers"
$_pubPeekPath = Join-Path $MANIFEST_DIR "update-manifest.json"
$_curCore     = ""
$_curCampaign = ""
if (Test-Path $_pubPeekPath) {
    $peek = Get-Content $_pubPeekPath -Raw | ConvertFrom-Json
    if ($peek.versions) {
        $_curCore     = $peek.versions.multiplayer
        $_curCampaign = $peek.versions.campaign
        Write-Info "Current versions -- Core: $_curCore  /  Campaign: $_curCampaign"
    }
}
$versionCore     = Prompt-Text "   Core (multiplayer) version" $_curCore
$versionCampaign = Prompt-Text "   Campaign version"           $_curCampaign

# ==============================================================================
# PUBLIC MANIFEST
# ==============================================================================
if ($buildPublic) {
    Write-Header "Public Manifest"

    $pubPath     = Join-Path $MANIFEST_DIR "update-manifest.json"
    $pubExisting = $null
    $pubLookup   = @{}

    if (Test-Path $pubPath) {
        $pubExisting = Get-Content $pubPath -Raw | ConvertFrom-Json
        foreach ($mod in $pubExisting.modules) {
            foreach ($file in $mod.files) {
                $pubLookup[$file.path] = @{
                    id           = $mod.id
                    name         = $mod.name
                    description  = $mod.description
                    type         = $mod.type
                    hash         = $file.hash
                    downloadUrl  = $file.downloadUrl
                    downloadUrls = if ($file.downloadUrls) { @($file.downloadUrls) } else { $null }
                }
            }
        }
        Write-Info "Loaded existing manifest ($($pubExisting.modules.Count) modules)"
    } else {
        Write-Info "No existing manifest -- building from scratch."
    }

    # Check for missing files (in manifest but not on disk)
    $scannedPaths = @($scannedPublic | ForEach-Object { $_.relPath })
    if ($pubExisting) {
        foreach ($mod in $pubExisting.modules) {
            foreach ($file in $mod.files) {
                if ($file.path -notin $scannedPaths) {
                    Write-Warn "Not found on disk: $($file.name) ($($file.path))"
                    $remove = Prompt-YN "   Remove from manifest?" $true
                    if (-not $remove) {
                        Write-Info "Keeping $($file.name) in manifest (no file on disk)."
                        [void]$scannedPublic.Add(@{
                            name     = $file.name
                            relPath  = $file.path
                            size     = $file.size
                            hash     = $file.hash
                            isAsset  = ($file.size -ge $ASSET_THRESHOLD)
                            keepOnly = $true
                        })
                    }
                }
            }
        }
    }

    # Critical update
    Write-Host ""
    Write-Step "Critical update (public)"
    $critEnabled = Prompt-YN "   Enable critical update?" $false
    $critMin     = ""
    $critMsg     = ""
    $critSev     = "critical"
    if ($critEnabled) {
        $critMin = Prompt-Text "   Minimum version required"
        $critMsg = Prompt-Text "   Message shown to users"
        $critSev = Prompt-Text "   Severity" "critical"
    }

    # Build modules
    Write-Host ""
    Write-Step "Reviewing files..."
    $pubModules = Build-Modules $scannedPublic $pubLookup $versionCore

    # Assemble manifest
    $now         = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    $pubManifest = [ordered]@{
        schemaVersion  = $SCHEMA_VERSION
        lastUpdated    = $now
        versions       = [ordered]@{
            multiplayer = $versionCore
            campaign    = $versionCampaign
        }
        criticalUpdate = [ordered]@{
            enabled    = $critEnabled
            minVersion = $critMin
            message    = $critMsg
            severity   = $critSev
        }
        modules = $pubModules
    }

    # Preview
    $updated  = @($scannedPublic | Where-Object { $pubLookup[$_.relPath] -and ($_.hash -ne $pubLookup[$_.relPath].hash) }).Count
    $newFiles = @($scannedPublic | Where-Object { -not $pubLookup[$_.relPath] }).Count
    $assets   = @($scannedPublic | Where-Object { $_.isAsset }).Count
    $critLine = if ($critEnabled) { "ENABLED -- min $critMin" } else { "disabled" }

    Write-Header "Preview -- Public Manifest"
    Write-Host "  Updated files : $updated"        -ForegroundColor Cyan
    Write-Host "  New files     : $newFiles"        -ForegroundColor Green
    Write-Host "  Asset files   : $assets"          -ForegroundColor Yellow
    Write-Host "  Core version  : $versionCore"
    Write-Host "  Campaign ver  : $versionCampaign"
    Write-Host "  Critical      : $critLine"
    Write-Host ""

    if (Prompt-YN "Write update-manifest.json?" $true) {
        if (Test-Path $pubPath) {
            $bakPath = $pubPath -replace "\.json$", ".bak.json"
            Copy-Item $pubPath $bakPath -Force
            Write-Info "Backup saved: update-manifest.bak.json"
        }
        $pubManifest | ConvertTo-Json -Depth 10 | Set-Content $pubPath -Encoding UTF8
        Write-Ok "Written: $pubPath"
    } else {
        Write-Warn "Skipped writing public manifest."
    }
}

# ==============================================================================
# BETA MANIFEST
# ==============================================================================
if ($buildBeta) {
    Write-Header "Beta Manifest"

    $betaPath     = Join-Path $MANIFEST_DIR "beta-manifest.json"
    $betaExisting = $null
    $betaLookup   = @{}

    if (Test-Path $betaPath) {
        $betaExisting = Get-Content $betaPath -Raw | ConvertFrom-Json
        foreach ($mod in $betaExisting.modules) {
            foreach ($file in $mod.files) {
                $betaLookup[$file.path] = @{
                    id           = $mod.id
                    name         = $mod.name
                    description  = $mod.description
                    type         = $mod.type
                    hash         = $file.hash
                    downloadUrl  = $file.downloadUrl
                    downloadUrls = if ($file.downloadUrls) { @($file.downloadUrls) } else { $null }
                }
            }
        }
        Write-Info "Loaded existing beta manifest ($($betaExisting.modules.Count) modules)"
    } else {
        Write-Info "No existing beta manifest -- building from scratch."
    }

    # Beta metadata
    Write-Step "Beta metadata"
    $defBetaName = if ($betaExisting) { $betaExisting.betaName }    else { "" }
    $defMajor    = if ($betaExisting) { $betaExisting.majorVersion } else { "" }
    $defFull     = if ($betaExisting) { $betaExisting.fullVersion }  else { "" }
    $defAccent   = if ($betaExisting -and $betaExisting.theme) { $betaExisting.theme.accentColor } else { "#ff6600" }

    $betaName    = Prompt-Text "   Beta name"                                    $defBetaName
    $majorVer    = Prompt-Text "   Major version"                                $defMajor
    $fullVer     = Prompt-Text "   Full version"                                 $defFull
    $accentColor = Prompt-Text "   Theme accent colour"                          $defAccent
    $defBetaCoreVer = if ($betaExisting -and $betaExisting.versions) { $betaExisting.versions.multiplayer } else { "" }
    $betaCoreVer = Prompt-Text "   Core version (shown in Settings, blank skip)" $defBetaCoreVer

    # Access code / hash -- always enter plaintext, script auto-hashes
    Write-Host ""
    $plainCode = Read-Host "   Access code (plaintext)"
    $codeHash  = Get-StringSHA256 $plainCode.Trim().ToUpper()
    Write-Info "codeHash: $codeHash"

    # Critical update
    Write-Host ""
    Write-Step "Critical update (beta)"
    $bCritEnabled = Prompt-YN "   Enable critical update?" $false
    $bCritMin     = ""
    $bCritMsg     = ""
    if ($bCritEnabled) {
        $bCritMin = Prompt-Text "   Minimum version required"
        $bCritMsg = Prompt-Text "   Message shown to users"
    }

    # Build modules
    Write-Host ""
    Write-Step "Reviewing beta files..."
    $betaModules = Build-Modules $scannedBeta $betaLookup $fullVer

    # Compute theme fields (no System.Drawing needed)
    $accentDim   = $accentColor + "44"
    $particleRgb = Get-ParticleRgb $accentColor

    $now          = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    $betaManifest = [ordered]@{
        schemaVersion  = $SCHEMA_VERSION
        lastUpdated    = $now
        betaEnabled    = $true
        betaName       = $betaName
        majorVersion   = $majorVer
        fullVersion    = $fullVer
        codeHash       = $codeHash
        theme          = [ordered]@{
            accentColor    = $accentColor
            accentColorDim = $accentDim
            particleColor  = $particleRgb
            bgGlow         = $accentColor + "15"
            badgeText      = "BETA"
            badgeColor     = $accentColor
        }
        criticalUpdate = [ordered]@{
            enabled    = $bCritEnabled
            minVersion = $bCritMin
            message    = $bCritMsg
        }
        modules = $betaModules
    }
    if ($betaCoreVer) { $betaManifest["versions"] = [ordered]@{ multiplayer = $betaCoreVer } }

    # Preview
    $bCritLine = if ($bCritEnabled) { "ENABLED -- min $bCritMin" } else { "disabled" }

    Write-Header "Preview -- Beta Manifest"
    Write-Host "  Beta name    : $betaName"
    Write-Host "  Full version : $fullVer  (major: $majorVer)"
    Write-Host "  Accent       : $accentColor"
    if ($betaCoreVer) { Write-Host "  Core version : $betaCoreVer" }
    Write-Host "  Critical     : $bCritLine"
    Write-Host ""

    if (Prompt-YN "Write beta-manifest.json?" $true) {
        if (Test-Path $betaPath) {
            $bakPath = $betaPath -replace "\.json$", ".bak.json"
            Copy-Item $betaPath $bakPath -Force
            Write-Info "Backup saved: beta-manifest.bak.json"
        }
        $betaManifest | ConvertTo-Json -Depth 10 | Set-Content $betaPath -Encoding UTF8
        Write-Ok "Written: $betaPath"
    } else {
        Write-Warn "Skipped writing beta manifest."
    }
}

# -- Done ----------------------------------------------------------------------
Write-Host ""
Write-Host $SEP -ForegroundColor DarkCyan
Write-Host "  Done." -ForegroundColor Cyan
Write-Host $SEP -ForegroundColor DarkCyan
Write-Host ""
