# ==============================================================================
# SC Evo -- Campaign File Packager
# Packages .SC2Map and .SC2Mod source directories from the SC2 install folder
# into binary archives and copies them into payload\ or betapayload\.
#
# Raises the MPQ file-slot limit to 65536 (build.ps1 used 1000, which silently
# drops files in larger mods).
# ==============================================================================

$SEP             = "=" * 60
$MPQ_FILE_LIMIT  = 65536
$SCRIPT_ROOT     = $PSScriptRoot
$TEMP_DIR        = "$SCRIPT_ROOT\build-temp"
$MPQ_SCRIPT_PATH = "$SCRIPT_ROOT\Build-SC2Files.mpq2k"
$CONFIG_PATH     = "$SCRIPT_ROOT\deploy-config.json"
$MPQ_EDITOR      = "$SCRIPT_ROOT\MPQEditor.exe"
$IGNORED_PATH    = "$SCRIPT_ROOT\sc2packager-ignored.json"

# -- Colour helpers (matching build-manifests.ps1) ----------------------------
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

# -- Input helpers -------------------------------------------------------------
function Prompt-Text([string]$label, [string]$default = "") {
    $display = if ($default -ne "") { "$label [$default]: " } else { "${label}: " }
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

# -- Config helpers ------------------------------------------------------------
function Load-Config {
    if (Test-Path $CONFIG_PATH) {
        try { return Get-Content $CONFIG_PATH -Raw | ConvertFrom-Json } catch {}
    }
    return [pscustomobject]@{}
}

function Save-Config($config) {
    $json = $config | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($CONFIG_PATH, $json, (New-Object System.Text.UTF8Encoding $false))
}

function Load-Ignored {
    if (Test-Path $IGNORED_PATH) {
        try {
            $raw    = Get-Content $IGNORED_PATH -Raw
            $parsed = $raw | ConvertFrom-Json
            if ($parsed -is [array]) { return [string[]]$parsed }
            if ($parsed)             { return [string[]]@($parsed) }
        } catch {}
    }
    return [string[]]@()
}

function Save-Ignored([string[]]$list) {
    if ($list.Count -eq 0) {
        [System.IO.File]::WriteAllText($IGNORED_PATH, "[]`n",
            (New-Object System.Text.UTF8Encoding $false))
        return
    }
    $items = $list | ForEach-Object { "  `"$($_.Replace('\','\\'))`"" }
    $json  = "[`n$($items -join ",`n")`n]"
    [System.IO.File]::WriteAllText($IGNORED_PATH, $json,
        (New-Object System.Text.UTF8Encoding $false))
}

# -- Source discovery helpers --------------------------------------------------
# Adds all subdirectories of $relParent whose names match $extension to $list.
function Add-SourceDirs([System.Collections.ArrayList]$list, [string]$sc2Root, [string]$relParent, [string]$extension) {
    $full = Join-Path $sc2Root $relParent
    if (-not (Test-Path $full -PathType Container)) {
        Write-Warn "SC2 path not found, skipping: $relParent"
        return
    }
    Get-ChildItem -Path $full -Directory |
        Where-Object { $_.Name -like "*$extension" } |
        ForEach-Object {
            [void]$list.Add([pscustomobject]@{
                relPath   = "$relParent\$($_.Name)"
                sourceDir = $_.FullName
                target    = $null
            })
        }
}

# Adds a single named directory (the dir itself, not its children).
function Add-SingleSource([System.Collections.ArrayList]$list, [string]$sc2Root, [string]$relPath) {
    $full = Join-Path $sc2Root $relPath
    if (-not (Test-Path $full -PathType Container)) {
        Write-Warn "SC2 path not found, skipping: $relPath"
        return
    }
    [void]$list.Add([pscustomobject]@{
        relPath   = $relPath
        sourceDir = $full
        target    = $null
    })
}

# ==============================================================================
# MAIN
# ==============================================================================

Write-Header "SC Evo -- Campaign File Packager"
Write-Host " Deployment repo: $SCRIPT_ROOT" -ForegroundColor DarkGray
Write-Host ""

# -- Check MPQEditor -----------------------------------------------------------
if (-not (Test-Path $MPQ_EDITOR)) {
    Write-Host "ERROR: MPQEditor.exe not found at:" -ForegroundColor Red
    Write-Host "       $MPQ_EDITOR" -ForegroundColor Red
    Write-Host "       Place MPQEditor.exe in the same folder as this script." -ForegroundColor Red
    pause; exit 1
}

# -- SC2 install path ----------------------------------------------------------
Write-Step "SC2 install folder"
$config  = Load-Config
$ignored = Load-Ignored

# Migrate: remove corrupted key from deploy-config.json if present
if ($config.PSObject.Properties.Match("sc2PackagerIgnored").Count -gt 0) {
    $config.PSObject.Properties.Remove("sc2PackagerIgnored")
    Save-Config $config
    Write-Info "Migrated veto list to sc2packager-ignored.json"
}

$sc2Path = ""

$savedPath = if ($config.PSObject.Properties.Match("sc2InstallPath").Count -gt 0) { $config.sc2InstallPath } else { "" }
if ($savedPath -and (Test-Path $savedPath -PathType Container)) {
    Write-Info "Saved path: $savedPath"
    if (Prompt-YN "   Use this path?" $true) {
        $sc2Path = $savedPath
    }
}

if (-not $sc2Path) {
    do {
        $sc2Path = (Read-Host "   Full path to SC2 install folder").Trim()
        if (-not $sc2Path) { continue }
        if (-not (Test-Path $sc2Path -PathType Container)) {
            Write-Warn "Path not found -- try again."
            $sc2Path = ""
        }
    } while (-not $sc2Path)

    if ($config.PSObject.Properties.Match("sc2InstallPath").Count -gt 0) {
        $config.sc2InstallPath = $sc2Path
    } else {
        $config | Add-Member -MemberType NoteProperty -Name sc2InstallPath -Value $sc2Path
    }
    Save-Config $config
    Write-Info "Saved to deploy-config.json"
}

Write-Ok "SC2 path: $sc2Path"
Write-Host ""

# -- Discover source directories -----------------------------------------------
Write-Step "Scanning SC2 install folder..."
$sources = [System.Collections.ArrayList]@()

# Maps
Add-SourceDirs $sources $sc2Path "Maps\SCEvo\LegacyLoomings"  ".SC2Map"
Add-SourceDirs $sources $sc2Path "Maps\SCEvo\LegacyRebelYell" ".SC2Map"
Add-SingleSource $sources $sc2Path "Maps\SCEvo\EvoCompleteLauncher.SC2Map"

# Mods (must match the exact folder structure already in payload)
Add-SourceDirs $sources $sc2Path "Mods\SC Evolution Complete"                    ".SC2Mod"
Add-SourceDirs $sources $sc2Path "Mods\SC Evolution Complete\SCEvo_CampaignMods" ".SC2Mod"

if ($sources.Count -eq 0) {
    Write-Warn "No source directories found. Verify your SC2 install path contains the expected mod/map folders."
    pause; exit 1
}
Write-Ok "$($sources.Count) source(s) found."
Write-Host ""

# -- Check each source against payload / betapayload ---------------------------
foreach ($src in $sources) {
    $src | Add-Member -MemberType NoteProperty -Name inPayload     -Value (Test-Path "$SCRIPT_ROOT\payload\$($src.relPath)")
    $src | Add-Member -MemberType NoteProperty -Name inBetapayload -Value (Test-Path "$SCRIPT_ROOT\betapayload\$($src.relPath)")
}

# -- Status table (all discovered files, ignored ones marked) -----------------
Write-Step "File status"
Write-Host ""
Write-Host ("  {0,-58} {1,-9} {2}" -f "File", "Payload", "Betapayload") -ForegroundColor DarkGray
Write-Host ("  " + ("-" * 80)) -ForegroundColor DarkGray

foreach ($src in $sources) {
    if ($src.relPath -in $ignored) {
        Write-Host ("  {0,-58} [IGNORED]" -f $src.relPath) -ForegroundColor DarkGray
        continue
    }
    $pCol    = if ($src.inPayload)     { "Green"   } else { "DarkGray" }
    $bCol    = if ($src.inBetapayload) { "Cyan"    } else { "DarkGray" }
    $nameCol = if (-not $src.inPayload -and -not $src.inBetapayload) { "Green" } else { "White" }
    $p  = if ($src.inPayload)     { "YES" } else { "---" }
    $bp = if ($src.inBetapayload) { "YES" } else { "---" }
    Write-Host -NoNewline ("  {0,-58} " -f $src.relPath) -ForegroundColor $nameCol
    Write-Host -NoNewline ("{0,-9}" -f $p)  -ForegroundColor $pCol
    Write-Host $bp -ForegroundColor $bCol
}
Write-Host ""

# Filter out vetoed files before the decision prompts
$sources = [System.Collections.ArrayList]($sources | Where-Object { $_.relPath -notin $ignored })
if ($ignored.Count -gt 0) {
    Write-Info "$($ignored.Count) file(s) vetoed -- skipped. Delete sc2packager-ignored.json (or remove entries) to reset."
}
if ($sources.Count -eq 0) {
    Write-Warn "All files are vetoed. Nothing to prompt."
    pause; exit 0
}
Write-Host ""

# -- Per-file decision ---------------------------------------------------------
Write-Step "Select which files to package"
Write-Host ""

foreach ($src in $sources) {
    $inP  = $src.inPayload
    $inBP = $src.inBetapayload
    $name = $src.relPath

    if (-not $inP -and -not $inBP) {
        # New file -- ask where it goes
        Write-Host "   NEW: $name" -ForegroundColor Green
        do {
            $pick = (Read-Host "         Destination -- [P]ayload / [B]etapayload / [S]kip / [V]eto").Trim().ToUpper()
        } while ($pick -notin @("P", "B", "S", "V", ""))
        $src.target = switch ($pick) {
            "P" { "payload" }
            "B" { "betapayload" }
            "V" { "veto" }
            default { $null }
        }
    } elseif ($inP -and $inBP) {
        # In both -- ask which to update
        Write-Host "   BOTH: $name" -ForegroundColor White
        do {
            $pick = (Read-Host "         Update -- [P]ayload / [B]etapayload / [A]ll / [S]kip").Trim().ToUpper()
        } while ($pick -notin @("P", "B", "A", "S", ""))
        $src.target = switch ($pick) {
            "P" { "payload" }
            "B" { "betapayload" }
            "A" { "both" }
            default { $null }
        }
    } elseif ($inP) {
        do {
            $pick = (Read-Host "   payload\$name -- [Y]es update / [S]kip").Trim().ToUpper()
        } while ($pick -notin @("Y", "S", ""))
        $src.target = switch ($pick) {
            "Y" { "payload" }
            default { $null }
        }
    } else {
        do {
            $pick = (Read-Host "   betapayload\$name -- [Y]es update / [S]kip").Trim().ToUpper()
        } while ($pick -notin @("Y", "S", ""))
        $src.target = switch ($pick) {
            "Y" { "betapayload" }
            default { $null }
        }
    }
}

$toVeto = @($sources | Where-Object { $_.target -eq "veto" })
if ($toVeto.Count -gt 0) {
    foreach ($v in $toVeto) {
        if ($v.relPath -notin $ignored) { $ignored += $v.relPath }
    }
    Save-Ignored $ignored
    Write-Info "$($toVeto.Count) file(s) added to veto list -- will be skipped on future runs."
}
$toBuild = @($sources | Where-Object { $null -ne $_.target -and $_.target -ne "veto" })
if ($toBuild.Count -eq 0) {
    Write-Host ""
    Write-Warn "Nothing selected. Exiting."
    pause; exit 0
}

Write-Host ""
Write-Step "$($toBuild.Count) file(s) queued for packaging:"
foreach ($src in $toBuild) {
    Write-Host ("   -> {0,-58} [{1}]" -f $src.relPath, $src.target) -ForegroundColor Cyan
}
Write-Host ""

if (-not (Prompt-YN "Proceed with packaging?" $true)) {
    Write-Warn "Aborted."
    pause; exit 0
}

# -- Build phase ---------------------------------------------------------------
Write-Header "Building with MPQEditor"

if (Test-Path $TEMP_DIR) { Remove-Item $TEMP_DIR -Recurse -Force }
New-Item -ItemType Directory -Path $TEMP_DIR | Out-Null

# MPQEditor console scripts require RELATIVE paths (absolute paths are silently
# ignored — exit code 0, no output).  We always create an NTFS junction for
# each source dir so the relative path inside build-temp is space-free and
# consistent regardless of where the SC2 install lives.
# We also Push-Location to $SCRIPT_ROOT so that the relative paths in the
# .mpq2k file resolve correctly even when launched via double-click.
$junctions  = [System.Collections.ArrayList]@()
$mpq2kLines = [System.Collections.ArrayList]@()

foreach ($src in $toBuild) {
    $filename = [System.IO.Path]::GetFileName($src.relPath)
    $idx      = $junctions.Count
    $jLink    = "$TEMP_DIR\_src$idx"

    # Use cmd mklink /J -- works on all Windows/PS versions without elevation.
    # New-Item -ItemType Junction -Target is PS7+ only; -Value is PS5.1 but
    # mklink /J is unambiguous and handles spaces in the target path.
    $null = cmd /c "mklink /J `"$jLink`" `"$($src.sourceDir)`""
    if (-not (Test-Path $jLink -PathType Container)) {
        Write-Warn "Could not create junction for $($src.relPath) -- skipping."
        continue
    }
    [void]$junctions.Add($jLink)

    # Relative paths from $SCRIPT_ROOT — MPQEditor resolves from its working dir
    $outRel = "build-temp\$filename"
    $srcRel = "build-temp\_src$idx"

    [void]$mpq2kLines.Add("new $outRel $MPQ_FILE_LIMIT")
    [void]$mpq2kLines.Add("add $outRel $srcRel /r /c")
    [void]$mpq2kLines.Add("flush $outRel")
    [void]$mpq2kLines.Add("")
}

[System.IO.File]::WriteAllLines($MPQ_SCRIPT_PATH, $mpq2kLines,
    (New-Object System.Text.UTF8Encoding $false))

Write-Info "MPQ script contents:"
foreach ($line in $mpq2kLines) {
    if ($line) { Write-Host "      $line" -ForegroundColor DarkGray }
}
Write-Host ""

Write-Step "Running MPQEditor (this may take a while)..."
Write-Host ""
$mpqStart = Get-Date
Push-Location $SCRIPT_ROOT
& $MPQ_EDITOR console "Build-SC2Files.mpq2k"
$mpqExit = $LASTEXITCODE
Pop-Location
$mpqElapsed = [math]::Round(((Get-Date) - $mpqStart).TotalSeconds, 1)
Write-Info "MPQEditor finished in ${mpqElapsed}s (exit code: $(if ($null -eq $mpqExit) { 'n/a' } else { $mpqExit }))"

# Remove junctions (link only -- does not touch SC2 source files)
foreach ($j in $junctions) {
    if (Test-Path $j -PathType Container) {
        try { [System.IO.Directory]::Delete($j) } catch { Write-Warn "Could not remove junction: $j" }
    }
}

# Keep the .mpq2k on disk if MPQEditor produced nothing (aids debugging)
$anyBuilt = @($toBuild | Where-Object {
    Test-Path "$TEMP_DIR\$([System.IO.Path]::GetFileName($_.relPath))"
})
if ($anyBuilt.Count -eq 0) {
    if (Test-Path $MPQ_SCRIPT_PATH) {
        Write-Warn "No output produced. MPQ script left for inspection: $MPQ_SCRIPT_PATH"
    }
} else {
    Remove-Item $MPQ_SCRIPT_PATH -Force -ErrorAction SilentlyContinue
}

if ($mpqExit) {
    Write-Host ""
    Write-Warn "MPQEditor exited with code $mpqExit -- check output above for errors."
}

# -- Deploy phase --------------------------------------------------------------
Write-Header "Deploying built files"

$results = [System.Collections.ArrayList]@()

foreach ($src in $toBuild) {
    $filename  = [System.IO.Path]::GetFileName($src.relPath)
    $builtFile = "$TEMP_DIR\$filename"

    if (-not (Test-Path $builtFile)) {
        Write-Warn "Missing build output: $filename"
        [void]$results.Add([pscustomobject]@{ name = $filename; ok = $false; detail = "MPQEditor produced no output" })
        continue
    }

    $deployTargets = switch ($src.target) {
        "both"        { @("payload", "betapayload") }
        "payload"     { @("payload") }
        "betapayload" { @("betapayload") }
        default       { @() }
    }

    foreach ($folder in $deployTargets) {
        $destPath = "$SCRIPT_ROOT\$folder\$($src.relPath)"
        $destDir  = Split-Path $destPath -Parent
        try {
            if (-not (Test-Path $destDir)) {
                New-Item -ItemType Directory -Path $destDir -Force | Out-Null
            }
            Copy-Item $builtFile $destPath -Force
            Write-Ok "$filename  ->  $folder\$($src.relPath)"
            [void]$results.Add([pscustomobject]@{ name = $filename; ok = $true; detail = "$folder\$($src.relPath)" })
        } catch {
            Write-Warn "Copy failed: $filename -> $folder\ -- $($_.Exception.Message)"
            [void]$results.Add([pscustomobject]@{ name = $filename; ok = $false; detail = $_.Exception.Message })
        }
    }
}

# -- Cleanup -------------------------------------------------------------------
if (Test-Path $TEMP_DIR) {
    Remove-Item $TEMP_DIR -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $TEMP_DIR) { Write-Warn "Could not fully clean $TEMP_DIR -- delete it manually." }
}

# -- Summary -------------------------------------------------------------------
Write-Header "Summary"
$okCount  = @($results | Where-Object { $_.ok  }).Count
$badCount = @($results | Where-Object { -not $_.ok }).Count

Write-Host "  Packaged  : $okCount" -ForegroundColor Green
Write-Host "  Failed    : $badCount" -ForegroundColor $(if ($badCount -gt 0) { "Red" } else { "DarkGray" })
Write-Host ""
foreach ($r in $results) {
    if ($r.ok) { Write-Ok  "$($r.name)  ->  $($r.detail)" }
    else       { Write-Warn "$($r.name)  --  $($r.detail)" }
}

Write-Host ""
Write-Host $SEP -ForegroundColor DarkCyan
Write-Host "  Done." -ForegroundColor Cyan
Write-Host $SEP -ForegroundColor DarkCyan
Write-Host ""
